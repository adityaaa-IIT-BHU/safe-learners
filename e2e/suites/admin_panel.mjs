// Admin panel refinement: Document Verification / OCR are Cybria-only, the new dashboard is accurate and
// permission-aware, dashboard layouts are per admin, and roles were updated safely.
import { mkdirSync, writeFileSync } from 'node:fs';
import { SUPER_EMAIL, AUTH, FS, OWNER, P, at, call, checker, dayAhead, getDoc, list, seed, setDoc, signIn } from '../lib.mjs';

const { check, results } = checker();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { bik, learner, other } = await seed();
const status = (path, u, init = {}) => fetch(`${FS}/${path}`, { ...init, headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } }).then(r => r.status);
const setPassword = uid => fetch(`${AUTH}/projects/${P}/accounts:update`, { method: 'POST', headers: OWNER, body: JSON.stringify({ localId: uid, password: 'password123', emailVerified: true }) });
const fresh = async email => { const u = await signIn(email); await call('onboardUser', u.token, {}); return signIn(email); };
const sup = await fresh(SUPER_EMAIL);

// ---------- Seed: an older role set (before this change) and operational data ----------
// Simulate the test site: roles saved earlier still include Document Verification / OCR, plus the old officer role.
await setDoc('adminRoles/client_main_admin', { name: 'Client Main Admin', description: 'x', builtIn: true, perms: { learners: 'vcearxd', instructors: 'vcearxd', bookings: 'vcearxd', scheduling: 'vcearxd', finance: 'vcearx', wallet: 'vcearx', invoices: 'vcearx', documents: 'vcearx', reviews: 'vcearx', reports: 'vx', ocr: 'v', notifications: 'v', xero: 'v', commission: 'v' } });
await setDoc('adminRoles/document_officer', { name: 'Document Verification Officer', description: 'x', builtIn: true, perms: { documents: 'vear', instructors: 'v', ocr: 'v' } });
await setDoc('adminRoles/learner_support', { name: 'Learner Support', description: 'x', builtIn: true, perms: { learners: 've', bookings: 've', wallet: 'v', invoices: 'v' } });
await setDoc('adminRoles/finance_manager', { name: 'Finance Manager', description: 'x', builtIn: true, perms: { finance: 'vcearx', wallet: 'vcearx', invoices: 'vcearx', learners: 'v', reports: 'vx', xero: 'v' } });

