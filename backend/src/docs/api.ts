// Callable functions for instructor documents: uploads (instructors), secure file viewing, and the
// admin verification actions, settings and tools. Every action is checked here on the server and
// written to the document audit trail.
import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import {
  DECISION_LABEL,
  DECISION_RESULT,
  DOC_TYPE_KEYS,
  FEATURE_INFO,
  LEGACY_DOC_TYPES,
  REVIEW_QUEUE,
  canDecide,
  daysUntil,
  docType,
  docTypeLabel,
  documentId,
  documentSettingsFrom,
  isActive,
  jobId,
  versionId,
  type DecisionAction,
  type DocStatus,
  type DocTypeKey,
  type DocumentSettings,
} from '../../../shared/documents';
import { parseDate } from '../../../shared/docExtract';
import { fullName, isExpired, legacyVerificationDocs, normaliseExpiry } from '../../../shared/domain';
import { FieldValue, db, fail, notify, requireAuth, requireUser, userFrom, requirePermission, requireSuperAdmin, hasPermission } from '../core';
import { expiryState, recomputeEligibility, runDocumentCleanup, runExpiryMonitor } from './compliance';
import { inspectFile } from './fileChecks';
import { failNextOcrCalls } from './ocrProvider';
import { processJob, runQueue } from './pipeline';
import {
  docBucket,
  SETTINGS_DOC,
  SYSTEM,
  actorFrom,
  audit,
  docRef,
  estimateCostUsd,
  forgetCachedSettings,
  getDocumentSettings,
  jobRef,
  pagesUsedThisMonth,
  reviewRef,
  versionRef,
  type Actor,
} from './store';

const opts = { region: 'australia-southeast1', cors: true };
const UPLOAD_ROOT = 'verification-documents';
const STATES = ['NSW', 'VIC', 'QLD', 'ACT', 'SA', 'WA', 'TAS', 'NT'];

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function typeArg(v: unknown): DocTypeKey {
  if (typeof v !== 'string' || !DOC_TYPE_KEYS.includes(v as DocTypeKey)) fail('Unknown document type.', 'invalid-argument');
  return v as DocTypeKey;
}
function docIdArg(v: unknown): string {
  const s = str(v, 200);
  if (!/^[A-Za-z0-9_-]+__[a-zA-Z]+$/.test(s)) fail('Unknown document.', 'invalid-argument');
  return s;
}
function nArg(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 999) fail('Unknown version.', 'invalid-argument');
  return n;
}

// ---------- Instructor: upload ----------

interface UploadFile { path: string; name: string; contentType: string; side?: string }

