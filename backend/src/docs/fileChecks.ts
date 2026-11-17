// File-level checks that don't need OCR: format, corruption, password protection, image quality,
// editing-software metadata, a fingerprint for near-duplicate detection, and QR codes.
// Pure JavaScript (no native modules, no external services).
import { createHash } from 'node:crypto';
import jpeg from 'jpeg-js';
import jsQR from 'jsqr';
import { EncryptedPDFError, PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';

export type FileKind = 'jpeg' | 'png' | 'pdf' | 'unknown';

export const ALLOWED_TYPES: Record<string, FileKind> = { 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'application/pdf': 'pdf' };
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 10;

export interface QualityIssue { code: string; message: string; severity: 'blocking' | 'warning' }

export interface FileReport {
  kind: FileKind;
  sha256: string;
  size: number;
  /** Opened without error (images decoded, PDFs parsed). */
  readable: boolean;
  passwordProtected: boolean;
  pageCount: number;
  width?: number;
  height?: number;
  /** Sharpness score (higher = sharper); null for PDFs. */
  sharpness: number | null;
  /** 64-bit perceptual fingerprint (hex) for spotting resized or recompressed copies. */
  dHash: string | null;
  /** Editing software named in the file's metadata. */
  software: string | null;
  qr: string[];
  issues: QualityIssue[];
}

export function sniff(buf: Buffer): FileKind {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return 'unknown';
}

const EDITORS = /(Adobe Photoshop|Photoshop|GIMP|Picsart|Snapseed|Pixlr|Canva|Affinity Photo|Lightroom|Paint\.NET|PhotoDirector|Fotor|Illustrator)/i;

/** Editing software named in image metadata (EXIF/XMP/PNG text chunks), searched as plain text. */
function imageSoftware(buf: Buffer): string | null {
  const head = buf.subarray(0, Math.min(buf.length, 256 * 1024)).toString('latin1');
  return EDITORS.exec(head)?.[1] ?? null;
}

interface Gray { w: number; h: number; px: Float32Array }

function toGray(rgba: Uint8Array | Buffer, w: number, h: number, maxSide: number): Gray {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const gw = Math.max(1, Math.round(w * scale)), gh = Math.max(1, Math.round(h * scale));
  const px = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < gw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const i = (sy * w + sx) * 4;
      px[y * gw + x] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
  }
  return { w: gw, h: gh, px };
}

/** Variance of the Laplacian: a standard sharpness measure (blurry images score low). */
function sharpness(g: Gray): number {
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < g.h - 1; y++) for (let x = 1; x < g.w - 1; x++) {
    const i = y * g.w + x;
    const v = 4 * g.px[i] - g.px[i - 1] - g.px[i + 1] - g.px[i - g.w] - g.px[i + g.w];
    sum += v; sq += v * v; n++;
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.round(sq / n - mean * mean);
}

/** Share of the image in blown-out (near-white) patches, when the document itself isn't white. */
function glare(g: Gray): number {
  const cells = 12;
  const cw = Math.floor(g.w / cells), ch = Math.floor(g.h / cells);
  if (cw < 2 || ch < 2) return 0;
  const means: number[] = [], white: number[] = [];
  for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) {
    let s = 0, wcount = 0, n = 0;
    for (let y = cy * ch; y < (cy + 1) * ch; y++) for (let x = cx * cw; x < (cx + 1) * cw; x++) {
      const v = g.px[y * g.w + x];
      s += v; n++; if (v >= 252) wcount++;
    }
    means.push(s / n); white.push(wcount / n);
  }
  const sorted = [...means].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median >= 246) return 0; // a white page: bright everywhere is normal
  return white.filter(f => f > 0.97).length / white.length;
}

/** Difference hash (9×8 grayscale): similar images give fingerprints a few bits apart. */
function dHash(g: Gray): string {
  const W = 9, H = 8;
  const cell = (x: number, y: number) => {
    const x0 = Math.floor((x * g.w) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * g.w) / W));
    const y0 = Math.floor((y * g.h) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * g.h) / H));
    let s = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += g.px[yy * g.w + xx]; n++; }
    return s / n;
  };
  let bits = '';
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) bits += cell(x, y) > cell(x + 1, y) ? '1' : '0';
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

export function hammingHex(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

function decodeImage(buf: Buffer, kind: FileKind): { data: Uint8Array | Buffer; width: number; height: number } {
  if (kind === 'jpeg') {
    const d = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 600, formatAsRGBA: true });
    return { data: d.data, width: d.width, height: d.height };
  }
  const p = PNG.sync.read(buf);
  return { data: p.data, width: p.width, height: p.height };
}

function readQr(img: { data: Uint8Array | Buffer; width: number; height: number }): string[] {
  try {
    const max = 1400;
    let { data, width, height } = img;
    if (Math.max(width, height) > max) {
      const s = max / Math.max(width, height);
      const w2 = Math.round(width * s), h2 = Math.round(height * s);
      const out = new Uint8ClampedArray(w2 * h2 * 4);
      for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
        const si = (Math.min(height - 1, Math.floor(y / s)) * width + Math.min(width - 1, Math.floor(x / s))) * 4;
        out.set(data.subarray(si, si + 4), (y * w2 + x) * 4);
      }
      const code = jsQR(out, w2, h2);
      return code?.data ? [code.data] : [];
    }
    const code = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width, height);
    return code?.data ? [code.data] : [];
  } catch {
    return [];
  }
}

