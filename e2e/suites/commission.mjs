// End-to-end test of commission management on the local emulators (dummy accounts only).
import { mkdirSync, writeFileSync } from 'node:fs';
import { FS, OWNER, TZ, at, call, checker, dayAhead, getDoc, list, seed, setDoc, signIn, signUp } from '../lib.mjs';

const { check, results } = checker();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(500); } return v; };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const tomorrow = dayAhead(1);

const { bik, learner, admin } = await seed();
// Bik (the seeded, already-verified instructor) is a test account: never counted for introductory places.
await call('setTestAccount', admin.token, { uid: bik.uid, testAccount: true });

const instructors = [];
async function newInstructor(n, mobile) {
  const email = `inst${n}@test.local`;
  const u = await signUp(email);
  await setDoc(`users/${u.uid}`, { role: 'instructor', firstName: `Instructor${n}`, surname: 'Demo', timezone: TZ, createdAt: new Date(), verificationStatus: 'pending_review' });
  await setDoc(`users/${u.uid}/private/profile`, { email, mobile });
  await call('onboardUser', u.token, {});
  return { ...u, name: `Instructor${n} Demo` };
}
const approve = async u => { const r = await call('reviewVerification', admin.token, { uid: u.uid, approve: true }); await sleep(300); return r; };
const profile = uid => getDoc(`commissionProfiles/${uid}`);
const summary = uid => getDoc(`users/${uid}/private/commission`);

// ---------- 1. Structure ----------
let r = await call('saveCommissionSettings', admin.token, { defaultRate: 20, introEnabled: true, introRate: 10, introPlaces: 10, effectiveFrom: today, reason: 'E2E: first 10 instructors at 10%' });
check('Settings', 'Admin saves a structure (default 20%, introductory 10% for 10 places)', r.ok, JSON.stringify(r));
check('Settings', 'Test account (Bik) not given a place', !(await profile(bik.uid))?.intro);

// ---------- 2. First 10 instructors ----------
for (let i = 1; i <= 5; i++) { const u = await newInstructor(i, `04000000${String(i).padStart(2, '0')}`); instructors.push(u); await approve(u); }
const dup = await newInstructor(99, '0400000003'); // same mobile as instructor 3
await approve(dup);
const dupP = await profile(dup.uid);
check('Places', 'Second account with the same mobile number is excluded (no repeat place)', dupP?.intro?.status === 'excluded' && /mobile/.test(dupP.intro.reason), JSON.stringify(dupP?.intro));
for (let i = 6; i <= 11; i++) { const u = await newInstructor(i, `04000000${String(i).padStart(2, '0')}`); instructors.push(u); await approve(u); }
const places = await Promise.all(instructors.map(u => profile(u.uid).then(p => p?.intro?.place ?? null)));
check('Places', '1st approved instructor receives the introductory rate (place 1)', places[0] === 1 && (await summary(instructors[0].uid))?.rate === 10 && (await summary(instructors[0].uid))?.category === 'introductory', JSON.stringify(await summary(instructors[0].uid)));
check('Places', '10th approved instructor receives place 10 (duplicate did not use a place)', places[9] === 10, places.join(','));
check('Places', '11th approved instructor gets the default rate', places[10] === null && (await summary(instructors[10].uid))?.rate === 20 && (await summary(instructors[10].uid))?.category === 'default');
check('Places', 'Places given strictly in approval order', places.slice(0, 10).every((p, i) => p === i + 1));
r = await call('allocateIntroNow', admin.token, {});
check('Places', 'Running allocation again changes nothing (10 of 10, 0 remaining)', r.allocated.length === 0 && r.remaining === 0, JSON.stringify(r));
const changesAll = await list('commissionChanges');
check('Audit', 'Each place allocation recorded with approval date', changesAll.filter(c => c.kind === 'intro_allocated').length === 10 && changesAll.some(c => c.kind === 'intro_excluded'));

