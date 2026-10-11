import type { Transaction } from 'firebase-admin/firestore';
import { onCall } from 'firebase-functions/v2/https';
import {
  FREE_CANCELLATION_HOURS,
  LESSON_TYPES,
  calendarOf,
  STATUS_META,
  fullName,
  holdsSlot,
  hoursUntil,
  learnerCanReschedule,
  lessonPrice,
  openSlotsForDay,
  openSlotsForRange,
  overlaps,
  pricingFor,
  type Booking,
  type LessonType,
  type UserProfile,
} from '../../shared/domain';
import { DEFAULT_TIMEZONE, dayKey, formatDate, formatTime } from '../../shared/time';
import {
  FieldValue,
  bookingFields,
  bookingFrom,
  db,
  fail,
  historyEntry,
  instructorBookings,
  notify,
  requireAuth,
  requireUser,
  reserveRef,
  userFrom,
  walletEntry,
} from './core';

const opts = { region: 'australia-southeast1', cors: true };

// ---------- Input helpers ----------

function str(v: unknown, field: string, { required = true, max = 300 } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (required) fail(`${field} is required.`, 'invalid-argument');
    return '';
  }
  if (typeof v !== 'string' || v.length > max) fail(`${field} is invalid.`, 'invalid-argument');
  return v.trim();
}

function lessonTypeArg(v: unknown): LessonType {
  if (typeof v !== 'string' || !(v in LESSON_TYPES)) fail('Unknown lesson type.', 'invalid-argument');
  return v as LessonType;
}

function dateArg(v: unknown, field: string): Date {
  const d = typeof v === 'string' || typeof v === 'number' ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) fail(`${field} is invalid.`, 'invalid-argument');
  return d;
}

function when(b: Pick<Booking, 'startAt' | 'timezone'>): string {
  return `${formatDate(b.startAt, b.timezone)} at ${formatTime(b.startAt, b.timezone)}`;
}

function tzOf(instructor: UserProfile): string {
  return instructor.timezone || DEFAULT_TIMEZONE;
}

function assertBookableInstructor(instructor: UserProfile | null): asserts instructor is UserProfile {
  if (!instructor || instructor.role !== 'instructor') fail('Instructor not found.', 'not-found');
  if (instructor.accountStatus === 'disabled') fail('This instructor is not taking bookings.');
  if (instructor.verificationStatus !== 'verified') fail('This instructor has not completed verification yet.');
}

/** Slot must sit inside operating hours (learner bookings) and must not clash with held time. */
function assertSlotFree(
  existing: Booking[],
  start: Date,
  end: Date,
  { excludeIds = [] as string[] } = {},
) {
  const clash = existing.find(b => !excludeIds.includes(b.id) && holdsSlot(b) && overlaps(start, end, b.startAt, b.endAt));
  if (clash) fail('That time is no longer available. Please pick another slot.');
}

/** Availability inputs from the instructor's calendar settings (buffer, notice, smart gaps, extra hours). */
function scheduleOptions(instructor: UserProfile, existing: Booking[], excludeIds: string[], graceMinutes = 0) {
  const cal = calendarOf(instructor);
  const now = new Date();
  return {
    hours: instructor.operatingHours || {},
    busy: existing.filter(b => !excludeIds.includes(b.id) && holdsSlot(b)).map(b => ({ start: b.startAt, end: b.endAt })),
    extraOpen: existing.filter(b => b.kind === 'open' && b.status === 'confirmed').map(b => ({ start: b.startAt, end: b.endAt })),
    timeZone: tzOf(instructor),
    bufferMinutes: cal.bufferMinutes,
    // A little grace so a slot picked a moment ago doesn't fail on submit.
    minNoticeMinutes: Math.max(0, cal.minNoticeHours * 60 - graceMinutes),
    smartGapMinutes: cal.smartScheduling ? cal.smartGapMinutes : 0,
    latest: new Date(now.getTime() + cal.maxAdvanceDays * 86_400_000),
    now,
  };
}