/** An instructor adds a new version of a document (the files are already in their private folder). */
export const uploadDocumentVersion = onCall({ ...opts, timeoutSeconds: 120, memory: '1GiB' }, async req => {
  const uid = requireAuth(req);
  const instructor = await requireUser(uid, 'instructor');
  const type = typeArg(req.data?.type);
  const info = docType(type)!;
  const files = (Array.isArray(req.data?.files) ? req.data.files : []).slice(0, 2) as UploadFile[];
  if (!files.length) fail('Please upload a photo or PDF of the document.');
  for (const f of files) {
    if (typeof f?.path !== 'string' || !f.path.startsWith(`${UPLOAD_ROOT}/${uid}/`) || f.path.includes('..')) fail('That file can’t be used.', 'permission-denied');
  }
  const number = str(req.data?.number, 40);
  const expiryRaw = str(req.data?.expiry, 20);
  const expiry = expiryRaw ? (normaliseExpiry(expiryRaw) ?? parseDate(expiryRaw)) : null;
  const issueDate = str(req.data?.issueDate, 20) ? normaliseExpiry(str(req.data?.issueDate, 20)) : null;
  const state = STATES.includes(str(req.data?.state, 5)) ? str(req.data?.state, 5) : null;
  if (type !== 'other' && !number) fail('Please enter the document number.');
  if (info.expiryRequired && !expiry) fail('Please enter the expiry date with a 4-digit year, e.g. 30/06/2029.');
  if (expiry && isExpired(expiry)) fail('The expiry date is in the past. Please check it, or renew the document first.');

  // Validate every file on the server (type, size, corruption, password protection).
  const bucket = docBucket();
  const checked: { path: string; name: string; contentType: string; side: string | null; size: number; sha256: string; pages: number }[] = [];
  for (const f of files) {
    const file = bucket.file(f.path);
    const [exists] = await file.exists();
    if (!exists) fail('The upload didn’t finish. Please try again.');
    const [meta] = await file.getMetadata();
    const contentType = String(meta.contentType || f.contentType || '');
    const [buf] = await file.download();
    const report = await inspectFile(buf, contentType, { analyseImage: false });
    const blocking = report.issues.find(i => i.severity === 'blocking');
    if (blocking) {
      await file.delete().catch(() => undefined);
      await audit({ action: 'upload_rejected', actor: actorFrom(req, 'instructor'), instructorId: uid, details: { type, code: blocking.code } });
      fail(blocking.message);
    }
    checked.push({ path: f.path, name: str(f.name, 120) || f.path.split('/').pop()!, contentType, side: f.side === 'back' ? 'back' : f.side === 'front' ? 'front' : null, size: buf.length, sha256: report.sha256, pages: report.pageCount });
  }

  const id = documentId(uid, type);
  const settings = await getDocumentSettings(true);
  const now = Date.now();
  const n = await db.runTransaction(async tx => {
    const parent = await tx.get(docRef(id));
    const next = (parent.data()?.latestVersion ?? 0) + 1;
    tx.set(docRef(id), {
      instructorId: uid, instructorName: fullName(instructor), type, latestVersion: next, latestStatus: 'uploaded', uploadedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(), testAccount: (instructor as any).testAccount === true,
      ...(parent.exists ? {} : { createdAt: FieldValue.serverTimestamp(), verifiedVersion: null, verifiedExpiry: null, expiryState: 'valid' }),
    }, { merge: true });
    tx.set(versionRef(id, next), {
      n: next, type, instructorId: uid, files: checked, hashes: checked.map(c => c.sha256),
      entered: { number: number || null, expiry, issueDate, state },
      status: 'uploaded', uploadedAt: FieldValue.serverTimestamp(), uploadedMs: now, uploadedBy: uid,
      processing: { attempts: 0 }, trust: { extracted: false, checked: false, reviewed: false, confirmed: false },
    });
    if (parent.exists && parent.data()!.latestVersion) tx.update(versionRef(id, parent.data()!.latestVersion), { supersededBy: next });
    tx.set(jobRef(jobId(id, next)), { docId: id, version: next, instructorId: uid, status: 'queued', attempts: 0, nextAttemptAt: 0, leaseUntil: 0, waitingFor: null, createdAt: FieldValue.serverTimestamp(), createdMs: now });
    return next;
  });

  // Keep the original verification records in step for the four core document types.
  if (LEGACY_DOC_TYPES.includes(type)) {
    const front = checked.find(c => c.side !== 'back') ?? checked[0];
    const back = checked.find(c => c.side === 'back');
    await db.doc(`users/${uid}/private/profile`).set({
      verification: { [type]: { path: front.path, ...(back ? { backPath: back.path } : {}), number: number || null, expiry, ...(state ? { state } : {}), submittedAt: new Date(), docId: id, version: n } },
    }, { merge: true });
    if (instructor.verificationStatus === 'verified') {
      await db.doc(`users/${uid}`).update({ [`documentReviews.${type}`]: { status: 'pending', submittedAt: FieldValue.serverTimestamp() }, documentsPending: true });
    }
  }
  await audit({ action: n > 1 ? 'document_replaced' : 'document_uploaded', actor: actorFrom(req, 'instructor'), instructorId: uid, docId: id, version: n,
    details: { type, files: checked.map(c => ({ name: c.name, contentType: c.contentType, size: c.size, pages: c.pages })), automation: settings.automation, ocr: isActive(settings, 'ocr') } });
  return { docId: id, version: n };
});

