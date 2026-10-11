import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore, type DocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { dayKey } from '../../shared/time';
import {
  formatBookingRef,
  normaliseBooking,
  normaliseUser,
  type Booking,
  type BookingHistoryEntry,
  type UserProfile,
} from '../../shared/domain';

initializeApp();
export const db = getFirestore();
export const auth = getAuth();
export { FieldValue, Timestamp, logger };

export const REGION = 'australia-southeast1';
export const APP_URL = process.env.APP_URL || 'https://australiadrivingproj.web.app';
// Admins: accounts listed by UID, or emails on the list that have been verified (see isAdminAccount).
// No built-in fallback, so a missing config can never hand admin to whoever registers an address first.
const listEnv = (name: string) => (process.env[name] || '').split(',').map(e => e.trim()).filter(Boolean);
const ADMIN_EMAILS = listEnv('ADMIN_EMAILS').map(e => e.toLowerCase());
const ADMIN_UIDS = listEnv('ADMIN_UIDS');

export function toDate(v: any): Date | undefined {
  if (!v) return undefined;
  if (v instanceof Timestamp) return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export function bookingFrom(snap: DocumentSnapshot): Booking | null {
  if (!snap.exists) return null;
  return normaliseBooking(snap.id, snap.data()!, toDate);
}

export function userFrom(snap: DocumentSnapshot): UserProfile | null {
  if (!snap.exists) return null;
  return normaliseUser(snap.id, snap.data()!, toDate);
}

// ---------- Auth guards ----------

/** Whether this signed-in account may be an admin: listed by UID, or a verified email on the list. */
export function isAdminAccount(uid: string, token: { email?: string; email_verified?: boolean }): boolean {
  if (ADMIN_UIDS.includes(uid)) return true;
  return !!token.email && token.email_verified === true && ADMIN_EMAILS.includes(token.email.toLowerCase());
}

export function adminEmails(): string[] {
  return ADMIN_EMAILS;
}

export function requireAuth(req: CallableRequest): string {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please sign in.');
  return req.auth.uid;
}

export function requireAdmin(req: CallableRequest): string {
  const uid = requireAuth(req);
  // Only the custom claim counts; it's granted by onboardUser after the checks in isAdminAccount.
  if (req.auth!.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admins only.');
  }
  return uid;
}

export async function requireUser(uid: string, role?: UserProfile['role']): Promise<UserProfile> {
  const user = userFrom(await db.doc(`users/${uid}`).get());
  if (!user) throw new HttpsError('failed-precondition', 'Your profile could not be found.');
  if (user.accountStatus === 'disabled') throw new HttpsError('permission-denied', 'Your account has been disabled.');
  if (role && user.role !== role) throw new HttpsError('permission-denied', `Only ${role}s can do this.`);
  return user;
}

export function fail(message: string, code: 'failed-precondition' | 'invalid-argument' | 'not-found' | 'permission-denied' = 'failed-precondition'): never {
  throw new HttpsError(code, message);
}

// ---------- Booking writes ----------

/** Full new-schema fields for a booking, so legacy docs are upgraded whenever they are touched. */
export function bookingFields(b: Booking): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: b.kind,
    status: b.status,
    instructorId: b.instructorId,
    startAt: Timestamp.fromDate(b.startAt),
    endAt: Timestamp.fromDate(b.endAt),
    timezone: b.timezone,
  };
  const optional: (keyof Booking)[] = [
    'ref', 'instructorName', 'instructorMobile', 'learnerId', 'learnerName', 'lessonType', 'title', 'transmission', 'pickupLocation',
    'dropoffLocation', 'testLocation', 'notes', 'price', 'paymentStatus', 'proposedBy', 'cancelledBy',
    'cancellationReason', 'rescheduledFrom', 'rescheduledTo', 'reviewed',
  ];
  for (const key of optional) if (b[key] !== undefined) out[key] = b[key];
  return out;
}

export function historyEntry(action: string, by: BookingHistoryEntry['by'], byName?: string) {
  return { at: Timestamp.now(), action, by, ...(byName ? { byName } : {}) };
}