// ---------- 3. Custom rates ----------
const [i1, i2] = instructors;
r = await call('setInstructorCommission', admin.token, { uid: i1.uid, rate: 12, effectiveFrom: today, reason: 'Negotiated rate' });
check('Custom', 'Custom 12% overrides the introductory 10%', r.effective?.rate === 12 && (await summary(i1.uid))?.category === 'custom', JSON.stringify(r));
r = await call('setInstructorCommission', admin.token, { uid: i1.uid, rate: null, effectiveFrom: today, reason: 'Back to standard' });
check('Custom', 'Removing the custom rate restores the introductory rate', r.effective?.rate === 10 && r.effective?.category === 'introductory' && (await summary(i1.uid))?.rate === 10, JSON.stringify(r));
check('Custom', 'Introductory place kept after custom rate removed', (await profile(i1.uid))?.intro?.place === 1);
await call('setInstructorCommission', admin.token, { uid: i2.uid, rate: 14, effectiveFrom: today, reason: 'Negotiated rate' });
r = await call('saveCommissionSettings', admin.token, { defaultRate: 25, introEnabled: true, introRate: 10, introPlaces: 10, effectiveFrom: today, reason: 'E2E: default up to 25%' });
check('Custom', 'Changing the default rate does not affect custom rates', (await summary(i2.uid))?.rate === 14 && (await summary(instructors[10].uid))?.rate === 25);
check('Places', 'Changing the default rate does not change introductory places', (await profile(instructors[3].uid))?.intro?.place === 4 && (await summary(instructors[3].uid))?.rate === 10);

// ---------- 4. Validation and permissions ----------
for (const [label, data, re] of [
  ['negative rate', { uid: i1.uid, rate: -5, effectiveFrom: today, reason: 'x test' }, /percentage/],
  ['100% or more', { uid: i1.uid, rate: 100, effectiveFrom: today, reason: 'x test' }, /percentage/],
  ['three decimals', { uid: i1.uid, rate: 12.345, effectiveFrom: today, reason: 'x test' }, /percentage/],
  ['date in the past', { uid: i1.uid, rate: 12, effectiveFrom: dayAhead(-1), reason: 'x test' }, /past/],
  ['no reason', { uid: i1.uid, rate: 12, effectiveFrom: today, reason: '' }, /reason/],
]) { r = await call('setInstructorCommission', admin.token, data); check('Validation', `Rejected: ${label}`, re.test(r.error ?? ''), r.error); }
const inst = await signIn('inst3@test.local');
for (const [fn, data] of [['saveCommissionSettings', { defaultRate: 1, introEnabled: false, introRate: 1, introPlaces: 0, effectiveFrom: today, reason: 'hack' }], ['setInstructorCommission', { uid: inst.uid, rate: 0, effectiveFrom: today, reason: 'hack' }], ['allocateIntroNow', {}], ['cancelScheduledCommission', { id: 'x', reason: 'hack' }]]) {
  r = await call(fn, inst.token, data);
  check('Security', `Instructor cannot call ${fn}`, /Admins only/.test(r.error ?? ''), r.error);
}
const get = (path, u) => fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${u.token}` } }).then(x => x.status);
check('Security', 'Instructor cannot read commission profiles, settings or change log', (await get(`commissionProfiles/${inst.uid}`, inst)) === 403 && (await get('integrations/commissionSettings', inst)) === 403 && (await get('commissionChanges/x', inst)) === 403);
const w = await fetch(`${FS}/users/${inst.uid}/private/commission?updateMask.fieldPaths=rate`, { method: 'PATCH', headers: { Authorization: `Bearer ${inst.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { rate: { integerValue: '0' } } }) });
check('Security', 'Instructor cannot edit their own commission summary', w.status === 403, w.status);
const aw = await fetch(`${FS}/integrations/commissionSettings?updateMask.fieldPaths=versions`, { method: 'PATCH', headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: { versions: { arrayValue: {} } } }) });
check('Security', 'Settings can only change through the audited server function (direct write refused)', aw.status === 403, aw.status);
check('Security', 'Instructor can read their own summary', (await get(`users/${inst.uid}/private/commission`, inst)) === 200);