/** Opens one file of a document version for its owner or an admin (no public links exist). */
export const getDocumentFile = onCall({ ...opts, memory: '512MiB' }, async req => {
  const uid = requireAuth(req);
  const docId = docIdArg(req.data?.docId);
  const n = nArg(req.data?.version);
  const index = Math.max(0, Math.min(1, Number(req.data?.index ?? 0)));
  const isAdmin = await hasPermission(req, 'documents', 'view');
  if (!isAdmin && docId.split('__')[0] !== uid) fail('You can’t open this document.', 'permission-denied');
  const v = (await versionRef(docId, n).get()).data();
  const f = v?.files?.[index];
  if (!f?.path) fail('File not found.', 'not-found');
  const [buf] = await docBucket().file(f.path).download();
  return { name: f.name, contentType: f.contentType, data: buf.toString('base64') };
});

// ---------- Admin: review ----------

async function loadVersion(docId: string, n: number) {
  const [p, v] = await Promise.all([docRef(docId).get(), versionRef(docId, n).get()]);
  if (!p.exists || !v.exists) fail('Document not found.', 'not-found');
  return { parent: p.data()!, version: v.data()! };
}

const fieldValue = (v: any, k: string): string | null => v.fields?.[k]?.correctedValue ?? null;

/** The expiry and number an approval records: admin corrections first, then what the instructor typed, then what OCR read. */
function approvedValues(v: any) {
  const expiry = fieldValue(v, 'expiryDate') ?? v.entered?.expiry ?? v.fields?.expiryDate?.value ?? null;
  const number = fieldValue(v, 'number') ?? v.entered?.number ?? v.fields?.number?.value ?? null;
  return { expiry: expiry ? normaliseExpiry(expiry) : null, number };
}

/** Applies an admin decision to a version (shared by the Verifications screen and instructor approval). */
export async function applyDecision(docId: string, n: number, action: DecisionAction, reason: string, actor: Actor, opts: { silent?: boolean } = {}) {
  const { parent, version } = await loadVersion(docId, n);
  const from = version.status as DocStatus;
  if (!canDecide(from, action)) fail(`This document is already ${from.replace(/_/g, ' ')}.`);
  if (action !== 'approve' && !reason) fail('Please give a reason.');
  const type = parent.type as DocTypeKey;
  const to = DECISION_RESULT[action];
  const uid = parent.instructorId as string;
  const vals = approvedValues(version);
  if (action === 'approve') {
    if (docType(type)?.expiryRequired && !vals.expiry) fail('Enter the expiry date (Correct details) before approving.');
    if (vals.expiry && isExpired(vals.expiry)) fail('This document has already expired. It can’t be approved.');
  }

  const decision = { action, reason: reason || null, by: actor.uid, byName: actor.name, at: new Date() };
  const fields = Object.fromEntries(Object.entries(version.fields ?? {}).map(([k, f]: [string, any]) => [k, { ...f, review: f.review === 'unreviewed' && action === 'approve' ? 'confirmed' : f.review }]));
  await versionRef(docId, n).update({
    status: to, statusAt: FieldValue.serverTimestamp(), decision, fields,
    'trust.reviewed': true,
    ...(action === 'approve' ? { approved: { expiry: vals.expiry, number: vals.number } } : {}),
  });
  const parentUpdate: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
  if (parent.latestVersion === n) parentUpdate.latestStatus = to;
  if (action === 'approve') {
    Object.assign(parentUpdate, { verifiedVersion: n, verifiedExpiry: vals.expiry, verifiedNumber: vals.number, verifiedAt: FieldValue.serverTimestamp(),
      expiryState: expiryState(vals.expiry ? daysUntil(vals.expiry) : null) });
  } else if (parent.verifiedVersion === n) {
    // Rejecting the version that was relied on: nothing verified remains for this document.
    Object.assign(parentUpdate, { verifiedVersion: null, verifiedExpiry: null, verifiedNumber: null, expiryState: 'valid' });
  }
  await docRef(docId).update(parentUpdate);

  // Keep the original per-document review status in step for the four core types.
  if (LEGACY_DOC_TYPES.includes(type) && parent.latestVersion === n && (action === 'approve' || action === 'reject' || action === 'reupload' || action === 'correction')) {
    const user = (await db.doc(`users/${uid}`).get()).data() ?? {};
    const reviews = { ...(user.documentReviews ?? {}) };
    reviews[type] = { status: action === 'approve' ? 'approved' : 'rejected', ...(reason ? { note: reason } : {}) };
    await db.doc(`users/${uid}`).update({
      [`documentReviews.${type}`]: { status: action === 'approve' ? 'approved' : 'rejected', reviewedAt: FieldValue.serverTimestamp(), ...(reason ? { note: reason } : {}) },
      documentsPending: Object.values(reviews).some((r: any) => r?.status === 'pending'),
    });
    if (action === 'approve') {
      await db.doc(`users/${uid}/private/profile`).set({ verification: { [type]: { number: vals.number, expiry: vals.expiry } } }, { merge: true });
    }
  }

  // Final decisions: the full OCR text is kept 30 days for follow-up, then removed (extracted fields stay).
  if (action === 'approve' || action === 'reject') {
    await db.doc(`ocrTextCleanup/${docId}__${versionId(n)}`).set({ docId, version: n, deleteAfterMs: Date.now() + 30 * 86_400_000 });
  }

  const auditAction = { approve: 'document_approved', reject: 'document_rejected', reupload: 'reupload_requested', correction: 'correction_requested', manual: 'manual_verification' } as const;
  await audit({ action: auditAction[action], actor, instructorId: uid, docId, version: n, before: from, after: to, reason: reason || undefined, details: action === 'approve' ? vals : undefined });

  if (!opts.silent) {
    const label = docTypeLabel(type);
    const text: Record<DecisionAction, [string, string] | null> = {
      approve: [`${label} approved`, 'Thanks — your document has been verified.'],
      reject: [`${label} rejected`, reason],
      reupload: [`${label}: please upload it again`, reason],
      correction: [`${label}: please correct the details`, reason],
      manual: null,
    };
    const t = text[action];
    if (t) await notify(uid, { type: 'document_review', title: t[0], body: t[1], link: `/instructor/verification?doc=${type}` });
  }
  await recomputeEligibility(uid, `${DECISION_LABEL[action]}: ${docTypeLabel(type)}`, actor);
  return { status: to };
}