/** Bookings belonging to an instructor, read inside a transaction. */
export async function instructorBookings(tx: Transaction, instructorId: string): Promise<Booking[]> {
  const snap = await tx.get(db.collection('bookings').where('instructorId', '==', instructorId));
  return snap.docs.map(d => normaliseBooking(d.id, d.data(), toDate)).filter((b): b is Booking => !!b);
}

// ---------- Booking references ----------

/** Reads the per-day counter (must run before any transaction writes); returns a commit function. */
export async function reserveRef(tx: Transaction, startAt: Date, timeZone: string) {
  const key = dayKey(startAt, timeZone).replace(/-/g, '');
  const ref = db.doc(`counters/booking-refs-${key}`);
  const snap = await tx.get(ref);
  const next = (snap.exists ? Number(snap.data()!.count || 0) : 0) + 1;
  return {
    value: formatBookingRef(startAt, next, timeZone),
    commit: () => tx.set(ref, { count: next, date: key }, { merge: true }),
  };
}

// ---------- Wallet ----------

/** Records a wallet movement inside a transaction. Positive = credit. */
export function walletEntry(
  tx: Transaction,
  userId: string,
  currentBalance: number,
  amount: number,
  entry: { type: 'booking' | 'refund' | 'topup' | 'referral' | 'adjustment' | 'charge'; note: string; bookingId?: string },
): number {
  const balanceAfter = Math.round((currentBalance + amount) * 100) / 100;
  tx.update(db.doc(`users/${userId}`), { walletBalance: balanceAfter });
  tx.set(db.collection(`users/${userId}/transactions`).doc(), {
    amount,
    balanceAfter,
    ...entry,
    createdAt: FieldValue.serverTimestamp(),
  });
  return balanceAfter;
}

// ---------- Notifications ----------

export interface NotificationInput {
  title: string;
  body: string;
  link?: string;
  type?: string;
  email?: boolean;
}

/** In-app notification (realtime bell) plus an optional email. Never throws. */
export async function notify(userId: string | undefined, n: NotificationInput): Promise<void> {
  if (!userId) return;
  try {
    await db.collection('notifications').add({
      userId,
      title: n.title,
      body: n.body,
      link: n.link ?? null,
      type: n.type ?? 'general',
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    logger.error('notification write failed', err);
  }
  if (n.email === false) return;
  const to = await emailFor(userId);
  if (to) await sendEmail(to, n.title, `${n.body}\n\n${APP_URL}${n.link ?? ''}`);
}

export async function notifyAdmins(n: NotificationInput): Promise<void> {
  await notify('admin', { ...n, email: false });
  for (const email of adminEmails()) await sendEmail(email, `[Admin] ${n.title}`, `${n.body}\n\n${APP_URL}${n.link ?? ''}`);
}

async function emailFor(userId: string): Promise<string | undefined> {
  try {
    const user = await auth.getUser(userId);
    if (user.email) return user.email;
  } catch {
    // Invited learners have no auth account yet
  }
  const doc = await db.doc(`users/${userId}`).get();
  return doc.data()?.email || doc.data()?.inviteEmail;
}

/**
 * Sends email through Resend when RESEND_API_KEY is configured (backend/.env.<project>).
 * Without it, notifications are in-app only and the email is logged.
 */
export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'Safe Learners <notifications@safelearners.com.au>';
  if (!key) {
    logger.info('Email not sent (RESEND_API_KEY not configured)', { to, subject });
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, html: emailHtml(subject, text) }),
    });
    if (!res.ok) {
      logger.error('Email send failed', { status: res.status, body: await res.text() });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('Email send failed', err);
    return false;
  }
}

function emailHtml(subject: string, text: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const body = esc(text)
    .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" style="color:#4f46e5">$1</a>')
    .replace(/\n/g, '<br>');
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
    <div style="font-weight:800;font-size:18px;margin-bottom:16px">Safe Learners</div>
    <h2 style="font-size:20px;margin:0 0 12px">${esc(subject)}</h2>
    <p style="line-height:1.6;color:#334155">${body}</p>
  </div>`;
}