/** The instructor's mobile (kept privately) to give booked learners. Read inside the transaction. */
async function instructorContact(tx: Transaction, instructor: UserProfile): Promise<string | undefined> {
  const priv = (await tx.get(db.doc(`users/${instructor.id}/private/profile`))).data();
  return (priv?.mobile as string | undefined) || instructor.mobile || undefined;
}

function assertOffered(instructor: UserProfile, lessonType: LessonType) {
  if (!calendarOf(instructor).lessonTypes.includes(lessonType)) {
    fail(`${instructor.firstName} doesn’t offer ${LESSON_TYPES[lessonType].label.toLowerCase()}s.`);
  }
}

function assertWithinHours(instructor: UserProfile, existing: Booking[], start: Date, minutes: number, excludeIds: string[]) {
  const tz = tzOf(instructor);
  const slots = openSlotsForDay({
    ...scheduleOptions(instructor, existing, excludeIds, 15),
    day: dayKey(start, tz),
    durationMinutes: minutes,
  });
  if (!slots.some(s => s.start.getTime() === start.getTime())) {
    fail('That time is outside the instructor’s availability or already taken.');
  }
}

// ---------- Availability (public) ----------

export const getAvailability = onCall(opts, async req => {
  const instructorId = str(req.data?.instructorId, 'instructorId', { max: 128 });
  const lessonType = lessonTypeArg(req.data?.lessonType);
  const days = Math.min(Math.max(Number(req.data?.days) || 14, 1), 121);
  const excludeBookingId = typeof req.data?.excludeBookingId === 'string' ? req.data.excludeBookingId : undefined;

  const instructor = userFrom(await db.doc(`users/${instructorId}`).get());
  if (!instructor || instructor.role !== 'instructor') fail('Instructor not found.', 'not-found');
  const tz = tzOf(instructor);
  const snap = await db.collection('bookings').where('instructorId', '==', instructorId).get();
  const existing = snap.docs.map(d => bookingFrom(d)).filter((b): b is Booking => !!b);
  const cal = calendarOf(instructor);

  const fromDay = typeof req.data?.fromDay === 'string' ? req.data.fromDay : dayKey(new Date(), tz);
  const byDay = openSlotsForRange({
    ...scheduleOptions(instructor, existing, excludeBookingId ? [excludeBookingId] : []),
    fromDay,
    days: Math.min(days, cal.maxAdvanceDays + 1),
    durationMinutes: LESSON_TYPES[lessonType].minutes,
  });
  const slots: Record<string, string[]> = {};
  for (const [day, list] of Object.entries(byDay)) slots[day] = list.map(s => s.start.toISOString());
  return { timezone: tz, slots, offered: cal.lessonTypes.includes(lessonType), maxAdvanceDays: cal.maxAdvanceDays };
});

// ---------- Learner books a lesson (optionally rebooking an existing one) ----------

