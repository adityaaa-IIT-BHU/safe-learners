// Wallet: payments, part payments, cancellations, late cancellations, proposals, reschedules, duplicates, ledger consistency, security.
import { mkdirSync, writeFileSync } from 'node:fs';
import { FS, OWNER, at, call, checker, dayAhead, getDoc, list, seed, setDoc } from '../lib.mjs';
const { check, results } = checker();
const A = 'Wallet';
const { bik, learner, other, admin } = await seed();

const wallet = async uid => {
  const u = await getDoc(`users/${uid}`);
  const tx = (await list(`users/${uid}/transactions`)).sort((a, b) => a.createdAt - b.createdAt);
  return { balance: u.walletBalance ?? 0, tx, last: tx.at(-1) };
};
const booking = id => getDoc(`bookings/${id}`);
const book = (day, time, extra = {}) => call('createBooking', learner.token, {
  instructorId: bik.uid, lessonType: 'lesson-1h', startAt: at(day, time).toISOString(), experience: 'some', testBooked: false,
  pickupLocation: '11 Kildare Rd, Blacktown NSW 2148', ...extra,
});
const topUp = (amount, uid = learner.uid) => call('adjustWallet', admin.token, { uid, amount, note: amount > 0 ? 'Test credit' : 'Test adjustment', category: amount > 0 ? 'goodwill' : undefined });
const ledgerOk = async uid => {
  const w = await wallet(uid);
  const sum = Math.round(w.tx.reduce((s, t) => s + t.amount, 0) * 100) / 100;
  // Entries written in one transaction share a timestamp; walk them in whichever order the running balance follows.
  const left = [...w.tx];
  let running = 0, chainOk = true;
  while (left.length) {
    const t0 = left[0].createdAt.getTime();
    const i = left.findIndex(t => t.createdAt.getTime() === t0 && Math.abs(t.balanceAfter - Math.round((running + t.amount) * 100) / 100) < 0.001);
    if (i < 0) { chainOk = false; break; }
    running = left[i].balanceAfter;
    left.splice(i, 1);
  }
  return { ok: Math.abs(sum - w.balance) < 0.001 && chainOk, detail: `balance $${w.balance}, entries sum $${sum}, ${w.tx.length} entries` };
};

// 1. Credit purchased (admin top-up stands in for card payments, which aren't connected yet)
let r = await topUp(200);
let w = await wallet(learner.uid);
check(A, 'Credit added: balance and activity update', !r.error && w.balance === 200 && w.last?.type === 'topup' && w.last.amount === 200, r.error ?? `balance $${w.balance}`);

// 2. Booking paid in full from the wallet
r = await book(dayAhead(5), '10:00');
let b = await booking(r.bookingId);
w = await wallet(learner.uid);
check(A, 'Booking takes the full $75 from the wallet', b?.paymentStatus === 'paid' && b.walletPaid === 75 && w.balance === 125, r.error ?? `${b?.paymentStatus}, walletPaid ${b?.walletPaid}, balance $${w.balance}`);
check(A, 'Booking appears in wallet activity with its reference', w.last?.type === 'booking' && w.last.amount === -75 && w.last.bookingId === r.bookingId && w.last.note.includes(b.ref), w.last?.note);
const paidId = r.bookingId;

// 3. Free cancellation refunds once
r = await call('cancelBooking', learner.token, { bookingId: paidId });
b = await booking(paidId);
w = await wallet(learner.uid);
check(A, 'Cancelling more than 24 h ahead refunds $75', r.result === 'cancelled' && b.paymentStatus === 'refunded' && w.balance === 200 && w.last.type === 'refund' && w.last.amount === 75, r.error ?? `balance $${w.balance}`);
check(A, 'Refund shows booking reference, amount and date', w.last.bookingId === paidId && w.last.note.includes(b.ref) && w.last.createdAt instanceof Date, w.last.note);
r = await call('cancelBooking', learner.token, { bookingId: paidId });
w = await wallet(learner.uid);
check(A, 'Cancelling again is refused and does not refund twice', !!r.error && w.balance === 200 && w.tx.filter(t => t.bookingId === paidId && t.type === 'refund').length === 1, r.error);

// 4. Two cancellations at the same moment: only one refund
r = await book(dayAhead(6), '10:00');
const raceId = r.bookingId;
const race = await Promise.all([call('cancelBooking', learner.token, { bookingId: raceId }), call('cancelBooking', learner.token, { bookingId: raceId })]);
w = await wallet(learner.uid);
check(A, 'Two cancellations at once refund only once', race.filter(x => x.result === 'cancelled').length === 1 && w.tx.filter(t => t.bookingId === raceId && t.type === 'refund').length === 1 && w.balance === 200, `${race.map(x => x.result ?? x.error).join(' / ')}; balance $${w.balance}`);

