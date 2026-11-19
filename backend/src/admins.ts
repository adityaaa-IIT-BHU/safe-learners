// Cybria Super Admin: client admin accounts, roles and permissions, login history, the admin audit
// trail and the platform dashboard. Every function here is Super Admin only, except recording one's
// own admin login. Super Admins themselves are set only in server configuration (SUPER_ADMIN_*).
import { randomUUID } from 'node:crypto';
import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { BUILT_IN_ROLES, cleanPerms, type AdminStatus, type Perms } from '../../shared/access';
import { APP_URL, FieldValue, Timestamp, auth, db, fail, forgetAdminAccount, isAdminAccount, isSuper, isSuperAccount, logger, requireAuth, requireSuperAdmin, userFrom } from './core';

const opts = { region: 'australia-southeast1', cors: true };
const acctRef = (uid: string) => db.doc(`adminAccounts/${uid}`);
const roleRef = (id: string) => db.doc(`adminRoles/${id}`);

interface Actor { uid: string; name: string }
const actorOf = (req: CallableRequest): Actor => {
  const t = req.auth?.token as { name?: string; email?: string } | undefined;
  return { uid: req.auth!.uid, name: t?.email || t?.name || req.auth!.uid };
};
const ipOf = (req: CallableRequest) => String(req.rawRequest?.headers?.['x-forwarded-for'] ?? req.rawRequest?.ip ?? '').split(',')[0].trim() || null;
const reasonArg = (v: unknown, min = 3) => {
  const s = typeof v === 'string' ? v.trim().slice(0, 500) : '';
  if (s.length < min) fail('Please give a reason.', 'invalid-argument');
  return s;
};

export async function adminAudit(req: CallableRequest | null, e: { action: string; targetUid?: string; targetName?: string; before?: unknown; after?: unknown; reason?: string; details?: Record<string, unknown> }) {
  const actor = req ? actorOf(req) : { uid: 'system', name: 'System' };
  await db.collection('adminAudit').add({
    ...e, before: e.before ?? null, after: e.after ?? null,
    actor, ip: req ? ipOf(req) : null, userAgent: req ? String(req.rawRequest?.headers?.['user-agent'] ?? '').slice(0, 200) || null : null,
    at: FieldValue.serverTimestamp(), atMs: Date.now(),
  }).catch(err => logger.error('admin audit failed', { error: String(err) }));
}

/** Built-in role templates are created on first use; Cybria can edit them afterwards. */
async function ensureRoles() {
  const snap = await db.collection('adminRoles').limit(1).get();
  if (!snap.empty) return;
  const batch = db.batch();
  for (const r of BUILT_IN_ROLES) batch.set(roleRef(r.id), { name: r.name, description: r.description, perms: r.perms, builtIn: true, createdAt: FieldValue.serverTimestamp() });
  await batch.commit();
}

// ---------- Claims ----------

/**
 * The sign-in claims an account should hold. Super Admin: { admin, sa }. Active client admin:
 * { admin }. Everyone else: none. (Permissions are read live from adminAccounts, never from claims.)
 * Accounts listed in the older ADMIN_UIDS / ADMIN_EMAILS configuration become client admins with the
 * Client Main Admin role the first time they sign in.
 */
export async function desiredClaims(uid: string, token: { email?: string; email_verified?: boolean }): Promise<Record<string, boolean>> {
  if (isSuperAccount(uid, token)) return { admin: true, sa: true };
  let acct = (await acctRef(uid).get()).data();
  if (!acct && isAdminAccount(uid, token)) {
    await ensureRoles();
    const role = (await roleRef('client_main_admin').get()).data();
    acct = { email: token.email ?? null, status: 'active', roleId: 'client_main_admin', roleName: role?.name ?? 'Client Main Admin', perms: cleanPerms(role?.perms), customised: false,
      createdAt: FieldValue.serverTimestamp(), createdBy: { uid: 'system', name: 'Migrated from server configuration' } };
    await acctRef(uid).set(acct);
    await adminAudit(null, { action: 'admin_migrated', targetUid: uid, after: { roleId: 'client_main_admin' }, reason: 'Listed in the existing admin configuration' });
  }
  return acct?.status === 'active' ? { admin: true } : {};
}

async function applyClaims(uid: string, opts2: { revoke?: boolean } = {}) {
  const user = await auth.getUser(uid);
  const want = await desiredClaims(uid, { email: user.email, email_verified: user.emailVerified });
  await auth.setCustomUserClaims(uid, want);
  if (opts2.revoke) await auth.revokeRefreshTokens(uid);
  forgetAdminAccount(uid);
}

