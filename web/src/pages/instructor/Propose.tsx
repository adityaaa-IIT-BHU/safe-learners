import { ArrowLeft, RefreshCw, Send, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { LESSON_TYPES, LESSON_TYPE_ORDER, PROPOSAL_EXPIRY_HOURS, displayRef, fullName, isPrivateLearner, lessonPrice, pricingFor, type LessonType } from '@shared/domain';
import { DEFAULT_TIMEZONE, atLocalTime, dayKey, formatDate, formatTimeRange } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { AddressInput, EMPTY_ADDRESS, areaProblem, placeOf, type AddressValue } from '@/components/AddressInput';
import { SlotPicker, type Availability } from '@/components/booking';
import { Button, Card, CardHeader, Input, PageHeader, Segmented, Select, Textarea, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useBooking, useBookings } from '@/lib/data';
import { InviteLearnerModal, formatHHmm } from './actions';
import { useMyLearners } from './useLearners';

export function Propose() {
  const me = useProfile();
  const { uid, readOnly } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const tz = me.timezone ?? DEFAULT_TIMEZONE;
  const rescheduleId = params.get('reschedule') ?? undefined;
  const presetStart = params.get('start');

  const { data: original } = useBooking(rescheduleId);
  const { data: bookings } = useBookings('instructorId', uid);
  const { learners } = useMyLearners(uid, bookings);

  const [learnerId, setLearnerId] = useState(params.get('learner') ?? '');
  const [lessonType, setLessonType] = useState<LessonType>('lesson-1h');
  const [mode, setMode] = useState<'availability' | 'custom'>(presetStart ? 'custom' : 'availability');
  const [slot, setSlot] = useState<string | null>(null);
  const [customDay, setCustomDay] = useState(presetStart ? dayKey(new Date(presetStart), tz) : dayKey(new Date(Date.now() + 86_400_000), tz));
  const [customTime, setCustomTime] = useState(presetStart ? formatHHmm(new Date(presetStart), tz) : '09:00');
  const [pickup, setPickup] = useState<AddressValue>(EMPTY_ADDRESS);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [notes, setNotes] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!original) return;
    setLearnerId(original.learnerId ?? '');
    if (original.lessonType) setLessonType(original.lessonType);
    setPickup(p => p.text || !original.pickupLocation ? p : { text: original.pickupLocation, valid: true });
  }, [original]);

  // Default the pick up address to the learner's usual address.
  const learner = learners.find(l => l.id === learnerId);
  useEffect(() => {
    if (learner?.homeSuburb && !rescheduleId) setPickup(p => p.text ? p : { text: learner.homeSuburb!, valid: true });
  }, [learner?.homeSuburb, rescheduleId]);

  const startIso = mode === 'availability' ? slot : customStartIso(customDay, customTime, tz);
  const start = startIso ? new Date(startIso) : null;
  const end = start ? new Date(start.getTime() + LESSON_TYPES[lessonType].minutes * 60_000) : null;
  const pickupProblem = areaProblem(me, pickup, (availability?.areaHours ?? []).map(h => h.area), 'pick up');
  const ready = !!learnerId && !!start && start.getTime() > Date.now() && pickup.valid && !pickupProblem;

  const submit = async () => {
    if (!startIso) return;
    setBusy(true);
    try {
      const res = await api.proposeBooking({
        learnerId,
        lessonType,
        startAt: startIso,
        pickupLocation: pickup.text.trim(),
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        notes: notes.trim() || undefined,
        rescheduleOf: rescheduleId,
        allowOutsideHours: mode === 'custom',
      });
      toast.success(`Proposal #${res.ref} sent${learner ? ` to ${learner.firstName}` : ''}.`);
      navigate(`/instructor/bookings/${res.bookingId}`, { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
      setSlot(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        back={<Link to={rescheduleId ? `/instructor/bookings/${rescheduleId}` : '/instructor'} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white"><ArrowLeft className="size-4" />Back</Link>}
        title={rescheduleId ? 'Reschedule booking' : 'Propose a lesson'}
        subtitle={rescheduleId ? 'The current booking is cancelled and the learner gets the new time to accept or decline.' : `The learner is notified and can accept or decline. The time is held for ${PROPOSAL_EXPIRY_HOURS} hours (or until the lesson starts); if they don’t answer, it expires and the time is free again.`}
      />

      {rescheduleId && original && (
        <div className="mb-6 flex gap-3 rounded-2xl bg-red-50 p-4 text-sm text-red-900 dark:bg-red-500/10 dark:text-red-200">
          <RefreshCw className="mt-0.5 size-4 shrink-0" />
          <span>Proposing will <strong>cancel {displayRef(original)}</strong> ({formatDate(original.startAt, original.timezone)}, {formatTimeRange(original.startAt, original.endAt, original.timezone)}){original.paymentStatus === 'paid' ? ' and refund it to the learner’s wallet' : ''}.</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Learner" />
            <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-end">
              <Select label="Choose a learner" value={learnerId} onChange={e => setLearnerId(e.target.value)} disabled={!!rescheduleId} wrapperClassName="flex-1">
                <option value="">{learners.length ? 'Select a learner…' : 'No learners yet — invite one'}</option>
                {learners.map(l => (
                  <option key={l.id} value={l.id}>{fullName(l)}{l.mobile ? ` · ${l.mobile}` : ''}{l.status === 'invited' ? ' (invited)' : ''}</option>
                ))}
              </Select>
              {!rescheduleId && <Button variant="secondary" icon={<UserPlus className="size-4" />} onClick={() => setInviteOpen(true)} disabled={readOnly}>Invite new</Button>}
            </div>
          </Card>

          <Card>
            <CardHeader title="Lesson" />
            <div className="p-5">
              <Segmented value={lessonType} onChange={t => { setLessonType(t); setSlot(null); }} className="max-sm:!grid-cols-2"
                options={LESSON_TYPE_ORDER.map(t => ({ value: t, label: LESSON_TYPES[t].short, sub: formatMoney(lessonPrice(t, pricingFor(me, learner))) }))} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Time" action={
              <Segmented value={mode} onChange={setMode} className="w-56 [&_button]:py-1.5 [&_button]:text-center [&_button]:text-xs"
                options={[{ value: 'availability', label: 'My free slots' }, { value: 'custom', label: 'Custom time' }]} />
            } />
            <div className="p-5">
              {mode === 'availability' ? (
                <SlotPicker instructorId={me.id} lessonType={lessonType} value={slot} onChange={setSlot} excludeBookingId={rescheduleId}
                  pickup={pickup.valid && !pickupProblem ? placeOf(pickup) : null} onLoaded={setAvailability} />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label="Date" type="date" value={customDay} min={dayKey(new Date(), tz)} onChange={e => setCustomDay(e.target.value)} />
                  <Input label="Start time" type="time" step={900} value={customTime} onChange={e => setCustomTime(e.target.value)} />
                  <p className="text-xs text-ink-500 sm:col-span-2">Custom times can be outside your usual hours, but can’t overlap another booking.</p>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Pick up" />
            <div className="space-y-4 p-5">
              <AddressInput label="Pick up address" placeholder="e.g. 12 Windsor Rd, Kellyville NSW 2155" value={pickup} onChange={setPickup}
                requireSuggestion={false} areaError={pickupProblem} hint="Must be in one of your suburbs (or a suburb you’ve opened extra hours in)." />
              {!!me.servicedSuburbs?.length && (
                <div className="flex flex-wrap gap-1.5">
                  {me.servicedSuburbs.slice(0, 8).map(s => (
                    <button key={s} type="button" onClick={() => setPickup({ text: s, valid: true })} className="rounded-full border border-ink-200 px-2.5 py-1 text-xs font-semibold hover:border-ink-400 dark:border-ink-700">{s}</button>
                  ))}
                </div>
              )}
              <Textarea label="Note for the learner (optional)" rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. We’ll practise highway merging" />
            </div>
          </Card>
        </div>

        <Card className="sticky top-24 h-fit">
          <CardHeader title="Proposal" />
          <div className="space-y-3 p-5 text-sm">
            <Row label="Learner">{learner ? fullName(learner) : '—'}</Row>
            <Row label="Lesson">{LESSON_TYPES[lessonType].label}</Row>
            <Row label="When">{start && end ? <>{formatDate(start, tz)}<br />{formatTimeRange(start, end, tz)}</> : '—'}</Row>
            <Row label="Price">{formatMoney(lessonPrice(lessonType, pricingFor(me, learner)))}{learner && isPrivateLearner(learner, me.id) ? ' (private rate)' : ''}</Row>
            <Button size="lg" className="mt-2 w-full" icon={<Send className="size-4" />} disabled={!ready || readOnly} loading={busy} onClick={submit}>
              {rescheduleId ? 'Cancel & propose new time' : 'Send proposal'}
            </Button>
            {learner?.status === 'invited' && <p className="text-xs text-ink-500">{learner.firstName} hasn’t signed up yet — they’ll see this when they do.</p>}
          </div>
        </Card>
      </div>

      <InviteLearnerModal open={inviteOpen} onClose={() => setInviteOpen(false)} onInvited={id => setLearnerId(id)} />
    </>
  );
}

/** ISO start for the custom date/time inputs, or null while they're incomplete. */
function customStartIso(day: string, time: string, tz: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = atLocalTime(day, time, tz);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex justify-between gap-4"><span className="text-ink-500">{label}</span><span className="text-right font-medium">{children}</span></div>;
}