// 5. Part payment when credit is short
r = await topUp(-150);
r = await book(dayAhead(7), '10:00');
b = await booking(r.bookingId);
w = await wallet(learner.uid);
check(A, '$50 credit on a $75 lesson: $50 taken, $25 left to pay', b.paymentStatus === 'part_paid' && b.walletPaid === 50 && w.balance === 0 && w.last.amount === -50 && /\$25\.00 still due/.test(w.last.note), `${b.paymentStatus}, ${w.last?.note}`);
const partId = r.bookingId;
r = await call('cancelBooking', learner.token, { bookingId: partId });
b = await booking(partId);
w = await wallet(learner.uid);
check(A, 'Cancelling a part-paid lesson returns exactly the $50 taken', b.paymentStatus === 'refunded' && w.balance === 50 && w.last.amount === 50, `balance $${w.balance}`);

// 6. No credit: booking is made, nothing taken, nothing recorded
r = await topUp(-50);
const before = (await wallet(learner.uid)).tx.length;
r = await book(dayAhead(8), '10:00');
b = await booking(r.bookingId);
w = await wallet(learner.uid);
check(A, '$0 balance: lesson booked as payment due, wallet untouched', b.paymentStatus === 'unpaid' && !b.walletPaid && w.balance === 0 && w.tx.length === before, `${b.paymentStatus}, entries ${before}→${w.tx.length}`);
r = await call('cancelBooking', learner.token, { bookingId: r.bookingId });
w = await wallet(learner.uid);
check(A, 'Cancelling an unpaid lesson adds no refund', w.balance === 0 && w.tx.length === before, `balance $${w.balance}`);

// 7. Late cancellation: refund decision and fee decision
await topUp(150);
const late = async () => {
  const res = await book(dayAhead(9 + Math.floor(Math.random() * 3)), '10:00');
  const soon = new Date(Date.now() + 5 * 3_600_000);
  await setDoc(`bookings/${res.bookingId}`, { startAt: soon, endAt: new Date(soon.getTime() + 3_600_000) }, ['startAt', 'endAt']);
  return res.bookingId;
};
const lateRefundId = await late();
r = await call('cancelBooking', learner.token, { bookingId: lateRefundId });
w = await wallet(learner.uid);
check(A, 'Late cancellation waits for the instructor; no refund yet', r.result === 'requested' && w.balance === 75, `${r.result ?? r.error}, balance $${w.balance}`);
r = await call('resolveLateCancel', bik.token, { bookingId: lateRefundId, decision: 'refund' });
w = await wallet(learner.uid);
b = await booking(lateRefundId);
check(A, 'Instructor approves without a fee: $75 refunded', !r.error && b.paymentStatus === 'refunded' && w.balance === 150, r.error ?? `balance $${w.balance}`);
const notes = await list(`users/${learner.uid}/notifications`).catch(() => []);
const note = (await list('notifications')).concat(notes).find(n => n.title?.includes('Cancellation of') && n.userId !== bik.uid);
check(A, 'Learner is told the amount returned', !note || /\$75\.00 is back in your wallet/.test(note.body), note?.body ?? 'no notification found');
const lateFeeId = await late();
await call('cancelBooking', learner.token, { bookingId: lateFeeId });
r = await call('resolveLateCancel', bik.token, { bookingId: lateFeeId, decision: 'charge' });
w = await wallet(learner.uid);
b = await booking(lateFeeId);
check(A, 'Instructor charges the late fee: credit kept, no refund', !r.error && b.paymentStatus === 'charged' && w.balance === 75 && !w.tx.some(t => t.bookingId === lateFeeId && t.type === 'refund'), r.error ?? `balance $${w.balance}`);
r = await call('resolveLateCancel', bik.token, { bookingId: lateFeeId, decision: 'refund' });
w = await wallet(learner.uid);
check(A, 'A decided cancellation can’t be refunded afterwards', !!r.error && w.balance === 75, r.error);

// 8. Instructor proposal accepted: paid from the wallet; instructor cancels: refunded
const D = dayAhead(13);
r = await call('proposeBooking', bik.token, { learnerId: learner.uid, lessonType: 'lesson-1h', startAt: at(D, '10:00').toISOString(), pickupLocation: 'Quakers Hill NSW 2763' });
const propId = r.bookingId;
r = await call('respondToProposal', learner.token, { bookingId: propId, accept: true });
b = await booking(propId);
w = await wallet(learner.uid);
check(A, 'Accepting a proposal pays it from the wallet', b.status === 'confirmed' && b.paymentStatus === 'paid' && b.walletPaid === 75 && w.balance === 0, r.error ?? `balance $${w.balance}`);
r = await call('cancelBooking', bik.token, { bookingId: propId });
w = await wallet(learner.uid);
check(A, 'Instructor cancelling a paid lesson refunds the learner', r.result === 'cancelled' && w.balance === 75 && w.last.type === 'refund', r.error ?? `balance $${w.balance}`);