export const createBooking = onCall(opts, async req => {
  const learnerId = requireAuth(req);
  const instructorId = str(req.data?.instructorId, 'instructorId', { max: 128 });
  const lessonType = lessonTypeArg(req.data?.lessonType);
  const startAt = dateArg(req.data?.startAt, 'startAt');
  const pickupLocation = str(req.data?.pickupLocation, 'Pick up location');
  const dropoffLocation = str(req.data?.dropoffLocation, 'Drop off location', { required: false }) || pickupLocation;
  const testLocation = str(req.data?.testLocation, 'Test location', { required: lessonType === 'test-package' });
  const notes = str(req.data?.notes, 'Notes', { required: false, max: 1000 });
  const rescheduleOf = str(req.data?.rescheduleOf, 'rescheduleOf', { required: false, max: 128 });

  const minutes = LESSON_TYPES[lessonType].minutes;
  const endAt = new Date(startAt.getTime() + minutes * 60_000);
  const bookingRef = db.collection('bookings').doc();

  const result = await db.runTransaction(async tx => {
    // --- reads ---
    const learner = userFrom(await tx.get(db.doc(`users/${learnerId}`)));
    if (!learner || learner.role !== 'learner') fail('Only learners can book lessons.', 'permission-denied');
    if (learner.accountStatus === 'disabled') fail('Your account has been disabled.', 'permission-denied');
    const instructor = userFrom(await tx.get(db.doc(`users/${instructorId}`)));
    assertBookableInstructor(instructor);
    assertOffered(instructor, lessonType);
    const instructorMobile = await instructorContact(tx, instructor);
    const existing = await instructorBookings(tx, instructorId);
    const old = rescheduleOf ? bookingFrom(await tx.get(db.doc(`bookings/${rescheduleOf}`))) : null;
    if (rescheduleOf) {
      if (!old || old.learnerId !== learnerId) fail('Original booking not found.', 'not-found');
      if (!learnerCanReschedule(old)) fail('This booking can no longer be rescheduled online. Please contact your instructor.');
    }
    const tz = tzOf(instructor);
    const ref = await reserveRef(tx, startAt, tz);

    assertWithinHours(instructor, existing, startAt, minutes, old ? [old.id] : []);

    // --- writes ---
    const price = lessonPrice(lessonType, pricingFor(instructor, learner));
    let balance = learner.walletBalance ?? 0;

    // Moving a confirmed lesson: release and refund the old one first.
    if (old && old.status === 'confirmed') {
      if (old.paymentStatus === 'paid' && old.price) {
        balance = walletEntry(tx, learnerId, balance, old.price, { type: 'refund', note: `Rescheduled ${old.ref ?? ''}`.trim(), bookingId: old.id });
      }
      tx.update(db.doc(`bookings/${old.id}`), {
        ...bookingFields({ ...old, status: 'cancelled', cancelledBy: 'learner', paymentStatus: old.paymentStatus === 'paid' ? 'refunded' : old.paymentStatus }),
        rescheduledTo: bookingRef.id,
        history: FieldValue.arrayUnion(historyEntry('Rescheduled to a new time', 'learner', learner.firstName)),
      });
    } else if (old) {
      tx.update(db.doc(`bookings/${old.id}`), { ...bookingFields(old), rescheduledTo: bookingRef.id });
    }

    const paid = balance >= price;
    if (paid) balance = walletEntry(tx, learnerId, balance, -price, { type: 'booking', note: `Booking ${ref.value}`, bookingId: bookingRef.id });

    ref.commit();
    const booking: Booking = {
      id: bookingRef.id,
      ref: ref.value,
      kind: 'lesson',
      status: 'confirmed',
      instructorId,
      instructorName: instructor.firstName,
      instructorMobile,
      learnerId,
      learnerName: fullName(learner),
      lessonType,
      startAt,
      endAt,
      timezone: tz,
      transmission: instructor.transmission || 'Auto',
      pickupLocation,
      dropoffLocation,
      testLocation: testLocation || undefined,
      notes: notes || undefined,
      price,
      paymentStatus: paid ? 'paid' : 'unpaid',
      proposedBy: 'learner',
      rescheduledFrom: old?.id,
    };
    tx.set(bookingRef, {
      ...bookingFields(booking),
      createdAt: FieldValue.serverTimestamp(),
      history: [historyEntry(old ? `Rescheduled from ${old.ref ?? 'a previous booking'}` : 'Booked', 'learner', learner.firstName)],
    });
    tx.update(db.doc(`users/${learnerId}`), {
      bookedInstructorIds: FieldValue.arrayUnion(instructorId),
      ...(learner.instructorId ? {} : { instructorId }),
    });
    return { booking, old, learnerName: learner.firstName };
  });

  const { booking, old } = result;
  await notify(booking.instructorId, {
    type: 'booking_confirmed',
    title: old ? `Booking ${old.ref ?? ''} moved by ${result.learnerName}` : `New booking from ${result.learnerName}`,
    body: `${LESSON_TYPES[booking.lessonType!].label} on ${when(booking)} at ${booking.pickupLocation}. Ref ${booking.ref}.`,
    link: `/instructor/bookings/${booking.id}`,
  });
  return { bookingId: booking.id, ref: booking.ref, paymentStatus: booking.paymentStatus };
});

