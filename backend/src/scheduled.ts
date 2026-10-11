import { onSchedule } from 'firebase-functions/v2/scheduler';
import {
  LESSON_TYPES,
  REFERRAL_REWARD_FRIEND,
  REFERRAL_REWARD_REFERRER,
  pricingOf,
} from '../../shared/domain';
import { formatDate, formatTime } from '../../shared/time';
import { FieldValue, Timestamp, bookingFields, bookingFrom, db, historyEntry, logger, notify, userFrom, walletEntry } from './core';

const opts = { region: 'australia-southeast1', timeZone: 'Australia/Sydney' };

/** Marks finished lessons as completed, prompts for a review and pays out referral rewards. */
export const completeLessons = onSchedule({ ...opts, schedule: 'every 30 minutes' }, async () => {
  const snap = await db.collection('bookings')
    .where('status', '==', 'confirmed')
    .where('endAt', '<=', Timestamp.now())
    .limit(300)
    .get();
  for (const doc of snap.docs) {
    const booking = bookingFrom(doc);
    if (!booking) continue;
    if (booking.kind === 'event') {
      await doc.ref.update({ status: 'completed' });
      continue;
    }
    await doc.ref.update({
      ...bookingFields({ ...booking, status: 'completed' }),
      history: FieldValue.arrayUnion(historyEntry('Lesson completed', 'system')),
    });
    await notify(booking.learnerId, {
      type: 'review_prompt',
      title: `How was your lesson with ${booking.instructorName}?`,
      body: 'Leave a quick rating to help other learners find great instructors.',
      link: `/learner/bookings/${booking.id}?review=1`,
      email: false,
    });
    if (booking.learnerId) await payReferralReward(booking.learnerId);
  }
  logger.info(`Completed ${snap.size} bookings`);
});

/** First completed lesson of a referred learner credits both learners once. */
async function payReferralReward(learnerId: string) {
  const reward = await db.runTransaction(async tx => {
    const learner = userFrom(await tx.get(db.doc(`users/${learnerId}`)));
    if (!learner?.referredBy || (learner as any).referralRewarded) return null;
    const referrer = userFrom(await tx.get(db.doc(`users/${learner.referredBy}`)));
    if (!referrer) return null;
    walletEntry(tx, learner.id, learner.walletBalance ?? 0, REFERRAL_REWARD_FRIEND, { type: 'referral', note: `Welcome reward from ${referrer.firstName}’s referral` });
    walletEntry(tx, referrer.id, referrer.walletBalance ?? 0, REFERRAL_REWARD_REFERRER, { type: 'referral', note: `Referral reward for ${learner.firstName}` });
    tx.update(db.doc(`users/${learner.id}`), { referralRewarded: true });
    return { referrer, learner };
  });
  if (!reward) return;
  await notify(reward.referrer.id, {
    type: 'referral',
    title: `You earned $${REFERRAL_REWARD_REFERRER}!`,
    body: `${reward.learner.firstName} completed their first lesson. $${REFERRAL_REWARD_REFERRER} has been added to your wallet.`,
    link: '/learner/wallet',
  });
  await notify(reward.learner.id, {
    type: 'referral',
    title: `$${REFERRAL_REWARD_FRIEND} added to your wallet`,
    body: 'Thanks for joining through a friend’s referral.',
    link: '/learner/wallet',
  });
}

/** Applies scheduled price changes from local midnight (every 15 min so half-hour zones like Adelaide are on time). */
export const applyPriceChanges = onSchedule({ ...opts, schedule: 'every 15 minutes' }, async () => {
  const snap = await db.collection('users')
    .where('pendingPriceChange.effectiveAt', '<=', Timestamp.now())
    .get();
  for (const doc of snap.docs) {
    const user = userFrom(doc)!;
    const pending = user.pendingPriceChange!;
    // pricingOf already folds in a change whose start time has passed.
    const pricing = pricingOf(user);
    await doc.ref.update({ pricing, pendingPriceChange: FieldValue.delete() });
    await notify(doc.id, {
      type: 'price_change',
      title: 'Your new prices are live',
      body: `Learners now see $${pending.newPrice}/hr${pending.newTestPackage ? ` and $${pending.newTestPackage} for the test package` : ''}.`,
      link: '/instructor/pricing',
      email: false,
    });
  }
});

/** Day-before reminders for learners and instructors. */
export const lessonReminders = onSchedule({ ...opts, schedule: 'every 60 minutes' }, async () => {
  const now = Date.now();
  const snap = await db.collection('bookings')
    .where('status', '==', 'confirmed')
    .where('startAt', '>=', Timestamp.fromMillis(now + 23 * 3_600_000))
    .where('startAt', '<', Timestamp.fromMillis(now + 25 * 3_600_000))
    .get();
  for (const doc of snap.docs) {
    const booking = bookingFrom(doc);
    if (!booking || booking.kind !== 'lesson' || doc.data().reminderSent) continue;
    await doc.ref.update({ reminderSent: true });
    const when = `${formatDate(booking.startAt, booking.timezone)} at ${formatTime(booking.startAt, booking.timezone)}`;
    const label = LESSON_TYPES[booking.lessonType!].label;
    await notify(booking.learnerId, {
      type: 'reminder',
      title: `Reminder: lesson tomorrow with ${booking.instructorName}`,
      body: `${label} on ${when}. Pick up: ${booking.pickupLocation}. Bring your learner licence!`,
      link: `/learner/bookings/${booking.id}`,
    });
    await notify(booking.instructorId, {
      type: 'reminder',
      title: `Reminder: ${booking.learnerName} tomorrow`,
      body: `${label} on ${when}. Pick up: ${booking.pickupLocation}.`,
      link: `/instructor/bookings/${booking.id}`,
      email: false,
    });
  }
});