export const decideDocument = onCall(opts, async req => {
  await requirePermission(req, 'documents', req.data?.action === 'approve' ? 'approve' : req.data?.action === 'reject' ? 'reject' : 'edit');
  const action = String(req.data?.action) as DecisionAction;
  if (!(action in DECISION_RESULT)) fail('Unknown action.', 'invalid-argument');
  return applyDecision(docIdArg(req.data?.docId), nArg(req.data?.version), action, str(req.data?.reason, 1000), actorFrom(req, 'admin'));
});

/** Admin corrects extracted values (the original OCR value is kept alongside). */
export const correctDocumentFields = onCall(opts, async req => {
  await requirePermission(req, 'documents', 'edit');
  const docId = docIdArg(req.data?.docId), n = nArg(req.data?.version);
  const { parent, version } = await loadVersion(docId, n);
  const corrections = (req.data?.corrections ?? {}) as Record<string, unknown>;
  const allowed = new Set([...(docType(parent.type)?.fields ?? []), 'number', 'expiryDate', 'issueDate', 'fullName']);
  const actor = actorFrom(req, 'admin');
  const fields = { ...(version.fields ?? {}) } as Record<string, any>;
  const before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(corrections)) {
    if (!allowed.has(k)) fail(`Unknown field: ${k}`, 'invalid-argument');
    let value = str(raw, 200);
    if (/Date$|dateOfBirth/.test(k) && value) {
      const iso = normaliseExpiry(value) ?? parseDate(value);
      if (!iso) fail('Dates must be like 30/06/2029.', 'invalid-argument');
      value = iso;
    }
    before[k] = fields[k]?.correctedValue ?? fields[k]?.value ?? null;
    after[k] = value || null;
    fields[k] = { ...(fields[k] ?? { value: null, method: 'manual', confidence: null, band: 'unknown', page: null }), correctedValue: value || null, review: 'corrected', correctedBy: actor.uid, correctedByName: actor.name, correctedAt: new Date() };
  }
  await versionRef(docId, n).update({ fields });
  // A correction to the version currently relied on also updates the recorded expiry.
  if (parent.verifiedVersion === n && after.expiryDate) await docRef(docId).update({ verifiedExpiry: after.expiryDate, expiryState: expiryState(daysUntil(String(after.expiryDate))) });
  await audit({ action: 'fields_corrected', actor, instructorId: parent.instructorId, docId, version: n, before, after, reason: str(req.data?.note, 500) || undefined });
  if (parent.verifiedVersion === n) await recomputeEligibility(parent.instructorId, 'Details corrected', actor);
  return { ok: true };
});