// ---------- Client admin accounts ----------

export const createClientAdmin = onCall(opts, async req => {
  requireSuperAdmin(req);
  await ensureRoles();
  const email = String(req.data?.email ?? '').trim().toLowerCase();
  const firstName = String(req.data?.firstName ?? '').trim().slice(0, 60);
  const surname = String(req.data?.surname ?? '').trim().slice(0, 60);
  const roleId = String(req.data?.roleId ?? '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Enter a valid email address.', 'invalid-argument');
  if (!firstName) fail('Enter the administrator’s first name.', 'invalid-argument');
  const role = (await roleRef(roleId).get()).data();
  if (!role) fail('Choose a role.', 'invalid-argument');
  let user = await auth.getUserByEmail(email).catch(() => null);
  if (user) {
    const existing = userFrom(await db.doc(`users/${user.uid}`).get());
    if (existing && existing.role !== 'admin') fail(`This email already belongs to a ${existing.role} account. Use a separate email for admin access.`);
    if (isSuperAccount(user.uid, { email: user.email, email_verified: user.emailVerified })) fail('This is a Cybria Super Admin account.');
    if ((await acctRef(user.uid).get()).exists) fail('This person is already an administrator.');
  } else {
    user = await auth.createUser({ email, displayName: `${firstName} ${surname}`.trim(), emailVerified: false });
  }
  const uid = user.uid;
  await db.doc(`users/${uid}`).set({ role: 'admin', firstName, surname, email, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  const perms = cleanPerms(role!.perms);
  await acctRef(uid).set({ email, firstName, surname, status: 'active', roleId, roleName: role!.name, perms, customised: false, notes: [],
    createdAt: FieldValue.serverTimestamp(), createdBy: actorOf(req) });
  await applyClaims(uid);
  // A one-time link to set their own password (nobody else ever sees or sets it).
  const link = await auth.generatePasswordResetLink(email, { url: `${APP_URL}/login` });
  await adminAudit(req, { action: 'admin_created', targetUid: uid, targetName: `${firstName} ${surname}`.trim(), after: { email, roleId, roleName: role!.name, perms } });
  return { uid, setPasswordLink: link };
});

export const updateClientAdmin = onCall(opts, async req => {
  requireSuperAdmin(req);
  const uid = String(req.data?.uid ?? '');
  const acct = (await acctRef(uid).get()).data();
  if (!acct) fail('Administrator not found.', 'not-found');
  const firstName = String(req.data?.firstName ?? acct!.firstName ?? '').trim().slice(0, 60);
  const surname = String(req.data?.surname ?? acct!.surname ?? '').trim().slice(0, 60);
  if (!firstName) fail('Enter the first name.', 'invalid-argument');
  await acctRef(uid).update({ firstName, surname, updatedAt: FieldValue.serverTimestamp() });
  await db.doc(`users/${uid}`).set({ firstName, surname }, { merge: true });
  await adminAudit(req, { action: 'admin_details_changed', targetUid: uid, targetName: `${firstName} ${surname}`.trim(), before: { firstName: acct!.firstName, surname: acct!.surname }, after: { firstName, surname } });
  return { ok: true };
});

/** Activate, suspend (no admin access, can be reinstated), deactivate (sign-in disabled too) or reinstate. */
export const setClientAdminStatus = onCall(opts, async req => {
  requireSuperAdmin(req);
  const uid = String(req.data?.uid ?? '');
  const status = String(req.data?.status ?? '') as AdminStatus;
  if (!['active', 'suspended', 'deactivated'].includes(status)) fail('Unknown status.', 'invalid-argument');
  const reason = reasonArg(req.data?.reason);
  const acct = (await acctRef(uid).get()).data();
  if (!acct) fail('Administrator not found.', 'not-found');
  if (acct!.status === status) fail(`Already ${status}.`);
  await acctRef(uid).update({ status, statusReason: reason, statusAt: FieldValue.serverTimestamp() });
  await auth.updateUser(uid, { disabled: status === 'deactivated' });
  await applyClaims(uid, { revoke: status !== 'active' });
  await adminAudit(req, { action: `admin_${status === 'active' ? 'reinstated' : status}`, targetUid: uid, targetName: `${acct!.firstName ?? ''} ${acct!.surname ?? ''}`.trim(), before: acct!.status, after: status, reason });
  return { ok: true };
});

/** Assigns a role and/or individual permissions. Never grants anything Super Admin only. */
export const setClientAdminAccess = onCall(opts, async req => {
  requireSuperAdmin(req);
  const uid = String(req.data?.uid ?? '');
  const reason = reasonArg(req.data?.reason);
  const acct = (await acctRef(uid).get()).data();
  if (!acct) fail('Administrator not found.', 'not-found');
  let roleId: string = acct!.roleId, roleName: string = acct!.roleName, perms: Perms, customised = false;
  if (req.data?.roleId && req.data.roleId !== acct!.roleId) {
    const role = (await roleRef(String(req.data.roleId)).get()).data();
    if (!role) fail('Role not found.', 'not-found');
    roleId = String(req.data.roleId); roleName = role!.name; perms = cleanPerms(role!.perms);
  } else perms = cleanPerms(acct!.perms);
  if (req.data?.perms) {
    perms = cleanPerms(req.data.perms);
    const role = (await roleRef(roleId).get()).data();
    customised = JSON.stringify(perms) !== JSON.stringify(cleanPerms(role?.perms));
  }
  await acctRef(uid).update({ roleId, roleName, perms, customised, accessUpdatedAt: FieldValue.serverTimestamp() });
  forgetAdminAccount(uid);
  await adminAudit(req, { action: 'admin_permissions_changed', targetUid: uid, targetName: `${acct!.firstName ?? ''} ${acct!.surname ?? ''}`.trim(),
    before: { roleId: acct!.roleId, roleName: acct!.roleName, perms: acct!.perms }, after: { roleId, roleName, perms, customised }, reason });
  return { ok: true, perms, customised };
});

export const revokeAdminSessions = onCall(opts, async req => {
  requireSuperAdmin(req);
  const uid = String(req.data?.uid ?? '');
  const reason = reasonArg(req.data?.reason);
  if (!(await acctRef(uid).get()).exists) fail('Administrator not found.', 'not-found');
  await auth.revokeRefreshTokens(uid);
  await adminAudit(req, { action: 'admin_sessions_revoked', targetUid: uid, reason });
  return { ok: true };
});

export const addAdminNote = onCall(opts, async req => {
  requireSuperAdmin(req);
  const uid = String(req.data?.uid ?? '');
  const text = String(req.data?.text ?? '').trim().slice(0, 2000);
  if (!text) fail('Write a note first.', 'invalid-argument');
  if (!(await acctRef(uid).get()).exists) fail('Administrator not found.', 'not-found');
  const a = actorOf(req);
  await acctRef(uid).update({ notes: FieldValue.arrayUnion({ id: randomUUID(), text, by: a.name, at: new Date().toISOString() }) });
  await adminAudit(req, { action: 'admin_note_added', targetUid: uid, details: { text } });
  return { ok: true };
});

/** A fresh one-time link for the administrator to set a new password (sent by Cybria securely). */
export const adminPasswordLink = onCall(opts, async req => {
  requireSuperAdmin(req);
  const uid = String(req.data?.uid ?? '');
  const acct = (await acctRef(uid).get()).data();
  if (!acct) fail('Administrator not found.', 'not-found');
  const user = await auth.getUser(uid);
  const link = await auth.generatePasswordResetLink(user.email!, { url: `${APP_URL}/login` });
  await adminAudit(req, { action: 'admin_password_link', targetUid: uid, reason: String(req.data?.reason ?? '').slice(0, 300) || undefined });
  return { link };
});

// ---------- Roles ----------

export const saveAdminRole = onCall(opts, async req => {
  requireSuperAdmin(req);
  await ensureRoles();
  const id = req.data?.id ? String(req.data.id) : `role_${randomUUID().slice(0, 8)}`;
  const name = String(req.data?.name ?? '').trim().slice(0, 60);
  const description = String(req.data?.description ?? '').trim().slice(0, 300);
  if (!name) fail('Name the role.', 'invalid-argument');
  const perms = cleanPerms(req.data?.perms);
  const reason = reasonArg(req.data?.reason);
  const before = (await roleRef(id).get()).data() ?? null;
  await roleRef(id).set({ name, description, perms, builtIn: before?.builtIn ?? false, updatedAt: FieldValue.serverTimestamp(), ...(before ? {} : { createdAt: FieldValue.serverTimestamp() }) }, { merge: true });
  // Administrators on this role (without individual changes) follow it.
  const users = await db.collection('adminAccounts').where('roleId', '==', id).get();
  let updated = 0;
  for (const u of users.docs) {
    if (u.data().customised) { await u.ref.update({ roleName: name }); continue; }
    await u.ref.update({ roleName: name, perms, accessUpdatedAt: FieldValue.serverTimestamp() });
    forgetAdminAccount(u.id);
    updated++;
  }
  await adminAudit(req, { action: before ? 'role_changed' : 'role_created', details: { roleId: id, name, accountsUpdated: updated }, before: before ? { name: before.name, perms: before.perms } : null, after: { name, perms }, reason });
  return { id, accountsUpdated: updated };
});

export const deleteAdminRole = onCall(opts, async req => {
  requireSuperAdmin(req);
  const id = String(req.data?.id ?? '');
  const reason = reasonArg(req.data?.reason);
  const role = (await roleRef(id).get()).data();
  if (!role) fail('Role not found.', 'not-found');
  const inUse = await db.collection('adminAccounts').where('roleId', '==', id).limit(1).get();
  if (!inUse.empty) fail('Administrators still use this role. Move them to another role first.');
  await roleRef(id).delete();
  await adminAudit(req, { action: 'role_deleted', before: { id, name: role!.name, perms: role!.perms }, reason });
  return { ok: true };
});

export const ensureAdminRoles = onCall(opts, async req => {
  requireSuperAdmin(req);
  await ensureRoles();
  return { ok: true };
});

// ---------- Login history ----------

/** Called by the app when an admin (client or Super Admin) starts a session. */
export const recordAdminLogin = onCall(opts, async req => {
  const uid = requireAuth(req);
  const sa = isSuper(req);
  if (!sa && req.auth!.token.admin !== true) return { ok: false };
  const at = Date.now();
  await db.collection('adminLogins').add({ uid, email: req.auth!.token.email ?? null, sa, ip: ipOf(req), userAgent: String(req.rawRequest?.headers?.['user-agent'] ?? '').slice(0, 200) || null,
    authTime: req.auth!.token.auth_time ?? null, at: FieldValue.serverTimestamp(), atMs: at });
  if (!sa) await acctRef(uid).set({ lastLoginAt: FieldValue.serverTimestamp(), lastLoginMs: at }, { merge: true });
  return { ok: true };
});

// ---------- Platform dashboard ----------

const count = async (q: FirebaseFirestore.Query) => (await q.count().get()).data().count;
const tsRange = (q: FirebaseFirestore.Query, field: string, from: Date, to: Date) => q.where(field, '>=', Timestamp.fromDate(from)).where(field, '<', Timestamp.fromDate(to));
const money = (n: number) => Math.round(n * 100) / 100;

/** Figures for the Super Admin dashboard, from live data, for a date range (bookings by lesson date). */
export const superDashboard = onCall({ ...opts, timeoutSeconds: 120, memory: '512MiB' }, async req => {
  requireSuperAdmin(req);
  const from = new Date(String(req.data?.from ?? ''));
  const to = new Date(String(req.data?.to ?? ''));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) fail('Choose a valid date range.', 'invalid-argument');
  const users = db.collection('users'), bookings = db.collection('bookings');
  const now = new Date();
  const lessons = tsRange(bookings.where('kind', '==', 'lesson'), 'startAt', from, to);
  const fromDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(from);
  const toDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date(to.getTime() - 1));

  const [learnerSnap, instructorTotal, instructorVerified, instructorPending, disabled, adminSnap] = await Promise.all([
    users.where('role', '==', 'learner').select('accountStatus', 'walletBalance', 'testAccount').get(),
    count(users.where('role', '==', 'instructor')),
    count(users.where('role', '==', 'instructor').where('verificationStatus', '==', 'verified')),
    count(users.where('role', '==', 'instructor').where('verificationStatus', '==', 'pending_review')),
    count(users.where('accountStatus', '==', 'disabled')),
    db.collection('adminAccounts').select('status').get(),
  ]);
  const learnersDisabled = learnerSnap.docs.filter(d => d.data().accountStatus === 'disabled').length;
  const instructorsDisabled = await count(users.where('role', '==', 'instructor').where('accountStatus', '==', 'disabled'));
  const walletTotal = money(learnerSnap.docs.reduce((s, d) => s + Number(d.data().walletBalance ?? 0), 0));

  const [bookingsInRange, completed, cancelled, upcoming, proposed, lateCancel] = await Promise.all([
    count(lessons), count(lessons.where('status', '==', 'completed')), count(lessons.where('status', '==', 'cancelled')),
    count(bookings.where('kind', '==', 'lesson').where('status', '==', 'confirmed').where('startAt', '>=', Timestamp.fromDate(now))),
    count(bookings.where('status', '==', 'proposed')), count(bookings.where('status', '==', 'late_cancel_requested')),
  ]);

  const [txSnap, invSnap, refundSnap, ledgerSnap] = await Promise.all([
    tsRange(db.collection('financeTransactions'), 'createdAt', from, to).select('type', 'amount', 'syncStatus').get(),
    db.collection('invoices').select('amountDue', 'status').get(),
    db.collection('refundRequests').where('status', 'in', ['awaiting_approval', 'approved']).select('amount').get(),
    db.collection('commissionLedger').where('bookedDay', '>=', fromDay).where('bookedDay', '<=', toDay).select('status', 'commission', 'earnings').get(),
  ]);
  const tx = txSnap.docs.map(d => d.data());
  const sum = (types: string[]) => money(tx.filter(t => types.includes(t.type)).reduce((s, t) => s + Math.abs(Number(t.amount ?? 0)), 0));
  const counted = ledgerSnap.docs.map(d => d.data()).filter(l => ['booked', 'completed', 'late_fee'].includes(l.status));
  const outstanding = invSnap.docs.map(d => d.data()).filter(i => Number(i.amountDue ?? 0) > 0.004 && !['voided', 'credited'].includes(i.status));

  const docs = db.collection('instructorDocuments');
  const [docsQueue, docsSoon, docsExpired, docJobsFailed, xeroJobsFailed, reconOpen, financeAttention] = await Promise.all([
    count(docs.where('latestStatus', 'in', ['pending_verification', 'manual_verification', 'processing_failed', 'awaiting_ocr', 'processing_paused'])),
    count(docs.where('expiryState', '==', 'expiring_soon')), count(docs.where('expiryState', '==', 'expired')),
    count(db.collection('documentJobs').where('status', '==', 'failed')),
    count(db.collection('xeroSyncJobs').where('status', 'in', ['failed', 'attention'])),
    count(db.collection('reconciliationIssues').where('status', '==', 'open')),
    count(db.collection('financeTransactions').where('syncStatus', 'in', ['failed', 'attention'])),
  ]);
  const notes = (await tsRange(db.collection('documentNotifications'), 'createdAt', from, to).select('email').get()).docs.map(d => d.data().email?.status ?? 'unknown');
  const xero = (await db.doc('integrations/xeroStatus').get()).data() ?? {};
  const fin = (await db.doc('integrations/xeroSettings').get()).data() ?? {};

  return {
    users: {
      learners: learnerSnap.size, learnersActive: learnerSnap.size - learnersDisabled, learnersInactive: learnersDisabled,
      instructors: instructorTotal, instructorsActive: instructorVerified - 0, instructorsPending: instructorPending, instructorsSuspended: instructorsDisabled,
      suspended: disabled, admins: adminSnap.size, adminsActive: adminSnap.docs.filter(d => d.data().status === 'active').length,
    },
    bookings: { inRange: bookingsInRange, upcoming, completed, cancelled, pending: proposed + lateCancel },
    finance: {
      walletTotal, paymentsRecorded: sum(['credit_purchase']), outstanding: money(outstanding.reduce((s, i) => s + Number(i.amountDue), 0)), outstandingCount: outstanding.length,
      commission: money(counted.reduce((s, l) => s + Number(l.commission ?? 0), 0)), earnings: money(counted.reduce((s, l) => s + Number(l.earnings ?? 0), 0)),
      pendingRefunds: refundSnap.size, pendingRefundAmount: money(refundSnap.docs.reduce((s, d) => s + Number(d.data().amount ?? 0), 0)),
      adjustments: tx.filter(t => ['goodwill_credit', 'correction_credit', 'correction_debit', 'promotional_credit'].includes(t.type)).length, adjustmentAmount: sum(['goodwill_credit', 'correction_credit', 'correction_debit', 'promotional_credit']),
      financeEnabled: fin.enabled === true,
    },
    documents: { awaiting: docsQueue, expiringSoon: docsSoon, expired: docsExpired },
    notifications: { total: notes.length, sent: notes.filter(s => s === 'sent').length, failed: notes.filter(s => s === 'failed').length, notConfigured: notes.filter(s => s === 'not_configured').length, emailConfigured: !!process.env.RESEND_API_KEY },
    integrations: {
      xero: { connected: xero.connected === true, organisation: xero.tenantName ?? null, demo: xero.organisationClass === 'DEMO', lastSyncAt: xero.lastSyncAt?.toDate?.()?.toISOString?.() ?? null },
      ocr: { configured: !!process.env.OCR_ENDPOINT }, email: { configured: !!process.env.RESEND_API_KEY },
    },
    alerts: { documentJobsFailed: docJobsFailed, xeroJobsFailed, reconciliationOpen: reconOpen, financeSyncAttention: financeAttention },
    range: { from: from.toISOString(), to: to.toISOString() },
  };
});

