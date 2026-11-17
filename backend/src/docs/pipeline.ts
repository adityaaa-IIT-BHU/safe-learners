// Document processing queue: one job per uploaded version. A job reads the file (OCR), identifies the
// type, extracts fields and runs the enabled checks, then hands the version to an admin. Every step
// honours the automation switches at the moment it runs; a paused job simply waits, untouched, and is
// picked up again on resume. Nothing here ever marks a document Verified.
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  compareWithProfile,
  detectType,
  extractFields,
  missingFields,
  squash,
  textRiskFlags,
  type ComparisonRow,
  type ExtractedFields,
  type OcrOutput,
  type OcrWord,
  type RiskFlag,
  type TypeGuess,
} from '../../../shared/docExtract';
import {
  appliesTo,
  docTypeLabel,
  fieldLabel,
  isActive,
  type DocStatus,
  type DocTypeKey,
} from '../../../shared/documents';
import { fullName } from '../../../shared/domain';
import { dayKey } from '../../../shared/time';
import { FieldValue, db, logger, notify, userFrom } from '../core';
import { MAX_PDF_PAGES, analyseQr, croppedText, hammingHex, inspectFile, textSimilarity, type FileReport, type QrFinding, type QualityIssue } from './fileChecks';
import { OcrError, ocrProvider, type OcrRead } from './ocrProvider';
import {
  docBucket,
  SYSTEM,
  audit,
  docRef,
  getDocumentSettings,
  jobRef,
  pagesUsedThisMonth,
  recordOcrUsage,
  reviewRef,
  setVersionStatus,
  versionRef,
} from './store';

const REGION = 'australia-southeast1';
const RETRY_MINUTES = [2, 10, 30];
const MAX_ATTEMPTS = 3;
const LEASE_MS = 8 * 60_000;

export type JobOutcome = 'done' | 'waiting' | 'retry' | 'failed' | 'skipped' | 'busy';

export interface DuplicateHit {
  level: 1 | 2 | 3 | 4;
  message: string;
  instructorId: string;
  instructorName?: string;
  docId: string;
  version: number;
  sameInstructor: boolean;
}

function notifyAdmins(title: string, body: string, link: string) {
  return notify('admin', { type: 'document_review', title, body, link, email: false });
}

async function download(path: string): Promise<Buffer> {
  const [buf] = await docBucket().file(path).download();
  return buf;
}

/** OCR every file of a version (cached by file hash, so the same file is never read twice). */
async function readAll(files: { sha256: string; contentType: string; pages: number; buf: Buffer }[], fresh: boolean): Promise<{ out: OcrOutput; pages: number; cachedPages: number }> {
  const provider = ocrProvider();
  if (!provider) throw new OcrError('OCR is not configured for this environment', false, 'not_configured');
  const out: OcrOutput = { text: '', words: [], pages: [] };
  let pages = 0, cachedPages = 0;
  const texts: string[] = [];
  for (const f of files) {
    const cacheRef = db.doc(`ocrCache/${f.sha256}`);
    let read: OcrRead | null = null;
    if (!fresh) {
      const c = await cacheRef.get();
      if (c.exists) read = c.data()!.read as OcrRead;
    }
    if (read) cachedPages += read.units;
    else {
      read = await provider.read(f.buf, f.contentType, { maxPages: MAX_PDF_PAGES, pageCount: f.pages || undefined });
      pages += read.units;
      await cacheRef.set({ read, createdAt: FieldValue.serverTimestamp(), createdMs: Date.now() });
    }
    const offset = out.pages.length;
    out.pages.push(...read.pages);
    out.words.push(...read.words.map((w: OcrWord) => ({ ...w, page: w.page + offset })));
    texts.push(read.text);
  }
  out.text = texts.join('\n');
  return { out, pages, cachedPages };
}

