import { ArrowLeft, CalendarPlus, CalendarX2, Lock, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { serviceAreasOf, type Booking, type ServiceArea } from '@shared/domain';
import { addDaysToKey, atLocalTime, dayKey, formatDate, formatTimeRange, startOfDayKey } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { AreaPicker } from '@/components/AreaPicker';
import { Badge, Button, Card, CardHeader, Input, Modal, PageHeader, Textarea } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatHHmm } from './actions';

/** Personal events, time off and extra open hours: view, edit and delete. */
export function EventDetail({ booking: b }: { booking: Booking }) {
  const { readOnly } = useAuth();
  const me = useProfile();
  const navigate = useNavigate();
  const [area, setArea] = useState<ServiceArea | undefined>(b.area);
  const tz = b.timezone;
  const allDay = formatHHmm(b.startAt, tz) === '00:00' && formatHHmm(b.endAt, tz) === '00:00';
  const isOpen = b.kind === 'open';
  const [title, setTitle] = useState(b.title ?? '');
  const [day, setDay] = useState(dayKey(b.startAt, tz));
  const [toDay, setToDay] = useState(dayKey(new Date(b.endAt.getTime() - (allDay ? 1 : 0)), tz));
  const [from, setFrom] = useState(formatHHmm(b.startAt, tz));
  const [to, setTo] = useState(formatHHmm(b.endAt, tz));
  const [location, setLocation] = useState(b.pickupLocation ?? '');
  const [notes, setNotes] = useState(b.notes ?? '');
  const [applyBuffer, setApplyBuffer] = useState(b.applyBuffer !== false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState<'one' | 'series' | null>(null);

  const kindLabel = isOpen ? 'Extra open hours' : allDay ? 'Time off' : 'Personal event';
  const icon = isOpen ? <CalendarPlus className="size-4" /> : allDay ? <CalendarX2 className="size-4" /> : <Lock className="size-4" />;

  const save = async () => {
    const startAt = allDay ? startOfDayKey(day, tz) : atLocalTime(day, from, tz);
    const endAt = allDay ? startOfDayKey(addDaysToKey(toDay, 1), tz) : atLocalTime(allDay ? toDay : day, to, tz);
    if (endAt <= startAt) return toast.error('The end must be after the start.');
    setSaving(true);
    try {
      await api.updateEvent({ bookingId: b.id, title: title.trim() || undefined, startAt: startAt.toISOString(), endAt: endAt.toISOString(), location: location.trim() || undefined, notes: notes.trim() || undefined, applyBuffer, ...(isOpen && area ? { area } : {}) });
      toast.success('Saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (series: boolean) => {
    setDeleting(series ? 'series' : 'one');
    try {
      const res = await api.deleteEvent({ bookingId: b.id, series });
      toast.success(res.deleted > 1 ? `Deleted ${res.deleted} events` : `${kindLabel} deleted`);
      navigate('/instructor/calendar', { replace: true });
    } catch (err) {
      toast.error(errorMessage(err));
      setDeleting(null);
    }
  };

  return (
    <>
      <PageHeader
        back={<Link to="/instructor/calendar" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white"><ArrowLeft className="size-4" />Calendar</Link>}
        title={<span className="flex flex-wrap items-center gap-3">{b.title || kindLabel} <Badge tone={isOpen ? 'green' : 'slate'}>{icon}{kindLabel}</Badge></span>}
        subtitle={`${formatDate(b.startAt, tz)}${allDay ? '' : ` · ${formatTimeRange(b.startAt, b.endAt, tz)}`}${b.repeatGroupId ? ' · repeating' : ''}`}
        actions={!readOnly && <Button variant="ghost" icon={<Trash2 className="size-4" />} className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10" onClick={() => setConfirmDelete(true)}>Delete</Button>}
      />
      <Card className="max-w-2xl">
        <CardHeader title="Details" subtitle={isOpen ? (b.area ? `Learners with a pick up in ${b.area.name} can book lessons inside these hours.` : 'Learners can book lessons inside these hours.') : 'Learners can’t book over this time.'} />
        <div className="grid gap-4 p-5 sm:grid-cols-3">
          {!isOpen && <Input label="Title" value={title} onChange={e => setTitle(e.target.value)} wrapperClassName="sm:col-span-3" disabled={readOnly} />}
          {allDay ? (
            <>
              <Input label="From" type="date" value={day} onChange={e => setDay(e.target.value)} disabled={readOnly} />
              <Input label="To (inclusive)" type="date" value={toDay} min={day} onChange={e => setToDay(e.target.value)} wrapperClassName="sm:col-span-2" disabled={readOnly} />
            </>
          ) : (
            <>
              <Input label="Date" type="date" value={day} onChange={e => setDay(e.target.value)} disabled={readOnly} />
              <Input label="From" type="time" step={900} value={from} onChange={e => setFrom(e.target.value)} disabled={readOnly} />
              <Input label="To" type="time" step={900} value={to} onChange={e => setTo(e.target.value)} disabled={readOnly} />
            </>
          )}
          {isOpen && <div className="sm:col-span-3"><AreaPicker areas={serviceAreasOf(me)} value={area} onChange={setArea} disabled={readOnly} /></div>}
          {b.kind === 'event' && !allDay && (
            <>
              <Input label="Address (optional)" value={location} onChange={e => setLocation(e.target.value)} wrapperClassName="sm:col-span-3" disabled={readOnly} />
              <Textarea label="Notes (optional)" rows={3} value={notes} onChange={e => setNotes(e.target.value)} wrapperClassName="sm:col-span-3" disabled={readOnly} />
              <label className="flex items-center gap-2 text-sm sm:col-span-3">
                <input type="checkbox" className="size-4 accent-brand-500" checked={applyBuffer} onChange={e => setApplyBuffer(e.target.checked)} disabled={readOnly} />
                Keep travel buffer around this event
              </label>
            </>
          )}
          {!readOnly && <div className="sm:col-span-3"><Button loading={saving} onClick={save}>Save changes</Button></div>}
        </div>
      </Card>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${kindLabel.toLowerCase()}?`}
        footer={<>
          <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Keep it</Button>
          {b.repeatGroupId && <Button variant="danger" loading={deleting === 'series'} disabled={!!deleting} onClick={() => remove(true)}>This and later repeats</Button>}
          <Button variant="danger" loading={deleting === 'one'} disabled={!!deleting} onClick={() => remove(false)}>{b.repeatGroupId ? 'Only this one' : 'Delete'}</Button>
        </>}
      >
        <p className="text-sm text-ink-600 dark:text-ink-300">
          {isOpen ? 'Learners will no longer be able to book these extra hours. Lessons already booked in them stay booked.' : 'Learners will be able to book this time again.'}
        </p>
      </Modal>
    </>
  );
}
