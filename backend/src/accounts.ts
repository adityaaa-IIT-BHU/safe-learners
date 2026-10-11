import { onCall } from 'firebase-functions/v2/https';
import { DEFAULT_TIMEZONE, formatDate } from '../../shared/time';
import {
  priceChangeEffectiveAt,
  pricingOf,
  VERIFICATION_STEPS,
  fullName,
  isExpired,
  normaliseBooking,
  type UserProfile,
} from '../../shared/domain';
import {
  APP_URL,
  FieldValue,
  Timestamp,
  auth,
  bookingFields,
  db,
  fail,
  isAdminEmail,
  notify,
  notifyAdmins,
  requireAdmin,
  requireAuth,
  requireUser,
  sendEmail,
  toDate,
  userFrom,
  walletEntry,
} from './core';

const opts = { region: 'australia-southeast1', cors: true };

function referralCodeFor(user: Pick<UserProfile, 'firstName'>): string {
  const base = (user.firstName || 'SL').replace(/[^a-z]/gi, '').toUpperCase().slice(0, 6) || 'SL';
  return `${base}${Math.floor(1000 + Math.random() * 9000)}`;
}

// ---------- Called after every sign-in: admin claim, referral code, invites ----------

export const onboardUser = onCall(opts, async req => {
  const uid = requireAuth(req);
  const email = (req.auth!.token.email || '').toLowerCase();
  let claimsChanged = false;

  // Admin access comes from the ADMIN_EMAILS list.
  const shouldBeAdmin = isAdminEmail(email);
  if (shouldBeAdmin !== (req.auth!.token.admin === true)) {
    await auth.setCustomUserClaims(uid, shouldBeAdmin ? { admin: true } : {});
    claimsChanged = true;
  }

  const ref = db.doc(`users/${uid}`);
  let user = userFrom(await ref.get());
  if (!user && shouldBeAdmin) {
    await ref.set({ role: 'admin', firstName: 'Admin', email, createdAt: FieldValue.serverTimestamp() });
    user = userFrom(await ref.get());
  }
  if (!user) return { claimsChanged, admin: shouldBeAdmin };

  const updates: Record<string, unknown> = {};
  if (user.role === 'learner' && !user.referralCode) updates.referralCode = referralCodeFor(user);
  if (user.role === 'learner' && user.walletBalance === undefined) updates.walletBalance = 0;

  // A referral code entered at sign-up (only once, never your own).
  const code = typeof req.data?.referralCode === 'string' ? req.data.referralCode.trim().toUpperCase() : '';
  if (code && user.role === 'learner' && !user.referredBy) {
    const referrer = await db.collection('users').where('referralCode', '==', code).limit(1).get();
    if (!referrer.empty && referrer.docs[0].id !== uid) {
      updates.referredBy = referrer.docs[0].id;
      await referrer.docs[0].ref.update({ referralCount: FieldValue.increment(1) });
    }
  }
  if (Object.keys(updates).length) await ref.update(updates);

  // Learners invited by an instructor before they had an account: move proposals over.
  let claimed = 0;
  if (user.role === 'learner' && email) {
    const invites = await db.collection('users').where('inviteEmail', '==', email).where('status', '==', 'invited').get();
    for (const invite of invites.docs) {
      if (invite.id === uid) continue;
      const bookings = await db.collection('bookings').where('learnerId', '==', invite.id).get();
      const batch = db.batch();
      bookings.forEach(b => batch.update(b.ref, { learnerId: uid, learnerName: fullName(user!) }));
      const invitedBy = invite.data().invitedBy;
      if (invitedBy) {
        batch.update(ref, {
          privateInstructorIds: FieldValue.arrayUnion(invitedBy),
          ...(user.instructorId ? {} : { instructorId: invitedBy }),
        });
      }
      batch.update(invite.ref, { status: 'claimed', claimedBy: uid });
      await batch.commit();
      claimed += bookings.size;
      if (invitedBy) {
        await notify(invitedBy, {
          type: 'invite_accepted',
          title: `${user.firstName} joined Safe Learners`,
          body: `${fullName(user)} accepted your invitation${bookings.size ? ' and can now respond to your proposals' : ''}.`,
          link: `/instructor/learners/${uid}`,
        });
      }
    }
  }
  return { claimsChanged, admin: shouldBeAdmin, claimed };
});

