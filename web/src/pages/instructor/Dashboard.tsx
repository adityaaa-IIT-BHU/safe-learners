import { AlertTriangle, BadgeCheck, CalendarClock, CalendarPlus, ChartColumn, Clock, Inbox, Lock, Send, Star, UserPlus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CLOSED_STATUSES, PLATFORM_FEE_RATE, hasAnyHours, isExpiredProposal, type Booking } from '@shared/domain';
import { DEFAULT_TIMEZONE, dayKey, formatTimeRange } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { BookingRow, lessonLabel } from '@/components/booking';
import { Button, ButtonLink, Card, CardHeader, EmptyState, Skeleton, Stat, Tabs, formatMoney } from '@/components/ui';
import { useBookings } from '@/lib/data';
import { greeting } from '@/lib/format';
import { BlockTimeModal, InviteLearnerModal, LateCancelActions, WithdrawButton } from './actions';

type Tab = 'upcoming' | 'proposals' | 'history';

export function InstructorDashboard() {
  const me = useProfile();
  const { uid, readOnly } = useAuth();
  const { data: bookings, loading } = useBookings('instructorId', uid);
  const [tab, setTab] = useState<Tab>('upcoming');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const tz = me.timezone ?? DEFAULT_TIMEZONE;

  const view = useMemo(() => {
    const now = Date.now();
    const lessons = bookings.filter(b => b.kind === 'lesson');
    const today = dayKey(new Date(), tz);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const done = (b: Booking) => b.status === 'completed' || (b.status === 'confirmed' && b.endAt.getTime() < now);
    return {
      lateCancels: lessons.filter(b => b.status === 'late_cancel_requested'),
      proposals: lessons.filter(b => b.status === 'proposed' && b.endAt.getTime() > now && !isExpiredProposal(b)),
      upcoming: lessons.filter(b => ['confirmed', 'late_cancel_requested'].includes(b.status) && b.endAt.getTime() > now),
      history: lessons.filter(b => b.endAt.getTime() <= now || CLOSED_STATUSES.includes(b.status) || isExpiredProposal(b)).filter(b => b.status !== 'proposed' || isExpiredProposal(b)).reverse(),
      todays: bookings.filter(b => dayKey(b.startAt, tz) === today && ['confirmed', 'late_cancel_requested', 'proposed'].includes(b.status) && !isExpiredProposal(b)),
      monthEarnings: lessons.filter(b => done(b) && b.startAt >= monthStart).reduce((s, b) => s + (b.price ?? 0) * (1 - PLATFORM_FEE_RATE), 0),
      learners: new Set(lessons.map(b => b.learnerId).filter(Boolean)).size,
    };
  }, [bookings, tz]);

  const verified = me.verificationStatus === 'verified';
  const setupMissing = [
    !hasAnyHours(me.operatingHours) && { label: 'Set your weekly availability', to: '/instructor/availability' },
    !me.servicedSuburbs?.length && { label: 'Add the suburbs you cover', to: '/instructor/availability' },
    !me.vehicle?.make && { label: 'Add your vehicle details', to: '/instructor/profile' },
    !me.bio && { label: 'Write a short bio', to: '/instructor/profile' },
  ].filter(Boolean) as { label: string; to: string }[];

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4 animate-slide-up">
        <div>
          <p className="text-sm font-semibold text-ink-500">{greeting()}</p>
          <h1 className="text-3xl font-extrabold tracking-tight">{me.firstName}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<UserPlus className="size-4" />} onClick={() => setInviteOpen(true)} disabled={readOnly}>Invite learner</Button>
          <Button variant="secondary" icon={<Lock className="size-4" />} onClick={() => setBlockOpen(true)} disabled={readOnly}>Block time</Button>
          <ButtonLink to="/instructor/propose"><Send className="size-4" />Propose a lesson</ButtonLink>
        </div>
      </div>

      {!verified && <VerificationBanner status={me.verificationStatus} />}

      {setupMissing.length > 0 && (
        <Card className="p-5">
          <p className="font-bold">Finish setting up your profile</p>
          <p className="text-sm text-ink-500">Learners see these before they book.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {setupMissing.map(s => <ButtonLink key={s.label} to={s.to} variant="secondary" size="sm">{s.label}</ButtonLink>)}
          </div>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Upcoming lessons" value={view.upcoming.length} icon={<CalendarClock className="size-4" />} sub={<Link to="/instructor/calendar" className="underline">Open calendar</Link>} />
        <Stat label="Earnings this month" value={formatMoney(view.monthEarnings)} icon={<ChartColumn className="size-4" />} sub={<Link to="/instructor/reports" className="underline">View reports</Link>} />
        <Stat label="Rating" value={me.ratingCount ? me.ratingAvg?.toFixed(1) : '—'} icon={<Star className="size-4" />} sub={me.ratingCount ? `${me.ratingCount} reviews` : 'No reviews yet'} />
        <Stat label="Learners" value={view.learners} icon={<Users className="size-4" />} sub={<Link to="/instructor/learners" className="underline">Manage learners</Link>} />
      </div>

      {view.lateCancels.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 font-bold text-red-600 dark:text-red-400"><AlertTriangle className="size-4" />Needs your decision</h2>
          {view.lateCancels.map(b => (
            <BookingRow key={b.id} booking={b} to={`/instructor/bookings/${b.id}`} person={{ name: b.learnerName }} highlight actions={<LateCancelActions booking={b} />} />
          ))}
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_320px]">
        <section>
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: 'upcoming', label: 'Upcoming', count: view.upcoming.length },
            { value: 'proposals', label: 'Pending proposals', count: view.proposals.length },
            { value: 'history', label: 'History' },
          ]} />
          <div className="mt-4 space-y-3">
            {loading ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-24" />) : (() => {
              const list = tab === 'upcoming' ? view.upcoming : tab === 'proposals' ? view.proposals : view.history.slice(0, 30);
              if (!list.length) {
                return (
                  <Card>
                    <EmptyState
                      icon={tab === 'proposals' ? <Inbox className="size-6" /> : <CalendarPlus className="size-6" />}
                      title={tab === 'proposals' ? 'No pending proposals' : tab === 'upcoming' ? 'No upcoming lessons' : 'No past lessons yet'}
                      body={tab === 'history' ? undefined : 'Propose a time to one of your learners — they’ll get a notification to accept it.'}
                      action={tab !== 'history' ? <ButtonLink to="/instructor/propose" size="sm">Propose a lesson</ButtonLink> : undefined}
                    />
                  </Card>
                );
              }
              return list.map(b => (
                <BookingRow key={b.id} booking={b} to={`/instructor/bookings/${b.id}`} person={{ name: b.learnerName }}
                  actions={b.status === 'proposed' ? <WithdrawButton booking={b} /> : b.status === 'late_cancel_requested' ? <LateCancelActions booking={b} /> : undefined} />
              ));
            })()}
          </div>
        </section>

        <Card className="h-fit">
          <CardHeader title="Today" subtitle={new Intl.DateTimeFormat('en-AU', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())} />
          {view.todays.length === 0 ? (
            <EmptyState icon={<Clock className="size-6" />} title="Nothing scheduled today" />
          ) : (
            <ol className="space-y-3 p-5">
              {view.todays.map(b => (
                <li key={b.id}>
                  <Link to={`/instructor/bookings/${b.id}`} className={`block rounded-xl border-l-4 p-3 transition hover:bg-ink-50 dark:hover:bg-ink-800 ${b.kind === 'open' ? 'border-emerald-400 bg-emerald-50/60 dark:bg-emerald-500/5' : b.kind === 'event' ? 'border-ink-300 bg-ink-50 dark:bg-ink-800/50' : b.status === 'proposed' ? 'border-amber-400 bg-amber-50/60 dark:bg-amber-500/5' : 'border-brand-500 bg-brand-50/60 dark:bg-brand-500/5'}`}>
                    <p className="text-xs font-bold text-ink-500">{formatTimeRange(b.startAt, b.endAt, b.timezone)}</p>
                    <p className="font-semibold">{b.kind === 'lesson' ? b.learnerName : lessonLabel(b)}</p>
                    <p className="truncate text-xs text-ink-500">{b.kind === 'open' ? 'Open for bookings' : b.kind === 'event' ? 'Blocked' : `${lessonLabel(b)} · ${b.pickupLocation ?? ''}`}</p>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <InviteLearnerModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
      {blockOpen && <BlockTimeModal open onClose={() => setBlockOpen(false)} timeZone={tz} />}
    </div>
  );
}

function VerificationBanner({ status }: { status?: string }) {
  const pending = status === 'pending_review';
  const rejected = status === 'rejected';
  return (
    <div className={`flex flex-col gap-4 rounded-2xl p-5 sm:flex-row sm:items-center ${pending ? 'bg-sky-50 text-sky-900 dark:bg-sky-500/10 dark:text-sky-200' : 'bg-brand-500 text-ink-950'}`}>
      <BadgeCheck className="size-8 shrink-0" />
      <div className="flex-1">
        <p className="font-bold">{pending ? 'Your documents are being reviewed' : rejected ? 'Your verification needs attention' : 'Get verified to start taking bookings'}</p>
        <p className="text-sm opacity-80">{pending ? 'We’ll notify you as soon as you’re approved. You can still set up your profile and availability.' : 'Upload your licences, WWC check and vehicle registration. It takes about five minutes.'}</p>
      </div>
      {!pending && <ButtonLink to="/instructor/verification" variant="dark">{rejected ? 'Review documents' : 'Start verification'}</ButtonLink>}
    </div>
  );
}