// ---------- Instructor proposes a lesson (optionally replacing an existing booking) ----------

export const proposeBooking = onCall(opts, async req => {
  const instructorId = requireAuth(req);
  const learnerId = str(req.data?.learnerId, 'Learner', { max: 128 });
  const lessonType = lessonTypeArg(req.data?.lessonType);
  const startAt = dateArg(req.data?.startAt, 'startAt');
  const pickupLocation = str(req.data?.pickupLocation, 'Pick up location');
  const notes = str(req.data?.notes, 'Notes', { required: false, max: 1000 });
  const rescheduleOf = str(req.data?.rescheduleOf, 'rescheduleOf', { required: false, max: 128 });
  const allowOutsideHours = req.data?.allowOutsideHours === true;
  if (startAt.getTime() < Date.now()) fail('Please choose a time in the future.', 'invalid-argument');

  const minutes = LESSON_TYPES[lessonType].minutes;
  const endAt = new Date(startAt.getTime() + minutes * 60_000);
  const bookingRef = db.collection('bookings').doc();

  const { booking, old, instructorName } = await db.runTransaction(async tx => {
    const instructor = userFrom(await tx.get(db.doc(`users/${instructorId}`)));
    assertBookableInstructor(instructor);
    const instructorMobile = await instructorContact(tx, instructor);
    const learner = userFrom(await tx.get(db.doc(`users/${learnerId}`)));
    if (!learner || learner.role !== 'learner') fail('Learner not found.', 'not-found');
    const existing = await instructorBookings(tx, instructorId);
    const old = rescheduleOf ? bookingFrom(await tx.get(db.doc(`bookings/${rescheduleOf}`))) : null;
    if (rescheduleOf && (!old || old.instructorId !== instructorId)) fail('Original booking not found.', 'not-found');
    if (old && !['confirmed', 'late_cancel_requested', 'cancelled'].includes(old.status)) fail('This booking can no longer be rescheduled.');
    const tz = tzOf(instructor);
    const ref = await reserveRef(tx, startAt, tz);
    const learnerSnap = old?.status === 'confirmed' && old.paymentStatus === 'paid' ? learner : null;

    const exclude = old ? [old.id] : [];
    if (allowOutsideHours) assertSlotFree(existing, startAt, endAt, { excludeIds: exclude });
    else assertWithinHours(instructor, existing, startAt, minutes, exclude);

    if (old && old.status !== 'cancelled') {
      if (learnerSnap && old.price) {
        walletEntry(tx, learnerId, learnerSnap.walletBalance ?? 0, old.price, { type: 'refund', note: `Rescheduled ${old.ref ?? ''}`.trim(), bookingId: old.id });
      }
      tx.update(db.doc(`bookings/${old.id}`), {
        ...bookingFields({ ...old, status: 'cancelled', cancelledBy: 'instructor', paymentStatus: old.paymentStatus === 'paid' ? 'refunded' : old.paymentStatus }),
        rescheduledTo: bookingRef.id,
        history: FieldValue.arrayUnion(historyEntry('Cancelled and rescheduled by instructor', 'instructor', instructor.firstName)),
      });
    } else if (old) {
      tx.update(db.doc(`bookings/${old.id}`), { ...bookingFields(old), rescheduledTo: bookingRef.id });
    }

    ref.commit();
    const booking: Booking = {
      id: bookingRef.id,
      ref: ref.value,
      kind: 'lesson',
      status: 'proposed',
      instructorId,
      instructorName: instructor.firstName,
      instructorMobile,
      learnerId,
      learnerName: fullName(learner),
      lessonType,
      startAt,
      endAt,
      timezone: tz,
      transmission: instructor.transmission || 'Auto',
      pickupLocation,
      dropoffLocation: pickupLocation,
      notes: notes || undefined,
      price: lessonPrice(lessonType, pricingFor(instructor, learner)),
      paymentStatus: 'unpaid',
      proposedBy: 'instructor',
      rescheduledFrom: old?.id,
    };
    tx.set(bookingRef, {
      ...bookingFields(booking),
      createdAt: FieldValue.serverTimestamp(),
      history: [historyEntry(old ? `Proposed as a new time for ${old.ref ?? 'a previous booking'}` : 'Proposed', 'instructor', instructor.firstName)],
    });
    tx.update(db.doc(`users/${learnerId}`), {
      bookedInstructorIds: FieldValue.arrayUnion(instructorId),
      ...(learner.instructorId ? {} : { instructorId }),
    });
    return { booking, old, instructorName: instructor.firstName };
  });

  await notify(learnerId, {
    type: 'proposal',
    title: old ? `${instructorName} rescheduled your lesson` : `${instructorName} proposed a lesson`,
    body: old
      ? `Booking ${old.ref ?? ''} was cancelled and a new time was proposed: ${when(booking)}. Please accept or decline.`
      : `${LESSON_TYPES[lessonType].label} on ${when(booking)}, pick up at ${pickupLocation}. Please accept or decline.`,
    link: `/learner/bookings/${booking.id}`,
  });
  return { bookingId: booking.id, ref: booking.ref };
});

