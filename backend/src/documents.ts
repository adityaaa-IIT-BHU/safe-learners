import { createHash } from 'node:crypto';
import { onCall } from 'firebase-functions/v2/https';
import { appliesTo, documentId, isActive } from '../../shared/documents';
import { VERIFICATION_STEPS, fullName, isExpired, type VerificationStepKey } from '../../shared/domain';
import { parseDocumentText } from '../../shared/ocr';
import { FieldValue, db, fail, logger, notify, notifyCybria, requireAuth, requireUser, userFrom, requirePermission } from './core';
import { applyDecision } from './docs/api';
import { OcrError, ocrProvider } from './docs/ocrProvider';
import { actorFrom, docBucket, docRef, getDocumentSettings, pagesUsedThisMonth, recordOcrUsage } from './docs/store';

const opts = { region: 'australia-southeast1', cors: true };
const KEYS = VERIFICATION_STEPS.map(s => s.key) as string[];

function keyArg(v: unknown): VerificationStepKey {
  if (typeof v !== 'string' || !KEYS.includes(v)) fail('Unknown document.', 'invalid-argument');
  return v as VerificationStepKey;
}

function labelOf(key: VerificationStepKey) {
  return VERIFICATION_STEPS.find(s => s.key === key)!.label;
}

/**
 * Reads a document photo with OCR and suggests its number, expiry and state while the instructor is
 * filling in the form. Only runs when OCR is enabled (and, in test mode, for test accounts); the
 * result is cached by file hash so the background processing never reads the same file again.
 */
export const scanDocument = onCall({ ...opts, timeoutSeconds: 60, memory: '512MiB' }, async req => {
  const uid = requireAuth(req);
  const key = keyArg(req.data?.key);
  const path = String(req.data?.path || '');
  if (!(path.startsWith(`licenses/${uid}/`) || path.startsWith(`verification-documents/${uid}/`)) || path.includes('..')) fail('That file can’t be scanned.', 'permission-denied');
  if (/\.pdf$/i.test(path)) return { found: false, reason: 'pdf' };

  const settings = await getDocumentSettings();
  const user = userFrom(await db.doc(`users/${uid}`).get());
  if (!isActive(settings, 'ocr') || !appliesTo(settings, user)) return { found: false, reason: 'paused' };
  if (settings.monthlyPageLimit > 0 && (await pagesUsedThisMonth()) >= settings.monthlyPageLimit) return { found: false, reason: 'paused' };
  const provider = ocrProvider();
  if (!provider) return { found: false, reason: 'unavailable' };

  const file = docBucket().file(path);
  const [buf] = await file.download();
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const cacheRef = db.doc(`ocrCache/${sha256}`);
  let text = '';
  const cached = await cacheRef.get();
  if (cached.exists) {
    text = String(cached.data()!.read?.text ?? '');
    await recordOcrUsage(1, true);
  } else {
    try {
      const [meta] = await file.getMetadata();
      const read = await provider.read(buf, String(meta.contentType || 'image/jpeg'), { maxPages: 1 });
      await cacheRef.set({ read, createdAt: FieldValue.serverTimestamp(), createdMs: Date.now() });
      await recordOcrUsage(read.units, false);
      text = read.text;
    } catch (err) {
      logger.warn('OCR suggestion unavailable', { code: err instanceof OcrError ? err.code : 'unknown' });
      return { found: false, reason: 'unavailable' };
    }
  }
  if (!text.trim()) return { found: false, reason: 'no-text' };
  const parsed = parseDocumentText(key, text);
  return { found: !!(parsed.number || parsed.expiry), ...parsed };
});

/** An instructor sends a new or renewed document to admins for review (original flow). */
export const submitDocument = onCall(opts, async req => {
  const uid = requireAuth(req);
  const instructor = await requireUser(uid, 'instructor');
  const key = keyArg(req.data?.key);
  const doc = ((await db.doc(`users/${uid}/private/profile`).get()).data()?.verification ?? {})[key];
  if (!(doc?.url || doc?.path) || !doc?.number || !doc?.expiry) fail('Please upload the document and enter its number and expiry.');
  if (isExpired(doc.expiry)) fail(`Your ${labelOf(key).toLowerCase()} has expired. Please upload the current one.`);

  await db.doc(`users/${uid}`).update({
    [`documentReviews.${key}`]: { status: 'pending', submittedAt: FieldValue.serverTimestamp() },
    documentsPending: true,
  });
  // Instructors who are already verified stay bookable while an update is reviewed.
  if (instructor.verificationStatus === 'verified') {
    await notifyCybria({
      type: 'document_update',
      title: 'Document update to review',
      body: `${fullName(instructor)} submitted a new ${labelOf(key).toLowerCase()} (expires ${doc.expiry}).`,
      link: '/cybria/documents?tab=updates',
    });
  }
  return { ok: true };
});

/** Admin approves or rejects a single document (routes to the document records when they exist). */
export const reviewDocument = onCall(opts, async req => {
  await requirePermission(req, 'documents', req.data?.approve === true ? 'approve' : 'reject');
  const uid = String(req.data?.uid || '');
  const key = keyArg(req.data?.key);
  const approve = req.data?.approve === true;
  const note = String(req.data?.note || '').slice(0, 500);
  const instructor = userFrom(await db.doc(`users/${uid}`).get());
  if (!instructor || instructor.role !== 'instructor') fail('Instructor not found.', 'not-found');

  const parent = (await docRef(documentId(uid, key)).get()).data();
  if (parent?.latestVersion) {
    await applyDecision(documentId(uid, key), parent.latestVersion, approve ? 'approve' : 'reject', note, actorFrom(req, 'admin'));
    return { ok: true };
  }

  const reviews = { ...(instructor.documentReviews ?? {}) };
  reviews[key] = { status: approve ? 'approved' : 'rejected', ...(note ? { note } : {}) };
  const stillPending = Object.values(reviews).some(r => r?.status === 'pending');
  await db.doc(`users/${uid}`).update({
    [`documentReviews.${key}`]: { status: approve ? 'approved' : 'rejected', reviewedAt: FieldValue.serverTimestamp(), ...(note ? { note } : {}) },
    documentsPending: stillPending,
  });
  await notify(uid, {
    type: 'document_review',
    title: approve ? `${labelOf(key)} approved` : `${labelOf(key)} needs attention`,
    body: approve ? 'Thanks — your updated document has been approved.' : `Please check and resubmit: ${note || 'the document could not be approved.'}`,
    link: '/instructor/verification',
  });
  return { ok: true };
});
