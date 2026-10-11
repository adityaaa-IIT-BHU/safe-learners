// Pulls the licence/registration number, expiry date and state out of OCR text from a document photo.
// Australian documents vary a lot by state, so this looks for labelled values first and falls back
// to shape-based guesses. Results are only ever suggestions the instructor confirms.
import { normaliseExpiry, type VerificationStepKey } from './domain';

export interface ScanResult {
  number?: string;
  expiry?: string; // YYYY-MM-DD
  state?: string;
}

const STATE_PATTERNS: [string, RegExp][] = [
  ['NSW', /\b(NEW SOUTH WALES|NSW)\b/i],
  ['VIC', /\b(VICTORIA|VIC ?ROADS|VIC)\b/i],
  ['QLD', /\b(QUEENSLAND|QLD)\b/i],
  ['ACT', /\b(AUSTRALIAN CAPITAL TERRITORY|ACT)\b/],
  ['SA', /\b(SOUTH AUSTRALIA)\b/i],
  ['WA', /\b(WESTERN AUSTRALIA)\b/i],
  ['TAS', /\b(TASMANIA|TAS)\b/i],
  ['NT', /\b(NORTHERN TERRITORY)\b/i],
];

const MONTH = '(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)[A-Z]*';
const DATE_RE = new RegExp(
  `\\b(\\d{1,2}[/.\\-]\\d{1,2}[/.\\-](?:\\d{4}|\\d{2})|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s+${MONTH}\\.?\\s+(?:\\d{4}|\\d{2}))\\b`,
  'gi',
);

/** Dates in the text, normalised, with their position. */
function findDates(text: string): { iso: string; index: number }[] {
  const out: { iso: string; index: number }[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const iso = normaliseExpiry(m[1].replace(/\./g, '/'));
    if (iso) out.push({ iso, index: m.index ?? 0 });
  }
  return out;
}

function pickExpiry(text: string): string | undefined {
  const dates = findDates(text);
  if (!dates.length) return undefined;
  // Prefer a date right after an expiry label.
  const labelRe = /(expir\w*|exp\.?|valid (?:to|until)|until|due date|registration expires)/gi;
  for (const label of text.matchAll(labelRe)) {
    const after = dates.find(d => d.index >= (label.index ?? 0) && d.index - (label.index ?? 0) < 60);
    if (after) return after.iso;
  }
  // Otherwise the latest date on the card (issue dates and dates of birth are earlier).
  return dates.map(d => d.iso).sort().at(-1);
}

function afterLabel(text: string, labels: RegExp, value: RegExp): string | undefined {
  for (const label of text.matchAll(labels)) {
    const rest = text.slice((label.index ?? 0) + label[0].length, (label.index ?? 0) + label[0].length + 40);
    const m = rest.match(value);
    if (m) return m[0].replace(/\s+/g, '').toUpperCase();
  }
  return undefined;
}

export function parseDocumentText(key: VerificationStepKey, rawText: string): ScanResult {
  const text = rawText.replace(/\r/g, '');
  const result: ScanResult = {};
  result.expiry = pickExpiry(text);
  result.state = STATE_PATTERNS.find(([, re]) => re.test(text))?.[0];

  // Dates removed so their digits aren't mistaken for numbers.
  const noDates = text.replace(DATE_RE, ' ');

  if (key === 'wwc') {
    result.number = noDates.match(/\bWWC\s?\d{7}[A-Z]\b/i)?.[0].replace(/\s/g, '').toUpperCase()
      ?? afterLabel(noDates, /(check number|wwc number|card number|number)[:\s]*/gi, /[A-Z0-9-]{6,14}/i);
  } else if (key === 'vehicleRego') {
    result.number = afterLabel(noDates, /(plate number|number plate|registration number|plate|rego(?:istration)? no\.?)[:\s]*/gi, /[A-Z0-9]{2,3}\s?[A-Z0-9]{2,4}/i)
      ?? noDates.match(/\b[A-Z]{2,3}\s?\d{2,3}\s?[A-Z]{0,2}\b/)?.[0].replace(/\s/g, '');
  } else {
    result.number = afterLabel(noDates, /(licen[cs]e\s*(?:no\.?|number|#)|authority\s*(?:no\.?|number)|card\s*number)[:\s]*/gi, /[A-Z0-9]{5,12}/i)
      ?? noDates.match(/\b\d{8,10}\b/)?.[0];
  }
  return result;
}