/** Moves a version to another document category (it is processed again as that type). */
export const changeDocumentCategory = onCall(opts, async req => {
  await requirePermission(req, 'documents', 'edit');
  const docId = docIdArg(req.data?.docId), n = nArg(req.data?.version);
  const newType = typeArg(req.data?.newType);
  const reason = str(req.data?.reason, 500);
  const { parent, version } = await loadVersion(docId, n);
  if (parent.type === newType) fail('That is already its category.');
  if (version.status === 'moved') fail('This version was already moved.');
  const uid = parent.instructorId as string;
  const target = documentId(uid, newType);
  const actor = actorFrom(req, 'admin');
  const now = Date.now();
  const m = await db.runTransaction(async tx => {
    const t = await tx.get(docRef(target));
    const next = (t.data()?.latestVersion ?? 0) + 1;
    tx.set(docRef(target), {
      instructorId: uid, instructorName: parent.instructorName, type: newType, latestVersion: next, latestStatus: 'uploaded', uploadedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      testAccount: parent.testAccount ?? false,
      ...(t.exists ? {} : { createdAt: FieldValue.serverTimestamp(), verifiedVersion: null, verifiedExpiry: null, expiryState: 'valid' }),
    }, { merge: true });
    tx.set(versionRef(target, next), {
      n: next, type: newType, instructorId: uid, files: version.files, hashes: version.hashes ?? [], entered: version.entered ?? {},
      status: 'uploaded', uploadedAt: version.uploadedAt ?? FieldValue.serverTimestamp(), uploadedMs: version.uploadedMs ?? now, uploadedBy: version.uploadedBy ?? uid,
      movedFrom: { docId, version: n }, processing: { attempts: 0 }, trust: { extracted: false, checked: false, reviewed: false, confirmed: false },
    });
    tx.update(versionRef(docId, n), { status: 'moved', statusAt: FieldValue.serverTimestamp(), movedTo: { docId: target, version: next }, decision: { action: 'move', reason: reason || null, by: actor.uid, byName: actor.name, at: new Date() } });
    if (parent.latestVersion === n) tx.update(docRef(docId), { latestStatus: 'moved', updatedAt: FieldValue.serverTimestamp() });
    tx.set(jobRef(jobId(target, next)), { docId: target, version: next, instructorId: uid, status: 'queued', attempts: 0, nextAttemptAt: 0, leaseUntil: 0, waitingFor: null, createdAt: FieldValue.serverTimestamp(), createdMs: now });
    return next;
  });
  await audit({ action: 'category_changed', actor, instructorId: uid, docId, version: n, before: parent.type, after: newType, reason: reason || undefined, details: { newDocId: target, newVersion: m } });
  return { docId: target, version: m };
});

export const addDocumentNote = onCall(opts, async req => {
  await requirePermission(req, 'documents', 'edit');
  const docId = docIdArg(req.data?.docId), n = nArg(req.data?.version);
  const text = str(req.data?.text, 2000);
  if (!text) fail('Write a note first.');
  const { parent } = await loadVersion(docId, n);
  const actor = actorFrom(req, 'admin');
  await reviewRef(docId, n).set({ notes: FieldValue.arrayUnion({ text, by: actor.uid, byName: actor.name, at: new Date().toISOString() }) }, { merge: true });
  await audit({ action: 'note_added', actor, instructorId: parent.instructorId, docId, version: n, details: { text } });
  return { ok: true };
});

