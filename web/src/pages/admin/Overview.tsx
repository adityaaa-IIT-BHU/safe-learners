import { collection, limit, orderBy, query } from 'firebase/firestore';
import { BadgeCheck, CalendarDays, GraduationCap, MessageSquareText, Users } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader, EmptyState, PageHeader, Stat } from '@/components/ui';
import { mapBooking, mapUser, toDate, useNotifications, useQuery } from '@/lib/data';
import { db } from '@/lib/firebase';
import { timeAgo } from '@/lib/format';

export function useAllUsers() {
  return useQuery(query(collection(db, 'users')), mapUser, 'admin:users');
}

export function useAllBookings() {
  const live = useQuery(query(collection(db, 'bookings')), mapBooking, 'admin:bookings');
  const data = useMemo(() => [...live.data].sort((a, b) => b.startAt.getTime() - a.startAt.getTime()), [live.data]);
  return { ...live, data };
}

export function AdminOverview() {
  const { data: users } = useAllUsers();
  const { data: bookings } = useAllBookings();
  const { data: notifications } = useNotifications('admin');
  const { data: feedback } = useQuery(
    query(collection(db, 'feedback'), orderBy('createdAt', 'desc'), limit(10)),
    (id, d) => ({ id, name: d.name as string, role: d.role as string, topic: d.topic as string, message: d.message as string, createdAt: toDate(d.createdAt) }),
    'admin:feedback',
  );

  const stats = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    return {
      learners: users.filter(u => u.role === 'learner' && u.status !== 'claimed').length,
      instructors: users.filter(u => u.role === 'instructor').length,
      pending: users.filter(u => u.role === 'instructor' && u.verificationStatus === 'pending_review').length,
      newBookings: bookings.filter(b => b.kind === 'lesson' && (b.createdAt?.getTime() ?? 0) > weekAgo).length,
    };
  }, [users, bookings]);

  return (
    <>
      <PageHeader title="Admin overview" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Learners" value={stats.learners} icon={<GraduationCap className="size-4" />} />
        <Stat label="Instructors" value={stats.instructors} icon={<Users className="size-4" />} />
        <Stat label="Awaiting verification" value={stats.pending} icon={<BadgeCheck className="size-4" />} sub={<Link to="/admin/verifications" className="underline">Review now</Link>} />
        <Stat label="Bookings this week" value={stats.newBookings} icon={<CalendarDays className="size-4" />} sub={<Link to="/admin/bookings" className="underline">All bookings</Link>} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Activity" />
          {notifications.length === 0 ? <EmptyState title="No activity yet" /> : (
            <ul className="divide-y divide-ink-100 dark:divide-ink-800">
              {notifications.slice(0, 15).map(n => (
                <li key={n.id}>
                  <Link to={n.link ?? '#'} className="block px-5 py-3 hover:bg-ink-50 dark:hover:bg-ink-800/50">
                    <p className="text-sm font-semibold">{n.title}</p>
                    <p className="text-xs text-ink-500">{n.body}</p>
                    {n.createdAt && <p className="mt-0.5 text-[11px] text-ink-400">{timeAgo(n.createdAt)}</p>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><MessageSquareText className="size-4" />Feedback & support requests</span>} />
          {feedback.length === 0 ? <EmptyState title="No feedback yet" /> : (
            <ul className="divide-y divide-ink-100 dark:divide-ink-800">
              {feedback.map(f => (
                <li key={f.id} className="px-5 py-3">
                  <p className="text-xs font-semibold uppercase text-ink-400">{f.topic} · {f.name} ({f.role}){f.createdAt ? ` · ${timeAgo(f.createdAt)}` : ''}</p>
                  <p className="mt-1 whitespace-pre-line text-sm">{f.message}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