// ---------- Instructor invites a learner by email ----------

export const inviteLearner = onCall(opts, async req => {
  const instructorId = requireAuth(req);
  const instructor = await requireUser(instructorId, 'instructor');
  const firstName = String(req.data?.firstName || '').trim();
  const surname = String(req.data?.surname || '').trim();
  const email = String(req.data?.email || '').trim().toLowerCase();
  const mobile = String(req.data?.mobile || '').trim();
  if (!firstName) fail('Learner name is required.', 'invalid-argument');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Please enter a valid email address.', 'invalid-argument');

  // Already a learner? Link them instead of creating a duplicate.
  let existingUid: string | null = null;
  try {
    existingUid = (await auth.getUserByEmail(email)).uid;
  } catch {
    existingUid = null;
  }
  if (existingUid) {
    const existing = userFrom(await db.doc(`users/${existingUid}`).get());
    if (existing?.role !== 'learner') fail('That email belongs to a non-learner account.');
    await db.doc(`users/${existingUid}`).update({
      privateInstructorIds: FieldValue.arrayUnion(instructorId),
      ...(existing.instructorId ? {} : { instructorId }),
    });
    await notify(existingUid, {
      type: 'invite',
      title: `${instructor.firstName} added you as a learner`,
      body: `${fullName(instructor)} can now propose lessons to you on Safe Learners.`,
      link: '/learner',
    });
    return { learnerId: existingUid, existing: true, emailed: true };
  }

  const pending = await db.collection('users').where('inviteEmail', '==', email).where('status', '==', 'invited').limit(1).get();
  const learnerRef = pending.empty ? db.collection('users').doc() : pending.docs[0].ref;
  await learnerRef.set({
    role: 'learner',
    status: 'invited',
    firstName,
    surname,
    mobile,
    inviteEmail: email,
    invitedBy: instructorId,
    instructorId,
    createdAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  const emailed = await sendEmail(
    email,
    `${instructor.firstName} invited you to Safe Learners`,
    `Hi ${firstName},\n\n${fullName(instructor)} has invited you to book driving lessons on Safe Learners.\n\n` +
      `Create your account with this email address (${email}) to see and accept your lessons:\n${APP_URL}/signup?email=${encodeURIComponent(email)}`,
  );
  return { learnerId: learnerRef.id, existing: false, emailed };
});

// ---------- Instructor pricing: changes go live after a 24 hour notice period ----------

function priceArg(v: unknown, label: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${label} must be between $${min} and $${max}.`, 'invalid-argument');
  return Math.round(n * 100) / 100;
}

export const requestPriceChange = onCall(opts, async req => {
  const uid = requireAuth(req);
  const instructor = await requireUser(uid, 'instructor');
  const lesson = priceArg(req.data?.lesson, 'Hourly price', 30, 300);
  if (lesson === undefined) fail('Hourly price is required.', 'invalid-argument');
  const testPackage = priceArg(req.data?.testPackage, 'Test package price', 50, 1000);
  const privateLesson = priceArg(req.data?.privateLesson, 'Private hourly price', 30, 300);
  const privateTestPackage = priceArg(req.data?.privateTestPackage, 'Private test package price', 50, 1000);

  // New prices go live at the next midnight in the instructor's time zone.
  const tz = instructor.timezone || DEFAULT_TIMEZONE;
  const effectiveAt = priceChangeEffectiveAt(new Date(), tz);
  // A previous change that has already started counts as the current price.
  const current = pricingOf(instructor);
  await db.doc(`users/${uid}`).update({
    pricing: current,
    pendingPriceChange: {
      newPrice: lesson,
      ...(testPackage !== undefined ? { newTestPackage: testPackage } : {}),
      ...(privateLesson !== undefined ? { newPrivateLesson: privateLesson } : {}),
      ...(privateTestPackage !== undefined ? { newPrivateTestPackage: privateTestPackage } : {}),
      requestedAt: FieldValue.serverTimestamp(),
      effectiveAt: Timestamp.fromDate(effectiveAt),
    },
  });
  await notifyAdmins({
    type: 'price_change',
    title: 'Price change scheduled',
    body: `${fullName(instructor)}: $${lesson}/hr${testPackage ? `, test package $${testPackage}` : ''}` +
      `${privateLesson ? `; private learners $${privateLesson}/hr` : ''}${privateTestPackage ? `, private test package $${privateTestPackage}` : ''}` +
      `, from midnight ${formatDate(effectiveAt, tz)}.`,
    link: `/admin/users/${uid}`,
  });
  return { effectiveAt: effectiveAt.toISOString() };
});

export const cancelPriceChange = onCall(opts, async req => {
  const uid = requireAuth(req);
  await requireUser(uid, 'instructor');
  await db.doc(`users/${uid}`).update({ pendingPriceChange: FieldValue.delete() });
  return { ok: true };
});

// ---------- Instructor verification ----------

export const submitVerification = onCall(opts, async req => {
  const uid = requireAuth(req);
  const instructor = await requireUser(uid, 'instructor');
  const priv = (await db.doc(`users/${uid}/private/profile`).get()).data() || {};
  const docs = priv.verification || {};
  const missing = VERIFICATION_STEPS.filter(s => !docs[s.key]?.url || !docs[s.key]?.number || !docs[s.key]?.expiry);
  if (missing.length) fail(`Please complete: ${missing.map(m => m.label).join(', ')}.`);
  const expired = VERIFICATION_STEPS.filter(s => isExpired(docs[s.key]?.expiry));
  if (expired.length) fail(`These documents have expired: ${expired.map(m => m.label).join(', ')}. Please update them.`);
  await db.doc(`users/${uid}`).update({
    verificationStatus: 'pending_review',
    verificationSubmittedAt: FieldValue.serverTimestamp(),
    documentReviews: Object.fromEntries(VERIFICATION_STEPS.map(s => [s.key, { status: 'pending', submittedAt: Timestamp.now() }])),
    documentsPending: true,
  });
  await notifyAdmins({
    type: 'verification',
    title: 'Instructor verification submitted',
    body: `${fullName(instructor)} submitted their documents for review.`,
    link: `/admin/verifications`,
  });
  return { ok: true };
});

export const reviewVerification = onCall(opts, async req => {
  requireAdmin(req);
  const uid = String(req.data?.uid || '');
  const approve = req.data?.approve === true;
  const reason = String(req.data?.reason || '').slice(0, 500);
  const instructor = userFrom(await db.doc(`users/${uid}`).get());
  if (!instructor || instructor.role !== 'instructor') fail('Instructor not found.', 'not-found');
  await db.doc(`users/${uid}`).update({
    verificationStatus: approve ? 'verified' : 'rejected',
    verificationRejectionReason: approve ? FieldValue.delete() : reason || 'Please check your documents and resubmit.',
    ...(approve ? {
      documentReviews: Object.fromEntries(VERIFICATION_STEPS.map(s => [s.key, { status: 'approved', reviewedAt: Timestamp.now() }])),
      documentsPending: false,
    } : {}),
  });
  await notify(uid, {
    type: 'verification_result',
    title: approve ? 'You’re verified!' : 'Verification needs attention',
    body: approve
      ? 'Your documents were approved. Learners can now find and book you.'
      : `Your documents could not be approved: ${reason || 'please check and resubmit.'}`,
    link: approve ? '/instructor' : '/instructor/verification',
  });
  return { ok: true };
});

// ---------- Reviews ----------

export const submitReview = onCall(opts, async req => {
  const learnerId = requireAuth(req);
  const bookingId = String(req.data?.bookingId || '');
  const rating = Math.round(Number(req.data?.rating));
  const comment = String(req.data?.comment || '').trim().slice(0, 2000);
  if (!(rating >= 1 && rating <= 5)) fail('Please choose a rating from 1 to 5.', 'invalid-argument');

  const result = await db.runTransaction(async tx => {
    const bookingSnap = await tx.get(db.doc(`bookings/${bookingId}`));
    const booking = bookingSnap.exists ? normaliseBooking(bookingSnap.id, bookingSnap.data()!, toDate) : null;
    if (!booking || booking.learnerId !== learnerId) fail('Booking not found.', 'not-found');
    if (booking.status !== 'completed' && !(booking.status === 'confirmed' && booking.endAt.getTime() < Date.now())) {
      fail('You can review a lesson once it has been completed.');
    }
    if (booking.reviewed) fail('You have already reviewed this lesson.');
    const instructorRef = db.doc(`users/${booking.instructorId}`);
    const instructor = userFrom(await tx.get(instructorRef))!;
    const learner = userFrom(await tx.get(db.doc(`users/${learnerId}`)))!;
    const count = (instructor.ratingCount ?? 0) + 1;
    const avg = ((instructor.ratingAvg ?? 0) * (count - 1) + rating) / count;
    tx.set(db.collection('reviews').doc(), {
      bookingId,
      instructorId: booking.instructorId,
      instructorName: instructor.firstName,
      learnerId,
      learnerName: learner.firstName,
      rating,
      comment,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(instructorRef, { ratingAvg: Math.round(avg * 100) / 100, ratingCount: count });
    tx.update(bookingSnap.ref, { reviewed: true });
    return { instructorId: booking.instructorId, learnerName: learner.firstName };
  });
  await notify(result.instructorId, {
    type: 'review',
    title: `New ${rating}★ review from ${result.learnerName}`,
    body: comment ? `“${comment.slice(0, 160)}”` : 'A learner rated their lesson.',
    link: '/instructor/reviews',
    email: false,
  });
  return { ok: true };
});

// ---------- Admin tools ----------

export const setAccountStatus = onCall(opts, async req => {
  requireAdmin(req);
  const uid = String(req.data?.uid || '');
  const status = req.data?.status === 'disabled' ? 'disabled' : 'active';
  await db.doc(`users/${uid}`).update({ accountStatus: status });
  await auth.updateUser(uid, { disabled: status === 'disabled' }).catch(() => undefined);
  return { ok: true };
});

export const adjustWallet = onCall(opts, async req => {
  requireAdmin(req);
  const uid = String(req.data?.uid || '');
  const amount = Math.round(Number(req.data?.amount) * 100) / 100;
  const note = String(req.data?.note || 'Adjustment by Safe Learners').slice(0, 200);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 5000) fail('Enter an amount between -$5000 and $5000.', 'invalid-argument');
  const balance = await db.runTransaction(async tx => {
    const user = userFrom(await tx.get(db.doc(`users/${uid}`)));
    if (!user || user.role !== 'learner') fail('Learner not found.', 'not-found');
    if ((user.walletBalance ?? 0) + amount < 0) fail('The wallet balance can’t go below $0.');
    return walletEntry(tx, uid, user.walletBalance ?? 0, amount, { type: amount > 0 ? 'topup' : 'adjustment', note });
  });
  await notify(uid, {
    type: 'wallet',
    title: amount > 0 ? `$${amount.toFixed(2)} added to your wallet` : `Wallet adjusted by $${amount.toFixed(2)}`,
    body: `${note}. New balance: $${balance.toFixed(2)}.`,
    link: '/learner/wallet',
  });
  return { balance };
});

/** One-off: rewrite bookings created by the old site into the new schema (keeps the old fields too). */
export const migrateLegacyBookings = onCall({ ...opts, timeoutSeconds: 300 }, async req => {
  requireAdmin(req);
  const snap = await db.collection('bookings').get();
  let migrated = 0;
  let skipped = 0;
  let batch = db.batch();
  let pending = 0;
  for (const doc of snap.docs) {
    const raw = doc.data();
    if (raw.startAt) continue;
    const booking = normaliseBooking(doc.id, raw, toDate);
    if (!booking) {
      skipped++;
      continue;
    }
    batch.update(doc.ref, { ...bookingFields(booking), legacyMigratedAt: FieldValue.serverTimestamp() });
    migrated++;
    if (++pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending) await batch.commit();
  return { migrated, skipped };
});