/** Claims a queued job for processing (one worker at a time). */
async function claim(id: string, manual: boolean): Promise<Record<string, any> | null> {
  return db.runTransaction(async tx => {
    const snap = await tx.get(jobRef(id));
    if (!snap.exists) return null;
    const j = snap.data()!;
    const now = Date.now();
    if (j.status === 'running' && (j.leaseUntil ?? 0) > now) return null;
    if (j.status !== 'queued' && j.status !== 'running') return null;
    if (!manual && (j.nextAttemptAt ?? 0) > now) return null;
    tx.update(jobRef(id), { status: 'running', leaseUntil: now + LEASE_MS, startedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return j;
  });
}

async function wait(id: string, docId: string, n: number, status: DocStatus, waitingFor: string, note: string) {
  await jobRef(id).update({ status: 'queued', waitingFor, leaseUntil: 0, updatedAt: FieldValue.serverTimestamp() });
  const v = (await versionRef(docId, n).get()).data();
  if (v?.status !== status) {
    await setVersionStatus(docId, n, status, { 'processing.waitingFor': waitingFor, 'processing.note': note });
    await audit({ action: 'processing_waiting', actor: SYSTEM, docId, version: n, instructorId: v?.instructorId, details: { waitingFor, status } });
  }
}

/**
 * Runs one job. Safe to call repeatedly: finished jobs are skipped, running ones are leased, and a
 * paused job is left queued without counting an attempt.
 */
export async function processJob(id: string, opts: { manual?: boolean; fresh?: boolean } = {}): Promise<JobOutcome> {
  const settings = await getDocumentSettings(true);
  const pre = (await jobRef(id).get()).data();
  if (!pre) return 'skipped';
  if (pre.status !== 'queued' && pre.status !== 'running') return 'skipped';
  // Pauses are checked before claiming, so a paused job is never touched (and never retried).
  if (!settings.automation) {
    if (pre.waitingFor !== 'automation_paused') await wait(id, pre.docId, pre.version, 'processing_paused', 'automation_paused', 'Document automation is paused');
    return 'waiting';
  }
  const job = await claim(id, !!opts.manual);
  if (!job) return 'busy';
  const { docId, version: n } = job as { docId: string; version: number };

  try {
    const vSnap = await versionRef(docId, n).get();
    const parentSnap = await docRef(docId).get();
    if (!vSnap.exists || !parentSnap.exists) { await jobRef(id).update({ status: 'done', note: 'Version not found', leaseUntil: 0 }); return 'skipped'; }
    const v = vSnap.data()!;
    const parent = parentSnap.data()!;
    const uid: string = parent.instructorId;
    const user = userFrom(await db.doc(`users/${uid}`).get());
    const type = parent.type as DocTypeKey;

    if (!appliesTo(settings, user)) {
      await setVersionStatus(docId, n, 'pending_verification', { processing: { skipped: 'test_mode', note: 'Automation is in test mode and applies to test accounts only. Review manually.', completedAt: FieldValue.serverTimestamp() } });
      await jobRef(id).update({ status: 'done', waitingFor: null, note: 'test mode: not a test account', leaseUntil: 0, updatedAt: FieldValue.serverTimestamp() });
      return 'skipped';
    }

    await setVersionStatus(docId, n, 'processing', { 'processing.waitingFor': null });

    // ----- File checks (no OCR needed) -----
    const files = v.files as { path: string; contentType: string; name: string; sha256: string; side?: string }[];
    const bufs = await Promise.all(files.map(f => download(f.path)));
    const reports: FileReport[] = [];
    for (let i = 0; i < files.length; i++) reports.push(await inspectFile(bufs[i], files[i].contentType, { analyseImage: isActive(settings, 'qualityChecks') }));
    const quality: QualityIssue[] = isActive(settings, 'qualityChecks') ? reports.flatMap(r => r.issues) : [];
    const qr: QrFinding[] = reports.flatMap(r => r.qr.map(analyseQr));
    const software = reports.map(r => r.software).find(Boolean) ?? null;

    const duplicates: DuplicateHit[] = [];
    const dupActive = isActive(settings, 'duplicateDetection');
    if (dupActive) {
      for (const f of files) {
        const fp = (await db.doc(`documentFingerprints/${f.sha256}`).get()).data();
        for (const e of (fp?.entries ?? []) as { docId: string; version: number; instructorId: string }[]) {
          if (e.docId === docId && e.version === n) continue;
          const same = e.instructorId === uid;
          duplicates.push({ level: 1, sameInstructor: same, instructorId: e.instructorId, docId: e.docId, version: e.version,
            message: same ? `Identical file to version ${e.version} of ${docTypeLabel(e.docId.split('__')[1])}` : 'Identical file uploaded by another instructor' });
        }
      }
    }

    // ----- OCR -----
    if (!isActive(settings, 'ocr')) {
      await versionRef(docId, n).set({ quality: { issues: quality, checkedAt: FieldValue.serverTimestamp() } }, { merge: true });
      await reviewRef(docId, n).set({ duplicates, qr, software, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await wait(id, docId, n, 'awaiting_ocr', 'ocr_paused', 'OCR is paused');
      return 'waiting';
    }
    const pageTotal = reports.reduce((s, r) => s + Math.min(MAX_PDF_PAGES, Math.max(1, r.pageCount)), 0);
    if (settings.monthlyPageLimit > 0) {
      const used = await pagesUsedThisMonth();
      if (used + pageTotal > settings.monthlyPageLimit) {
        const flag = db.doc(`ocrUsage/limitNotice`);
        const notice = (await flag.get()).data();
        if (notice?.month !== new Date().toISOString().slice(0, 7)) {
          await flag.set({ month: new Date().toISOString().slice(0, 7) });
          await notifyAdmins('OCR monthly limit reached', `Automatic OCR is waiting: ${used} of ${settings.monthlyPageLimit} pages used this month. Raise the limit or review documents manually.`, '/admin/settings');
        }
        await wait(id, docId, n, 'awaiting_ocr', 'limit', 'Monthly OCR page limit reached');
        return 'waiting';
      }
    }

    await audit({ action: 'ocr_started', actor: SYSTEM, docId, version: n, instructorId: uid, details: { files: files.length } });
    let ocr: { out: OcrOutput; pages: number; cachedPages: number };
    try {
      ocr = await readAll(files.map((f, i) => ({ sha256: f.sha256, contentType: f.contentType, pages: reports[i].pageCount, buf: bufs[i] })), !!opts.fresh);
    } catch (err) {
      const e = err instanceof OcrError ? err : new OcrError('OCR failed', true, 'unknown');
      const attempts = Number(job.attempts ?? 0) + 1;
      const retry = e.retryable && attempts < MAX_ATTEMPTS;
      await audit({ action: 'ocr_failed', actor: SYSTEM, docId, version: n, instructorId: uid, details: { code: e.code, message: e.message, attempts, willRetry: retry } });
      if (retry) {
        await jobRef(id).update({ status: 'queued', attempts, lastError: e.message, nextAttemptAt: Date.now() + RETRY_MINUTES[attempts - 1] * 60_000, leaseUntil: 0, waitingFor: 'retry', updatedAt: FieldValue.serverTimestamp() });
        await setVersionStatus(docId, n, 'processing', { 'processing.lastError': e.message, 'processing.attempts': attempts });
        return 'retry';
      }
      await jobRef(id).update({ status: 'failed', attempts, lastError: e.message, leaseUntil: 0, waitingFor: null, updatedAt: FieldValue.serverTimestamp() });
      await setVersionStatus(docId, n, 'processing_failed', { 'processing.lastError': e.message, 'processing.attempts': attempts, quality: { issues: quality, checkedAt: FieldValue.serverTimestamp() } });
      await reviewRef(docId, n).set({ duplicates, qr, software, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await notifyAdmins('Document processing failed', `${parent.instructorName ?? 'An instructor'}'s ${docTypeLabel(type).toLowerCase()} could not be read automatically. Review it manually or retry.`, `/admin/verifications?tab=documents&doc=${docId}&v=${n}`);
      return 'failed';
    }
    await recordOcrUsage(ocr.pages, false);
    if (ocr.cachedPages) await recordOcrUsage(ocr.cachedPages, true);
    await audit({ action: 'ocr_completed', actor: SYSTEM, docId, version: n, instructorId: uid, details: { pages: ocr.pages, cachedPages: ocr.cachedPages, words: ocr.out.words.length } });

    // ----- Type, fields, quality -----
    const reasons: string[] = [];
    let detected: TypeGuess | null = null;
    if (isActive(settings, 'typeDetection')) {
      detected = detectType(ocr.out.text);
      if (detected.certainty !== 'confident' || !detected.type) reasons.push('Manual document type verification required');
      else if (detected.type !== type) reasons.push(`Looks like a ${docTypeLabel(detected.type).toLowerCase()}, uploaded as ${docTypeLabel(type).toLowerCase()}`);
    }
    let fields: ExtractedFields = {};
    let missing: string[] = [];
    if (isActive(settings, 'extraction')) {
      fields = extractFields(type, ocr.out);
      missing = missingFields(type, fields);
      for (const f of Object.values(fields)) if (f.band === 'low') { reasons.push('Some details were read with low confidence'); break; }
    }
    if (isActive(settings, 'qualityChecks')) {
      if (croppedText(ocr.out.words, ocr.out.pages)) quality.push({ code: 'cropped', severity: 'warning', message: 'Text runs to the edge of the image, so part of the document may be cut off. Please upload the complete document.' });
      if (isActive(settings, 'extraction') && missing.length) quality.push({ code: 'missing_fields', severity: 'warning', message: `Some details couldn’t be read: ${missing.map(fieldLabel).join(', ')}. Please upload a clearer image or the complete document.` });
      if (!ocr.out.text.trim()) quality.push({ code: 'no_text', severity: 'warning', message: 'No readable text was found. Please upload a clearer image.' });
    }

    // ----- Profile comparison -----
    const prevN: number | null = parent.verifiedVersion ?? null;
    const prev = prevN && prevN !== n ? (await versionRef(docId, prevN).get()).data() : null;
    const prevFields = prev ? { number: prev.fields?.number?.correctedValue ?? prev.fields?.number?.value ?? prev.entered?.number ?? null, expiry: prev.fields?.expiryDate?.correctedValue ?? prev.fields?.expiryDate?.value ?? prev.entered?.expiry ?? null, issueDate: prev.fields?.issueDate?.value ?? null } : null;
    let comparison: ComparisonRow[] = [];
    if (isActive(settings, 'profileComparison') && isActive(settings, 'extraction')) {
      const priv = (await db.doc(`users/${uid}/private/profile`).get()).data() ?? {};
      comparison = compareWithProfile({
        type, fields,
        profile: { name: user ? fullName(user) : parent.instructorName ?? '', dateOfBirth: typeof priv.dob === 'string' ? priv.dob : null },
        entered: { number: v.entered?.number ?? null, expiry: v.entered?.expiry ?? null, state: v.entered?.state ?? null },
        previous: prevFields,
      });
      if (comparison.some(r => r.status === 'mismatch')) reasons.push('Details differ from the instructor’s profile or typed details');
    }

    // ----- Duplicates by number and near-duplicate files -----
    const number = fields.number?.value ?? (type === 'vehicleRego' ? fields.plate?.value : undefined) ?? v.entered?.number ?? null;
    if (dupActive) {
      if (number && squash(number).length >= 4) {
        const numDoc = (await db.doc(`documentNumbers/${type}__${squash(number)}`).get()).data();
        for (const e of (numDoc?.entries ?? []) as { docId: string; version: number; instructorId: string }[]) {
          if (e.docId === docId && e.version === n) continue;
          const same = e.instructorId === uid;
          if (same && duplicates.some(d => d.docId === e.docId && d.version === e.version)) continue;
          duplicates.push({ level: same ? 2 : 3, sameInstructor: same, instructorId: e.instructorId, docId: e.docId, version: e.version,
            message: same ? `Same number as version ${e.version} (normal for a renewal)` : 'The same document number is on another instructor’s account' });
        }
      }
      const hashes = reports.map(r => r.dHash).filter(Boolean) as string[];
      if (hashes.length || ocr.out.text) {
        const pool = (await db.doc(`documentImageHashes/${type}`).get()).data()?.items ?? [];
        for (const it of pool as { docId: string; version: number; instructorId: string; dHash?: string; textKey?: string }[]) {
          if (it.docId === docId && it.version === n) continue;
          // Skip only when it's the very same file (already reported); a re-saved copy is worth saying even if the number matched.
          if (duplicates.some(d => d.docId === it.docId && d.version === it.version && d.level === 1)) continue;
          const isPdf = reports.every(r => r.kind === 'pdf');
          const close = it.dHash && hashes.some(h => hammingHex(h, it.dHash!) <= 6);
          if (!close && !isPdf) continue;
          let similar = false, why = '';
          if (isPdf) {
            // PDF text is stable, so near-identical text means the same document saved again.
            const otherText = (await reviewRef(it.docId, it.version).get()).data()?.ocrText as string | undefined;
            const sim = otherText ? textSimilarity(ocr.out.text, otherText) : 0;
            similar = sim >= 0.85; why = `${Math.round(sim * 100)}% same text`;
          } else {
            // Photos of the same card template look alike, so also require the same printed details.
            const of = (await versionRef(it.docId, it.version).get()).data()?.fields ?? {};
            const keys = ['number', 'fullName', 'expiryDate'].filter(k => fields[k]?.value && of[k]?.value);
            similar = keys.length >= 2 && keys.every(k => squash(fields[k].value) === squash(of[k].value));
            why = 'same image and printed details';
          }
          if (similar) {
            const same = it.instructorId === uid;
            duplicates.push({ level: 4, sameInstructor: same, instructorId: it.instructorId, docId: it.docId, version: it.version,
              message: `${same ? 'Very similar to an earlier upload' : 'Very similar to a document on another instructor’s account'} (resized or re-saved copy: ${why})` });
          }
        }
      }
      if (duplicates.some(d => !d.sameInstructor)) reasons.push('Possible duplicate on another instructor’s account');
      // Names of other instructors, for admins only.
      for (const d of duplicates) if (!d.sameInstructor) d.instructorName = (await docRef(d.docId).get()).data()?.instructorName ?? undefined;
    }

    // ----- Risk indicators -----
    let risks: RiskFlag[] = [];
    if (isActive(settings, 'riskIndicators')) {
      if (isActive(settings, 'extraction')) risks = textRiskFlags({ type, fields, words: ocr.out.words, previous: prevFields, today: dayKey(new Date()) });
      if (software) risks.push({ code: 'edited_metadata', severity: 'warning', message: `File metadata names editing software (${software})` });
      for (const q of qr) if (q.warning) risks.push({ code: 'qr_destination', severity: 'warning', message: `QR code: ${q.warning}` });
      if (duplicates.some(d => !d.sameInstructor && d.level !== 1)) risks.push({ code: 'cross_instructor_number', severity: 'high', message: 'Document number also appears on another instructor’s account' });
      if (duplicates.some(d => !d.sameInstructor && d.level === 1)) risks.push({ code: 'cross_instructor_file', severity: 'high', message: 'Identical file uploaded by another instructor' });
      if (detected?.type && detected.certainty === 'confident' && detected.type !== type) risks.push({ code: 'type_mismatch', severity: 'warning', message: `Uploaded as ${docTypeLabel(type)} but reads like ${docTypeLabel(detected.type)}` });
      if (risks.some(r => r.severity === 'high')) reasons.push('High-severity risk indicator');
    }

    // ----- Save and hand to an admin -----
    const status: DocStatus = reasons.length ? 'manual_verification' : 'pending_verification';
    const instructorMessage = quality.length ? `Document quality issue – ${quality.map(q => q.message).join(' ')}` : null;
    const fieldDocs = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, { ...f, review: 'unreviewed' }]));
    await versionRef(docId, n).set({
      detected: detected ? { type: detected.type, certainty: detected.certainty, scores: detected.scores } : null,
      fields: fieldDocs,
      missingFields: missing,
      quality: { issues: quality, checkedAt: FieldValue.serverTimestamp() },
      instructorMessage,
      reviewReasons: reasons,
      summary: {
        mismatches: comparison.filter(r => r.status === 'mismatch').length,
        duplicates: duplicates.filter(d => !d.sameInstructor || d.level === 1 || d.level === 4).length,
        risks: risks.length,
        quality: quality.length,
        lowConfidence: Object.values(fields).filter(f => f.band === 'low').length,
      },
      trust: {
        extracted: Object.keys(fields).length > 0,
        checked: isActive(settings, 'riskIndicators') && isActive(settings, 'qualityChecks') && !risks.length && !quality.length && !comparison.some(r => r.status === 'mismatch'),
        reviewed: false,
        confirmed: false,
      },
      processing: {
        completedAt: FieldValue.serverTimestamp(), pages: ocr.pages, cachedPages: ocr.cachedPages, attempts: Number(job.attempts ?? 0) + 1, lastError: null, waitingFor: null,
        steps: Object.fromEntries((['typeDetection', 'extraction', 'profileComparison', 'duplicateDetection', 'qualityChecks', 'riskIndicators'] as const).map(s => [s, isActive(settings, s) ? 'done' : 'paused'])),
      },
    }, { merge: true });
    await reviewRef(docId, n).set({
      comparison, duplicates, risks, qr, software,
      ocrText: ocr.out.text.slice(0, 20_000),
      sharpness: reports.map(r => r.sharpness),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await setVersionStatus(docId, n, status);
    await docRef(docId).set({ flags: { duplicates: duplicates.filter(d => !d.sameInstructor).length, risks: risks.length, mismatches: comparison.filter(r => r.status === 'mismatch').length, quality: quality.length } }, { merge: true });

    // Indexes for later duplicate checks.
    for (const f of files) await db.doc(`documentFingerprints/${f.sha256}`).set({ entries: FieldValue.arrayUnion({ docId, version: n, instructorId: uid }) }, { merge: true });
    if (number && squash(number).length >= 4) await db.doc(`documentNumbers/${type}__${squash(number)}`).set({ type, entries: FieldValue.arrayUnion({ docId, version: n, instructorId: uid }) }, { merge: true });
    await db.doc(`documentImageHashes/${type}`).set({ items: FieldValue.arrayUnion({ docId, version: n, instructorId: uid, dHash: reports.map(r => r.dHash).find(Boolean) ?? null }) }, { merge: true });

    await jobRef(id).update({ status: 'done', attempts: Number(job.attempts ?? 0) + 1, leaseUntil: 0, waitingFor: null, lastError: null, finishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    await audit({ action: 'processing_completed', actor: SYSTEM, docId, version: n, instructorId: uid, after: status,
      details: { detectedType: detected?.type ?? null, fields: Object.keys(fields), reasons, duplicates: duplicates.length, risks: risks.map(r => r.code), quality: quality.map(q => q.code) } });
    if (instructorMessage) {
      await notify(uid, { type: 'document_review', title: `${docTypeLabel(type)}: please check your upload`, body: 'Document Quality Issue – Please upload a clearer image or complete document.', link: `/instructor/verification?doc=${type}`, email: false });
    }
    await notifyAdmins(status === 'manual_verification' ? 'Document needs manual verification' : 'Document ready to verify',
      `${parent.instructorName ?? 'An instructor'} — ${docTypeLabel(type)}${reasons.length ? `: ${reasons[0]}` : ''}`, `/admin/verifications?tab=documents&doc=${docId}&v=${n}`);
    return 'done';
  } catch (err) {
    logger.error('document processing failed', { job: id, error: err instanceof Error ? err.message : String(err) });
    const attempts = Number(job.attempts ?? 0) + 1;
    if (attempts < MAX_ATTEMPTS) {
      await jobRef(id).update({ status: 'queued', attempts, lastError: 'Unexpected processing error', nextAttemptAt: Date.now() + RETRY_MINUTES[attempts - 1] * 60_000, leaseUntil: 0, waitingFor: 'retry' });
      return 'retry';
    }
    await jobRef(id).update({ status: 'failed', attempts, lastError: 'Unexpected processing error', leaseUntil: 0, waitingFor: null });
    await setVersionStatus(docId, n, 'processing_failed', { 'processing.lastError': 'Unexpected processing error' });
    return 'failed';
  }
}

/** Processes queued jobs that are due (stops early when paused). */
export async function runQueue(limit = 20): Promise<{ processed: number; outcomes: Record<string, number> }> {
  const settings = await getDocumentSettings(true);
  const outcomes: Record<string, number> = {};
  if (!settings.automation) return { processed: 0, outcomes };
  const snap = await db.collection('documentJobs').where('status', 'in', ['queued', 'running']).limit(200).get();
  const now = Date.now();
  const due = snap.docs
    .map(d => ({ id: d.id, ...d.data() } as Record<string, any> & { id: string }))
    .filter(j => j.status === 'queued' ? (j.nextAttemptAt ?? 0) <= now : (j.leaseUntil ?? 0) <= now)
    // While OCR is paused, jobs waiting for OCR stay put (no calls, no retries).
    .filter(j => !(j.waitingFor === 'ocr_paused' && !isActive(settings, 'ocr')))
    .sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0))
    .slice(0, limit);
  for (const j of due) {
    if (j.status === 'running') await jobRef(j.id).update({ status: 'queued', leaseUntil: 0 });
    const o = await processJob(j.id);
    outcomes[o] = (outcomes[o] ?? 0) + 1;
  }
  return { processed: due.length, outcomes };
}

/** New uploads are processed straight away when automation allows. */
export const documentJobCreated = onDocumentCreated({ region: REGION, document: 'documentJobs/{id}', timeoutSeconds: 300, memory: '1GiB', retry: false }, async event => {
  await processJob(event.params.id);
});

/** Picks up retries, and jobs left waiting while something was paused. */
export const documentQueueWorker = onSchedule({ region: REGION, schedule: 'every 5 minutes', timeoutSeconds: 540, memory: '1GiB' }, async () => {
  const r = await runQueue(25);
  if (r.processed) logger.info('document queue', r);
});
