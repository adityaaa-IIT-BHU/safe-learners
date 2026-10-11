import { applicationDefault } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { onCall } from 'firebase-functions/v2/https';
import { VERIFICATION_STEPS, fullName, isExpired, type VerificationStepKey } from '../../shared/domain';
import { parseDocumentText } from '../../shared/ocr';
import { FieldValue, db, fail, logger, notify, notifyAdmins, requireAdmin, requireAuth, requireUser, userFrom } from './core';

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
 * Reads a document photo with Cloud Vision and suggests its number, expiry and state.
 * Only the instructor's own files under licenses/{uid}/ can be scanned.
 */
export const scanDocument = onCall({ ...opts, timeoutSeconds: 60 }, async req => {
  const uid = requireAuth(req);
  const key = keyArg(req.data?.key);
  const path = String(req.data?.path || '');
  if (!path.startsWith(`licenses/${uid}/`) || path.includes('..')) fail('That file can’t be scanned.', 'permission-denied');
  if (/\.pdf$/i.test(path)) return { found: false, reason: 'pdf' };

  const bucket = getStorage().bucket().name;
  const { access_token } = await applicationDefault().getAccessToken();
  const res = await fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ image: { source: { imageUri: `gs://${bucket}/${path}` } }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }],
    }),
  });
  if (!res.ok) {
    logger.error('Vision request failed', { status: res.status, body: (await res.text()).slice(0, 500) });
    return { found: false, reason: 'unavailable' };
  }
  const json = (await res.json()) as { responses?: { fullTextAnnotation?: { text?: string }; error?: { message: string } }[] };
  const text = json.responses?.[0]?.fullTextAnnotation?.text ?? '';
  if (!text.trim()) return { found: false, reason: 'no-text' };
  const parsed = parseDocumentText(key, text);
  return { found: !!(parsed.number || parsed.expiry), ...parsed };
});

/** An instructor sends a new or renewed document to admins for review. */
export const submitDocument = onCall(opts, async req => {
  const uid = requireAuth(req);
  const instructor = await requireUser(uid, 'instructor');
  const key = keyArg(req.data?.key);
  const doc = ((await db.doc(`users/${uid}/private/profile`).get()).data()?.verification ?? {})[key];
  if (!doc?.url || !doc?.number || !doc?.expiry) fail('Please upload the document and enter its number and expiry.');
  if (isExpired(doc.expiry)) fail(`Your ${labelOf(key).toLowerCase()} has expired. Please upload the current one.`);

  await db.doc(`users/${uid}`).update({
    [`documentReviews.${key}`]: { status: 'pending', submittedAt: FieldValue.serverTimestamp() },
    documentsPending: true,
  });
  // Instructors who are already verified stay bookable while an update is reviewed.
  if (instructor.verificationStatus === 'verified') {
    await notifyAdmins({
      type: 'document_update',
      title: 'Document update to review',
      body: `${fullName(instructor)} submitted a new ${labelOf(key).toLowerCase()} (expires ${doc.expiry}).`,
      link: '/admin/verifications',
    });
  }
  return { ok: true };
});

/** Admin approves or rejects a single document. */
export const reviewDocument = onCall(opts, async req => {
  requireAdmin(req);
  const uid = String(req.data?.uid || '');
  const key = keyArg(req.data?.key);
  const approve = req.data?.approve === true;
  const note = String(req.data?.note || '').slice(0, 500);
  const instructor = userFrom(await db.doc(`users/${uid}`).get());
  if (!instructor || instructor.role !== 'instructor') fail('Instructor not found.', 'not-found');

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
