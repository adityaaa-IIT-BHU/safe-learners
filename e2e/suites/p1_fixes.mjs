// P1 fixes: server-only document records (legacy, verification, compliance, commission) and the
// office's booking actions (cancel, decide late cancellation, move, private notes).
import { mkdirSync, writeFileSync } from 'node:fs';
import { AUTH, FS, OWNER, P, SUPER_EMAIL, at, call, checker, dayAhead, getDoc, list, seed, setDoc, signIn } from '../lib.mjs';

const { check, results } = checker();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { bik, learner } = await seed();
const s = v => ({ stringValue: v });
const patch = (path, u, fields) => fetch(`${FS}/${path}`, { method: 'PATCH', headers: { Authorization: `Bearer ${u.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) }).then(r => r.status);
const read = (path, u) => fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${u.token}` } }).then(r => r.status);
const fresh = async email => { const u = await signIn(email); await call('onboardUser', u.token, {}); return signIn(email); };
const sup = await fresh(SUPER_EMAIL);
const mk = async (email, roleId) => {
  const r = await call('createClientAdmin', sup.token, { email, firstName: email.split('.')[0], surname: 'Admin', roleId });
  await fetch(`${AUTH}/projects/${P}/accounts:update`, { method: 'POST', headers: OWNER, body: JSON.stringify({ localId: r.uid, password: 'password123', emailVerified: true }) });
  return { ...(await fresh(email)), uid: r.uid };
};

// ---------- 1. Earlier-website document records are server-only ----------
const fakeLegacy = { mapValue: { fields: { wwcCheckUrl: s('https://example.com/x.png'), wwcNumber: s('X'), wwcExpiry: s('2031-01-01') } } };
check('Documents', 'Instructor can’t write earlier-website document records', (await patch(`users/${bik.uid}/private/profile`, bik, { legacy: fakeLegacy })) === 403);
check('Documents', 'Instructor can still update their own mobile number', (await patch(`users/${bik.uid}/private/profile?updateMask.fieldPaths=mobile`, bik, { mobile: s('0400 111 222') })) === 200);
const ops = await mk('ops.admin@test.local', 'operations_manager'); // instructors: edit
await sleep(5500);
check('Documents', 'Client admin (instructor edit) can’t write document records either', (await patch(`users/${bik.uid}/private/profile?updateMask.fieldPaths=legacy`, ops, { legacy: fakeLegacy })) === 403);
check('Documents', 'Client admin can’t write eligibility (compliance) or commission records', (await patch(`users/${bik.uid}/private/compliance`, ops, { eligible: { booleanValue: true } })) === 403 && (await patch(`users/${bik.uid}/private/commission`, ops, { rate: { integerValue: '1' } })) === 403);
check('Documents', 'Client admin can still correct an instructor’s contact details', (await patch(`users/${bik.uid}/private/profile?updateMask.fieldPaths=mobile`, ops, { mobile: s('0400 333 444') })) === 200);
check('Documents', 'Cybria Super Admin is not restricted', (await patch(`users/${bik.uid}/private/profile?updateMask.fieldPaths=legacyNote`, sup, { legacyNote: s('checked') })) === 200);

// ---------- 2. Office booking actions ----------
const book = async (id, startMs, extra = {}) => setDoc(`bookings/${id}`, { kind: 'lesson', status: 'confirmed', instructorId: bik.uid, instructorName: 'Bik Singh', learnerId: learner.uid, learnerName: 'Safe Learner',
  ref: id.toUpperCase(), lessonType: 'lesson-1h', price: 75, walletPaid: 75, paymentStatus: 'paid', timezone: 'Australia/Sydney', startAt: new Date(startMs), endAt: new Date(startMs + 3_600_000), createdAt: new Date(), ...extra });
await setDoc(`users/${learner.uid}`, { walletBalance: 0 }, ['walletBalance']);
await book('b_cancel', at(dayAhead(3), '11:00').getTime());
await book('b_fee', at(dayAhead(4), '11:00').getTime());
await book('b_late', at(dayAhead(1), '11:00').getTime(), { status: 'late_cancel_requested' });
await book('b_move', at(dayAhead(5), '11:00').getTime());
await book('b_block', at(dayAhead(5), '14:00').getTime(), { learnerName: 'Other Learner' });

const ls = await mk('support.admin@test.local', 'learner_support'); // bookings: view + edit
const ro = await mk('auditor.admin@test.local', 'read_only_auditor'); // bookings: view + export only
await sleep(5500);

let r = await call('adminCancelBooking', ro.token, { bookingId: 'b_cancel', refund: 'refund', reason: 'Instructor unwell' });
check('Bookings', 'Read-only admin can’t cancel a booking', !!r.error, r.error);
r = await call('adminCancelBooking', learner.token, { bookingId: 'b_cancel', refund: 'refund', reason: 'x test' });
check('Bookings', 'Learners can’t use office actions', !!r.error, r.error);
r = await call('adminCancelBooking', ls.token, { bookingId: 'b_cancel', refund: 'refund', reason: '' });
check('Bookings', 'A reason is required', /reason/i.test(r.error ?? ''), r.error);
r = await call('adminCancelBooking', ls.token, { bookingId: 'b_cancel', reason: 'Instructor unwell' });
check('Bookings', 'Refund or fee must be chosen explicitly', /refund|fee/i.test(r.error ?? ''), r.error);

