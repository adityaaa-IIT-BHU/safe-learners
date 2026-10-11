import { AlertTriangle, ArrowLeft, CalendarCheck, Info, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { LESSON_TYPES, calendarOf, displayRef, fullName, isPrivateLearner, lessonPrice, pricingFor, type LessonType } from '@shared/domain';
import { formatDate, formatTimeRange } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { SlotPicker } from '@/components/booking';
import { Avatar, Button, Card, CardHeader, EmptyState, Input, PageHeader, PageLoader, Segmented, Select, Textarea, ButtonLink, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useBooking, useUser } from '@/lib/data';

export function BookLesson() {
  const { instructorId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const me = useProfile();
  const { readOnly } = useAuth();
  const rescheduleId = params.get('reschedule') ?? undefined;
  const initialType = params.get('type');

  const { data: instructor, loading } = useUser(instructorId);
  const { data: original } = useBooking(rescheduleId);

  const [lessonType, setLessonType] = useState<LessonType>(initialType && initialType in LESSON_TYPES ? initialType as LessonType : 'lesson-1h');
  const [slot, setSlot] = useState<string | null>(null);
  const [pickup, setPickup] = useState(rescheduleId ? '' : me.homeSuburb ?? '');
  const [dropoff, setDropoff] = useState('');
  const [testLocation, setTestLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Only lesson lengths this instructor offers can be picked.
  useEffect(() => {
    if (!instructor) return;
    const offered = calendarOf(instructor).lessonTypes;
    if (!offered.includes(lessonType)) setLessonType(offered[0]);
  }, [instructor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rebooking: start from the original booking's details.
  useEffect(() => {
    if (!original) return;
    setPickup(p => p || original.pickupLocation || '');
    setDropoff(d => d || (original.dropoffLocation && original.dropoffLocation !== original.pickupLocation ? original.dropoffLocation : ''));
    setTestLocation(t => t || original.testLocation || '');
  }, [original]);

  if (loading) return <PageLoader />;
  if (!instructor || instructor.role !== 'instructor') {
    return <Card><EmptyState title="Instructor not found" action={<ButtonLink to="/learner/instructors">Find an instructor</ButtonLink>} /></Card>;
  }
  if (instructor.verificationStatus !== 'verified') {
    return <Card><EmptyState title={`${instructor.firstName} isn’t taking bookings yet`} body="They need to finish verification first. Try another instructor in your area." action={<ButtonLink to="/learner/instructors">Find an instructor</ButtonLink>} /></Card>;
  }

  // Learners an instructor invited pay that instructor's private rates.
  const pricing = pricingFor(instructor, me);
  const price = lessonPrice(lessonType, pricing);
  const offered = calendarOf(instructor).lessonTypes;
  const balance = me.walletBalance ?? 0;
  const coveredByWallet = balance >= price;
  const isTest = lessonType === 'test-package';
  const privateRate = isPrivateLearner(me, instructor.id);
  const start = slot ? new Date(slot) : null;
  const end = start ? new Date(start.getTime() + LESSON_TYPES[lessonType].minutes * 60_000) : null;
  const tz = instructor.timezone ?? 'Australia/Sydney';
  const ready = !!slot && pickup.trim().length > 2 && (!isTest || testLocation.trim().length > 2);

  const submit = async () => {
    if (!slot) return;
    setSubmitting(true);
    try {
      const res = await api.createBooking({
        instructorId,
        lessonType,
        startAt: slot,
        pickupLocation: pickup.trim(),
        dropoffLocation: dropoff.trim() || undefined,
        testLocation: isTest ? testLocation.trim() : undefined,
        notes: notes.trim() || undefined,
        rescheduleOf: rescheduleId,
      });
      toast.success(rescheduleId ? `Rescheduled! New booking #${res.ref}` : `Booked! Your reference is #${res.ref}`);
      navigate(`/learner/bookings/${res.bookingId}`, { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
      // The slot may have just been taken: let the picker refresh.
      setSlot(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader
        back={<Link to={rescheduleId ? `/learner/bookings/${rescheduleId}` : '/learner'} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white"><ArrowLeft className="size-4" />Back</Link>}
        title={rescheduleId ? 'Reschedule lesson' : `Book with ${instructor.firstName}`}
        subtitle={rescheduleId && original
          ? <>Moving {displayRef(original)} from {formatDate(original.startAt, original.timezone)} {formatTimeRange(original.startAt, original.endAt, original.timezone)}</>
          : 'Choose a lesson, pick a time, and you’re booked.'}
      />

      {rescheduleId && original?.status === 'confirmed' && (
        <div className="mb-6 flex gap-3 rounded-2xl bg-sky-50 p-4 text-sm text-sky-900 dark:bg-sky-500/10 dark:text-sky-200">
          <RefreshCw className="mt-0.5 size-4 shrink-0" />
          Your current booking stays in place until you confirm the new time. Then it’s cancelled{original.paymentStatus === 'paid' ? ' and refunded to your wallet' : ''} automatically.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="1. Lesson type" />
            <div className="p-5">
              <Segmented
                value={lessonType}
                onChange={t => { setLessonType(t); setSlot(null); }}
                options={offered.map(t => ({ value: t, label: LESSON_TYPES[t].short, sub: formatMoney(lessonPrice(t, pricing)) }))}
                className="max-sm:!grid-cols-2"
              />
              {isTest && (
                <p className="mt-4 flex gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  Book your driving test with your state’s licensing authority first. This package books {instructor.firstName} and their car, plus a 45 minute warm-up. Choose a start time 1 hour before your test.
                </p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="2. Pick a time" subtitle="Live availability — booked times are hidden." />
            <div className="p-5">
              <SlotPicker instructorId={instructorId} lessonType={lessonType} value={slot} onChange={setSlot} excludeBookingId={original?.status === 'confirmed' ? original.id : undefined} />
            </div>
          </Card>

          <Card>
            <CardHeader title="3. Where should we meet?" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Input label="Pick up address" placeholder="e.g. 12 Windsor Rd, Kellyville NSW 2155" value={pickup} onChange={e => setPickup(e.target.value)} wrapperClassName="sm:col-span-2" hint={instructor.servicedSuburbs?.length ? `${instructor.firstName} covers ${instructor.servicedSuburbs.slice(0, 4).join(', ')}${instructor.servicedSuburbs.length > 4 ? '…' : ''}` : undefined} />
              <Input label="Drop off address" placeholder="Same as pick up" value={dropoff} onChange={e => setDropoff(e.target.value)} wrapperClassName="sm:col-span-2" />
              {isTest && (instructor.testLocations?.length ? (
                <Select label="Test centre" value={instructor.testLocations.some(l => l.name === testLocation) || !testLocation ? testLocation : '__other'}
                  onChange={e => setTestLocation(e.target.value === '__other' ? ' ' : e.target.value)} wrapperClassName="sm:col-span-2">
                  <option value="">Choose your test centre…</option>
                  {instructor.testLocations.map(l => <option key={l.name} value={l.name}>{l.name}{l.address ? ` — ${l.address}` : ''}</option>)}
                  <option value="__other">Another centre…</option>
                </Select>
              ) : null)}
              {isTest && (!instructor.testLocations?.length || (testLocation && !instructor.testLocations.some(l => l.name === testLocation))) && (
                <Input label={instructor.testLocations?.length ? 'Other test centre' : 'Test centre'} placeholder="e.g. Service NSW Castle Hill" value={testLocation.trim() ? testLocation : ''} onChange={e => setTestLocation(e.target.value)} wrapperClassName="sm:col-span-2" />
              )}
              <Textarea label="Notes for your instructor (optional)" rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything they should know — e.g. practise reverse parking" wrapperClassName="sm:col-span-2" />
            </div>
          </Card>
        </div>

        <div>
          <Card className="sticky top-24">
            <CardHeader title="Summary" />
            <div className="space-y-4 p-5">
              <div className="flex items-center gap-3">
                <Avatar name={fullName(instructor)} src={instructor.photoUrl} size={44} />
                <div>
                  <p className="font-bold">{fullName(instructor)}</p>
                  <p className="text-xs text-ink-500">{instructor.transmission ?? 'Auto'} · {[instructor.vehicle?.make, instructor.vehicle?.model].filter(Boolean).join(' ') || 'Instructor vehicle'}</p>
                </div>
              </div>
              <dl className="space-y-2 text-sm">
                <Row label="Lesson">{LESSON_TYPES[lessonType].label}</Row>
                <Row label="When">{start && end ? <>{formatDate(start, tz)}<br />{formatTimeRange(start, end, tz)}</> : <span className="text-ink-400">Pick a time</span>}</Row>
                <Row label="Pick up">{pickup || <span className="text-ink-400">—</span>}</Row>
              </dl>
              <div className="border-t border-ink-100 pt-4 dark:border-ink-800">
                <div className="flex items-baseline justify-between">
                  <span className="font-semibold">Total</span>
                  <span className="text-2xl font-extrabold">{formatMoney(price)}</span>
                </div>
                {privateRate && <p className="mt-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">Your instructor’s private rate applies.</p>}
                <p className={`mt-2 flex gap-2 rounded-xl p-3 text-xs ${coveredByWallet ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300'}`}>
                  <Info className="mt-px size-3.5 shrink-0" />
                  {coveredByWallet
                    ? `Paid from your wallet (balance ${formatMoney(balance)} → ${formatMoney(balance - price)}).`
                    : `Your wallet has ${formatMoney(balance)}. The lesson is booked now and payment is due before the lesson.`}
                </p>
              </div>
              <Button size="lg" className="w-full" icon={<CalendarCheck className="size-5" />} disabled={!ready || readOnly} loading={submitting} onClick={submit}>
                {rescheduleId ? 'Confirm new time' : 'Confirm booking'}
              </Button>
              <p className="text-center text-xs text-ink-500">Free cancellation up to 24 hours before.</p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}
