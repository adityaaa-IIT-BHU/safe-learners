import { ArrowRight, CalendarPlus, CarFront, Clock, History, Inbox, MapPin, Search, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LESSON_TYPES, displayRef, fullName, lessonPrice, pricingFor, type Booking } from '@shared/domain';
import { formatDate, formatTimeRange } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { AddToCalendarButton, BookingRow } from '@/components/booking';
import { Avatar, Badge, ButtonLink, Card, CardHeader, EmptyState, Skeleton, Stat, Tabs, formatMoney } from '@/components/ui';
import { useBookings, useUser } from '@/lib/data';
import { greeting, timeUntil } from '@/lib/format';
import { CancelButton, ProposalActions, RescheduleButton } from './actions';

type Tab = 'upcoming' | 'history';

export function LearnerDashboard() {
  const me = useProfile();
  const { uid } = useAuth();
  const { data: bookings, loading } = useBookings('learnerId', uid);
  const { data: instructor } = useUser(me.instructorId);
  const [tab, setTab] = useState<Tab>('upcoming');

  const { proposals, upcoming, history, next, hoursDone } = useMemo(() => {
    const now = Date.now();
    const lessons = bookings.filter(b => b.kind === 'lesson');
    const future = lessons.filter(b => b.endAt.getTime() > now);
    const proposals = future.filter(b => b.status === 'proposed');
    // Cancelled lessons stay visible (with Rebook) until they're replaced or their date passes.
    const upcoming = future.filter(b => ['confirmed', 'late_cancel_requested'].includes(b.status) || (b.status === 'cancelled' && !b.rescheduledTo));
    const history = lessons
      .filter(b => !future.includes(b) || ['declined', 'withdrawn'].includes(b.status) || (b.status === 'cancelled' && b.rescheduledTo))
      .filter(b => b.status !== 'proposed')
      .sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
    const next = upcoming.find(b => b.status === 'confirmed');
    const hoursDone = lessons
      .filter(b => b.status === 'completed' || (b.status === 'confirmed' && b.endAt.getTime() < now))
      .reduce((sum, b) => sum + (b.endAt.getTime() - b.startAt.getTime()) / 3_600_000, 0);
    return { proposals, upcoming, history, next, hoursDone };
  }, [bookings]);

  return (
    <div className="space-y-8">
      <div className="animate-slide-up">
        <p className="text-sm font-semibold text-ink-500">{greeting()}</p>
        <h1 className="text-3xl font-extrabold tracking-tight">{me.firstName} 👋</h1>
      </div>

      {proposals.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 font-bold"><Inbox className="size-4" />Waiting for your answer</h2>
          {proposals.map(b => (
            <BookingRow key={b.id} booking={b} to={`/learner/bookings/${b.id}`} person={{ name: b.instructorName }} highlight actions={<ProposalActions booking={b} />} />
          ))}
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_340px]">
        {loading ? <Skeleton className="h-56" /> : next ? <NextLessonCard booking={next} /> : <NoLessonCard hasInstructor={!!instructor} instructorId={instructor?.id} />}
        <MyInstructorCard instructor={instructor} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Wallet balance" value={formatMoney(me.walletBalance ?? 0)} icon={<Wallet className="size-4" />} sub={<Link to="/learner/wallet" className="font-semibold underline">Add credit</Link>} />
        <Stat label="Hours driven" value={hoursDone % 1 ? hoursDone.toFixed(1) : hoursDone} icon={<Clock className="size-4" />} sub="With Safe Learners instructors" />
        <Stat label="Upcoming lessons" value={upcoming.filter(b => b.status === 'confirmed').length} icon={<CalendarPlus className="size-4" />} sub={next ? `Next ${timeUntil(next.startAt)}` : 'None booked'} />
      </div>

      {instructor && <TestPackageCard instructorId={instructor.id} name={instructor.firstName} price={lessonPrice('test-package', pricingFor(instructor, me))} />}

      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <h2 className="text-xl font-extrabold tracking-tight">Bookings</h2>
          {instructor && <ButtonLink to={`/learner/book/${instructor.id}`} size="sm">Book a lesson</ButtonLink>}
        </div>
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'upcoming', label: 'Upcoming', count: upcoming.length },
          { value: 'history', label: 'History', count: history.length },
        ]} />
        <div className="mt-4 space-y-3">
          {loading ? (
            Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-24" />)
          ) : tab === 'upcoming' ? (
            upcoming.length ? upcoming.map(b => (
              <BookingRow
                key={b.id}
                booking={b}
                to={`/learner/bookings/${b.id}`}
                person={{ name: b.instructorName }}
                actions={<><RescheduleButton booking={b} /><CancelButton booking={b} /></>}
              />
            )) : (
              <Card>
                <EmptyState
                  icon={<CalendarPlus className="size-6" />}
                  title="No upcoming lessons"
                  body="Pick a time that suits you from your instructor’s live calendar."
                  action={instructor ? <ButtonLink to={`/learner/book/${instructor.id}`}>Book a lesson</ButtonLink> : <ButtonLink to="/learner/instructors">Find an instructor</ButtonLink>}
                />
              </Card>
            )
          ) : history.length ? history.map(b => (
            <BookingRow key={b.id} booking={b} to={`/learner/bookings/${b.id}`} person={{ name: b.instructorName }} actions={<RescheduleButton booking={b} />} />
          )) : (
            <Card><EmptyState icon={<History className="size-6" />} title="No past bookings yet" body="Completed and cancelled lessons will appear here." /></Card>
          )}
        </div>
      </section>
    </div>
  );
}

