import { collection, orderBy, query } from 'firebase/firestore';
import { Eye, EyeOff, MessageSquareReply } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Button, Card, EmptyState, PageHeader, Segmented, Stars } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { mapReview, useQuery } from '@/lib/data';
import { db } from '@/lib/firebase';
import { timeAgo } from '@/lib/format';

/** Review moderation: hide a review from the website (it also stops counting towards the rating). */
export function AdminReviews() {
  const { data: reviews } = useQuery(query(collection(db, 'reviews'), orderBy('createdAt', 'desc')), mapReview, 'admin:reviews');
  const [filter, setFilter] = useState<'all' | 'visible' | 'hidden'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const list = reviews.filter(r => filter === 'all' || (filter === 'hidden' ? r.hidden : !r.hidden));

  return (
    <>
      <PageHeader title="Reviews" subtitle="Hide a review to remove it from the website. Ratings only count visible reviews." />
      <Segmented value={filter} onChange={setFilter} className="mb-4 max-w-sm [&_button]:text-center"
        options={[{ value: 'all', label: 'All' }, { value: 'visible', label: 'Visible' }, { value: 'hidden', label: 'Hidden' }]} />
      {list.length === 0 ? <Card><EmptyState title="No reviews" /></Card> : (
        <Card className="divide-y divide-ink-100 dark:divide-ink-800">
          {list.map(r => (
            <div key={r.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{r.learnerName}</span>
                  <span className="text-sm text-ink-500">on <Link to={`/admin/users/${r.instructorId}`} className="underline">their instructor</Link></span>
                  {r.hidden && <Badge tone="slate">Hidden</Badge>}
                  <span className="text-xs text-ink-400">{r.createdAt ? timeAgo(r.createdAt) : ''}</span>
                </div>
                <Stars value={r.rating} />
                {r.comment && <p className="mt-1 text-sm text-ink-700 dark:text-ink-300">{r.comment}</p>}
                {r.reply && <p className="mt-2 flex gap-1.5 text-xs text-ink-500"><MessageSquareReply className="size-3.5 shrink-0" />Instructor replied: “{r.reply}”</p>}
              </div>
              <Button size="sm" variant={r.hidden ? 'secondary' : 'ghost'} icon={r.hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />} loading={busy === r.id}
                onClick={async () => {
                  setBusy(r.id);
                  try {
                    const res = await api.setReviewHidden({ reviewId: r.id, hidden: !r.hidden });
                    toast.success(`${r.hidden ? 'Shown' : 'Hidden'}. Instructor rating is now ${res.ratingCount ? res.ratingAvg.toFixed(1) : '—'} from ${res.ratingCount} review${res.ratingCount === 1 ? '' : 's'}.`);
                  } catch (err) {
                    toast.error(errorMessage(err));
                  } finally {
                    setBusy(null);
                  }
                }}>{r.hidden ? 'Show on website' : 'Hide from website'}</Button>
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
