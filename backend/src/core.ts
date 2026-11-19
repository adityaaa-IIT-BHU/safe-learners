import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp, getFirestore, type DocumentSnapshot, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import { dayKey } from '../../shared/time';
import { MODULES, allows, isSuperOnlyModule, type Action, type ModuleKey, type Perms } from '../../shared/access';
import {
  formatBookingRef,
  normaliseBooking,
  normaliseUser,
  refundableFromWallet,
  type Booking,
  type BookingHistoryEntry,
  type PaymentStatus,
  type UserProfile,
} from '../../shared/domain';

initializeApp();
export const db = getFirestore();
// Optional values (e.g. a comparison note) may be undefined: leave them out instead of failing the write.
db.settings({ ignoreUndefinedProperties: true });
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

// ---------- Access hierarchy ----------
// Cybria Super Admin: SUPER_ADMIN_UIDS, or a *verified* email on SUPER_ADMIN_EMAILS (server
// configuration only; never grantable in the app). Client admins: adminAccounts/{uid} with a status
// and per-module permissions, copied into the sign-in token (admin: true, pm: { module: letters }).
const SUPER_ADMIN_UIDS = listEnv('SUPER_ADMIN_UIDS');
const SUPER_ADMIN_EMAILS = listEnv('SUPER_ADMIN_EMAILS').map(e => e.toLowerCase());

export function isSuperAccount(uid: string, token: { email?: string; email_verified?: boolean }): boolean {
  if (SUPER_ADMIN_UIDS.includes(uid)) return true;
  return !!token.email && token.email_verified === true && SUPER_ADMIN_EMAILS.includes(token.email.toLowerCase());
}

export const isSuper = (req: CallableRequest) => req.auth?.token.sa === true && isSuperAccount(req.auth.uid, req.auth.token);

const acctCache = new Map<string, { at: number; acct: { status: string; perms: Perms } | null }>();
/** A client admin's live account (status and permissions), re-read every few seconds so changes bite at once. */
export async function adminAccountOf(uid: string): Promise<{ status: string; perms: Perms } | null> {
  const c = acctCache.get(uid);
  if (c && Date.now() - c.at < 5_000) return c.acct;
  const d = (await db.doc(`adminAccounts/${uid}`).get()).data();
  const acct = d ? { status: String(d.status ?? ''), perms: (d.perms ?? {}) as Perms } : null;
  acctCache.set(uid, { at: Date.now(), acct });
  return acct;
}
export const forgetAdminAccount = (uid: string) => acctCache.delete(uid);

export function requireSuperAdmin(req: CallableRequest): string {
  const uid = requireAuth(req);
  if (!isSuper(req)) throw new HttpsError('permission-denied', 'Cybria Super Admin only.');
  return uid;
}

/** Any active admin (super, or a client admin whose account is active). */
export async function requireAnyAdmin(req: CallableRequest): Promise<string> {
  const uid = requireAuth(req);
  if (isSuper(req)) return uid;
  if (req.auth!.token.admin !== true || (await adminAccountOf(uid))?.status !== 'active') throw new HttpsError('permission-denied', 'Admins only.');
  return uid;
}

/** The admin may perform `action` in `module` (always true for Cybria Super Admin). Enforced on the server. */
export async function requirePermission(req: CallableRequest, module: ModuleKey, action: Action): Promise<string> {
  const uid = requireAuth(req);
  if (isSuper(req)) return uid;
  if (isSuperOnlyModule(module)) throw new HttpsError('permission-denied', 'Cybria Super Admin only.');
  const acct = req.auth!.token.admin === true ? await adminAccountOf(uid) : null;
  if (!acct || acct.status !== 'active') throw new HttpsError('permission-denied', 'Admins only.');
  if (!allows(acct.perms, module, action)) {
    throw new HttpsError('permission-denied', `You don’t have permission to ${action === 'settings' ? 'change the settings in' : action === 'export' ? 'export from' : action} ${MODULES.find(m => m.key === module)!.label}. Ask Cybria to change your access.`);
  }
  return uid;
}

/** Whether the caller may do this, without throwing (for optional admin paths). */
export async function hasPermission(req: CallableRequest, module: ModuleKey, action: Action): Promise<boolean> {
  try { await requirePermission(req, module, action); return true; } catch { return false; }
}

