// Existing booking, scheduling, location, extra-hours, test-centre, proposal and event rules still hold.
import { mkdirSync, writeFileSync } from 'node:fs';
import { at, call, checker, dayAhead, fmtTime, getDoc, list, seed, setDoc } from '../lib.mjs';
const { check, results } = checker();
const A = 'Booking & scheduling';
const { bik, learner, admin } = await seed();
const slotsOn = async (day, extra = {}) => {
  const r = await call('getAvailability', learner.token, { instructorId: bik.uid, lessonType: 'lesson-1h', days: 20, ...extra });
  return (r.slots?.[day] ?? []).map(fmtTime);
};
const book = (startAt, extra = {}) => call('createBooking', learner.token, {
  instructorId: bik.uid, lessonType: 'lesson-1h', startAt: startAt.toISOString(), experience: 'some', testBooked: false,
  pickupLocation: '11 Kildare Rd, Blacktown NSW 2148', ...extra,
});
const D = dayAhead(5), D1 = dayAhead(6), D3 = dayAhead(8), D4 = dayAhead(9), D7 = dayAhead(12), D8 = dayAhead(13);

let s = await slotsOn(D);
check(A, 'Smart scheduling packs 1 hr blocks', s.join() === '10:00am,11:45am,1:30pm,3:15pm,5:00pm', s.join(' '));
let r = await book(at(D, '10:00'), { pickupLocation: '100 George St, Sydney NSW 2000' });
check(A, 'Pick up outside the instructor’s suburbs is rejected', !!r.error && /Sydney/.test(r.error), r.error);
r = await book(at(D, '10:30'));
check(A, 'Time off the smart-scheduling grid is rejected', !!r.error, r.error);
r = await book(at(D, '10:00'));
check(A, 'Normal booking succeeds and gets a reference', !!r.bookingId && !!r.ref, r.error ?? r.ref);
s = await slotsOn(D);
check(A, 'Booked time disappears; next block follows lesson + buffer', s[0] === '11:45am' && !s.includes('10:00am'), s.join(' '));
r = await book(at(D, '10:00'));
check(A, 'Double booking the same time is rejected', !!r.error, r.error);

const ev = await call('createEvent', bik.token, { kind: 'open', startAt: at(D3, '18:30').toISOString(), endAt: at(D3, '21:30').toISOString(),
  areas: [{ name: 'Schofields', state: 'NSW', postcode: '2762' }, { name: 'The Ponds', state: 'NSW', postcode: '2769' }] });
check(A, 'Extra open hours in two suburbs save as one entry', !!ev.bookingId && (await getDoc(`bookings/${ev.bookingId}`)).areas?.length === 2, ev.error);
s = await slotsOn(D3, { pickup: { address: '3 Riverbank Dr, The Ponds NSW 2769' } });
check(A, 'A pick up in a chosen suburb sees the extra hours', s.includes('6:30pm'), s.join(' '));
s = await slotsOn(D3, { pickup: { address: '11 Kildare Rd, Blacktown NSW 2148' } });
check(A, 'A pick up elsewhere does not', !s.includes('6:30pm'), s.join(' '));
r = await book(at(D3, '18:30'), { pickupLocation: '9 Railway Tce, Schofields NSW 2762' });
check(A, 'Booking inside suburb extra hours succeeds', !!r.bookingId, r.error);

r = await call('createBooking', learner.token, { instructorId: bik.uid, lessonType: 'test-package', startAt: at(D1, '10:00').toISOString(), pickupLocation: '11 Kildare Rd, Blacktown NSW 2148', testLocation: 'Somewhere else', experience: 'some', testBooked: true });
check(A, 'Test package at an unlisted centre is rejected', !!r.error, r.error);
r = await call('createBooking', learner.token, { instructorId: bik.uid, lessonType: 'test-package', startAt: at(D1, '10:00').toISOString(), pickupLocation: '11 Kildare Rd, Blacktown NSW 2148', testLocation: 'Service NSW Blacktown', experience: 'some', testBooked: true });
check(A, 'Test package at a listed centre succeeds with its address saved', !!r.bookingId && (await getDoc(`bookings/${r.bookingId}`)).testLocationAddress?.includes('St Martins'), r.error);