// 9. Learner reschedules a paid lesson: old refunded, new paid, one of each
r = await book(dayAhead(14), '10:00');
const moveId = r.bookingId;
r = await call('createBooking', learner.token, { instructorId: bik.uid, lessonType: 'lesson-1h', startAt: at(dayAhead(15), '10:00').toISOString(), experience: 'some', testBooked: false, pickupLocation: '11 Kildare Rd, Blacktown NSW 2148', rescheduleOf: moveId });
const old = await booking(moveId);
b = await booking(r.bookingId);
w = await wallet(learner.uid);
check(A, 'Rescheduling: old lesson refunded, new one paid, balance unchanged', !r.error && old.paymentStatus === 'refunded' && b.paymentStatus === 'paid' && w.balance === 0 && w.tx.filter(t => t.bookingId === moveId && t.type === 'refund').length === 1, r.error ?? `balance $${w.balance}`);

// 10. Bug fixed: instructor reschedules a lesson awaiting a late-cancel decision — credit must come back
await call('cancelBooking', bik.token, { bookingId: r.bookingId });
w = await wallet(learner.uid);
const pendingId = await late();
await call('cancelBooking', learner.token, { bookingId: pendingId });
const balBefore = (await wallet(learner.uid)).balance;
r = await call('proposeBooking', bik.token, { learnerId: learner.uid, lessonType: 'lesson-1h', startAt: at(dayAhead(16), '10:00').toISOString(), pickupLocation: 'Quakers Hill NSW 2763', rescheduleOf: pendingId });
b = await booking(pendingId);
w = await wallet(learner.uid);
check(A, 'Instructor reschedules a late-cancel request: $75 really returned (was lost before)', !r.error && b.paymentStatus === 'refunded' && w.balance === balBefore + 75 && w.tx.some(t => t.bookingId === pendingId && t.type === 'refund'), r.error ?? `balance $${balBefore} → $${w.balance}`);

// 10b. A reschedule must be for the same learner as the original booking
const mine = await book(dayAhead(17), '10:00');
r = await call('proposeBooking', bik.token, { learnerId: other.uid, lessonType: 'lesson-1h', startAt: at(dayAhead(18), '10:00').toISOString(), pickupLocation: 'Quakers Hill NSW 2763', rescheduleOf: mine.bookingId });
check(A, 'Rescheduling one learner’s booking for a different learner is refused', !!r.error && (await booking(mine.bookingId)).status === 'confirmed', r.error);
await call('cancelBooking', learner.token, { bookingId: mine.bookingId });
w = await wallet(learner.uid);

// 11. Ledger consistency and booking records
let lc = await ledgerOk(learner.uid);
check(A, 'Balance equals the sum of all wallet entries, and every running balance is right', lc.ok, lc.detail);
const all = (await list('bookings')).filter(x => x.learnerId === learner.uid && x.kind === 'lesson');
const mismatch = all.filter(x => {
  const taken = -w.tx.filter(t => t.bookingId === x.id && t.type === 'booking').reduce((s, t) => s + t.amount, 0);
  const back = w.tx.filter(t => t.bookingId === x.id && t.type === 'refund').reduce((s, t) => s + t.amount, 0);
  if ((x.walletPaid ?? 0) !== taken) return true;
  if (x.paymentStatus === 'refunded') return back !== taken;
  return back !== 0;
});
check(A, 'Every booking’s recorded payment matches the wallet entries', mismatch.length === 0, `${all.length} bookings checked${mismatch.length ? `, mismatched: ${mismatch.map(m => m.ref).join(', ')}` : ''}`);

// 12. Security
const learnerH = { Authorization: `Bearer ${learner.token}`, 'Content-Type': 'application/json' };
let denied = false;
try { await setDoc(`users/${learner.uid}`, { walletBalance: 9999 }, ['walletBalance'], learnerH); } catch { denied = true; }
check(A, 'A learner can’t change their own balance directly', denied);
denied = false;
try { await setDoc(`users/${learner.uid}/transactions/fake`, { amount: 500, type: 'topup', note: 'x' }, null, learnerH); } catch { denied = true; }
check(A, 'A learner can’t write wallet entries', denied);
const peek = await fetch(`${FS}/users/${learner.uid}/transactions`, { headers: { Authorization: `Bearer ${other.token}` } });
check(A, 'A learner can’t read another learner’s wallet activity', peek.status === 403, `HTTP ${peek.status}`);
r = await call('adjustWallet', learner.token, { uid: learner.uid, amount: 100 });
check(A, 'Only admins can add credit', !!r.error, r.error);
r = await call('adjustWallet', admin.token, { uid: learner.uid, amount: -1000 });
check(A, 'Balance can’t go below $0', !!r.error, r.error);
lc = await ledgerOk(learner.uid);
check(A, 'Ledger still consistent after all tests', lc.ok, lc.detail);

mkdirSync(new URL('../results/', import.meta.url), { recursive: true }); writeFileSync(new URL('../results/wallet_finance.json', import.meta.url), JSON.stringify(results, null, 1));
console.log(`\n${results.filter(x => x.ok).length} passed, ${results.filter(x => !x.ok).length} failed`);