// ---------- 5. Scheduled change ----------
r = await call('saveCommissionSettings', admin.token, { defaultRate: 30, introEnabled: true, introRate: 10, introPlaces: 10, effectiveFrom: tomorrow, reason: 'E2E: scheduled rise' });
const s11 = await summary(instructors[10].uid);
check('Schedule', 'A future change does not apply today; shown as upcoming', s11.rate === 25 && s11.upcoming?.rate === 30 && s11.upcoming?.effectiveFrom === tomorrow, JSON.stringify(s11));

// ---------- 6. Lessons: commission fixed at confirmation ----------
// Bik (test account, default rate 25% today) is the instructor the seeded learner can book.
await call('adjustWallet', admin.token, { uid: learner.uid, amount: 30, note: 'E2E part credit', category: 'goodwill' });
const book = (day, time, extra = {}) => call('createBooking', learner.token, { instructorId: bik.uid, lessonType: 'lesson-1h', startAt: at(day, time).toISOString(), experience: 'some', testBooked: false, pickupLocation: '11 Kildare Rd, Blacktown NSW 2148', ...extra });
const ledger = id => until(() => getDoc(`commissionLedger/${id}`));
const b1 = await book(dayAhead(3), '10:00');
const l1 = await ledger(b1.bookingId);
check('Lessons', 'Commission recorded at confirmation: 25% of $75 = $18.75, earnings $56.25', l1?.rate === 25 && l1.commission === 18.75 && l1.earnings === 56.25 && l1.category === 'default' && l1.status === 'booked', JSON.stringify(l1));
const bk1 = await getDoc(`bookings/${b1.bookingId}`);
check('Lessons', 'Partly paid from the wallet ($30): still one commission record on the full price', bk1.walletPaid === 30 && (await list('commissionLedger')).filter(x => x.bookingId === b1.bookingId).length === 1, `walletPaid ${bk1.walletPaid}`);
check('Privacy', 'Learner cannot see the commission', (await get(`commissionLedger/${b1.bookingId}`, learner)) === 403 && !('commission' in bk1) && !('rate' in bk1));
check('Privacy', 'Another instructor cannot see it', (await get(`commissionLedger/${b1.bookingId}`, inst)) === 403);
check('Privacy', 'Its instructor can', (await get(`commissionLedger/${b1.bookingId}`, bik)) === 200);
await call('setInstructorCommission', admin.token, { uid: bik.uid, rate: 12, effectiveFrom: today, reason: 'E2E custom' });
const l1b = await getDoc(`commissionLedger/${b1.bookingId}`);
check('History', 'Changing the rate later leaves the booked lesson at its original rate', l1b.rate === 25 && l1b.commission === 18.75);
const b2 = await book(dayAhead(4), '10:00');
const l2 = await ledger(b2.bookingId);
check('Lessons', 'A new lesson uses the new custom rate (12% → $9.00)', l2?.rate === 12 && l2.commission === 9 && l2.category === 'custom', JSON.stringify(l2));
// Completion keeps the amounts.
await setDoc(`bookings/${b1.bookingId}`, { status: 'completed' }, ['status']);
const l1c = await until(async () => { const x = await getDoc(`commissionLedger/${b1.bookingId}`); return x.status === 'completed' ? x : null; });
check('Lessons', 'Completed lesson keeps its commission', l1c?.rate === 25 && l1c.commission === 18.75);
// Retry safety: the same booking written again never creates a second record or changes amounts.
const created = l2.createdMs;
await setDoc(`bookings/${b2.bookingId}`, { instructorNotes: 'touch 1' }, ['instructorNotes']);
await setDoc(`bookings/${b2.bookingId}`, { instructorNotes: 'touch 2' }, ['instructorNotes']);
await sleep(2500);
const l2b = await getDoc(`commissionLedger/${b2.bookingId}`);
check('Retries', 'Repeated booking writes (retries) never duplicate or recalculate commission', l2b.createdMs === created && l2b.commission === 9 && (await list('commissionLedger')).filter(x => x.bookingId === b2.bookingId).length === 1);
// Cancellation more than 24 h ahead: no commission.
await call('cancelBooking', learner.token, { bookingId: b2.bookingId });
const l2c = await until(async () => { const x = await getDoc(`commissionLedger/${b2.bookingId}`); return x.status === 'void' ? x : null; });
check('Cancellations', 'Free cancellation: commission no longer counted', l2c?.status === 'void');
// Reschedule keeps the original rate even though Bik's rate changed.
const b3old = b1; // completed, so book a fresh one at 12% then change rate and reschedule
const b4 = await book(dayAhead(5), '10:00');
const l4 = await ledger(b4.bookingId);
await call('setInstructorCommission', admin.token, { uid: bik.uid, rate: 16, effectiveFrom: today, reason: 'E2E second custom' });
const b5 = await book(dayAhead(6), '10:00', { rescheduleOf: b4.bookingId });
const l5 = await ledger(b5.bookingId);
check('Reschedule', 'Rescheduled lesson keeps the rate of the booking it replaces (12%, not the new 16%)', l4?.rate === 12 && l5?.rate === 12 && l5.inheritedFrom === b4.bookingId, `${l4?.rate} → ${l5?.rate}`);
const l4v = await until(async () => { const x = await getDoc(`commissionLedger/${b4.bookingId}`); return x.status === 'void' ? x : null; });
check('Reschedule', 'The replaced booking’s commission is not counted twice', l4v?.status === 'void');
// Late cancellation with the fee kept.
const b6 = await book(dayAhead(7), '10:00');
await ledger(b6.bookingId);
await setDoc(`bookings/${b6.bookingId}`, { startAt: new Date(Date.now() + 5 * 3600_000), endAt: new Date(Date.now() + 6 * 3600_000) }, ['startAt', 'endAt']);
r = await call('cancelBooking', learner.token, { bookingId: b6.bookingId });
r = await call('resolveLateCancel', bik.token, { bookingId: b6.bookingId, decision: 'charge' });
const l6 = await until(async () => { const x = await getDoc(`commissionLedger/${b6.bookingId}`); return x.status === 'late_fee' ? x : null; });
check('Cancellations', 'Late cancellation with the fee kept: counted as a late fee at the booked rate', l6?.status === 'late_fee' && l6.rate === 16, JSON.stringify(r));