// ---------- Learner accepts / declines a proposal ----------

export const respondToProposal = onCall(opts, async req => {
  const learnerId = requireAuth(req);
  const bookingId = str(req.data?.bookingId, 'bookingId', { max: 128 });
  const accept = req.data?.accept === true;

  const { booking, learnerName } = await db.runTransaction(async tx => {
    const booking = bookingFrom(await tx.get(db.doc(`bookings/${bookingId}`)));
    if (!booking || booking.learnerId !== learnerId) fail('Booking not found.', 'not-found');
    if (booking.status !== 'proposed') fail('This proposal is no longer open.');
    const learner = userFrom(await tx.get(db.doc(`users/${learnerId}`)))!;
    const existing = accept ? await instructorBookings(tx, booking.instructorId) : [];

    if (!accept) {
      tx.update(db.doc(`bookings/${bookingId}`), {
        ...bookingFields({ ...booking, status: 'declined' }),
        history: FieldValue.arrayUnion(historyEntry('Declined the proposal', 'learner', learner.firstName)),
      });
      return { booking: { ...booking, status: 'declined' as const }, learnerName: learner.firstName };
    }
    if (booking.startAt.getTime() < Date.now()) fail('This proposed time has already passed.');
    assertSlotFree(existing, booking.startAt, booking.endAt, { excludeIds: [booking.id] });

    let paymentStatus = booking.paymentStatus ?? 'unpaid';
    if (booking.price && (learner.walletBalance ?? 0) >= booking.price) {
      walletEntry(tx, learnerId, learner.walletBalance ?? 0, -booking.price, { type: 'booking', note: `Booking ${booking.ref ?? ''}`.trim(), bookingId });
      paymentStatus = 'paid';
    }
    tx.update(db.doc(`bookings/${bookingId}`), {
      ...bookingFields({ ...booking, status: 'confirmed', paymentStatus }),
      history: FieldValue.arrayUnion(historyEntry('Accepted the proposal', 'learner', learner.firstName)),
    });
    return { booking: { ...booking, status: 'confirmed' as const }, learnerName: learner.firstName };
  });

  await notify(booking.instructorId, {
    type: accept ? 'proposal_accepted' : 'proposal_declined',
    title: `${learnerName} ${accept ? 'accepted' : 'declined'} booking ${booking.ref ?? ''}`.trim(),
    body: `${LESSON_TYPES[booking.lessonType!].label} on ${when(booking)}.`,
    link: `/instructor/bookings/${booking.id}`,
  });
  return { status: booking.status };
});

// ---------- Instructor withdraws a proposal ----------