/** Records the result of an official check with the issuing authority (done by a person, outside the app). */
export const recordOfficialCheck = onCall(opts, async req => {
  await requirePermission(req, 'documents', 'approve');
  const docId = docIdArg(req.data?.docId), n = nArg(req.data?.version);
  const result = String(req.data?.result);
  if (!['confirmed', 'not_confirmed', 'unavailable'].includes(result)) fail('Choose a result.', 'invalid-argument');
  const reference = str(req.data?.reference, 200), note = str(req.data?.note, 1000);
  if (result === 'confirmed' && !reference) fail('Enter the reference or receipt of the official check.');
  const { parent } = await loadVersion(docId, n);
  const actor = actorFrom(req, 'admin');
  await versionRef(docId, n).update({ officialCheck: { result, reference: reference || null, note: note || null, by: actor.uid, byName: actor.name, at: new Date() }, 'trust.confirmed': result === 'confirmed' });
  await audit({ action: 'official_check_recorded', actor, instructorId: parent.instructorId, docId, version: n, after: result, details: { reference, note } });
  return { ok: true };
});

/** Retries (or re-runs) automatic processing for one version. Respects the pause switches. */
export const retryDocumentProcessing = onCall({ ...opts, timeoutSeconds: 300, memory: '1GiB' }, async req => {
  await requirePermission(req, 'ocr', 'edit');
  const docId = docIdArg(req.data?.docId), n = nArg(req.data?.version);
  const fresh = req.data?.fresh === true;
  const { parent, version } = await loadVersion(docId, n);
  if (version.status === 'moved') fail('This version was moved to another category.');
  const id = jobId(docId, n);
  const actor = actorFrom(req, 'admin');
  await jobRef(id).set({ docId, version: n, instructorId: parent.instructorId, status: 'queued', attempts: 0, nextAttemptAt: 0, leaseUntil: 0, waitingFor: null, lastError: null, updatedAt: FieldValue.serverTimestamp(), createdMs: Date.now() }, { merge: true });
  await audit({ action: 'processing_retried', actor, instructorId: parent.instructorId, docId, version: n, details: { fresh, previousStatus: version.status } });
  const outcome = await processJob(id, { manual: true, fresh });
  const settings = await getDocumentSettings(true);
  const message = outcome === 'waiting'
    ? (!settings.automation ? 'Document automation is paused. The job is saved and will run when automation is resumed.' : !isActive(settings, 'ocr') ? 'OCR is paused. The job is saved and will run when OCR is resumed.' : 'Waiting (monthly OCR limit reached).')
    : outcome === 'retry' ? 'OCR is temporarily unavailable. It will retry automatically.'
    : outcome === 'failed' ? 'Processing failed again. Review the document manually.'
    : outcome === 'skipped' ? 'Not processed (test mode applies automation to test accounts only).'
    : 'Processing finished.';
  return { outcome, message };
});

// ---------- Admin: settings and tools ----------

function diffSettings(a: DocumentSettings, b: DocumentSettings) {
  const changes: { key: string; before: unknown; after: unknown }[] = [];
  if (a.automation !== b.automation) changes.push({ key: 'automation', before: a.automation, after: b.automation });
  for (const f of FEATURE_INFO) if (a.features[f.key] !== b.features[f.key]) changes.push({ key: f.key, before: a.features[f.key], after: b.features[f.key] });
  if (a.testMode !== b.testMode) changes.push({ key: 'testMode', before: a.testMode, after: b.testMode });
  if (a.monthlyPageLimit !== b.monthlyPageLimit) changes.push({ key: 'monthlyPageLimit', before: a.monthlyPageLimit, after: b.monthlyPageLimit });
  for (const t of DOC_TYPE_KEYS) if (a.requirements[t] !== b.requirements[t]) changes.push({ key: `requirements.${t}`, before: a.requirements[t], after: b.requirements[t] });
  return changes;
}

