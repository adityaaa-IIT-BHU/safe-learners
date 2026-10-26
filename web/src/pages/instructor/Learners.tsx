import { ArrowLeft, Mail, Phone, Search, Send, UserPlus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CLOSED_STATUSES, fullName, isExpiredProposal, type Booking } from '@shared/domain';
import { useAuth } from '@/auth/AuthProvider';
import { BookingRow } from '@/components/booking';
import { Avatar, Badge, Button, ButtonLink, Card, CardHeader, EmptyState, PageHeader, PageLoader, Skeleton, Stat } from '@/components/ui';
import { useBookings, useUser } from '@/lib/data';
import { InviteLearnerModal } from './actions';
import { useMyLearners } from './useLearners';

function statsFor(learnerId: string, bookings: Booking[]) {
  const now = Date.now();
  const mine = bookings.filter(b => b.learnerId === learnerId && b.kind === 'lesson');
  const done = mine.filter(b => b.status === 'completed' || (b.status === 'confirmed' && b.endAt.getTime() < now));
  return {
    hours: done.reduce((s, b) => s + (b.endAt.getTime() - b.startAt.getTime()) / 3_600_000, 0),
    upcoming: mine.filter(b => b.status === 'confirmed' && b.startAt.getTime() > now).length,
    proposals: mine.filter(b => b.status === 'proposed' && b.startAt.getTime() > now && !isExpiredProposal(b)).length,
    last: done.at(-1),
    all: mine,
  };
}

export function Learners() {
  const { uid, readOnly } = useAuth();
  const { data: bookings } = useBookings('instructorId', uid);
  const { learners, loading } = useMyLearners(uid, bookings);
  const [search, setSearch] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return learners.filter(l => !q || [fullName(l), l.mobile, l.email, l.inviteEmail].some(v => v?.toLowerCase().includes(q)));
  }, [learners, search]);

  return (
    <>
      <PageHeader title="Learners" subtitle={`${learners.length} learner${learners.length === 1 ? '' : 's'}`}
        actions={<Button icon={<UserPlus className="size-4" />} onClick={() => setInviteOpen(true)} disabled={readOnly}>Invite learner</Button>} />
      <Card className="mb-4 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name, phone or email" className="input pl-10" aria-label="Search learners" />
        </div>
      </Card>
      {loading ? (
        <div className="space-y-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : filtered.length === 0 ? (
        <Card><EmptyState icon={<Users className="size-6" />} title={search ? 'No learners match' : 'No learners yet'} body={search ? undefined : 'Invite a learner by email, or they’ll appear here after their first booking with you.'} action={!search ? <Button onClick={() => setInviteOpen(true)} disabled={readOnly}>Invite a learner</Button> : undefined} /></Card>
      ) : (
        <Card className="divide-y divide-ink-100 dark:divide-ink-800">
          {filtered.map(l => {
            const s = statsFor(l.id, bookings);
            return (
              <Link key={l.id} to={`/instructor/learners/${l.id}`} className="flex flex-wrap items-center gap-4 px-5 py-4 transition hover:bg-ink-50 dark:hover:bg-ink-800/50">
                <Avatar name={fullName(l)} src={l.photoUrl} size={44} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-bold">{fullName(l)} {l.status === 'invited' && <Badge tone="amber">Invited</Badge>}</p>
                  <p className="truncate text-sm text-ink-500">{l.mobile || l.email || l.inviteEmail}</p>
                </div>
                <div className="flex gap-6 text-center text-sm">
                  <div><p className="font-extrabold">{s.hours % 1 ? s.hours.toFixed(1) : s.hours}</p><p className="text-xs text-ink-500">hours</p></div>
                  <div><p className="font-extrabold">{s.upcoming}</p><p className="text-xs text-ink-500">upcoming</p></div>
                  {s.proposals > 0 && <div><p className="font-extrabold text-amber-600">{s.proposals}</p><p className="text-xs text-ink-500">proposed</p></div>}
                </div>
              </Link>
            );
          })}
        </Card>
      )}
      <InviteLearnerModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </>
  );
}

export function LearnerDetail() {
  const { id = '' } = useParams();
  const { uid } = useAuth();
  const { data: learner, loading } = useUser(id);
  const { data: bookings } = useBookings('instructorId', uid);
  if (loading) return <PageLoader />;
  if (!learner) return <Card><EmptyState title="Learner not found" action={<ButtonLink to="/instructor/learners">All learners</ButtonLink>} /></Card>;

  const s = statsFor(id, bookings);
  const list = [...s.all].sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  const email = learner.email ?? learner.inviteEmail;
  return (
    <>
      <PageHeader
        back={<Link to="/instructor/learners" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white"><ArrowLeft className="size-4" />Learners</Link>}
        title={<span className="flex items-center gap-3"><Avatar name={fullName(learner)} src={learner.photoUrl} size={48} />{fullName(learner)}</span>}
        subtitle={learner.status === 'invited' ? 'Invited — hasn’t created an account yet' : undefined}
        actions={<ButtonLink to={`/instructor/propose?learner=${id}`}><Send className="size-4" />Propose a lesson</ButtonLink>}
      />
      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_300px]">
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Hours completed" value={s.hours % 1 ? s.hours.toFixed(1) : s.hours} />
            <Stat label="Upcoming" value={s.upcoming} />
            <Stat label="Lessons booked" value={s.all.filter(b => !CLOSED_STATUSES.includes(b.status) || b.status === 'cancelled').length} />
          </div>
          <section className="space-y-3">
            <h2 className="font-bold">Lessons</h2>
            {list.length ? list.map(b => <BookingRow key={b.id} booking={b} to={`/instructor/bookings/${b.id}`} />) : <Card><EmptyState title="No lessons yet" /></Card>}
          </section>
        </div>
        <Card className="h-fit">
          <CardHeader title="Contact" />
          <div className="space-y-2 p-5">
            {learner.mobile && <a href={`tel:${learner.mobile.replace(/\s/g, '')}`} className="flex items-center gap-2 rounded-xl bg-ink-50 px-4 py-3 text-sm font-semibold hover:bg-ink-100 dark:bg-ink-800"><Phone className="size-4" />{learner.mobile}</a>}
            {email && <a href={`mailto:${email}`} className="flex items-center gap-2 rounded-xl bg-ink-50 px-4 py-3 text-sm font-semibold hover:bg-ink-100 dark:bg-ink-800"><Mail className="size-4" /><span className="truncate">{email}</span></a>}
            {learner.homeSuburb && <p className="pt-2 text-sm text-ink-500">Usual pick up: {learner.homeSuburb}</p>}
          </div>
        </Card>
      </div>
    </>
  );
}