export const withdrawProposal = onCall(opts, async req => {
  const instructorId = requireAuth(req);
  const bookingId = str(req.data?.bookingId, 'bookingId', { max: 128 });
  const booking = bookingFrom(await db.doc(`bookings/${bookingId}`).get());
  if (!booking || booking.instructorId !== instructorId) fail('Booking not found.', 'not-found');
  if (booking.status !== 'proposed') fail('Only open proposals can be withdrawn.');
  await db.doc(`bookings/${bookingId}`).update({
    ...bookingFields({ ...booking, status: 'withdrawn' }),
    history: FieldValue.arrayUnion(historyEntry('Withdrew the proposal', 'instructor', booking.instructorName)),
  });
  await notify(booking.learnerId, {
    type: 'proposal_withdrawn',
    title: `${booking.instructorName ?? 'Your instructor'} withdrew a proposal`,
    body: `The proposed lesson on ${when(booking)} is no longer available.`,
    link: `/learner`,
  });
  return { ok: true };
});

// ---------- Cancel (learner or instructor) ----------

export const cancelBooking = onCall(opts, async req => {
  const uid = requireAuth(req);
  const bookingId = str(req.data?.bookingId, 'bookingId', { max: 128 });
  const reason = str(req.data?.reason, 'Reason', { required: false, max: 500 });

  const outcome = await db.runTransaction(async tx => {
    const booking = bookingFrom(await tx.get(db.doc(`bookings/${bookingId}`)));
    if (!booking) fail('Booking not found.', 'not-found');
    const actor = booking.learnerId === uid ? 'learner' : booking.instructorId === uid ? 'instructor' : null;
    if (!actor) fail('Booking not found.', 'not-found');
    if (booking.kind === 'event' || booking.kind === 'open') {
      tx.delete(db.doc(`bookings/${bookingId}`));
      return { booking, result: 'deleted' as const, actor };
    }
    if (booking.status !== 'confirmed') fail(`A ${STATUS_META[booking.status].label.toLowerCase()} booking can’t be cancelled.`);
    const learner = booking.learnerId ? userFrom(await tx.get(db.doc(`users/${booking.learnerId}`))) : null;
    const actorName = actor === 'learner' ? learner?.firstName : booking.instructorName;

    // Learners inside the free-cancellation window must ask the instructor.
    if (actor === 'learner' && hoursUntil(booking.startAt) < FREE_CANCELLATION_HOURS) {
      tx.update(db.doc(`bookings/${bookingId}`), {
        ...bookingFields({ ...booking, status: 'late_cancel_requested', cancellationReason: reason || undefined }),
        history: FieldValue.arrayUnion(historyEntry('Requested a late cancellation', 'learner', actorName)),
      });
      return { booking, result: 'requested' as const, actor };
    }

    let paymentStatus = booking.paymentStatus;
    if (booking.paymentStatus === 'paid' && booking.price && learner) {
      walletEntry(tx, learner.id, learner.walletBalance ?? 0, booking.price, { type: 'refund', note: `Cancelled ${booking.ref ?? ''}`.trim(), bookingId });
      paymentStatus = 'refunded';
    }
    tx.update(db.doc(`bookings/${bookingId}`), {
      ...bookingFields({ ...booking, status: 'cancelled', cancelledBy: actor, paymentStatus, cancellationReason: reason || undefined }),
      history: FieldValue.arrayUnion(historyEntry(reason ? `Cancelled: “${reason}”` : 'Cancelled', actor, actorName)),
    });
    return { booking, result: 'cancelled' as const, actor, refunded: paymentStatus === 'refunded' };
  });

  const { booking, result, actor } = outcome;
  if (result === 'requested') {
    await notify(booking.instructorId, {
      type: 'late_cancel',
      title: `Late cancellation request for ${booking.ref ?? 'a booking'}`,
      body: `${booking.learnerName} asked to cancel the lesson on ${when(booking)} (less than ${FREE_CANCELLATION_HOURS} hours away).` +
        (reason ? ` Reason: “${reason}”.` : '') + ' Please choose whether to refund or charge.',
      link: `/instructor/bookings/${booking.id}`,
    });
  } else if (result === 'cancelled') {
    const other = actor === 'learner' ? booking.instructorId : booking.learnerId;
    await notify(other, {
      type: 'booking_cancelled',
      title: `Booking ${booking.ref ?? ''} cancelled`.trim(),
      body: `The lesson on ${when(booking)} was cancelled by ${actor === 'learner' ? booking.learnerName : booking.instructorName}.` +
        (reason ? ` Message: “${reason}”` : '') +
        ('refunded' in outcome && outcome.refunded ? ' The lesson credit has been returned to the wallet.' : ''),
      link: actor === 'learner' ? `/instructor/bookings/${booking.id}` : `/learner/bookings/${booking.id}`,
    });
  }
  return { result };
});