export const saveDocumentSettings = onCall({ ...opts, timeoutSeconds: 300, memory: '1GiB' }, async req => {
  await requirePermission(req, 'ocr', 'settings');
  const actor = actorFrom(req, 'admin');
  const before = await getDocumentSettings(true);
  const next = documentSettingsFrom({ ...before, ...(req.data?.settings ?? {}), features: { ...before.features, ...(req.data?.settings?.features ?? {}) }, requirements: { ...before.requirements, ...(req.data?.settings?.requirements ?? {}) } });
  const changes = diffSettings(before, next);
  if (!changes.length) return { ok: true, changes: 0 };
  const reason = str(req.data?.reason, 500);
  await db.doc(SETTINGS_DOC).set({ ...next, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid, updatedByName: actor.name });
  forgetCachedSettings();
  for (const c of changes) await audit({ action: 'settings_changed', actor, before: { [c.key]: c.before }, after: { [c.key]: c.after }, reason: reason || undefined, details: { setting: c.key } });
  // Resumed: carry on with jobs that were waiting (each job is claimed once, so nothing runs twice).
  const resumed = changes.some(c => (c.key === 'automation' || c.key === 'ocr') && c.after === true) || changes.some(c => c.key === 'monthlyPageLimit');
  let queue: Awaited<ReturnType<typeof runQueue>> | null = null;
  if (resumed && isActive(next, 'ocr')) queue = await runQueue(10);
  // Requirement or eligibility changes: recalculate for every instructor with documents.
  if (changes.some(c => c.key.startsWith('requirements.') || (c.key === 'eligibilityUpdates' && c.after === true) || c.key === 'testMode')) {
    const instructors = await db.collection('users').where('role', '==', 'instructor').get();
    for (const u of instructors.docs) await recomputeEligibility(u.id, 'Document requirements changed', actor);
  }
  return { ok: true, changes: changes.length, queue };
});

/** Test accounts: in test mode, automation, reminders and eligibility changes apply only to these. */
export const setTestAccount = onCall(opts, async req => {
  await requirePermission(req, 'ocr', 'settings');
  const uid = str(req.data?.uid, 128);
  const value = req.data?.testAccount === true;
  const user = userFrom(await db.doc(`users/${uid}`).get());
  if (!user) fail('User not found.', 'not-found');
  await db.doc(`users/${uid}`).update({ testAccount: value });
  const docs = await db.collection('instructorDocuments').where('instructorId', '==', uid).get();
  for (const d of docs.docs) await d.ref.update({ testAccount: value });
  await audit({ action: 'test_account_changed', actor: actorFrom(req, 'admin'), instructorId: uid, before: !value, after: value });
  return { ok: true };
});

/** Creates document records for documents uploaded before this system (no file is re-read). */
export const importLegacyDocuments = onCall({ ...opts, timeoutSeconds: 540 }, async req => {
  await requirePermission(req, 'ocr', 'settings');
  const actor = actorFrom(req, 'admin');
  const only = str(req.data?.uid, 128);
  const users = only ? [await db.doc(`users/${only}`).get()] : (await db.collection('users').where('role', '==', 'instructor').get()).docs;
  let created = 0, skipped = 0;
  for (const u of users) {
    const user = userFrom(u);
    if (!user || user.role !== 'instructor') continue;
    const priv = (await db.doc(`users/${u.id}/private/profile`).get()).data() ?? {};
    const docs = { ...legacyVerificationDocs(priv.legacy), ...(priv.verification ?? {}) } as Record<string, any>;
    for (const type of LEGACY_DOC_TYPES) {
      const d = docs[type];
      if (!d?.url && !d?.path) continue;
      const id = documentId(u.id, type);
      if ((await docRef(id).get()).exists) { skipped++; continue; }
      const review = (user.documentReviews as Record<string, { status?: string }> | undefined)?.[type]?.status;
      const verified = user.verificationStatus === 'verified' && review !== 'pending' && review !== 'rejected';
      const status: DocStatus = verified ? 'verified' : review === 'rejected' ? 'rejected' : 'pending_verification';
      const expiry = normaliseExpiry(d.expiry);
      const files = [d.path ? { path: d.path, name: 'front', contentType: '', side: 'front' } : { url: d.url, name: 'front', side: 'front' },
        ...(d.backPath ? [{ path: d.backPath, name: 'back', contentType: '', side: 'back' }] : d.backUrl ? [{ url: d.backUrl, name: 'back', side: 'back' }] : [])];
      await docRef(id).set({ instructorId: u.id, instructorName: fullName(user), type, latestVersion: 1, latestStatus: status, verifiedVersion: verified ? 1 : null, verifiedExpiry: verified ? expiry : null, verifiedNumber: verified ? d.number ?? null : null,
        expiryState: verified ? expiryState(expiry ? daysUntil(expiry) : null) : 'valid', testAccount: (user as any).testAccount === true, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), imported: true });
      await versionRef(id, 1).set({ n: 1, type, instructorId: u.id, files, hashes: [], entered: { number: d.number ?? null, expiry, state: d.state ?? null, issueDate: null },
        status, uploadedAt: d.submittedAt ?? null, uploadedMs: 0, verifiedBeforeOcr: verified, imported: true,
        processing: { skipped: 'imported', note: 'Uploaded before automatic processing existed. Use Retry processing to read it.' },
        trust: { extracted: false, checked: false, reviewed: verified, confirmed: false } });
      await audit({ action: 'legacy_imported', actor, instructorId: u.id, docId: id, version: 1, after: status });
      created++;
    }
  }
  return { created, skipped };
});