/** @deprecated use requirePermission / requireSuperAdmin. Kept for any path not yet mapped: super admin only. */
export function requireAdmin(req: CallableRequest): string {
  return requireSuperAdmin(req);
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
    'dropoffLocation', 'testLocation', 'testLocationAddress', 'notes', 'experience', 'testBooked', 'price', 'paymentStatus', 'walletPaid', 'proposedBy', 'cancelledBy',
    'cancellationReason', 'rescheduledFrom', 'rescheduledTo', 'reviewed', 'applyBuffer', 'area', 'areas', 'repeatGroupId',
  ];
  for (const key of optional) if (b[key] !== undefined) out[key] = b[key];
  if (b.expiresAt) out.expiresAt = Timestamp.fromDate(b.expiresAt);
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
  entry: {
    type: 'booking' | 'refund' | 'topup' | 'referral' | 'adjustment' | 'charge' | 'refund_payout';
    note: string;
    bookingId?: string;
    /** Where the money came from or went (finance records read these). */
    category?: string;
    paymentMethod?: string;
    paymentReference?: string;
    addedBy?: string;
    refundRequestId?: string;
    referralOf?: string;
    /** A later payment of a lesson's outstanding balance. */
    balancePayment?: boolean;
  },
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

const dollars = (n: number) => `$${n.toFixed(2)}`;

/**
 * Pays a lesson from the wallet inside a transaction: the full price when the balance covers it,
 * otherwise whatever credit there is (the rest is due before the lesson), or nothing at a $0 balance.
 */
export function payFromWallet(
  tx: Transaction,
  learnerId: string,
  balance: number,
  price: number,
  booking: { id: string; ref?: string },
): { balance: number; walletPaid: number; paymentStatus: PaymentStatus } {
  const take = Math.round(Math.min(Math.max(balance, 0), price) * 100) / 100;
  if (!(take > 0)) return { balance, walletPaid: 0, paymentStatus: 'unpaid' };
  const full = take >= price;
  const ref = booking.ref ?? '';
  const note = full ? `Booking ${ref}`.trim() : `Booking ${ref} (part payment, ${dollars(price - take)} still due)`.replace('  ', ' ');
  const after = walletEntry(tx, learnerId, balance, -take, { type: 'booking', note, bookingId: booking.id });
  return { balance: after, walletPaid: take, paymentStatus: full ? 'paid' : 'part_paid' };
}

/**
 * Returns to the wallet exactly what a lesson took from it, once. A booking that wasn't paid from the
 * wallet, or was already refunded or kept as a fee, is left as it is.
 */
export function refundToWallet(
  tx: Transaction,
  booking: Booking,
  balance: number,
  note: string,
): { balance: number; paymentStatus: PaymentStatus | undefined; refunded: number } {
  const amount = refundableFromWallet(booking);
  if (!(amount > 0) || !booking.learnerId) return { balance, paymentStatus: booking.paymentStatus, refunded: 0 };
  const after = walletEntry(tx, booking.learnerId, balance, amount, { type: 'refund', note, bookingId: booking.id });
  return { balance: after, paymentStatus: 'refunded', refunded: amount };
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

/** Notifications for Cybria Super Admins only (document verification, OCR and automation). */
export async function notifyCybria(n: NotificationInput): Promise<void> {
  await notify('cybria', { ...n, email: false });
}

export async function emailFor(userId: string): Promise<string | undefined> {
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
  return (await deliverEmail(to, subject, text)).status === 'sent';
}

export interface EmailResult {
  status: 'sent' | 'failed' | 'not_configured';
  /** A failure worth retrying (network, rate limit, provider error). */
  transient?: boolean;
  error?: string;
}

/** Sends one email and reports exactly what happened (for delivery tracking and retries). */
export async function deliverEmail(to: string, subject: string, text: string): Promise<EmailResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'Safe Learners <notifications@safelearners.com.au>';
  if (!key) {
    logger.info('Email not sent (RESEND_API_KEY not configured)', { to, subject });
    // Local emulator only: keep a copy so tests can check what would have been sent.
    if (process.env.FUNCTIONS_EMULATOR === 'true') {
      await db.collection('devEmails').add({ to, subject, text, html: emailHtml(subject, text), createdAt: FieldValue.serverTimestamp() }).catch(() => {});
    }
    return { status: 'not_configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, html: emailHtml(subject, text) }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      logger.error('Email send failed', { status: res.status, body });
      return { status: 'failed', transient: res.status === 429 || res.status >= 500, error: `HTTP ${res.status}: ${body}` };
    }
    return { status: 'sent' };
  } catch (err) {
    logger.error('Email send failed', err);
    return { status: 'failed', transient: true, error: err instanceof Error ? err.message : String(err) };
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
