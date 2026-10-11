import { onCall } from 'firebase-functions/v2/https';
import { FieldValue, db, fail, requireAdmin } from './core';

const opts = { region: 'australia-southeast1', cors: true };

/** Admin hides or shows a review; the instructor's rating only counts visible reviews. */
export const setReviewHidden = onCall(opts, async req => {
  requireAdmin(req);
  const reviewId = String(req.data?.reviewId || '');
  const hidden = req.data?.hidden === true;
  const reviewRef = db.doc(`reviews/${reviewId}`);
  const review = await reviewRef.get();
  if (!review.exists) fail('Review not found.', 'not-found');
  const instructorId = review.data()!.instructorId as string;

  await reviewRef.update({ hidden, hiddenAt: hidden ? FieldValue.serverTimestamp() : FieldValue.delete() });
  const visible = (await db.collection('reviews').where('instructorId', '==', instructorId).get()).docs
    .map(d => d.data())
    .filter(r => !r.hidden && Number(r.rating) > 0);
  const count = visible.length;
  const avg = count ? visible.reduce((s, r) => s + Number(r.rating), 0) / count : 0;
  await db.doc(`users/${instructorId}`).update({ ratingAvg: Math.round(avg * 100) / 100, ratingCount: count });
  return { ratingAvg: avg, ratingCount: count };
});