// ---------- Instructor decides a late cancellation ----------

export const resolveLateCancel = onCall(opts, async req => {
  const instructorId = requireAuth(req);
  const bookingId = str(req.data?.bookingId, 'bookingId', { max: 128 });
  const decision = req.data?.decision === 'charge' ? 'charge' : 'refund';

  const booking = await db.runTransaction(async tx => {
    const booking = bookingFrom(await tx.get(db.doc(`bookings/${bookingId}`)));
    if (!booking || booking.instructorId !== instructorId) fail('Booking not found.', 'not-found');
    if (booking.status !== 'late_cancel_requested') fail('There is no pending cancellation request for this booking.');
    const learner = booking.learnerId ? userFrom(await tx.get(db.doc(`users/${booking.learnerId}`))) : null;
    let paymentStatus = booking.paymentStatus;
    if (decision === 'refund' && booking.paymentStatus === 'paid' && booking.price && learner) {
      walletEntry(tx, learner.id, learner.walletBalance ?? 0, booking.price, { type: 'refund', note: `Cancelled ${booking.ref ?? ''}`.trim(), bookingId });
      paymentStatus = 'refunded';
    } else if (decision === 'charge') {
      paymentStatus = 'charged';
    }
    tx.update(db.doc(`bookings/${bookingId}`), {
      ...bookingFields({ ...booking, status: 'cancelled', cancelledBy: 'learner', paymentStatus }),
      history: FieldValue.arrayUnion(historyEntry(decision === 'refund' ? 'Approved the cancellation with a refund' : 'Approved the cancellation with a fee', 'instructor', booking.instructorName)),
    });
    return booking;
  });

  await notify(booking.learnerId, {
    type: 'late_cancel_resolved',
    title: `Cancellation of ${booking.ref ?? 'your booking'} approved`,
    body: decision === 'refund'
      ? `${booking.instructorName} cancelled your lesson on ${when(booking)} and the credit is back in your wallet. You can book a new time any time.`
      : `${booking.instructorName} cancelled your lesson on ${when(booking)}. A late cancellation fee applies.`,
    link: `/learner/bookings/${booking.id}`,
  });
  return { ok: true };
});

// ---------- Instructor personal events (block out time) ----------

export const createEvent = onCall(opts, async req => {
  const instructorId = requireAuth(req);
  const instructor = await requireUser(instructorId, 'instructor');
  // 'event' blocks time (personal events, time off); 'open' adds extra bookable hours.
  const kind = req.data?.kind === 'open' ? 'open' : 'event';
  const title = str(req.data?.title, 'Title', { required: false, max: 120 }) || (kind === 'open' ? 'Extra open hours' : 'Personal time');
  const startAt = dateArg(req.data?.startAt, 'Start');
  const endAt = dateArg(req.data?.endAt, 'End');
  if (endAt <= startAt) fail('End time must be after the start time.', 'invalid-argument');
  if (endAt.getTime() - startAt.getTime() > 60 * 86_400_000) fail('Please block at most 60 days at a time.', 'invalid-argument');
  if (kind === 'open' && endAt.getTime() - startAt.getTime() > 86_400_000) fail('Extra open hours must be within one day.', 'invalid-argument');
  const ref = await db.collection('bookings').add({
    ...bookingFields({
      id: '',
      kind,
      status: 'confirmed',
      instructorId,
      title,
      startAt,
      endAt,
      timezone: tzOf(instructor),
    }),
    createdAt: FieldValue.serverTimestamp(),
  });
  return { bookingId: ref.id };
});