const now = Date.now(), H = 3_600_000;
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const base = { kind: 'lesson', instructorId: bik.uid, instructorName: 'Bik Singh', learnerId: learner.uid, learnerName: 'Safe Learner', timezone: 'Australia/Sydney', lessonType: 'lesson-1h', price: 75 };
const bk = (id, startMs, durH, extra) => setDoc(`bookings/${id}`, { ...base, ref: id.toUpperCase(), startAt: new Date(startMs), endAt: new Date(startMs + durH * H), createdAt: new Date(now - 2 * 864e5), ...extra });
await bk('t_ongoing', now - 0.5 * H, 1, { status: 'confirmed' });                        // today, in progress
await bk('t_done', now - 26 * H, 1, { status: 'completed' });                             // yesterday, completed
await bk('t_cancel', now - 50 * H, 1, { status: 'cancelled', cancelledAt: new Date(now - 60 * H), cancelledBy: 'learner' });
await bk('t_prop', now + 72 * H, 1, { status: 'proposed', proposedBy: 'instructor' });
await bk('t_late', now + 30 * H, 1, { status: 'late_cancel_requested' });
await bk('t_a', at(dayAhead(5), '10:00').getTime(), 1, { status: 'confirmed', createdAt: new Date(now - 3 * H) });        // conflict pair
await bk('t_b', at(dayAhead(5), '10:30').getTime(), 1, { status: 'confirmed', learnerId: other.uid, learnerName: 'Other Learner', createdAt: new Date(now - 4 * H) });
await setDoc('bookings/t_event', { kind: 'event', status: 'confirmed', instructorId: bik.uid, title: 'Dentist', startAt: at(dayAhead(9), '12:00'), endAt: at(dayAhead(9), '13:00'), timezone: 'Australia/Sydney' });
await bk('t_c', at(dayAhead(9), '12:30').getTime(), 1, { status: 'confirmed' });          // overlaps the personal event
await bk('t_old', now - 90 * 864e5, 1, { status: 'completed', createdAt: new Date(now - 95 * 864e5) }); // outside 30 days
const pend = await fetch(`${AUTH}/accounts:signUp?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'pending.instr@test.local', password: 'password123', returnSecureToken: true }) }).then(x => x.json());
await setDoc(`users/${pend.localId}`, { role: 'instructor', firstName: 'Penny', surname: 'Ding', verificationStatus: 'pending_review', createdAt: new Date(), timezone: 'Australia/Sydney' });
await setDoc('refundRequests/r1', { status: 'awaiting_approval', amount: 40, customerId: learner.uid, number: 'RF-1', requestedAt: new Date() });
await setDoc('invoices/i1', { status: 'authorised', amountDue: 75, total: 75, number: 'SL-1', learnerId: learner.uid, learnerName: 'Safe Learner', createdAt: new Date() });
await setDoc('feedback/f1', { userId: learner.uid, name: 'Safe Learner', role: 'learner', topic: 'Booking', message: 'Can I change my pickup address for Friday?', createdAt: new Date() });
await setDoc('notifications/cyb1', { userId: 'cybria', title: 'Document ready to verify', body: 'x', read: false, createdAt: new Date() });
await setDoc(`instructorDocuments/${bik.uid}__wwc`, { instructorId: bik.uid, type: 'wwc', latestStatus: 'pending_verification', latestVersion: 1 });

// ---------- 1. Roles updated safely ----------
r0: {
  const r = await call('ensureAdminRoles', sup.token, {});
  check('Roles', 'Role update runs for the Super Admin', !r?.error, r?.error);
  const cma = await getDoc('adminRoles/client_main_admin');
  check('Roles', 'Saved roles lose Document Verification and OCR; other access kept as it was', !cma.perms.documents && !cma.perms.ocr && cma.perms.learners === 'vcedarx' && cma.perms.commission === 'v', JSON.stringify(cma.perms));
  const off = await getDoc('adminRoles/document_officer');
  check('Roles', 'Document Verification Officer role retired (kept for history, not deleted)', off?.retired === true);
  const audit = await list('adminAudit');
  check('Roles', 'Role changes recorded in the audit trail with a reason', audit.some(a => a.action === 'role_changed' && /Super Admin only/.test(a.reason ?? '')));
  const bad = await call('createClientAdmin', sup.token, { email: 'officer@test.local', firstName: 'O', surname: 'F', roleId: 'document_officer' });
  check('Roles', 'Retired role can’t be given to a new admin', !!bad.error, bad.error);
}

// ---------- 2. Client admins (Client Main Admin) can't reach Document Verification / OCR ----------
const mk = async (email, roleId) => { const r = await call('createClientAdmin', sup.token, { email, firstName: email.split('.')[0], surname: 'Admin', roleId }); await setPassword(r.uid); return { ...(await fresh(email)), uid: r.uid }; };
const main = await mk('main.admin@test.local', 'client_main_admin');
// Even if an older record still holds document permissions, they must not work.
await setDoc(`adminAccounts/${main.uid}`, { perms: { ...(await getDoc(`adminAccounts/${main.uid}`)).perms, documents: 'vcedarxs', ocr: 'vcedarxs' } }, ['perms']);
await sleep(5500);
for (const [fn, data, label] of [
  ['decideDocument', { docId: `${bik.uid}__wwc`, version: 1, action: 'approve' }, 'decide a document'],
  ['saveDocumentSettings', { features: { automation: false } }, 'change OCR / automation settings'],
  ['documentUsage', {}, 'view OCR usage'],
  ['getDocumentFile', { docId: `${bik.uid}__wwc`, version: 1 }, 'open a document file'],
  ['reviewDocument', { uid: bik.uid, key: 'wwc', approve: true }, 'approve a renewed document'],
  ['retryDocumentProcessing', { docId: `${bik.uid}__wwc`, version: 1 }, 'retry OCR'],
  ['superDashboard', { from: new Date(now - 864e5).toISOString(), to: new Date(now).toISOString() }, 'open the Cybria Control Centre dashboard'],
  ['createClientAdmin', { email: 'x@test.local', firstName: 'x', surname: 'y', roleId: 'learner_support' }, 'use Control Centre admin management'],
]) {
  const r = await call(fn, main.token, data);
  check('Separation', `Client admin refused: ${label} (even with old document permissions stored)`, !!r.error && /Cybria Super Admin only|permission|Admins only|can’t open this document/i.test(r.error), r.error);
}
check('Separation', 'Database refuses document records, OCR usage and Cybria-only alerts to client admins',
  (await status(`instructorDocuments/${bik.uid}__wwc`, main)) === 403 && (await status('ocrUsage/2026-11', main)) === 403 && (await status('notifications/cyb1', main)) === 403);
check('Separation', 'Super Admin still reads document records and Cybria alerts', (await status(`instructorDocuments/${bik.uid}__wwc`, sup)) === 200 && (await status('notifications/cyb1', sup)) === 200);
let r = await call('documentUsage', sup.token, {});
check('Separation', 'Document Verification and OCR still work for the Super Admin', !r.error, r.error);
r = await call('setClientAdminAccess', sup.token, { uid: main.uid, perms: { learners: 'v', documents: 'vear', ocr: 'v' }, reason: 'Try to grant documents' });
const stored = (await getDoc(`adminAccounts/${main.uid}`)).perms;
check('Separation', 'Document Verification / OCR can’t be granted to a client admin (dropped when saved)', !stored.documents && !stored.ocr && stored.learners === 'v', JSON.stringify(stored));
r = await call('setClientAdminAccess', sup.token, { uid: main.uid, roleId: 'client_main_admin', reason: 'Back to role' });
await sleep(5500);
r = await call('reviewVerification', main.token, { uid: pend.localId, approve: false, reason: 'Please upload a clearer licence photo' });
check('Separation', 'Client admin can still approve or reject instructor applications', r.ok === true || !r.error, r.error);
await setDoc(`users/${pend.localId}`, { verificationStatus: 'pending_review' }, ['verificationStatus']);

// ---------- 3. Dashboard: accurate figures ----------
const range = { from: new Date(now - 30 * 864e5).toISOString(), to: new Date(now + 864e5).toISOString() };
const ds = await call('adminDashboard', sup.token, range);
check('Dashboard', 'Super Admin gets every section', ds.people?.learners && ds.people?.instructors && ds.lessons && ds.finance?.payments !== null && ds.finance?.commission, ds.error);
const L = ds.lessons;
check('Dashboard', 'Lesson counts match the records (period: 3 lessons, 1 completed, 1 cancelled)', L.inPeriod === 3 && L.completed === 1 && L.cancelled === 1, JSON.stringify({ inPeriod: L.inPeriod, c: L.completed, x: L.cancelled }));
check('Dashboard', 'Total bookings counts all lessons ever (9)', L.total === 9, L.total);
check('Dashboard', 'Pending bookings = 1 proposed + 1 late-cancel request', L.pending === 2 && L.proposed === 1 && L.lateCancel === 1);
check('Dashboard', 'Upcoming = confirmed lessons still to start (3)', L.upcoming === 3, L.upcoming);
check('Dashboard', 'Today: the in-progress lesson is shown as in progress', L.today.ongoing === 1 && L.today.lessons.some(l => l.id === 't_ongoing' && l.ongoing), JSON.stringify(L.today));
check('Dashboard', 'Conflicts: overlapping lessons and a lesson over personal time are both found', L.conflictCount === 2 && L.conflicts.some(c => c.first.id === 't_a' || c.second.id === 't_a') && L.conflicts.some(c => c.second.kind === 'event'), JSON.stringify(L.conflicts.map(c => [c.first.id, c.second.id])));
check('Dashboard', 'Daily series adds up to the period’s lessons', L.series.reduce((s, d) => s + d.completed + d.cancelled + d.upcoming + d.other, 0) === L.inPeriod);
check('Dashboard', 'Availability lists approved instructors with today’s lessons', L.availability?.some(a => a.id === bik.uid && a.lessonsToday === 1 && a.hours.length === 1), JSON.stringify(L.availability));
check('Dashboard', 'People: learners 2, instructors 2 (1 approved, 1 awaiting approval)', ds.people.learners.total === 2 && ds.people.instructors.total === 2 && ds.people.instructors.active === 1 && ds.people.instructors.approval.pending_review === 1);
check('Dashboard', 'Needs your attention lists only real items', ['approvals', 'bookings', 'conflicts', 'refunds', 'invoices'].every(k => ds.pending.some(p => p.key === k)) && !ds.pending.some(p => p.key === 'transfers' || p.key === 'payments'), ds.pending.map(p => `${p.key}:${p.count}`).join(' '));
check('Dashboard', 'Outstanding payments = $75 on 1 invoice; refunds pending $40', ds.finance.outstanding.amount === 75 && ds.finance.outstanding.count === 1 && ds.finance.refunds.amount === 40);
check('Dashboard', 'Recent activity shows registrations, bookings, cancellations and completions', ['learner', 'booking', 'cancelled', 'completed'].every(k => ds.activity.some(a => a.kind === k)), ds.activity.map(a => a.kind).join(','));
const d7 = await call('adminDashboard', sup.token, { from: new Date(now - 7 * 864e5).toISOString(), to: new Date(now + 864e5).toISOString() });
check('Dashboard', 'Changing the period changes the figures (old lesson excluded either way; series length follows the period)', d7.lessons.series.length < L.series.length && d7.lessons.completed === 1);
r = await call('adminDashboard', sup.token, { from: range.to, to: range.from });
check('Dashboard', 'Invalid period refused', !!r.error);

// ---------- 4. Dashboard respects each admin's permissions ----------
const ls = await mk('support.admin@test.local', 'learner_support'); // learners ve, bookings ve, wallet v, invoices v
const dl = await call('adminDashboard', ls.token, range);
check('Permissions', 'Learner Support: learners and bookings shown; no instructor data', dl.people?.learners && dl.people.instructors === null && dl.lessons && dl.lessons.availability === null, JSON.stringify(dl.people));
check('Permissions', 'Learner Support: no payments, refunds, commission or recent transactions (no Finance / Commission access)', dl.finance.payments === null && dl.finance.refunds === null && dl.finance.commission === null && dl.finance.recent === null && dl.finance.outstanding?.count === 1);
check('Permissions', 'Learner Support: no instructor-approval or refund items in Needs your attention', !dl.pending.some(p => ['approvals', 'refunds', 'payments'].includes(p.key)) && dl.pending.some(p => p.key === 'invoices'));
check('Permissions', 'Learner Support: activity has no instructor registrations or payments', !dl.activity.some(a => ['instructor', 'approval', 'payment'].includes(a.kind)));
const fm = await mk('finance.admin@test.local', 'finance_manager');
const df = await call('adminDashboard', fm.token, range);
check('Permissions', 'Finance Manager: money shown; no lessons or instructors', df.lessons === null && df.people?.instructors === null && df.finance?.payments !== null && df.finance?.refunds);
const nob = await call('setClientAdminAccess', sup.token, { uid: ls.uid, perms: { reviews: 'v' }, reason: 'Reviews only' });
await sleep(5500);
const dn = await call('adminDashboard', ls.token, range);
check('Permissions', 'An admin with none of these modules gets no figures at all', dn.people === null && dn.lessons === null && dn.finance === null && dn.pending.length === 0 && dn.activity.length === 0, JSON.stringify(dn).slice(0, 200));
const learnerCall = await call('adminDashboard', learner.token, range);
check('Permissions', 'Learners and instructors can’t call the dashboard', !!learnerCall.error && !!(await call('adminDashboard', bik.token, range)).error);

// ---------- 5. Dashboard layout preferences ----------
const prefs = (u, body) => status(`adminPrefs/${u.uid}`, u, { method: 'PATCH', body: JSON.stringify({ fields: body }) });
const okBody = { dashboard: { mapValue: { fields: { order: { arrayValue: { values: [{ stringValue: 'today' }, { stringValue: 'summary' }] } }, hidden: { arrayValue: { values: [{ stringValue: 'quick' }] } } } } } };
check('Layout', 'An admin can save their own dashboard layout', (await prefs(fm, okBody)) === 200);
check('Layout', 'Layouts are private to each admin', (await status(`adminPrefs/${fm.uid}`, main)) === 403);
check('Layout', 'A layout can only hold order and hidden sections (can’t smuggle other fields)', (await prefs(fm, { ...okBody, perms: { stringValue: 'all' } })) === 403);
check('Layout', 'Learners can’t create dashboard layouts', (await status(`adminPrefs/${learner.uid}`, learner, { method: 'PATCH', body: JSON.stringify({ fields: okBody }) })) === 403);

const passed = results.filter(x => x.ok).length;
console.log(`\n${passed}/${results.length} passed`);
mkdirSync(new URL('../results/', import.meta.url), { recursive: true }); writeFileSync(new URL('../results/admin_panel.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results, users: { main: main.uid, fm: fm.uid, ls: ls.uid } }, null, 2));