function NextLessonCard({ booking: b }: { booking: Booking }) {
  return (
    <Card className="relative overflow-hidden bg-ink-950 p-6 text-white dark:bg-ink-900">
      <div className="absolute -right-16 -top-16 size-56 rounded-full bg-brand-500/20 blur-2xl" />
      <div className="relative">
        <div className="flex items-center justify-between">
          <Badge tone="yellow">Next lesson · {timeUntil(b.startAt)}</Badge>
          <span className="font-mono text-xs text-ink-400">{displayRef(b)}</span>
        </div>
        <h2 className="mt-5 text-2xl font-extrabold">{formatDate(b.startAt, b.timezone)}</h2>
        <p className="mt-1 text-lg text-brand-400">{formatTimeRange(b.startAt, b.endAt, b.timezone)}</p>
        <div className="mt-4 space-y-1.5 text-sm text-ink-300">
          <p className="flex items-center gap-2"><CarFront className="size-4" />{LESSON_TYPES[b.lessonType!].label} with {b.instructorName}</p>
          {b.pickupLocation && <p className="flex items-center gap-2"><MapPin className="size-4" />{b.pickupLocation}</p>}
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          <ButtonLink to={`/learner/bookings/${b.id}`} size="sm">View details <ArrowRight className="size-4" /></ButtonLink>
          <div className="[&_button]:h-8 [&_button]:border-white/20 [&_button]:bg-white/10 [&_button]:px-3 [&_button]:text-xs [&_button]:text-white">
            <AddToCalendarButton booking={b} withName={b.instructorName} />
          </div>
        </div>
      </div>
    </Card>
  );
}

function NoLessonCard({ hasInstructor, instructorId }: { hasInstructor: boolean; instructorId?: string }) {
  return (
    <Card className="flex flex-col justify-center bg-brand-500 p-6 text-ink-950 dark:bg-brand-500">
      <h2 className="text-2xl font-extrabold">Ready for your next drive?</h2>
      <p className="mt-2 max-w-md text-ink-900/80">
        {hasInstructor ? 'See your instructor’s free times and book in seconds.' : 'Find a verified instructor who covers your suburb.'}
      </p>
      <div className="mt-6">
        {hasInstructor
          ? <ButtonLink to={`/learner/book/${instructorId}`} variant="dark">Book a lesson <ArrowRight className="size-4" /></ButtonLink>
          : <ButtonLink to="/learner/instructors" variant="dark"><Search className="size-4" />Find an instructor</ButtonLink>}
      </div>
    </Card>
  );
}

function MyInstructorCard({ instructor }: { instructor: ReturnType<typeof useUser>['data'] }) {
  const me = useProfile();
  if (!instructor) {
    return (
      <Card>
        <CardHeader title="My instructor" />
        <EmptyState title="No instructor yet" body="Your instructor appears here after your first booking." action={<ButtonLink to="/learner/instructors" size="sm" variant="secondary">Browse instructors</ButtonLink>} />
      </Card>
    );
  }
  const v = instructor.vehicle;
  const vehicleName = [v?.make, v?.model].filter(Boolean).join(' ');
  const vehicleDetails = [instructor.transmission, v?.ancap && v.ancap !== 'Other/Not Rated' ? `${v.ancap} ANCAP` : '', v?.dualControls ? 'Dual controls' : '', v?.plateNumber ? `Rego ${v.plateNumber}` : ''].filter(Boolean);
  return (
    <Card>
      <CardHeader title="My instructor" action={<Link to="/learner/instructors" className="text-xs font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white">Switch</Link>} />
      <div className="space-y-4 p-5">
        <Link to={`/learner/instructors/${instructor.id}`} className="flex items-center gap-3">
          <Avatar name={fullName(instructor)} src={instructor.photoUrl} size={48} />
          <div>
            <p className="font-bold">{fullName(instructor)}</p>
            <p className="text-sm text-ink-500">{formatMoney(pricingFor(instructor, me).lesson)}/hr{instructor.mobile ? ` · ${instructor.mobile}` : ''}</p>
          </div>
        </Link>
        <div className="flex items-center gap-3 rounded-xl bg-ink-50 p-3 dark:bg-ink-800/60">
          {v?.photoUrl ? <img src={v.photoUrl} alt="" className="size-12 rounded-lg object-cover" /> : <span className="flex size-12 items-center justify-center rounded-lg bg-white dark:bg-ink-900"><CarFront className="size-5 text-ink-400" /></span>}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{vehicleName || 'Vehicle details not added yet'}</p>
            {vehicleDetails.length > 0 && <p className="truncate text-xs text-ink-500">{vehicleDetails.join(' · ')}</p>}
          </div>
        </div>
        <ButtonLink to={`/learner/book/${instructor.id}`} variant="dark" className="w-full">Book with {instructor.firstName}</ButtonLink>
      </div>
    </Card>
  );
}

function TestPackageCard({ instructorId, name, price }: { instructorId: string; name: string; price: number }) {
  return (
    <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
      <span className="lplate size-12 shrink-0 text-xl">P</span>
      <div className="flex-1">
        <p className="font-bold">Driving test package</p>
        <p className="text-sm text-ink-500">2.5 hours · Instructor’s car for the test · Pick up & drop off · 45 minute warm-up lesson</p>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-2xl font-extrabold">{formatMoney(price)}</span>
        <ButtonLink to={`/learner/book/${instructorId}?type=test-package`} variant="secondary">Book with {name}</ButtonLink>
      </div>
    </Card>
  );
}