/** Thresholds (tuned on test documents; conservative so clear photos are never flagged). */
export const QUALITY = { minSide: 600, blurBelow: 60, glareAbove: 0.04 };

export async function inspectFile(buf: Buffer, declaredType: string, opts: { analyseImage: boolean }): Promise<FileReport> {
  const kind = sniff(buf);
  const report: FileReport = {
    kind, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length,
    readable: false, passwordProtected: false, pageCount: 0, sharpness: null, dHash: null, software: null, qr: [], issues: [],
  };
  const declared = ALLOWED_TYPES[declaredType];
  if (!declared || kind === 'unknown') {
    report.issues.push({ code: 'unsupported', severity: 'blocking', message: 'This file type isn’t supported. Please upload a JPG, PNG or PDF.' });
    return report;
  }
  if (declared !== kind) {
    report.issues.push({ code: 'type_mismatch', severity: 'blocking', message: 'The file doesn’t match its type. Please upload the original JPG, PNG or PDF.' });
    return report;
  }
  if (buf.length > MAX_FILE_BYTES) {
    report.issues.push({ code: 'too_large', severity: 'blocking', message: 'The file is larger than 10 MB.' });
    return report;
  }

  if (kind === 'pdf') {
    try {
      const doc = await PDFDocument.load(buf, { updateMetadata: false });
      report.readable = true;
      report.pageCount = doc.getPageCount();
      const meta = `${doc.getProducer() ?? ''} ${doc.getCreator() ?? ''}`;
      report.software = EDITORS.exec(meta)?.[1] ?? null;
      if (report.pageCount === 0) report.issues.push({ code: 'empty', severity: 'blocking', message: 'The PDF has no pages.' });
      if (report.pageCount > MAX_PDF_PAGES) report.issues.push({ code: 'many_pages', severity: 'warning', message: `Only the first ${MAX_PDF_PAGES} pages are read automatically.` });
    } catch (err) {
      if (err instanceof EncryptedPDFError || /encrypt/i.test(String((err as Error)?.message))) {
        report.passwordProtected = true;
        report.issues.push({ code: 'password_protected', severity: 'blocking', message: 'The PDF is password-protected. Please upload a copy without a password.' });
      } else {
        report.issues.push({ code: 'corrupt', severity: 'blocking', message: 'The file appears to be damaged and can’t be opened. Please upload it again.' });
      }
    }
    return report;
  }

  let img: ReturnType<typeof decodeImage>;
  try {
    img = decodeImage(buf, kind);
  } catch {
    report.issues.push({ code: 'corrupt', severity: 'blocking', message: 'The image appears to be damaged and can’t be opened. Please upload it again.' });
    return report;
  }
  report.readable = true;
  report.pageCount = 1;
  report.width = img.width;
  report.height = img.height;
  report.software = imageSoftware(buf);
  const g = toGray(img.data, img.width, img.height, 1000);
  report.dHash = dHash(g);
  report.qr = readQr(img);
  if (opts.analyseImage) {
    report.sharpness = sharpness(g);
    if (Math.min(img.width, img.height) < QUALITY.minSide) report.issues.push({ code: 'low_resolution', severity: 'warning', message: 'The image is small. Please upload a higher-resolution photo or scan.' });
    if (report.sharpness < QUALITY.blurBelow) report.issues.push({ code: 'blurry', severity: 'warning', message: 'The image looks blurry. Please upload a clearer photo.' });
    if (glare(g) > QUALITY.glareAbove) report.issues.push({ code: 'glare', severity: 'warning', message: 'Part of the document is washed out by glare or reflection. Please retake the photo without flash or direct light.' });
  }
  return report;
}

/** Where a QR code points, and whether that looks like an official issuing authority. */
export interface QrFinding { content: string; kind: 'url' | 'text'; host?: string; official: boolean; warning?: string }

const OFFICIAL = [/\.gov\.au$/i, /^gov\.au$/i];
const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly)$/i;

/** Classifies a QR payload without ever visiting it. */
export function analyseQr(content: string): QrFinding {
  let url: URL | null = null;
  try { url = /^https?:\/\//i.test(content) ? new URL(content) : null; } catch { url = null; }
  if (!url) return { content: content.slice(0, 500), kind: 'text', official: false };
  const host = url.hostname.toLowerCase();
  const official = OFFICIAL.some(r => r.test(host));
  let warning: string | undefined;
  if (SHORTENERS.test(host)) warning = 'Link shortener: the real destination is hidden';
  else if (!official) warning = 'Not a government (.gov.au) address';
  else if (url.protocol !== 'https:') warning = 'Not a secure (https) link';
  return { content: content.slice(0, 500), kind: 'url', host, official: official && url.protocol === 'https:', warning };
}

/** Text near-duplicate score (0–1): share of shared 3-word sequences. Used for PDFs. */
export function textSimilarity(a: string, b: string): number {
  const grams = (t: string) => {
    const w = t.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const s = new Set<string>();
    for (let i = 0; i + 2 < w.length; i++) s.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
    return s;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Text cut at the image edge (from OCR word positions): a sign the document is cropped. */
export function croppedText(words: { box?: { x: number; y: number; w: number; h: number }; page: number }[], pages: { width: number; height: number }[]): boolean {
  return words.some(w => {
    const p = pages[w.page];
    if (!w.box || !p) return false;
    const mx = Math.max(3, p.width * 0.012), my = Math.max(3, p.height * 0.012);
    return w.box.x <= mx || w.box.x + w.box.w >= p.width - mx || w.box.y <= my || w.box.y + w.box.h >= p.height - my;
  });
}