r = await call('adminCancelBooking', ls.token, { bookingId: 'b_cancel', refund: 'refund', reason: 'Instructor unwell' });
const bc = await getDoc('bookings/b_cancel');
const bal1 = (await getDoc(`users/${learner.uid}`)).walletBalance;
check('Bookings', 'Office cancellation with refund: cancelled, $75 back in the wallet, recorded as the office', r.ok && bc.status === 'cancelled' && bc.cancelledBy === 'admin' && bal1 === 75 && bc.cancelledAt, JSON.stringify({ status: bc.status, by: bc.cancelledBy, bal1 }));
check('Bookings', 'History shows who did it and why', (bc.history ?? []).some(h => h.by === 'admin' && /Instructor unwell/.test(h.action) && h.byName));
const notes = await list('bookings/b_cancel/adminNotes');
check('Bookings', 'Office note recorded automatically', notes.some(n => /refund to wallet/.test(n.text)));
const nts = await list('notifications');
check('Bookings', 'Learner and instructor both notified', nts.some(n => n.userId === learner.uid && /cancelled by the Safe Learners office/.test(n.body)) && nts.some(n => n.userId === bik.uid && /cancelled by the office/.test(n.body)));

r = await call('adminCancelBooking', ls.token, { bookingId: 'b_fee', refund: 'fee', reason: 'No-show agreed with learner' });
const bf = await getDoc('bookings/b_fee');
check('Bookings', 'Office cancellation keeping a fee: no refund, marked as charged', bf.status === 'cancelled' && bf.paymentStatus === 'charged' && (await getDoc(`users/${learner.uid}`)).walletBalance === bal1);

r = await call('adminCancelBooking', ls.token, { bookingId: 'b_late', refund: 'refund', reason: 'Instructor did not respond' });
const bl = await getDoc('bookings/b_late');
check('Bookings', 'Office decides a stuck late-cancellation request (recorded as the learner’s cancellation)', bl.status === 'cancelled' && bl.cancelledBy === 'learner' && (bl.history ?? []).some(h => /decided by the office/.test(h.action)));
r = await call('adminCancelBooking', ls.token, { bookingId: 'b_cancel', refund: 'refund', reason: 'again' });
check('Bookings', 'An already cancelled booking can’t be cancelled twice (no double refund)', !!r.error && (await getDoc(`users/${learner.uid}`)).walletBalance === 150, r.error);

const newStart = at(dayAhead(5), '14:30');
r = await call('adminMoveBooking', ls.token, { bookingId: 'b_move', startAt: newStart.toISOString(), reason: 'Learner asked by phone' });
check('Bookings', 'Moving onto another lesson is refused (no double booking)', !!r.error, r.error);
r = await call('adminMoveBooking', ls.token, { bookingId: 'b_move', startAt: at(dayAhead(5), '07:00').toISOString(), reason: 'Learner asked by phone' });
check('Bookings', 'Moving outside the instructor’s hours is refused unless allowed', !!r.error, r.error);
r = await call('adminMoveBooking', ls.token, { bookingId: 'b_move', startAt: at(dayAhead(6), '12:00').toISOString(), reason: 'Learner asked by phone' });
const bm = await getDoc('bookings/b_move');
check('Bookings', 'Move to a free time within hours: time changed, payment unchanged, reminder reset', r.ok && bm.startAt.getTime() === at(dayAhead(6), '12:00').getTime() && bm.paymentStatus === 'paid' && bm.walletPaid === 75 && bm.reminderSent === false, r.error);
r = await call('adminMoveBooking', ls.token, { bookingId: 'b_move', startAt: at(dayAhead(6), '07:00').toISOString(), reason: 'Instructor agreed early start', outsideHours: true });
check('Bookings', 'Outside usual hours allowed when the office ticks the override (recorded)', r.ok && ((await getDoc('bookings/b_move')).history ?? []).some(h => /outside usual hours/.test(h.action)), r.error);
r = await call('adminMoveBooking', ls.token, { bookingId: 'b_cancel', startAt: at(dayAhead(7), '12:00').toISOString(), reason: 'x test' });
check('Bookings', 'A cancelled lesson can’t be moved', !!r.error);

r = await call('adminBookingNote', ls.token, { bookingId: 'b_move', text: 'Learner prefers mornings' });
check('Bookings', 'Office can add a private note', r.ok === true);
check('Bookings', 'Office notes are hidden from the learner and instructor', (await read('bookings/b_move/adminNotes/x', learner)) === 403 && (await read('bookings/b_move/adminNotes/x', bik)) === 403);
check('Bookings', 'Admins with booking access can read office notes', (await read(`bookings/b_move/adminNotes/${(await list('bookings/b_move/adminNotes'))[0].id}`, ro)) === 200);

const passed = results.filter(x => x.ok).length;
console.log(`\n${passed}/${results.length} passed`);
mkdirSync(new URL('../results/', import.meta.url), { recursive: true }); writeFileSync(new URL('../results/p1_fixes.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2));
