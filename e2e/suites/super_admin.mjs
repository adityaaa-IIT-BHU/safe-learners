// Phase 1 end-to-end: access hierarchy, Client Admin Management, roles, backend and database enforcement.
import { mkdirSync, writeFileSync } from 'node:fs';
import { SUPER_EMAIL, AUTH, FS, OWNER, P, call, checker, getDoc, list, seed, setDoc, signIn } from '../lib.mjs';

const { check, results } = checker();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { bik, learner, admin: super0 } = await seed();
const claimsOf = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const get = (path, u) => fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${u.token}` } }).then(r => r.status);
const setPassword = (uid, password = 'password123') => fetch(`${AUTH}/projects/${P}/accounts:update`, { method: 'POST', headers: OWNER, body: JSON.stringify({ localId: uid, password, emailVerified: true }) });
const fresh = async email => { const u = await signIn(email); await call('onboardUser', u.token, {}); return signIn(email); };

// ---------- 1. Super Admin ----------
const sup = await fresh(SUPER_EMAIL);
check('Super', 'Cybria account carries the Super Admin claim (from server configuration)', claimsOf(sup.token).sa === true && claimsOf(sup.token).admin === true);
let r = await call('superDashboard', sup.token, { from: new Date(Date.now() - 30 * 864e5).toISOString(), to: new Date(Date.now() + 864e5).toISOString() });
check('Super', 'Super Admin dashboard returns live figures', r.users?.learners === 2 && r.users?.instructors === 1 && typeof r.finance?.walletTotal === 'number', JSON.stringify(r.users));
await call('ensureAdminRoles', sup.token, {});
const roles = await list('adminRoles');
check('Roles', 'Six built-in roles available (Document Verification Officer retired)', roles.length === 6 && roles.some(x => x.name === 'Read-Only Auditor'), roles.map(x => x.name).join(', '));

// ---------- 2. Create a client admin ----------
r = await call('createClientAdmin', sup.token, { email: 'support.admin@test.local', firstName: 'Sam', surname: 'Support', roleId: 'learner_support' });
check('Admins', 'Super Admin creates a client admin and gets a one-time set-password link', !!r.uid && /oobCode|mode=resetPassword/.test(r.setPasswordLink ?? ''), r.error);
const ca1 = r.uid;
await setPassword(ca1); // the admin choosing their password via the link (emulator shortcut)
let ca = await fresh('support.admin@test.local');
check('Admins', 'Client admin has admin access but not Super Admin', claimsOf(ca.token).admin === true && claimsOf(ca.token).sa !== true);
const acct = await getDoc(`adminAccounts/${ca1}`);
check('Admins', 'Account records role, permissions, status and creator', acct.status === 'active' && acct.roleId === 'learner_support' && acct.perms.learners === 've' && acct.createdBy?.name);
r = await call('createClientAdmin', sup.token, { email: 'learner@test.local', firstName: 'X', surname: 'Y', roleId: 'learner_support' });
check('Admins', 'A learner’s email can’t be turned into an admin', /already belongs to a learner/.test(r.error ?? ''), r.error);

// ---------- 3. Backend enforcement for the client admin (Learner Support: learners ve, bookings ve, wallet v, invoices v) ----------
r = await call('setAccountStatus', ca.token, { uid: learner.uid, status: 'active' });
check('Enforce', 'Allowed: edit a learner account (learners: edit)', r.ok === true, r.error);
for (const [fn, data, label] of [
  ['setAccountStatus', { uid: bik.uid, status: 'disabled' }, 'disable an instructor (no instructor access)'],
  ['setAccountStatus', { uid: sup.uid, status: 'disabled' }, 'disable the Cybria account'],
  ['adjustWallet', { uid: learner.uid, amount: 10, note: 'x', category: 'goodwill' }, 'add wallet credit (wallet: view only)'],
  ['saveCommissionSettings', { defaultRate: 1, introEnabled: false, introRate: 1, introPlaces: 0, effectiveFrom: '2099-01-01', reason: 'x test' }, 'change commission'],
  ['decideDocument', { docId: 'x__wwc', version: 1, action: 'approve' }, 'approve documents'],
  ['xeroConnectUrl', {}, 'connect Xero'],
  ['superDashboard', { from: new Date().toISOString(), to: new Date().toISOString() }, 'open the Super Admin dashboard'],
  ['createClientAdmin', { email: 'evil@test.local', firstName: 'E', surname: 'V', roleId: 'client_main_admin' }, 'create admins'],
  ['setClientAdminAccess', { uid: ca1, roleId: 'client_main_admin', reason: 'self upgrade' }, 'raise their own access'],
  ['saveAdminRole', { id: 'learner_support', name: 'Learner Support', description: '', perms: { finance: 'vcedarxs' }, reason: 'self upgrade' }, 'edit roles'],
  ['documentTestHooks', {}, 'use test hooks'],
]) {
  r = await call(fn, ca.token, data);
  check('Enforce', `Refused: ${label}`, !!r.error, r.error);
}
check('Enforce', 'Self-upgrade attempt left their access unchanged', (await getDoc(`adminAccounts/${ca1}`)).roleId === 'learner_support');

// ---------- 4. Database rules for the client admin ----------
check('Rules', 'Can read a learner profile', (await get(`users/${learner.uid}`, ca)) === 200);
check('Rules', 'Cannot read an instructor’s private profile', (await get(`users/${bik.uid}/private/profile`, ca)) === 403);
check('Rules', 'Cannot read finance transactions, commission or document records', (await get('financeTransactions/x', ca)) === 403 && (await get('commissionLedger/x', ca)) === 403 && (await get('instructorDocuments/x', ca)) === 403);
check('Rules', 'Can read own admin account, not anyone else’s', (await get(`adminAccounts/${ca1}`, ca)) === 200 && (await get(`adminAccounts/${sup.uid}`, ca)) === 403);
check('Rules', 'Cannot read roles, admin audit or login history', (await get('adminRoles/learner_support', ca)) === 403 && (await get('adminAudit/x', ca)) === 403 && (await get('adminLogins/x', ca)) === 403);
const w = await fetch(`${FS}/adminAccounts/${ca1}?updateMask.fieldPaths=perms`, { method: 'PATCH', headers: { Authorization: `Bearer ${ca.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { perms: { mapValue: { fields: { finance: { stringValue: 'vcedarxs' } } } } } }) });
check('Rules', 'Cannot write their own permissions directly', w.status === 403, w.status);