export const runDocumentExpiryNow = onCall({ ...opts, timeoutSeconds: 540 }, async req => {
  await requirePermission(req, 'documents', 'edit');
  // A simulated date is only accepted in the local emulator (for testing reminders).
  const asOf = process.env.FUNCTIONS_EMULATOR === 'true' && typeof req.data?.asOf === 'string' ? new Date(req.data.asOf) : undefined;
  return runExpiryMonitor({ now: asOf, force: true });
});

export const documentUsage = onCall(opts, async req => {
  await requirePermission(req, 'ocr', 'view');
  const pages = await pagesUsedThisMonth();
  const queued = await db.collection('documentJobs').where('status', 'in', ['queued', 'running']).get();
  const failed = await db.collection('documentJobs').where('status', '==', 'failed').get();
  return { pages, estimatedUsd: estimateCostUsd(pages), queued: queued.size, waiting: queued.docs.filter(d => d.data().waitingFor).length, failed: failed.size };
});

/** Local emulator only: simulate OCR outages and run the queue on demand. */
export const documentTestHooks = onCall({ ...opts, timeoutSeconds: 300, memory: '1GiB' }, async (req: CallableRequest) => {
  requireSuperAdmin(req);
  if (process.env.FUNCTIONS_EMULATOR !== 'true') fail('Only available in the test emulator.', 'permission-denied');
  if (typeof req.data?.failNext === 'number') await failNextOcrCalls(req.data.failNext);
  if (req.data?.runQueue) return { queue: await runQueue(50) };
  if (typeof req.data?.cleanupAt === 'number') return { cleanup: await runDocumentCleanup(req.data.cleanupAt) };
  if (req.data?.forceDue) {
    const q = await db.collection('documentJobs').where('status', '==', 'queued').get();
    for (const d of q.docs) await d.ref.update({ nextAttemptAt: 0 });
    return { due: q.size };
  }
  return { ok: true };
});

/** Approving a whole instructor also verifies the core documents waiting in review. */
export async function approveCoreDocuments(uid: string, actor: Actor) {
  for (const type of LEGACY_DOC_TYPES) {
    const p = (await docRef(documentId(uid, type)).get()).data();
    if (!p?.latestVersion) continue;
    const v = (await versionRef(documentId(uid, type), p.latestVersion).get()).data();
    if (!v || !REVIEW_QUEUE.includes(v.status)) continue;
    try {
      await applyDecision(documentId(uid, type), p.latestVersion, 'approve', '', actor, { silent: true });
    } catch (err) {
      await audit({ action: 'manual_verification', actor: SYSTEM, instructorId: uid, docId: documentId(uid, type), version: p.latestVersion, reason: `Not approved with the instructor: ${(err as Error).message}` });
    }
  }
  await recomputeEligibility(uid, 'Instructor verified', actor);
}

export { versionId };