r = await call('proposeBooking', bik.token, { learnerId: learner.uid, lessonType: 'lesson-1h', startAt: at(D4, '10:00').toISOString(), pickupLocation: 'Quakers Hill NSW 2763' });
check(A, 'Instructor proposal created', !!r.bookingId, r.error);
const pid = r.bookingId;
s = await slotsOn(D4);
check(A, 'A proposal holds its time', !s.includes('10:00am'), s.join(' '));
r = await call('respondToProposal', learner.token, { bookingId: pid, accept: false });
check(A, 'Learner can decline a proposal', !r.error && (await getDoc(`bookings/${pid}`)).status === 'declined', r.error);
r = await call('proposeBooking', bik.token, { learnerId: learner.uid, lessonType: 'lesson-1h', startAt: at(D4, '10:00').toISOString(), pickupLocation: 'Quakers Hill NSW 2763' });
const wid = r.bookingId;
r = await call('withdrawProposal', bik.token, { bookingId: wid });
check(A, 'Instructor can withdraw a proposal', !r.error && (await getDoc(`bookings/${wid}`)).status === 'withdrawn', r.error);

r = await call('createEvent', bik.token, { kind: 'event', title: 'Lunch', startAt: at(D7, '12:00').toISOString(), endAt: at(D7, '13:00').toISOString() });
s = await slotsOn(D7);
check(A, 'Personal event blocks its time', !!r.bookingId && !s.includes('11:45am'), s.join(' '));
r = await call('createEvent', bik.token, { kind: 'event', title: 'Time off', startAt: at(D8, '00:00').toISOString(), endAt: at(dayAhead(14), '00:00').toISOString() });
s = await slotsOn(D8);
check(A, 'Whole-day time off closes the day', !!r.bookingId && s.length === 0, s.join(' '));
r = await call('updateEvent', bik.token, { bookingId: ev.bookingId, startAt: at(D3, '18:30').toISOString(), endAt: at(D3, '20:30').toISOString() });
check(A, 'Editing extra hours works', !r.error && (await getDoc(`bookings/${ev.bookingId}`)).title === 'Extra open hours', r.error);

r = await call('inviteLearner', bik.token, { firstName: 'New', surname: 'Person', email: 'new.person@test.local' });
check(A, 'Instructor can invite a learner by email', !r.error && !!r.learnerId, r.error ?? `emailed: ${r.emailed}`);
check(A, 'Invites are not emailed locally (no email service configured here, as on the live site)', r.emailed === false, `emailed: ${r.emailed}`);

const notes = await list('notifications');
check(A, 'In-app notifications are created for bookings and proposals', notes.some(n => n.userId === bik.uid && /booking/i.test(n.title)) && notes.some(n => n.userId === learner.uid), `${notes.length} notifications`);

// Admin functions
r = await call('setAccountStatus', admin.token, { uid: learner.uid, status: 'disabled' });
const dis = await book(at(dayAhead(15), '10:00'));
check(A, 'Admin can disable an account; disabled learner can’t book', !r.error && !!dis.error, r.error ?? dis.error);
r = await call('setAccountStatus', admin.token, { uid: learner.uid, status: 'active' });
check(A, 'Admin can re-enable the account', !r.error, r.error);
r = await call('setAccountStatus', learner.token, { uid: learner.uid, status: 'active' });
check(A, 'Non-admins can’t use admin functions', !!r.error, r.error);

mkdirSync(new URL('../results/', import.meta.url), { recursive: true }); writeFileSync(new URL('../results/regression.json', import.meta.url), JSON.stringify(results, null, 1));
console.log(`\n${results.filter(x => x.ok).length} passed, ${results.filter(x => !x.ok).length} failed`);