// ---------- 5. Live access changes ----------
r = await call('setClientAdminAccess', sup.token, { uid: ca1, roleId: 'finance_manager', reason: 'Moved to finance' });
check('Live', 'Super Admin changes the role (Finance Manager)', r.ok === true, r.error);
await sleep(5500); // server-side account cache is 5 seconds
check('Live', 'New access works immediately without signing in again (finance records readable)', (await get('financeTransactions/x', ca)) !== 403);
r = await call('adjustWallet', ca.token, { uid: learner.uid, amount: 10, note: 'Finance manager credit', category: 'goodwill' });
check('Live', 'Now allowed: wallet credit (Finance Manager)', r.ok === true || r.balance !== undefined, r.error);
r = await call('setAccountStatus', ca.token, { uid: learner.uid, status: 'active' });
check('Live', 'No longer allowed: edit learner accounts (Finance Manager has learners view only)', !!r.error, r.error);
r = await call('setClientAdminAccess', sup.token, { uid: ca1, perms: { finance: 'v', wallet: 'v', reports: 'v' }, reason: 'Trim to view only' });
check('Live', 'Individual adjustment marks the account as adjusted', r.customised === true && (await getDoc(`adminAccounts/${ca1}`)).customised === true);

// ---------- 6. Roles ----------
r = await call('saveAdminRole', sup.token, { name: 'Weekend Cover', description: 'Bookings only', perms: { bookings: 'vae' }, reason: 'Weekend support' });
const roleId = r.id;
check('Roles', 'Custom role created (permissions cleaned: view added)', roleId && (await getDoc(`adminRoles/${roleId}`))?.perms?.bookings === 'vea', JSON.stringify(await getDoc(`adminRoles/${roleId}`)));
await call('createClientAdmin', sup.token, { email: 'weekend.admin@test.local', firstName: 'Wen', surname: 'Day', roleId });
const ca2 = (await list('adminAccounts')).find(a => a.email === 'weekend.admin@test.local').id;
r = await call('saveAdminRole', sup.token, { id: roleId, name: 'Weekend Cover', description: 'Bookings and learners', perms: { bookings: 'vae', learners: 'v' }, reason: 'Add learners view' });
check('Roles', 'Editing a role updates its administrators', r.accountsUpdated === 1 && (await getDoc(`adminAccounts/${ca2}`)).perms.learners === 'v');
r = await call('deleteAdminRole', sup.token, { id: roleId, reason: 'Not needed' });
check('Roles', 'A role in use can’t be deleted', /still use this role/.test(r.error ?? ''), r.error);

