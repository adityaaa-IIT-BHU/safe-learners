// Expiry monitoring and instructor eligibility. Both are independent of OCR and of the document
// automation switch: only their own switches ("Expiry monitoring", "Automatic eligibility updates")
// pause them. Reminders are recorded in documentNotifications with one record per document, expiry
// date and reminder stage, so the same reminder is never sent twice.
import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  DOCUMENT_REMINDER_SCHEDULE,
  LEGACY_DOC_TYPES,
  REVIEW_QUEUE,
  appliesTo,
  computeCompliance,
  daysUntil,
  describeCompliance,
  docTypeLabel,
  formatDocDateLong,
  isActive,
  reminderStage,
  reminderStageLabel,
  type Compliance,
  type DocStatus,
  type DocSummary,
  type DocTypeKey,
} from '../../../shared/documents';
import { fullName, legacyVerificationDocs, normaliseExpiry } from '../../../shared/domain';
import { DEFAULT_TIMEZONE, dayKey } from '../../../shared/time';
import { APP_URL, FieldValue, db, deliverEmail, emailFor, logger, notify, userFrom } from '../core';
import { SYSTEM, audit, docRef, getDocumentSettings, type Actor } from './store';

const REGION = 'australia-southeast1';
const MAX_EMAIL_ATTEMPTS = 4;

export type ExpiryState = 'valid' | 'expiring_soon' | 'expired';
export function expiryState(daysLeft: number | null): ExpiryState {
  if (daysLeft === null) return 'valid';
  if (daysLeft < 0) return 'expired';
  return daysLeft <= DOCUMENT_REMINDER_SCHEDULE.soonDays ? 'expiring_soon' : 'valid';
}

// ---------- Eligibility ----------

/** The documents an instructor relies on, from the new records, falling back to older profile records. */
export async function documentSummaries(uid: string, verifiedInstructor: boolean): Promise<DocSummary[]> {
  const snap = await db.collection('instructorDocuments').where('instructorId', '==', uid).get();
  const out: DocSummary[] = snap.docs.map(d => {
    const x = d.data();
    return { type: x.type as DocTypeKey, latestStatus: x.latestStatus as DocStatus, verifiedExpiry: x.verifiedExpiry ?? null, hasVerified: x.verifiedVersion != null };
  });
  // Instructors verified before document records existed: their accepted documents still count.
  const missingLegacy = LEGACY_DOC_TYPES.filter(t => !out.some(o => o.type === t));
  if (missingLegacy.length) {
    const priv = (await db.doc(`users/${uid}/private/profile`).get()).data() ?? {};
    const user = (await db.doc(`users/${uid}`).get()).data() ?? {};
    const legacy = { ...legacyVerificationDocs(priv.legacy), ...(priv.verification ?? {}) } as Record<string, any>;
    for (const t of missingLegacy) {
      const d = legacy[t];
      if (!d?.url && !d?.path) continue;
      const review = user.documentReviews?.[t]?.status;
      const accepted = verifiedInstructor && review !== 'pending' && review !== 'rejected';
      out.push({ type: t, latestStatus: accepted ? 'verified' : review === 'rejected' ? 'rejected' : 'pending_verification', verifiedExpiry: accepted ? normaliseExpiry(d.expiry) : null, hasVerified: accepted });
    }
  }
  return out;
}

/**
 * Recalculates whether an instructor meets the mandatory document rules and stores it on their
 * profile (checked by the booking functions). Does nothing while eligibility updates are paused, so
 * the last decision stands; pausing OCR or automation never changes eligibility.
 */
export async function recomputeEligibility(uid: string, reason: string, actor: Actor = SYSTEM, now = new Date()): Promise<Compliance | null> {
  const settings = await getDocumentSettings(true);
  if (!isActive(settings, 'eligibilityUpdates')) return null;
  const user = userFrom(await db.doc(`users/${uid}`).get());
  if (!user || user.role !== 'instructor' || !appliesTo(settings, user)) return null;
  const docs = await documentSummaries(uid, user.verificationStatus === 'verified');
  const c = computeCompliance(docs, settings.requirements, user.timezone ?? DEFAULT_TIMEZONE, now);
  const prev = (user as any).compliance as (Compliance & { enforced?: boolean }) | undefined;
  // Public profile: only whether new bookings are allowed. The details stay private (instructor + admins).
  await db.doc(`users/${uid}`).update({ compliance: { eligible: c.eligible, enforced: true, calculatedAt: FieldValue.serverTimestamp() } });
  await db.doc(`users/${uid}/private/compliance`).set({ ...c, calculatedAt: FieldValue.serverTimestamp(), reason });
  if (!prev || prev.eligible !== c.eligible) {
    await audit({ action: 'eligibility_changed', actor, instructorId: uid, before: prev ? { eligible: prev.eligible } : null, after: { eligible: c.eligible }, reason, details: { summary: describeCompliance(c) } });
    if (prev && prev.eligible && !c.eligible) {
      await notify(uid, { type: 'document_compliance', title: 'Action needed on your documents', body: `New bookings are paused until this is fixed. ${describeCompliance(c)}.`, link: '/instructor/verification', email: false });
      await notify('admin', { type: 'document_compliance', title: 'Instructor needs compliance action', body: `${fullName(user)}: ${describeCompliance(c)}`, link: `/admin/verifications?tab=compliance&instructor=${uid}`, email: false });
    } else if (prev && !prev.eligible && c.eligible) {
      await notify(uid, { type: 'document_compliance', title: 'Your documents are up to date', body: 'All mandatory documents are verified. You can take new bookings.', link: '/instructor/verification', email: false });
    }
  }
  return c;
}