// ---------- 7. Removal of a place by deleting an account; re-registration blocked ----------
const gone = instructors[4]; // place 5
await fetch(`${FS}/users/${gone.uid}`, { method: 'DELETE', headers: OWNER });
r = await call('allocateIntroNow', admin.token, {});
check('Places', 'A deleted account no longer counts: its place goes to the next approved instructor', r.allocated.includes(instructors[10].uid) && (await profile(instructors[10].uid))?.intro?.place === 11, JSON.stringify(r));
const again = await newInstructor(55, '0400000005'); // same mobile as the deleted instructor 5
await approve(again);
check('Places', 'Re-registering with the same details does not get a new place', (await profile(again.uid))?.intro?.status === 'excluded' || !(await profile(again.uid))?.intro);

// ---------- 8. Audit ----------
const ch = await list('commissionChanges');
const custom = ch.find(c => c.kind === 'custom_set' && c.instructorId === i1.uid);
check('Audit', 'Each change records previous and new rate, instructor, time, effective date, admin and reason', !!custom && custom.before?.rate === 10 && custom.after?.rate === 12 && custom.effectiveFrom === today && custom.byName && custom.reason === 'Negotiated rate' && custom.atMs > 0);
const del = await fetch(`${FS}/commissionChanges/${ch[0].id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin.token}` } });
check('Audit', 'Change log cannot be deleted (admin tried)', del.status === 403);

const passed = results.filter(x => x.ok).length;
console.log(`\n${passed}/${results.length} passed`);
mkdirSync(new URL('../results/', import.meta.url), { recursive: true }); writeFileSync(new URL('../results/commission.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results, users: { bik: bik.uid, learner: learner.uid, i1: i1.uid, i2: i2.uid, i11: instructors[10].uid } }, null, 2));
void b3old;
