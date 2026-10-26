import { AlertTriangle, ArrowLeft, CalendarCheck, Info, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  DRIVING_EXPERIENCE,
  LESSON_TYPES,
  calendarOf,
  displayRef,
  fullName,
  isPlausibleAddress,
  isPrivateLearner,
  lessonPrice,
  pricingFor,
  type DrivingExperience,
  type LessonType,
} from '@shared/domain';
import { formatDate, formatTimeRange } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { SlotPicker } from '@/components/booking';
import { Avatar, Button, Card, CardHeader, EmptyState, Input, PageHeader, PageLoader, Segmented, Select, Textarea, ButtonLink, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useBooking, useUser } from '@/lib/data';
import { attachAddressAutocomplete, onMapsUnavailable } from '@/lib/maps';

/** An address field: `valid` once picked from Google's suggestions (or, if Maps is unavailable, when it looks like a real address). */
interface AddressValue {
  text: string;
  valid: boolean;
}

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
  const [pickup, setPickup] = useState<AddressValue>({ text: '', valid: false });
  const [dropoff, setDropoff] = useState<AddressValue>({ text: '', valid: false });
  const [testLocation, setTestLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [experience, setExperience] = useState<DrivingExperience | ''>(me.drivingExperience ?? '');
  const [testBooked, setTestBooked] = useState<'' | 'yes' | 'no'>(me.testBooked === undefined ? '' : me.testBooked ? 'yes' : 'no');
  const [submitting, setSubmitting] = useState(false);

  // Only lesson lengths this instructor offers can be picked.
  useEffect(() => {
    if (!instructor) return;
    const offered = calendarOf(instructor).lessonTypes;
    if (!offered.includes(lessonType)) setLessonType(offered[0]);
  }, [instructor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rebooking: start from the original booking's details (its addresses were already accepted).
  useEffect(() => {
    if (!original) return;
    setPickup(p => p.text || !original.pickupLocation ? p : { text: original.pickupLocation, valid: true });
    setDropoff(d => d.text || !original.dropoffLocation || original.dropoffLocation === original.pickupLocation ? d : { text: original.dropoffLocation, valid: true });
    setTestLocation(t => t || original.testLocation || '');
    setNotes(n => n || original.notes || '');
    if (original.experience) setExperience(original.experience);
    if (original.testBooked !== undefined) setTestBooked(original.testBooked ? 'yes' : 'no');
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
  const dropoffOk = !dropoff.text.trim() || dropoff.valid;
  const missing = !slot ? 'Pick a time'
    : !pickup.valid ? 'Choose your pick up address from the suggestions'
      : !dropoffOk ? 'Choose your drop off address from the suggestions'
        : isTest && testLocation.trim().length <= 2 ? 'Choose your test centre'
          : !experience || !testBooked ? 'Answer the questions in step 4'
            : null;
  const ready = !missing;

  const submit = async () => {
    if (!slot || !experience || !testBooked) return;
    setSubmitting(true);
    try {
      const res = await api.createBooking({
        instructorId,
        lessonType,
        startAt: slot,
        pickupLocation: pickup.text.trim(),
        dropoffLocation: dropoff.text.trim() || undefined,
        testLocation: isTest ? testLocation.trim() : undefined,
        notes: notes.trim() || undefined,
        experience,
        testBooked: testBooked === 'yes',
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
              <AddressInput label="Pick up address" placeholder="Start typing, e.g. 12 Windsor Rd, Kellyville" value={pickup} onChange={setPickup} className="sm:col-span-2"
                hint={instructor.servicedSuburbs?.length ? `${instructor.firstName} covers ${instructor.servicedSuburbs.slice(0, 4).join(', ')}${instructor.servicedSuburbs.length > 4 ? '…' : ''}` : undefined} />
              <AddressInput label="Drop off address" placeholder="Same as pick up" value={dropoff} onChange={setDropoff} className="sm:col-span-2" />
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
            </div>
          </Card>

          <Card>
            <CardHeader title="4. A few quick questions" subtitle={`Helps ${instructor.firstName} plan your lesson.`} />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              <Select label="What driving experience do you have?" value={experience} onChange={e => setExperience(e.target.value as DrivingExperience | '')}>
                <option value="">Choose…</option>
                {Object.entries(DRIVING_EXPERIENCE).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
              <Select label="Have you booked your driving test?" value={testBooked} onChange={e => setTestBooked(e.target.value as '' | 'yes' | 'no')}>
                <option value="">Choose…</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </Select>
              <Textarea label="What would you like to work on? (optional)" hint="This will help us plan your lesson better." rows={3} value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="e.g. reverse parking, roundabouts, highway driving" wrapperClassName="sm:col-span-2" />
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
                <Row label="Pick up">{pickup.valid ? pickup.text : <span className="text-ink-400">—</span>}</Row>
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
              {missing && <p className="text-center text-xs font-semibold text-ink-600 dark:text-ink-300">{missing} to continue.</p>}
              <p className="text-center text-xs text-ink-500">Free cancellation up to 24 hours before.</p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

/** Address input with Google suggestions. Typing clears the picked address until a suggestion is chosen. */
function AddressInput({ label, placeholder, hint, value, onChange, className }: {
  label: string;
  placeholder: string;
  hint?: string;
  value: AddressValue;
  onChange: (value: AddressValue) => void;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [mapsDown, setMapsDown] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    let ac: google.maps.places.Autocomplete | undefined;
    let cancelled = false;
    attachAddressAutocomplete(input, address => onChangeRef.current({ text: address, valid: true }))
      .then(a => { if (cancelled) google.maps.event.clearInstanceListeners(a); else ac = a; })
      .catch(() => !cancelled && setMapsDown(true));
    const unsubscribe = onMapsUnavailable(() => setMapsDown(true));
    return () => {
      cancelled = true;
      unsubscribe();
      if (ac) google.maps.event.clearInstanceListeners(ac);
    };
  }, []);

  // Without Google, fall back to a basic check of what was typed.
  useEffect(() => {
    if (mapsDown && value.text && value.valid !== isPlausibleAddress(value.text)) onChangeRef.current({ text: value.text, valid: isPlausibleAddress(value.text) });
  }, [mapsDown, value]);

  const showError = value.text.trim().length > 0 && !value.valid;
  return (
    <Input
      ref={ref}
      label={label}
      placeholder={placeholder}
      autoComplete="off"
      value={value.text}
      onChange={e => onChange({ text: e.target.value, valid: mapsDown && isPlausibleAddress(e.target.value) })}
      wrapperClassName={className}
      hint={hint}
      error={showError ? (mapsDown ? 'Enter the full street address, e.g. 12 Windsor Rd, Kellyville NSW 2155.' : 'Choose your address from the suggestions list.') : undefined}
    />
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