// ---------- Expiry reminders ----------

function messages(name: string, label: string, expiry: string, daysLeft: number, renewalPending: boolean) {
  const date = formatDocDateLong(expiry);
  const expired = daysLeft < 0, today = daysLeft === 0;
  const title = expired ? 'Document Expired' : today ? 'Document Expires Today' : 'Document Expiring Soon';
  const instructor = renewalPending
    ? `Your ${label} ${expired ? `expired on ${date}` : today ? 'expires today' : `is due to expire on ${date}`}. Your renewed document has been received and is being reviewed.`
    : expired
      ? `Your ${label} expired on ${date}.\n\nPlease upload your renewed document as soon as possible to avoid any interruption to your verification status.`
      : `Your ${label} is due to expire on ${date}.\n\nPlease upload your renewed document before the expiry date to avoid any interruption to your verification status.`;
  const admin = `${name}'s ${label} ${expired ? `expired on ${date}` : today ? 'expires today' : `expires on ${date} (in ${daysLeft} days)`}.${renewalPending ? ' A renewal is waiting for review.' : ''}`;
  return { title, instructor, admin };
}

export interface ExpiryRunResult {
  skipped?: string;
  checked: number;
  generated: number;
  emailed: number;
  statusChanges: number;
  eligibilityChecked: number;
}

/**
 * Checks every verified document's expiry: updates Expiring soon / Expired, sends the reminder for
 * the current stage once, retries failed emails, and recalculates eligibility for those affected.
 */
export async function runExpiryMonitor(opts: { now?: Date; force?: boolean } = {}): Promise<ExpiryRunResult> {
  const now = opts.now ?? new Date();
  const res: ExpiryRunResult = { checked: 0, generated: 0, emailed: 0, statusChanges: 0, eligibilityChecked: 0 };
  const settings = await getDocumentSettings(true);
  if (!isActive(settings, 'expiryMonitoring')) return { ...res, skipped: 'Expiry monitoring is paused' };

  const horizon = dayKey(new Date(now.getTime() + (DOCUMENT_REMINDER_SCHEDULE.soonDays + 1) * 86_400_000));
  const hour = Number(new Intl.DateTimeFormat('en-AU', { timeZone: DEFAULT_TIMEZONE, hour: 'numeric', hourCycle: 'h23' }).format(now));
  const sendNow = opts.force || hour >= 8;
  const snap = await db.collection('instructorDocuments').where('verifiedExpiry', '<=', horizon).get();
  // Documents that were expiring and have since been renewed need their status reset too.
  const stale = await db.collection('instructorDocuments').where('expiryState', 'in', ['expiring_soon', 'expired']).get();
  const all = new Map([...snap.docs, ...stale.docs].map(d => [d.id, d]));
  const users = new Map<string, any>();
  const touched = new Set<string>();

  for (const d of all.values()) {
    const x = d.data();
    const uid = x.instructorId as string;
    if (!users.has(uid)) users.set(uid, userFrom(await db.doc(`users/${uid}`).get()));
    const user = users.get(uid);
    if (!user || !appliesTo(settings, user)) continue;
    res.checked++;
    const expiry: string | null = x.verifiedExpiry ?? null;
    const days = expiry ? daysUntil(expiry, user.timezone ?? DEFAULT_TIMEZONE, now) : null;
    const state = expiryState(days);
    if ((x.expiryState ?? 'valid') !== state) {
      await d.ref.update({ expiryState: state, updatedAt: FieldValue.serverTimestamp() });
      await audit({ action: 'expiry_status_changed', actor: SYSTEM, instructorId: uid, docId: d.id, version: x.verifiedVersion ?? undefined, before: x.expiryState ?? 'valid', after: state, details: { expiry, daysLeft: days } });
      res.statusChanges++;
      touched.add(uid);
    }
    if (!expiry || days === null || !sendNow) continue;
    const stage = reminderStage(days);
    if (!stage) continue;

    const label = docTypeLabel(x.type);
    const renewalPending = x.latestVersion !== x.verifiedVersion && REVIEW_QUEUE.includes(x.latestStatus);
    const m = messages(fullName(user), label, expiry, days, renewalPending);
    const ledger = db.doc(`documentNotifications/${d.id}__${expiry}__${stage}`);
    try {
      await ledger.create({
        docId: d.id, instructorId: uid, instructorName: fullName(user), type: x.type, expiry, stage, stageLabel: reminderStageLabel(stage), daysLeft: days,
        createdAt: FieldValue.serverTimestamp(), createdMs: now.getTime(),
        inApp: { instructor: true, admin: true },
        email: { status: 'pending', attempts: 0 },
      });
    } catch {
      continue; // already sent for this stage
    }
    res.generated++;
    touched.add(uid);
    await audit({ action: 'expiry_notification_generated', actor: SYSTEM, instructorId: uid, docId: d.id, details: { stage, expiry, daysLeft: days } });
    await notify(uid, { type: 'document_expiry', title: m.title, body: m.instructor.replace(/\n+/g, ' '), link: `/instructor/verification?doc=${x.type}`, email: false });
    await notify('admin', { type: 'document_expiry', title: `${m.title}: ${fullName(user)}`, body: m.admin, link: `/admin/verifications?tab=compliance&instructor=${uid}`, email: false });
    await sendReminderEmail(ledger.id, uid, user.firstName, m.title, m.instructor, x.type);
    res.emailed++;
  }

  // Retry emails that failed for a temporary reason.
  const failed = await db.collection('documentNotifications').where('email.status', '==', 'failed').limit(50).get();
  for (const f of failed.docs) {
    const e = f.data().email ?? {};
    if (!e.retryable || (e.attempts ?? 0) >= MAX_EMAIL_ATTEMPTS || (e.nextRetryAt ?? 0) > now.getTime()) continue;
    const x = f.data();
    const user = users.get(x.instructorId) ?? userFrom(await db.doc(`users/${x.instructorId}`).get());
    const m = messages(fullName(user), docTypeLabel(x.type), x.expiry, x.daysLeft, false);
    await sendReminderEmail(f.id, x.instructorId, user?.firstName ?? '', m.title, m.instructor, x.type);
  }

  for (const uid of touched) { if (await recomputeEligibility(uid, 'Expiry check', SYSTEM, now)) res.eligibilityChecked++; }
  return res;
}

