import { Ban, CircleDollarSign, Undo2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { serviceAreasOf, type Booking, type ServiceArea } from '@shared/domain';
import { DEFAULT_TIMEZONE, addDaysToKey, atLocalTime, dayKey, formatDate, formatTime, startOfDayKey } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { AreaPicker } from '@/components/AreaPicker';
import { Button, Input, Modal, Segmented, Select, Textarea, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export function LateCancelActions({ booking, size = 'sm' }: { booking: Booking; size?: 'sm' | 'md' }) {
  const { readOnly } = useAuth();
  const [busy, setBusy] = useState<'refund' | 'charge' | null>(null);
  if (booking.status !== 'late_cancel_requested') return null;
  const decide = async (decision: 'refund' | 'charge') => {
    setBusy(decision);
    try {
      await api.resolveLateCancel({ bookingId: booking.id, decision });
      toast.success(decision === 'refund' ? 'Cancelled and refunded.' : 'Cancelled with a late fee.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button size={size} variant="secondary" icon={<Undo2 className="size-4" />} loading={busy === 'refund'} disabled={!!busy || readOnly} onClick={() => decide('refund')}>Refund learner</Button>
      <Button size={size} variant="dark" icon={<CircleDollarSign className="size-4" />} loading={busy === 'charge'} disabled={!!busy || readOnly} onClick={() => decide('charge')}>
        Charge fee{booking.price ? ` (${formatMoney(booking.price)})` : ''}
      </Button>
    </>
  );
}

export function WithdrawButton({ booking, size = 'sm' }: { booking: Booking; size?: 'sm' | 'md' }) {
  const { readOnly } = useAuth();
  const [busy, setBusy] = useState(false);
  if (booking.status !== 'proposed') return null;
  return (
    <Button size={size} variant="ghost" loading={busy} disabled={readOnly} onClick={async () => {
      if (!confirm('Withdraw this proposal? The learner will no longer be able to accept it.')) return;
      setBusy(true);
      try {
        await api.withdrawProposal({ bookingId: booking.id });
        toast.success('Proposal withdrawn.');
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setBusy(false);
      }
    }}>Withdraw</Button>
  );
}

export function InstructorCancelButton({ booking, size = 'md', onDone }: { booking: Booking; size?: 'sm' | 'md'; onDone?: () => void }) {
  const { readOnly } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!(booking.status === 'confirmed' || (booking.kind === 'event' && booking.status !== 'cancelled')) || readOnly) return null;
  const isEvent = booking.kind === 'event';
  return (
    <>
      <Button size={size} variant="ghost" icon={<Ban className="size-4" />} className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10" onClick={() => setOpen(true)}>
        {isEvent ? 'Remove' : 'Cancel booking'}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={isEvent ? 'Remove this blocked time?' : 'Cancel without a new time?'}
        footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Keep it</Button>
          <Button variant="danger" loading={busy} onClick={async () => {
            setBusy(true);
            try {
              await api.cancelBooking({ bookingId: booking.id, reason: reason.trim() || undefined });
              toast.success(isEvent ? 'Time unblocked.' : 'Booking cancelled — the learner has been notified.');
              setOpen(false);
              onDone?.();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}>{isEvent ? 'Remove' : 'Cancel booking'}</Button>
        </>}
      >
        {isEvent ? (
          <p className="text-sm text-ink-600 dark:text-ink-300">Learners will be able to book this time again.</p>
        ) : (
          <>
            <p className="text-sm text-ink-600 dark:text-ink-300">
              {booking.learnerName}’s lesson on {formatDate(booking.startAt, booking.timezone)} at {formatTime(booking.startAt, booking.timezone)} will be cancelled
              {booking.paymentStatus === 'paid' ? ` and ${formatMoney(booking.price)} refunded to their wallet` : ''}. Want to move it instead? Use Reschedule.
            </p>
            <Textarea wrapperClassName="mt-4" label="Message to the learner (optional)" rows={3} value={reason} onChange={e => setReason(e.target.value)} />
          </>
        )}
      </Modal>
    </>
  );
}

export function InviteLearnerModal({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited?: (learnerId: string) => void }) {
  const [form, setForm] = useState({ firstName: '', surname: '', email: '', mobile: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<span className="flex items-center gap-2"><UserPlus className="size-5" />Invite a learner</span>}
      footer={<Button loading={busy} disabled={!form.firstName.trim() || !form.email.trim()} onClick={async () => {
        setBusy(true);
        try {
          const res = await api.inviteLearner({ ...form, surname: form.surname || undefined, mobile: form.mobile || undefined });
          toast.success(res.existing
            ? `${form.firstName} already has an account and was added to your learners.`
            : res.emailed ? `Invitation emailed to ${form.email}.` : `${form.firstName} was added. Email delivery isn’t set up yet, so share the sign-up link with them.`);
          setForm({ firstName: '', surname: '', email: '', mobile: '' });
          onInvited?.(res.learnerId);
          onClose();
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}>Send invitation</Button>}
    >
      <p className="mb-4 text-sm text-ink-500">They’ll get an email to create their account. You can propose lessons straight away — they’ll see them once they sign up.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="First name" value={form.firstName} onChange={set('firstName')} />
        <Input label="Surname" value={form.surname} onChange={set('surname')} />
        <Input label="Email" type="email" value={form.email} onChange={set('email')} wrapperClassName="sm:col-span-2" />
        <Input label="Mobile (optional)" type="tel" value={form.mobile} onChange={set('mobile')} wrapperClassName="sm:col-span-2" />
      </div>
    </Modal>
  );
}

export type EventMode = 'event' | 'timeoff' | 'open';

const EVENT_COPY: Record<EventMode, { title: string; button: string; done: string; blurb: string }> = {
  event: { title: 'Personal event', button: 'Block time', done: 'Time blocked — learners can’t book it.', blurb: 'Block part of a day, e.g. lunch or an appointment.' },
  timeoff: { title: 'Time off', button: 'Add time off', done: 'Time off added — that time is closed to bookings.', blurb: 'Close whole days (holidays, sick days) or a set time, e.g. 3:45–4:45 pm.' },
  open: { title: 'Extra open hours', button: 'Open these hours', done: 'Extra hours added — learners can book them now.', blurb: 'Take bookings outside your usual weekly hours on one day — in all your suburbs, or just one (e.g. near home after work).' },
};

export function EventModal({ open, onClose, mode: initialMode = 'event', initialStart, timeZone = DEFAULT_TIMEZONE }: {
  open: boolean;
  onClose: () => void;
  mode?: EventMode;
  initialStart?: Date;
  timeZone?: string;
}) {
  const me = useProfile();
  const start = initialStart ?? new Date();
  const [mode, setMode] = useState<EventMode>(initialMode);
  const [area, setArea] = useState<ServiceArea | undefined>();
  const [day, setDay] = useState(dayKey(start, timeZone));
  const [toDay, setToDay] = useState(dayKey(start, timeZone));
  const [from, setFrom] = useState(initialStart ? formatHHmm(start, timeZone) : '09:00');
  const [to, setTo] = useState(initialStart ? formatHHmm(new Date(start.getTime() + 3_600_000), timeZone) : '10:00');
  const [allDay, setAllDay] = useState(true);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [applyBuffer, setApplyBuffer] = useState(true);
  const [repeat, setRepeat] = useState<'' | 'daily' | 'weekly' | 'fortnightly'>('');
  const [occurrences, setOccurrences] = useState(4);
  const [busy, setBusy] = useState(false);
  const copy = EVENT_COPY[mode];
  const validDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const timedOff = mode === 'timeoff' && !allDay;

  const range = (): { startAt: Date; endAt: Date } => {
    if (mode === 'timeoff' && allDay) return { startAt: startOfDayKey(day, timeZone), endAt: startOfDayKey(addDaysToKey(toDay, 1), timeZone) };
    if (timedOff) return { startAt: atLocalTime(day, from, timeZone), endAt: atLocalTime(toDay, to, timeZone) };
    return { startAt: atLocalTime(day, from, timeZone), endAt: atLocalTime(day, to, timeZone) };
  };
  const valid = validDay(day) && (mode !== 'timeoff' || (validDay(toDay) && toDay >= day)) && (mode === 'timeoff' && allDay ? true : !!from && !!to);

  const submit = async () => {
    const { startAt, endAt } = range();
    if (endAt <= startAt) return toast.error('The end must be after the start.');
    setBusy(true);
    try {
      const res = await api.createEvent({
        kind: mode === 'open' ? 'open' : 'event',
        title: title.trim() || (mode === 'timeoff' ? 'Time off' : undefined),
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        ...(mode === 'open' && area ? { area } : {}),
        ...(mode === 'event' ? {
          location: location.trim() || undefined,
          notes: notes.trim() || undefined,
          applyBuffer,
          ...(repeat ? { repeat, occurrences } : {}),
        } : {}),
      });
      toast.success(res.count > 1 ? `${copy.done} (${res.count} times)` : copy.done);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={copy.title} footer={<Button loading={busy} disabled={!valid} onClick={submit}>{copy.button}</Button>}>
      <Segmented value={mode} onChange={setMode} className="mb-4 [&_button]:text-center [&_button]:text-xs"
        options={[{ value: 'event', label: 'Personal event' }, { value: 'timeoff', label: 'Time off' }, { value: 'open', label: 'Extra hours' }]} />
      <p className="mb-4 text-sm text-ink-500">{copy.blurb}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        {mode !== 'open' && <Input label="Title (optional)" placeholder={mode === 'timeoff' ? 'e.g. Holiday' : 'e.g. Lunch, car service'} value={title} onChange={e => setTitle(e.target.value)} wrapperClassName="sm:col-span-3" />}
        {mode === 'timeoff' ? (
          <>
            <label className="flex items-center gap-2 text-sm font-semibold sm:col-span-3">
              <input type="checkbox" className="size-4 accent-brand-500" checked={allDay} onChange={e => setAllDay(e.target.checked)} />
              Whole days
            </label>
            <Input label="From" type="date" value={day} onChange={e => { setDay(e.target.value); if (toDay < e.target.value) setToDay(e.target.value); }} />
            {!allDay && <Input label="Start time" type="time" step={900} value={from} onChange={e => setFrom(e.target.value)} wrapperClassName="sm:col-span-2" />}
            <Input label={allDay ? 'To (inclusive)' : 'Until'} type="date" value={toDay} min={day} onChange={e => setToDay(e.target.value)} wrapperClassName={allDay ? 'sm:col-span-2' : ''} />
            {!allDay && <Input label="End time" type="time" step={900} value={to} onChange={e => setTo(e.target.value)} wrapperClassName="sm:col-span-2" />}
          </>
        ) : (
          <>
            <Input label="Date" type="date" value={day} onChange={e => setDay(e.target.value)} />
            <Input label="From" type="time" step={900} value={from} onChange={e => setFrom(e.target.value)} />
            <Input label="To" type="time" step={900} value={to} onChange={e => setTo(e.target.value)} />
          </>
        )}
        {mode === 'open' && <div className="sm:col-span-3"><AreaPicker areas={serviceAreasOf(me)} value={area} onChange={setArea} /></div>}
        {mode === 'event' && (
          <>
            <Select label="Repeat" value={repeat} onChange={e => setRepeat(e.target.value as typeof repeat)} wrapperClassName="sm:col-span-2">
              <option value="">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="fortnightly">Every 2 weeks</option>
            </Select>
            {repeat ? <Input label="Times" type="number" min={2} max={26} value={occurrences} onChange={e => setOccurrences(Number(e.target.value))} /> : <div />}
            <Input label="Address (optional)" placeholder="e.g. 12 Windsor Rd, Kellyville" value={location} onChange={e => setLocation(e.target.value)} wrapperClassName="sm:col-span-3" />
            <Textarea label="Notes (optional)" rows={2} value={notes} onChange={e => setNotes(e.target.value)} wrapperClassName="sm:col-span-3" />
            <label className="flex items-start gap-2 text-sm sm:col-span-3">
              <input type="checkbox" className="mt-0.5 size-4 accent-brand-500" checked={applyBuffer} onChange={e => setApplyBuffer(e.target.checked)} />
              <span><strong>Keep travel buffer around this event</strong><br /><span className="text-ink-500">Turn off for things at home, so lessons can be booked right up to it.</span></span>
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}

/** Kept for existing callers: opens the event dialog on "Personal event". */
export function BlockTimeModal(props: { open: boolean; onClose: () => void; initialStart?: Date; timeZone?: string }) {
  return <EventModal {...props} mode="event" />;
}

export function formatHHmm(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}
