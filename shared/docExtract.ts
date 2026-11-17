// Turns OCR text into structured document details: the likely document type, labelled fields with
// their OCR reading confidence, a comparison with the instructor's profile, and text-level warning
// signs. Only values actually printed on the document are returned; nothing is guessed.
import { DOC_TYPES, confidenceBand, docType, type ConfidenceBand, type DocTypeKey } from './documents';

// ---------- OCR output ----------

export interface OcrBox { x: number; y: number; w: number; h: number }
export interface OcrWord { text: string; confidence?: number; box?: OcrBox; page: number }
export interface OcrOutput {
  text: string;
  words: OcrWord[];
  pages: { width: number; height: number }[];
}

// ---------- Dates ----------

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_RE = '(?:JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUNE?|JULY?|AUG(?:UST)?|SEPT?(?:EMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)';
export const DATE_PATTERN = new RegExp(
  `(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.\\-]\\d{1,2}[/.\\-](?:\\d{4}|\\d{2})|\\d{1,2}[\\s\\-]+${MONTH_RE}\\.?[\\s\\-,]+(?:\\d{4}|\\d{2}))`,
  'gi',
);

function validIso(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const fullYear = (y: number) => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

/** A printed Australian-style date (day first) as YYYY-MM-DD, or null. */
export function parseDate(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return validIso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})$/.exec(s);
  if (m) return validIso(fullYear(+m[3]), +m[2], +m[1]);
  m = new RegExp(`^(\\d{1,2})[\\s\\-]+(${MONTH_RE})\\.?[\\s\\-,]+(\\d{4}|\\d{2})$`).exec(s);
  if (m) return validIso(fullYear(+m[3]), MONTHS.indexOf(m[2].slice(0, 3)) + 1, +m[1]);
  return null;
}

function datesIn(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(DATE_PATTERN)) {
    const iso = parseDate(m[1]);
    if (iso) out.push(iso);
  }
  return out;
}

// ---------- Text helpers ----------

const lines = (text: string) => text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

/** Upper-case letters and digits only, for comparisons. */
export const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

interface Found { value: string; line: number }

/**
 * A value printed after a label, on the same line or the next one or two lines.
 * `value` must match the whole cleaned candidate (or its start, when `prefix` is true).
 */