// ---------- 7. Suspend, reinstate, deactivate ----------
r = await call('setClientAdminStatus', sup.token, { uid: ca1, status: 'suspended', reason: 'Investigation' });
await sleep(5500);
check('Status', 'Suspended: admin access stops at once (old token refused by rules and server)', (await get('financeTransactions/x', ca)) === 403 && !!(await call('decideRefund', ca.token, { id: 'x', approve: true })).error);
const after = await signIn('support.admin@test.local');
await call('onboardUser', after.token, {});
const after2 = await signIn('support.admin@test.local');
check('Status', 'Suspended admin signing in again has no admin claim', claimsOf(after2.token).admin !== true);
r = await call('setClientAdminStatus', sup.token, { uid: ca1, status: 'active', reason: 'Cleared' });
ca = await fresh('support.admin@test.local');
check('Status', 'Reinstated: access returns with the same permissions', claimsOf(ca.token).admin === true && (await getDoc(`adminAccounts/${ca1}`)).perms.finance === 'v');
r = await call('setClientAdminStatus', sup.token, { uid: ca2, status: 'deactivated', reason: 'Left the business' });
const dead = await signIn('weekend.admin@test.local');
check('Status', 'Deactivated: cannot sign in at all', !!dead.error, dead.error);
r = await call('revokeAdminSessions', sup.token, { uid: ca1, reason: 'Security check' });
check('Status', 'Sessions revoked', r.ok === true);
r = await call('setClientAdminStatus', sup.token, { uid: ca1, status: 'suspended', reason: '' });
check('Status', 'A reason is required for status changes', /reason/.test(r.error ?? ''));

// ---------- 8. Existing admins from server configuration ----------
const legacy = await fetch(`${AUTH}/accounts:signUp?key=fake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'legacy.admin@test.local', password: 'password123', returnSecureToken: true }) }).then(x => x.json());
await setPassword(legacy.localId);
const lg = await fresh('legacy.admin@test.local');
const la = await getDoc(`adminAccounts/${legacy.localId}`);
check('Migration', 'An admin from the old configuration becomes a Client Main Admin (not Super Admin)', claimsOf(lg.token).admin === true && claimsOf(lg.token).sa !== true && la?.roleId === 'client_main_admin' && la.status === 'active');
check('Migration', 'Client Main Admin has no commission access by default', !la.perms.commission && (await call('setInstructorCommission', lg.token, { uid: bik.uid, rate: 10, effectiveFrom: '2099-01-01', reason: 'x test' })).error);

// ---------- 9. Audit and login history ----------
await call('recordAdminLogin', ca.token, {});
const logins = await list('adminLogins');
check('Audit', 'Admin logins recorded with time and IP', logins.some(l => l.uid === ca1 && l.atMs > 0 && 'ip' in l) && (await getDoc(`adminAccounts/${ca1}`)).lastLoginMs > 0);
const audit = await list('adminAudit');
const needed = ['admin_created', 'admin_permissions_changed', 'admin_suspended', 'admin_reinstated', 'admin_deactivated', 'admin_sessions_revoked', 'role_created', 'role_changed', 'admin_migrated'];
check('Audit', 'Every admin management action recorded', needed.every(a => audit.some(x => x.action === a)), needed.filter(a => !audit.some(x => x.action === a)).join(','));
const pc = audit.find(x => x.action === 'admin_permissions_changed' && x.reason === 'Moved to finance');
check('Audit', 'Records show who, previous and new access, reason and IP', pc?.actor?.name && pc.before?.roleId === 'learner_support' && pc.after?.roleId === 'finance_manager' && 'ip' in pc);
const del = await fetch(`${FS}/adminAudit/${audit[0].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${sup.token}` } });
check('Audit', 'Audit records can’t be deleted (even by the Super Admin)', del.status === 403);

const passed = results.filter(x => x.ok).length;
console.log(`\n${passed}/${results.length} passed`);
mkdirSync(new URL('../results/', import.meta.url), { recursive: true }); writeFileSync(new URL('../results/super_admin.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results, users: { ca1, ca2, super: sup.uid } }, null, 2));
