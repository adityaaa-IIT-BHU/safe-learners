// OCR provider: sends one document to the configured OCR service and returns its text and words.
// The service address comes from OCR_ENDPOINT (server environment only); credentials come from the
// functions runtime's service account. Nothing here is reachable from the browser. Another provider
// can be added by implementing OcrProvider and selecting it in ocrProvider().
import { applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { OcrBox, OcrOutput, OcrWord } from '../../../shared/docExtract';

export interface OcrRead extends OcrOutput {
  /** Pages read (billable units). */
  units: number;
  /** Total pages in the file (PDFs), when known. */
  pageCount: number;
}

export class OcrError extends Error {
  readonly retryable: boolean;
  readonly code: string;
  constructor(message: string, retryable: boolean, code = 'ocr_failed') {
    super(message);
    this.retryable = retryable;
    this.code = code;
  }
}

export interface OcrProvider {
  read(file: Buffer, contentType: string, opts: { maxPages: number; pageCount?: number }): Promise<OcrRead>;
}

/** Test hook (local emulator only): make the next N OCR calls fail. Stored in the database because
 * the emulator runs each function in its own process. */
const HOOK = 'testHooks/ocr';
export async function failNextOcrCalls(n: number) {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return;
  await getFirestore().doc(HOOK).set({ failNext: Math.max(0, n) });
}
async function simulatedFailure(): Promise<boolean> {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return false;
  const db = getFirestore();
  return db.runTransaction(async tx => {
    const n = Number((await tx.get(db.doc(HOOK))).data()?.failNext ?? 0);
    if (n <= 0) return false;
    tx.set(db.doc(HOOK), { failNext: n - 1 });
    return true;
  });
}

const PDF_BATCH = 5;

function boxOf(bp: any, width: number, height: number): OcrBox | undefined {
  const v = bp?.vertices?.length ? bp.vertices : bp?.normalizedVertices?.map((p: any) => ({ x: (p.x ?? 0) * width, y: (p.y ?? 0) * height }));
  if (!v?.length) return undefined;
  const xs = v.map((p: any) => p.x ?? 0), ys = v.map((p: any) => p.y ?? 0);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Reads the service's full-text structure into plain text plus words with confidence and position. */
function parseAnnotation(ann: any, pageIndex: number, out: { text: string[]; words: OcrWord[]; pages: OcrOutput['pages'] }) {
  if (!ann) return;
  out.text.push(String(ann.text ?? ''));
  for (const p of ann.pages ?? []) {
    const width = Number(p.width) || 1, height = Number(p.height) || 1;
    const page = out.pages.length;
    out.pages.push({ width, height });
    for (const b of p.blocks ?? []) for (const para of b.paragraphs ?? []) for (const w of para.words ?? []) {
      const text = (w.symbols ?? []).map((s: any) => s.text ?? '').join('');
      if (!text) continue;
      out.words.push({ text, confidence: typeof w.confidence === 'number' ? w.confidence : undefined, box: boxOf(w.boundingBox, width, height), page });
    }
  }
  void pageIndex;
}

class HttpOcrProvider implements OcrProvider {
  private endpoint: string;
  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  private async post(path: string, body: unknown): Promise<any> {
    if (await simulatedFailure()) throw new OcrError('Simulated OCR failure (test)', true, 'simulated');
    let token: string;
    try {
      token = (await applicationDefault().getAccessToken()).access_token;
    } catch (err) {
      throw new OcrError('OCR credentials are not available', false, 'credentials');
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (process.env.OCR_QUOTA_PROJECT) headers['x-goog-user-project'] = process.env.OCR_QUOTA_PROJECT;
    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    } catch (err) {
      throw new OcrError('OCR service could not be reached', true, 'network');
    }
    if (!res.ok) {
      // Never log the request or response body: it can contain document text.
      throw new OcrError(`OCR service error (HTTP ${res.status})`, res.status === 429 || res.status >= 500, `http_${res.status}`);
    }
    return res.json();
  }

  async read(file: Buffer, contentType: string, opts: { maxPages: number; pageCount?: number }): Promise<OcrRead> {
    const out = { text: [] as string[], words: [] as OcrWord[], pages: [] as OcrOutput['pages'] };
    const feature = [{ type: 'DOCUMENT_TEXT_DETECTION' }];
    if (contentType === 'application/pdf') {
      const total = Math.max(1, Math.min(opts.pageCount ?? opts.maxPages, opts.maxPages));
      let units = 0;
      for (let start = 1; start <= total; start += PDF_BATCH) {
        const pages = Array.from({ length: Math.min(PDF_BATCH, total - start + 1) }, (_, i) => start + i);
        const json = await this.post('files:annotate', {
          requests: [{ inputConfig: { content: file.toString('base64'), mimeType: 'application/pdf' }, features: feature, pages }],
        });
        const r = json?.responses?.[0];
        if (r?.error) throw new OcrError('OCR could not read this file', false, 'unreadable');
        for (const [i, pr] of (r?.responses ?? []).entries()) {
          if (pr?.error) continue;
          parseAnnotation(pr?.fullTextAnnotation, start + i - 1, out);
          units++;
        }
        if (r?.totalPages && start + PDF_BATCH > r.totalPages) break;
      }
      return { text: out.text.join('\n'), words: out.words, pages: out.pages, units, pageCount: opts.pageCount ?? units };
    }
    const json = await this.post('images:annotate', {
      requests: [{ image: { content: file.toString('base64') }, features: feature, imageContext: { languageHints: ['en'] } }],
    });
    const r = json?.responses?.[0];
    if (r?.error) throw new OcrError('OCR could not read this image', false, 'unreadable');
    parseAnnotation(r?.fullTextAnnotation, 0, out);
    return { text: out.text.join('\n'), words: out.words, pages: out.pages, units: 1, pageCount: 1 };
  }
}

/** The configured provider, or null when OCR isn't configured for this environment. */
export function ocrProvider(): OcrProvider | null {
  const endpoint = (process.env.OCR_ENDPOINT || '').replace(/\/+$/, '');
  return endpoint ? new HttpOcrProvider(endpoint) : null;
}