async function sendReminderEmail(ledgerId: string, uid: string, firstName: string, title: string, body: string, type: string) {
  const ref = db.doc(`documentNotifications/${ledgerId}`);
  const to = await emailFor(uid);
  const prev = (await ref.get()).data()?.email ?? {};
  const attempts = Number(prev.attempts ?? 0) + 1;
  if (!to) {
    await ref.update({ email: { status: 'no_address', attempts } });
    return;
  }
  const text = `Hi ${firstName || 'there'},\n\n${body}\n\nUpload it here: ${APP_URL}/instructor/verification?doc=${type}\n\nThanks,\nThe Safe Learners team`;
  const r = await deliverEmail(to, title, text);
  await ref.update({
    email: {
      status: r.status, attempts, lastAttemptAt: FieldValue.serverTimestamp(),
      ...(r.error ? { lastError: r.error.slice(0, 300) } : {}),
      retryable: r.status === 'failed' && !!r.transient,
      ...(r.status === 'failed' && r.transient ? { nextRetryAt: Date.now() + attempts * 3_600_000 } : {}),
    },
  });
  if (r.status === 'sent') await audit({ action: 'expiry_notification_sent', actor: SYSTEM, instructorId: uid, details: { ledgerId, channel: 'email' } });
}

/** Hourly; reminders go out from 8 am Sydney time. Independent of OCR and document automation. */
export const documentExpiryMonitor = onSchedule({ region: REGION, schedule: 'every 60 minutes', timeZone: DEFAULT_TIMEZONE, timeoutSeconds: 540 }, async () => {
  const r = await runExpiryMonitor();
  if (r.generated || r.statusChanges) logger.info('document expiry', r);
});

/** Daily: removes OCR text 30 days after a final decision, and cached OCR results older than 30 days. */
export async function runDocumentCleanup(now = Date.now()): Promise<{ texts: number; cache: number }> {
  let texts = 0, cache = 0;
  const due = await db.collection('ocrTextCleanup').where('deleteAfterMs', '<=', now).limit(400).get();
  for (const d of due.docs) {
    const { docId, version } = d.data();
    await db.doc(`instructorDocuments/${docId}/versions/v${String(version).padStart(3, '0')}/admin/review`).set({ ocrText: FieldValue.delete(), ocrTextRemovedAt: FieldValue.serverTimestamp() }, { merge: true });
    await d.ref.delete();
    texts++;
  }
  const old = await db.collection('ocrCache').where('createdMs', '<=', now - 30 * 86_400_000).limit(400).get();
  for (const d of old.docs) { await d.ref.delete(); cache++; }
  return { texts, cache };
}

export const documentDataCleanup = onSchedule({ region: REGION, schedule: 'every day 03:15', timeZone: DEFAULT_TIMEZONE, timeoutSeconds: 300 }, async () => {
  const r = await runDocumentCleanup();
  if (r.texts || r.cache) logger.info('document data cleanup', r);
});

export { docRef };