function labelled(ls: string[], label: RegExp, value: RegExp, opts: { lookahead?: number } = {}): Found | null {
  for (let i = 0; i < ls.length; i++) {
    const m = label.exec(ls[i]);
    if (!m) continue;
    const rest = ls[i].slice((m.index ?? 0) + m[0].length).replace(/^[\s:#.\-–]+/, '');
    const candidates = [rest, ...ls.slice(i + 1, i + 1 + (opts.lookahead ?? 2))];
    for (let j = 0; j < candidates.length; j++) {
      const c = candidates[j];
      if (!c || LABEL_WORD.test(c.split(' ')[0])) continue;
      const v = value.exec(c);
      if (v) return { value: (v[1] ?? v[0]).trim(), line: j === 0 ? i : i + j };
    }
  }
  return null;
}

function labelledDate(ls: string[], label: RegExp): Found | null {
  for (let i = 0; i < ls.length; i++) {
    const m = label.exec(ls[i]);
    if (!m) continue;
    const after = ls[i].slice((m.index ?? 0) + m[0].length);
    const same = datesIn(after);
    if (same.length) return { value: same[0], line: i };
    // Value printed under the label (only if that line isn't itself another labelled date).
    for (let j = i + 1; j <= Math.min(i + 2, ls.length - 1); j++) {
      const d = datesIn(ls[j]);
      if (d.length) return { value: d[0], line: j };
    }
  }
  return null;
}

const NAME_VALUE = /^((?:[A-Z][A-Z'\-]+)(?:\s+[A-Z][A-Z'\-]+){1,4})\b/;

// ---------- Position-aware lookup (cards with labels above values, in columns) ----------

interface Line { page: number; words: OcrWord[]; y: number; h: number }

function layoutLines(words: OcrWord[]): Line[] {
  const out: Line[] = [];
  const boxed = words.filter(w => w.box && w.box.h > 0).sort((a, b) => a.page - b.page || (a.box!.y + a.box!.h / 2) - (b.box!.y + b.box!.h / 2));
  for (const w of boxed) {
    const cy = w.box!.y + w.box!.h / 2;
    // Compare with the smaller height so a tall (e.g. rotated watermark) word can't swallow other lines.
    const line = out.find(l => l.page === w.page && Math.abs(l.y - cy) < Math.min(l.h, w.box!.h) * 0.6);
    if (line) line.words.push(w);
    else out.push({ page: w.page, words: [w], y: cy, h: w.box!.h });
  }
  for (const l of out) l.words.sort((a, b) => a.box!.x - b.box!.x);
  return out.sort((a, b) => a.page - b.page || a.y - b.y);
}

/** Joins OCR words back into printed text ("FA - 778899" → "FA-778899", "05 / 03" → "05/03"). */
const joinWords = (ws: OcrWord[]) => ws.map(w => w.text).join(' ').toUpperCase().replace(/\s+([.,:])/g, '$1').replace(/(\w)\s*([-/])\s*(\w)/g, '$1$2$3');

/** Words running on from `start` (gaps no wider than `gap`, similar text height: skips watermarks). */
function runFrom(ws: OcrWord[], start: number, gap: number): OcrWord[] {
  const run = [ws[start]];
  const h0 = ws[start].box!.h;
  for (let k = start + 1; k < ws.length; k++) {
    const prev = run[run.length - 1].box!, cur = ws[k].box!;
    if (cur.x - (prev.x + prev.w) > gap) break;
    if (cur.h / h0 < 0.6 || cur.h / h0 > 1.6) break;
    run.push(ws[k]);
  }
  return run;
}

/** Words that start another label: never a value. */
const LABEL_WORD = /^(CLASS|EXPIRY|EXPIRES|NAME|NUMBER|NO\.?|DATE|CHECK|TYPE|STATUS|ISSUE|ISSUED|CARD|LICEN[CS]E|DOB|NATIONALITY|VIN|PLATE|POLICY|INSURER|PERIOD)$/;

/**
 * Finds a printed label (whole words) and reads the value to its right on the same line, or the
 * value printed directly under it (left-aligned with the label, within about three line heights).
 */
function geoLookup(lines: Line[], label: RegExp, accept: (s: string) => string | null): { value: string; raw: string } | null {
  const anchored = new RegExp(`^(?:${label.source})$`);
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    for (let i = 0; i < ln.words.length; i++) {
      for (let n = 1; n <= 4 && i + n <= ln.words.length; n++) {
        const lw = ln.words.slice(i, i + n);
        const text = joinWords(lw).replace(/[:#]$/, '').trim();
        if (!anchored.test(text)) continue;
        const lr = lw[lw.length - 1].box!.x + lw[lw.length - 1].box!.w, lh = ln.h;
        // Left edge of the whole printed label ("REGISTRATION EXPIRY" when "EXPIRY" matched).
        let s = i;
        while (s > 0 && ln.words[s].box!.x - (ln.words[s - 1].box!.x + ln.words[s - 1].box!.w) < lh * 0.8) s--;
        const starts = [lw[0].box!.x, ln.words[s].box!.x];
        // Right of the label.
        const right = ln.words.slice(i + n).filter(w => w.box!.x >= lr - 2);
        if (right.length && right[0].box!.x - lr < lh * 2.5 && !LABEL_WORD.test(right[0].text.toUpperCase())) {
          const run = runFrom(right, 0, lh * 1.2);
          const raw = joinWords(run).replace(/^[:#\-]\s*/, '');
          const v = accept(raw);
          if (v) return { value: v, raw };
        }
        // Under the label.
        for (let lj = li + 1; lj < lines.length && lines[lj].page === ln.page && lines[lj].y - ln.y < lh * 3.2; lj++) {
          const below = lines[lj].words;
          const k = below.findIndex(w => starts.some(x0 => Math.abs(w.box!.x - x0) < lh * 1.5));
          if (k < 0) continue;
          if (LABEL_WORD.test(below[k].text.toUpperCase())) break; // the next label, not a value
          const run = runFrom(below, k, lines[lj].h * 1.2);
          const raw = joinWords(run);
          const v = accept(raw);
          if (v) return { value: v, raw };
          break;
        }
      }
    }
  }
  return null;
}

const regexAccept = (re: RegExp) => (s: string) => { const m = re.exec(s); return m ? (m[1] ?? m[0]).trim() : null; };
const dateAccept = (s: string) => datesIn(s)[0] ?? null;

// ---------- States and authorities ----------

export const STATE_PATTERNS: [string, RegExp][] = [
  ['NSW', /\b(NEW SOUTH WALES|NSW)\b/],
  ['VIC', /\b(VICTORIA|VIC ?ROADS|VIC)\b/],
  ['QLD', /\b(QUEENSLAND|QLD)\b/],
  ['ACT', /\b(AUSTRALIAN CAPITAL TERRITORY|ACCESS CANBERRA)\b/],
  ['SA', /\b(SOUTH AUSTRALIA)\b/],
  ['WA', /\b(WESTERN AUSTRALIA)\b/],
  ['TAS', /\b(TASMANIA)\b/],
  ['NT', /\b(NORTHERN TERRITORY)\b/],
];

const AUTHORITIES = [
  'TRANSPORT FOR NSW', 'SERVICE NSW', 'ROADS AND MARITIME SERVICES', 'VICROADS', 'DEPARTMENT OF TRANSPORT AND PLANNING',
  'DEPARTMENT OF TRANSPORT AND MAIN ROADS', 'ACCESS CANBERRA', 'DEPARTMENT FOR INFRASTRUCTURE AND TRANSPORT',
  'DEPARTMENT OF TRANSPORT', 'OFFICE OF THE CHILDREN\'S GUARDIAN', 'OFFICE OF THE CHILDRENS GUARDIAN', 'BLUE CARD SERVICES',
  'WORKING WITH CHILDREN CHECK VICTORIA', 'SERVICE VICTORIA', 'DEPARTMENT OF HUMAN SERVICES', 'SCREENING UNIT',
  'AUSTRALIAN PASSPORT OFFICE', 'DEPARTMENT OF FOREIGN AFFAIRS AND TRADE',
];

// ---------- Type detection ----------

const TYPE_SIGNALS: Record<DocTypeKey, [RegExp, number][]> = {
  wwc: [[/WORKING WITH CHILDREN/, 6], [/\bWWCC?\b/, 4], [/BLUE CARD/, 5], [/CHILDREN'?S GUARDIAN/, 3], [/WORKING WITH VULNERABLE/, 4], [/\bWWC\d{7}[A-Z]\b/, 4]],
  instructorLicence: [[/DRIVING INSTRUCTOR/, 6], [/INSTRUCTOR('S)? (LICEN[CS]E|ACCREDITATION|AUTHORITY)/, 6], [/ACCREDITED (DRIVING )?INSTRUCTOR/, 6], [/DRIVER TRAINER/, 4], [/\bADI\b/, 2]],
  driverLicence: [[/DRIVER'?S? LICEN[CS]E/, 5], [/LICEN[CS]E (NO|NUMBER)/, 2], [/\bCLASS\s*:?\s*(C|R|RE|LR|MR|HR|HC|MC|CA)\b/, 3], [/PROVISIONAL|LEARNER LICEN/, 2], [/CARD NUMBER/, 1], [/DATE OF BIRTH|\bDOB\b/, 1]],
  vehicleRego: [[/CERTIFICATE OF REGISTRATION|REGISTRATION CERTIFICATE/, 6], [/REGISTERED OPERATOR/, 5], [/\bVIN\b/, 3], [/PLATE (NO|NUMBER)/, 3], [/REGISTRATION EXPIRY/, 2]],
  firstAid: [[/FIRST AID/, 6], [/HLTAID\d{3}/, 6], [/\bCPR\b|CARDIOPULMONARY/, 3], [/STATEMENT OF ATTAINMENT/, 2]],
  insurance: [[/CERTIFICATE OF CURRENCY/, 6], [/POLICY (NO|NUMBER)/, 4], [/\bINSURED\b|INSURER|UNDERWRIT/, 3], [/PUBLIC LIABILITY|PROFESSIONAL INDEMNITY/, 3], [/PERIOD OF INSURANCE|SUM INSURED|LIMIT OF (LIABILITY|INDEMNITY)/, 3]],
  identity: [[/\bPASSPORT\b/, 6], [/PROOF OF AGE|PHOTO CARD|IDENTITY CARD/, 5], [/NATIONALITY|PLACE OF BIRTH/, 3]],
  other: [],
};

export interface TypeGuess {
  type: DocTypeKey | null;
  /** 'confident' only when one type clearly leads. */
  certainty: 'confident' | 'uncertain';
  scores: Partial<Record<DocTypeKey, number>>;
}

export function detectType(text: string): TypeGuess {
  const u = text.toUpperCase();
  const scores: Partial<Record<DocTypeKey, number>> = {};
  for (const [type, signals] of Object.entries(TYPE_SIGNALS) as [DocTypeKey, [RegExp, number][]][]) {
    const s = signals.reduce((sum, [re, w]) => sum + (re.test(u) ? w : 0), 0);
    if (s > 0) scores[type] = s;
  }
  // An instructor licence also says "licence"; don't let the driver-licence signals win on that alone.
  if ((scores.instructorLicence ?? 0) >= 6 && scores.driverLicence) scores.driverLicence = Math.max(0, scores.driverLicence - 3);
  const ranked = (Object.entries(scores) as [DocTypeKey, number][]).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top || top[1] < 5) return { type: top?.[0] ?? null, certainty: 'uncertain', scores };
  const confident = !second || top[1] - second[1] >= 3;
  return { type: top[0], certainty: confident ? 'confident' : 'uncertain', scores };
}

// ---------- Field extraction ----------

export interface ExtractedField {
  value: string;
  /** How it was found: next to a printed label, or by its printed pattern. */
  method: 'label' | 'pattern';
  /** Average OCR reading confidence of the words that make up the value (0–1), when OCR reported it. */
  confidence: number | null;
  band: ConfidenceBand;
  page: number | null;
}

export type ExtractedFields = Record<string, ExtractedField>;

const NUMBER_LABEL: Partial<Record<DocTypeKey, RegExp>> = {
  driverLicence: /LICEN[CS]E\s*(NO|NUMBER|#)\b\.?/,
  instructorLicence: /(LICEN[CS]E|ACCREDITATION|AUTHORITY|CERTIFICATE|INSTRUCTOR)\s*(NO|NUMBER|ID)\b\.?/,
  wwc: /(WWCC?|CHECK|CLEARANCE|CARD|REFERENCE|BLUE CARD)\s*(NO|NUMBER|ID)\b\.?/,
  firstAid: /(CERTIFICATE|STATEMENT|CERT)\s*(NO|NUMBER|ID)\b\.?/,
  insurance: /POLICY\s*(NO|NUMBER)\b\.?/,
  identity: /(PASSPORT|DOCUMENT|CARD)\s*(NO|NUMBER)\b\.?/,
  other: /(NO|NUMBER|REFERENCE)\b\.?/,
};
const NUMBER_VALUE = /^([A-Z0-9][A-Z0-9\-/]{3,19})\b/;

const NAME_LABEL: Partial<Record<DocTypeKey, RegExp>> = {
  insurance: /(NAME OF INSURED|THE INSURED|INSURED NAME|INSURED|POLICY ?HOLDER)\b/,
  vehicleRego: /(REGISTERED OPERATOR|OPERATOR|OWNER)\b/,
};
const GENERIC_NAME_LABEL = /(FULL NAME|SURNAME AND GIVEN NAMES|CARD ?HOLDER|LICEN[CS]E HOLDER|HOLDER NAME|AWARDED TO|PRESENTED TO|CERTIFY THAT|\bNAME)\b/;

const LABELS = {
  expiry: /(EXPIRY DATE|DATE OF EXPIRY|EXPIRY|EXPIRES ON|EXPIRES|EXPIRATION|VALID UNTIL|VALID TO|VALID THRU|END DATE|RENEWAL DATE|\bEXP\b)/,
  issue: /(DATE OF ISSUE|ISSUE DATE|DATE ISSUED|ISSUED ON|ISSUED|COMPLETION DATE|DATE OF COMPLETION|DATE ATTAINED|EFFECTIVE DATE)/,
  dob: /(DATE OF BIRTH|BIRTH DATE|\bD\.?O\.?B\b)/,
  start: /(START DATE|COVER (START|FROM)|INCEPTION DATE|EFFECTIVE FROM)/,
};

function findAuthority(u: string): string | null {
  const hit = AUTHORITIES.find(a => u.includes(a));
  if (hit) return hit;
  const m = /(ISSUED BY|ISSUING AUTHORITY)\s*:?\s*([A-Z][A-Z '&\-]{3,60})/.exec(u);
  return m ? m[2].trim() : null;
}

/** Average OCR confidence of the words that spell `value`, and the page they're on. */
export function confidenceOf(value: string, words: OcrWord[]): { confidence: number | null; page: number | null } {
  const tokens = value.toUpperCase().split(/[\s/]+/).map(squash).filter(Boolean);
  if (!tokens.length || !words.length) return { confidence: null, page: null };
  const confs: number[] = [];
  let page: number | null = null;
  for (const t of tokens) {
    const w = words.find(x => squash(x.text) === t) ?? words.find(x => t.length > 3 && squash(x.text).includes(t));
    if (w) {
      if (typeof w.confidence === 'number') confs.push(w.confidence);
      page ??= w.page;
    }
  }
  return { confidence: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 1000) / 1000 : null, page };
}

/** Extracts the fields a document type is expected to show. Absent fields are simply left out. */
export function extractFields(type: DocTypeKey, ocr: Pick<OcrOutput, 'text' | 'words'>): ExtractedFields {
  const u = ocr.text.toUpperCase();
  const ls = lines(u);
  const geo = layoutLines(ocr.words);
  const raw: Record<string, { value: string; method: 'label' | 'pattern'; printed: string }> = {};
  type Hit = { value: string; printed: string } | null;
  const put = (k: string, f: Hit | string | null, method: 'label' | 'pattern' = 'label') => {
    if (!f) return;
    const value = typeof f === 'string' ? f : f.value;
    const printed = typeof f === 'string' ? f : f.printed;
    if (value) raw[k] = { value, method, printed };
  };
  /** A labelled value: by position first (cards), then by text lines. */
  const find = (label: RegExp, value: RegExp): Hit => {
    const g = geoLookup(geo, label, regexAccept(value));
    if (g) return { value: g.value, printed: g.value };
    const t = labelled(ls, label, value);
    return t ? { value: t.value, printed: t.value } : null;
  };
  const findDate = (label: RegExp): Hit => {
    const g = geoLookup(geo, label, dateAccept);
    if (g) return { value: g.value, printed: (g.raw.match(DATE_PATTERN) ?? [g.raw])[0] };
    const t = labelledDate(ls, label);
    return t ? { value: t.value, printed: '' } : null;
  };

  // Names
  const nameLabel = NAME_LABEL[type];
  const name = (nameLabel ? find(nameLabel, NAME_VALUE) : null) ?? find(GENERIC_NAME_LABEL, NAME_VALUE);
  const nameKey = type === 'insurance' ? 'insuredName' : type === 'vehicleRego' ? 'ownerName' : 'fullName';
  put(nameKey, name);

  // Dates
  put('expiryDate', findDate(LABELS.expiry));
  if (['instructorLicence', 'wwc', 'firstAid', 'other'].includes(type)) put('issueDate', findDate(LABELS.issue));
  if (['driverLicence', 'identity'].includes(type)) put('dateOfBirth', findDate(LABELS.dob));

  // Numbers
  if (type === 'wwc') {
    const nsw = /\b(WWC\d{7}[A-Z])\b/.exec(u.replace(/WWC\s+(\d)/g, 'WWC$1'));
    if (nsw) put('number', nsw[1], 'pattern');
  }
  if (type === 'identity') put('number', find(/PASSPORT\s*(NO|NUMBER)\b\.?/, /^([A-Z]{1,2}\d{6,8})\b/));
  if (!raw.number && NUMBER_LABEL[type]) put('number', find(NUMBER_LABEL[type]!, NUMBER_VALUE));

  switch (type) {
    case 'driverLicence': {
      const cls = find(/(LICEN[CS]E )?CLASS/, /^((?:C|R|RE|LR|MR|HR|HC|MC|CA)(?:\s*,\s*(?:C|R|RE|LR|MR|HR|HC|MC|CA))*)\b/);
      if (cls) put('licenceClass', { value: cls.value.replace(/\s+/g, ''), printed: cls.printed });
      put('cardNumber', find(/CARD\s*(NO|NUMBER)\b\.?/, /^(\d{3,4}(?:\s?\d{3}){2,3}|[A-Z0-9]{6,12})\b/));
      break;
    }
    case 'instructorLicence': {
      const t = /(ACCREDITED DRIVING INSTRUCTOR|DRIVING INSTRUCTOR LICEN[CS]E|DRIVING INSTRUCTOR AUTHORITY|DRIVER TRAINER|DRIVING INSTRUCTOR)/.exec(u);
      if (t) put('accreditationType', t[1], 'pattern');
      put('issuingAuthority', findAuthority(u), 'pattern');
      break;
    }
    case 'wwc': {
      const t = /\b(EMPLOYEE|VOLUNTEER|PAID|UNPAID|NON-?PAID|EMPLOYMENT)\b/.exec(u);
      if (t) put('checkType', t[1], 'pattern');
      put('issuingAuthority', findAuthority(u), 'pattern');
      const st = find(/STATUS/, /^(CLEARED|CURRENT|VALID|ACTIVE|NOT CLEARED|BARRED|EXPIRED)\b/) ?? (/\bCLEARED\b/.test(u) ? 'CLEARED' : null);
      put('checkStatus', st, typeof st === 'string' ? 'pattern' : 'label');
      break;
    }
    case 'vehicleRego': {
      put('plate', find(/(PLATE\s*(NO|NUMBER)?|REGISTRATION\s*(NO|NUMBER))\b\.?/, /^([A-Z0-9]{2,8})\b/));
      put('vin', find(/VIN/, /^([A-HJ-NPR-Z0-9]{17})\b/));
      break;
    }
    case 'firstAid': {
      const q = /\b(HLTAID\d{3}[A-Z ,\-]*)/.exec(u);
      if (q) put('qualification', q[1].trim(), 'pattern');
      else put('qualification', find(/(QUALIFICATION|UNIT OF COMPETENCY|COURSE)\b/, /^([A-Z0-9][A-Z0-9 ,\-]{4,80})$/));
      put('trainingProvider', find(/(TRAINING (PROVIDER|ORGANISATION)|REGISTERED TRAINING ORGANISATION|PROVIDER|ISSUED BY)\b/, /^([A-Z0-9][A-Z0-9 &'\-.]{2,80})$/));
      break;
    }
    case 'insurance': {
      put('insurer', find(/(INSURER|UNDERWRITTEN BY|UNDERWRITER|INSURANCE COMPANY)\b/, /^([A-Z0-9][A-Z0-9 &'\-.]{2,80})$/));
      const ct = find(/(TYPE OF COVER|COVER TYPE|POLICY TYPE|CLASS OF INSURANCE)\b/, /^([A-Z][A-Z &'\-]{2,60})$/)
        ?? (/(PUBLIC LIABILITY|PROFESSIONAL INDEMNITY|MOTOR VEHICLE|COMPREHENSIVE|THIRD PARTY PROPERTY)/.exec(u)?.[1] ?? null);
      put('coverType', ct, typeof ct === 'string' ? 'pattern' : 'label');
      put('coverDetails', find(/(LIMIT OF (LIABILITY|INDEMNITY)|SUM INSURED)\b/, /^([$A-Z0-9][$A-Z0-9 ,.\-]{1,60})$/));
      // "Period of insurance: 01/07/2026 to 01/07/2027"
      const period = ls.find(l => /PERIOD OF (INSURANCE|COVER)|POLICY PERIOD/.test(l));
      const pd = period ? [...period.matchAll(DATE_PATTERN)].map(m => ({ iso: parseDate(m[1]), printed: m[1] })).filter(d => d.iso) : [];
      if (pd.length >= 2) {
        put('startDate', { value: pd[0].iso!, printed: pd[0].printed });
        if (!raw.expiryDate) put('expiryDate', { value: pd[1].iso!, printed: pd[1].printed });
      } else put('startDate', findDate(LABELS.start));
      break;
    }
    case 'identity':
      put('issuingAuthority', findAuthority(u), 'pattern');
      break;
    default:
      break;
  }

  if (docType(type)?.needsState || type === 'vehicleRego') {
    const st = STATE_PATTERNS.find(([, re]) => re.test(u));
    if (st) put('state', { value: st[0], printed: st[1].exec(u)![0] }, 'pattern');
  }

  const out: ExtractedFields = {};
  for (const [k, v] of Object.entries(raw)) {
    const { confidence, page } = confidenceOf(v.printed || v.value, ocr.words);
    out[k] = { value: v.value, method: v.method, confidence, band: confidenceBand(confidence), page };
  }
  return out;
}

/** Fields this type should show that weren't found (only those a person can act on). */
export function missingFields(type: DocTypeKey, fields: ExtractedFields): string[] {
  const info = docType(type);
  if (!info) return [];
  const nameKey = type === 'insurance' ? 'insuredName' : type === 'vehicleRego' ? 'ownerName' : 'fullName';
  const need = [nameKey, ...(type === 'vehicleRego' ? ['plate'] : ['number']), ...(info.expiryRequired ? ['expiryDate'] : [])];
  return need.filter(f => !fields[f]);
}

// ---------- Profile comparison ----------

export type MatchStatus = 'match' | 'mismatch' | 'missing' | 'review';
export interface ComparisonRow { field: string; label: string; profile: string | null; document: string | null; status: MatchStatus; note?: string }

const nameTokens = (s: string) => s.toUpperCase().replace(/[^A-Z\s'\-]/g, ' ').split(/[\s\-']+/).filter(t => t.length > 1);

/** Name match tolerant of middle names, order and punctuation; one shared name only = review. */
export function compareNames(profile: string, document: string): MatchStatus {
  const p = nameTokens(profile);
  const d = new Set(nameTokens(document));
  if (!p.length || !d.size) return 'missing';
  const first = p[0], last = p[p.length - 1];
  if (d.has(first) && d.has(last)) return 'match';
  if (d.has(last) || d.has(first)) return 'review';
  return 'mismatch';
}

export interface CompareInput {
  type: DocTypeKey;
  fields: ExtractedFields;
  profile: { name: string; dateOfBirth?: string | null };
  /** What the instructor typed when uploading. */
  entered: { number?: string | null; expiry?: string | null; state?: string | null };
  /** The last verified version of this document, if any. */
  previous?: { number?: string | null; expiry?: string | null } | null;
}

export function compareWithProfile(i: CompareInput): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  const f = i.fields;
  const docName = (f.fullName ?? f.insuredName ?? f.ownerName)?.value ?? null;
  // An insurance certificate may be in a business name: a mismatch there is for review, not a red flag.
  const nameStatus = docName ? compareNames(i.profile.name, docName) : 'missing';
  rows.push({ field: 'name', label: 'Name', profile: i.profile.name || null, document: docName,
    status: nameStatus === 'mismatch' && (i.type === 'insurance' || i.type === 'vehicleRego') ? 'review' : nameStatus,
    note: nameStatus === 'mismatch' && i.type === 'insurance' ? 'May be insured under a business name' : undefined });

  if (i.type === 'driverLicence' || i.type === 'identity') {
    const d = f.dateOfBirth?.value ?? null;
    const p = i.profile.dateOfBirth ?? null;
    rows.push({ field: 'dateOfBirth', label: 'Date of birth', profile: p, document: d,
      status: !d ? 'missing' : !p ? 'review' : d === p ? 'match' : 'mismatch', note: !p && d ? 'No date of birth on the profile' : undefined });
  }

  const num = (i.type === 'vehicleRego' ? f.plate : f.number)?.value ?? null;
  if (i.entered.number || num) {
    rows.push({ field: 'number', label: i.type === 'vehicleRego' ? 'Plate number' : 'Document number', profile: i.entered.number ?? null, document: num,
      status: !num ? 'missing' : !i.entered.number ? 'review' : squash(num) === squash(i.entered.number) ? 'match' : 'mismatch',
      note: 'Profile value = what the instructor typed' });
  }
  if (i.previous?.number && num && squash(i.previous.number) !== squash(num)) {
    rows.push({ field: 'previousNumber', label: 'Number vs previous verified', profile: i.previous.number, document: num, status: 'review', note: 'Different from the last verified version' });
  }

  const exp = f.expiryDate?.value ?? null;
  if (i.entered.expiry || exp) {
    rows.push({ field: 'expiryDate', label: 'Expiry date', profile: i.entered.expiry ?? null, document: exp,
      status: !exp ? 'missing' : !i.entered.expiry ? 'review' : exp === i.entered.expiry ? 'match' : 'mismatch',
      note: 'Profile value = what the instructor typed' });
  }
  if (i.entered.state && f.state) {
    rows.push({ field: 'state', label: 'State', profile: i.entered.state, document: f.state.value, status: f.state.value === i.entered.state ? 'match' : 'mismatch' });
  }
  return rows;
}

// ---------- Text-level warning signs ----------

export interface RiskFlag { code: string; severity: 'info' | 'warning' | 'high'; message: string }

/** Conservative format checks: only flags values clearly unlike any normal document number. */
export function numberFormatIssue(type: DocTypeKey, number: string, state?: string | null): string | null {
  const n = squash(number);
  if (n.length < 4 || n.length > 20) return 'Document number length is unusual';
  if (type === 'wwc' && state === 'NSW' && !/^WWC\d{7}[A-Z]$/.test(n)) return 'NSW Working With Children Check numbers look like WWC1234567A';
  if (type === 'driverLicence' && !/\d/.test(n)) return 'Licence number has no digits';
  return null;
}

export interface RiskInput {
  type: DocTypeKey;
  fields: ExtractedFields;
  words: OcrWord[];
  previous?: { number?: string | null; expiry?: string | null; issueDate?: string | null } | null;
  today: string;
}

export function textRiskFlags(i: RiskInput): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const f = i.fields;
  const num = f.number?.value;
  if (num) {
    const issue = numberFormatIssue(i.type, num, f.state?.value);
    if (issue) flags.push({ code: 'number_format', severity: 'warning', message: issue });
  }
  const exp = f.expiryDate?.value, iss = f.issueDate?.value ?? f.startDate?.value, dob = f.dateOfBirth?.value;
  if (exp && iss && exp <= iss) flags.push({ code: 'dates_inconsistent', severity: 'high', message: 'Expiry date is not after the issue date' });
  if (exp && Number(exp.slice(0, 4)) - Number(i.today.slice(0, 4)) > 10) flags.push({ code: 'expiry_far', severity: 'warning', message: 'Expiry is more than 10 years away' });
  if (dob) {
    const age = Number(i.today.slice(0, 4)) - Number(dob.slice(0, 4));
    if (dob > i.today || age < 16 || age > 100) flags.push({ code: 'dob_implausible', severity: 'warning', message: 'Date of birth looks implausible for an instructor' });
  }
  if (i.previous?.number && num && squash(i.previous.number) === squash(num)) {
    if (exp && i.previous.expiry && exp < i.previous.expiry) flags.push({ code: 'expiry_earlier', severity: 'warning', message: 'Same number as the previous verified document, but an earlier expiry date' });
    if (exp && i.previous.expiry && exp !== i.previous.expiry && iss && i.previous.issueDate && iss === i.previous.issueDate) {
      flags.push({ code: 'expiry_changed', severity: 'high', message: 'Expiry changed while the number and issue date stayed the same' });
    }
  }
  // Text size of the expiry date compared with the rest of its page.
  if (exp && f.expiryDate) {
    const page = f.expiryDate.page ?? 0;
    const pageWords = i.words.filter(w => w.page === page && w.box && /[A-Z0-9]/i.test(w.text) && w.text.length >= 2);
    const heights = pageWords.map(w => w.box!.h).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    const raw = i.words.filter(w => w.page === page && w.box && parseDate(w.text) === exp);
    if (median && raw.length && heights.length >= 8) {
      const ratio = raw[0].box!.h / median;
      if (ratio < 0.6 || ratio > 1.7) flags.push({ code: 'text_size', severity: 'warning', message: 'Expiry date is printed at a noticeably different size from the surrounding text' });
    }
  }
  return flags;
}

export const DOC_TYPE_OPTIONS = DOC_TYPES.map(t => ({ value: t.key, label: t.label }));
