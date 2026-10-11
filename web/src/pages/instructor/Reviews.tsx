import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import { MessageSquareReply, Star } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Button, Card, CardHeader, EmptyState, PageHeader, Stars, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { db } from '@/lib/firebase';
import { useInstructorReviews, type Review } from '@/lib/data';
import { timeAgo } from '@/lib/format';

export function Reviews() {
  const me = useProfile();
  const { uid } = useAuth();
  const { data: reviews } = useInstructorReviews(uid ?? undefined);
  const counts = [5, 4, 3, 2, 1].map(n => ({ n, count: reviews.filter(r => r.rating === n).length }));
  const total = reviews.length || 1;

  return (
    <>
      <PageHeader title="Reviews" subtitle="What your learners say. Your most recent reviews appear on your public profile." />
      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[300px_1fr]">
        <Card className="h-fit p-6 text-center">
          <p className="text-5xl font-extrabold">{me.ratingCount ? me.ratingAvg?.toFixed(1) : '—'}</p>
          <div className="mt-2 flex justify-center"><Stars value={me.ratingAvg ?? 0} size={20} /></div>
          <p className="mt-1 text-sm text-ink-500">{me.ratingCount ?? 0} review{me.ratingCount === 1 ? '' : 's'}</p>
          <ul className="mt-6 space-y-2 text-left text-sm">
            {counts.map(({ n, count }) => (
              <li key={n} className="flex items-center gap-2">
                <span className="w-3 font-semibold">{n}</span>
                <Star className="size-3.5 fill-brand-500 text-brand-500" />
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
                  <span className="block h-full rounded-full bg-[#b38100]" style={{ width: `${(count / total) * 100}%` }} />
                </span>
                <span className="w-6 text-right text-ink-500">{count}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="All reviews" />
          {reviews.length === 0 ? (
            <EmptyState icon={<Star className="size-6" />} title="No reviews yet" body="Learners are asked for a rating after each completed lesson." />
          ) : (
            <ul className="divide-y divide-ink-100 dark:divide-ink-800">
              {reviews.map(r => (
                <li key={r.id} className="p-5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{r.learnerName}</span>
                    <span className="text-xs text-ink-400">{r.createdAt ? timeAgo(r.createdAt) : ''}</span>
                  </div>
                  <Stars value={r.rating} />
                  {r.hidden && <p className="mt-1 text-xs font-semibold text-ink-500">Hidden from your public profile by Safe Learners</p>}
                  {r.comment && <p className="mt-2 text-sm text-ink-600 dark:text-ink-300">{r.comment}</p>}
                  <ReplyBox review={r} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function ReplyBox({ review }: { review: Review }) {
  const { readOnly } = useAuth();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(review.reply ?? '');
  const [busy, setBusy] = useState(false);
  if (!editing) {
    return review.reply ? (
      <div className="mt-3 rounded-xl border-l-4 border-brand-500 bg-ink-50 p-3 text-sm dark:bg-ink-800/60">
        <p className="text-xs font-bold text-ink-500">Your reply</p>
        <p className="mt-1">{review.reply}</p>
        {!readOnly && <button onClick={() => setEditing(true)} className="mt-1 text-xs font-semibold text-ink-500 underline">Edit reply</button>}
      </div>
    ) : !readOnly ? (
      <button onClick={() => setEditing(true)} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-white">
        <MessageSquareReply className="size-3.5" />Reply publicly
      </button>
    ) : null;
  }
  return (
    <div className="mt-3 space-y-2">
      <Textarea rows={3} maxLength={1000} value={text} onChange={e => setText(e.target.value)} placeholder="Thank the learner or respond to their feedback. Your reply is public." />
      <div className="flex gap-2">
        <Button size="sm" loading={busy} disabled={!text.trim()} onClick={async () => {
          setBusy(true);
          try {
            await updateDoc(doc(db, 'reviews', review.id), { reply: text.trim(), replyAt: serverTimestamp() });
            toast.success('Reply posted');
            setEditing(false);
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}>Post reply</Button>
        <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setText(review.reply ?? ''); }}>Cancel</Button>
      </div>
    </div>
  );
}
