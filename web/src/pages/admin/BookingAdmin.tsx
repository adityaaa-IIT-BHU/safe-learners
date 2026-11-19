// Admin booking detail: everything about one lesson plus the office actions (cancel, decide a
// late-cancellation request, move to another time, private notes). The server checks every action
// (Booking Management: edit) and records it in the booking history.
import { collection, orderBy, query } from 'firebase/firestore';
import { CalendarClock, NotebookPen, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { STATUS_META, displayRef, type Booking } from '@shared/domain';
import { atLocalTime, dayKey, formatDate, formatTime, formatTimeRange } from '@shared/time';
import { useAuth } from '@/auth/AuthProvider';
import { Badge, Button, Card, Input, Modal, Textarea, cx, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { toDate, useQuery } from '@/lib/data';
import { db } from '@/lib/firebase';

type Panel = null | 'cancel' | 'move' | 'note';
const hhmm = (d: Date, tz: string) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

export function BookingAdmin({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const { can } = useAuth();
  const canEdit = can('bookings', 'edit');
  const tz = booking.timezone;
  const notes = useQuery(query(collection(db, 'bookings', booking.id, 'adminNotes'), orderBy('atMs', 'desc')),
    (id, d) => ({ id, text: d.text as string, by: d.by as string, kind: d.kind as string, at: toDate(d.at) }), `admin:bookingNotes:${booking.id}`).data;
  const [panel, setPanel] = useState<Panel>(null);
  const [reason, setReason] = useState('');
  const [refund, setRefund] = useState<'refund' | 'fee' | ''>('');
  const [day, setDay] = useState(dayKey(booking.startAt, tz));
  const [time, setTime] = useState(hhmm(booking.startAt, tz));
  const [outsideHours, setOutsideHours] = useState(false);
  const [busy, setBusy] = useState(false);
  const late = booking.status === 'late_cancel_requested';
  const cancellable = booking.kind === 'lesson' && (booking.status === 'confirmed' || late);
  const movable = booking.kind === 'lesson' && booking.status === 'confirmed';
  const open = (p: Panel) => { setPanel(p); setReason(''); setRefund(''); };

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); toast.success(done); setPanel(null); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  const row = (label: string, value: React.ReactNode) => value ? <div className="flex justify-between gap-4 py-1.5 text-sm"><span className="text-ink-500">{label}</span><span className="text-right font-semibold">{value}</span></div> : null;

  return (
    <Modal open onClose={onClose} size="lg" title={`Booking ${displayRef(booking)}`}>
      <div className="space-y-4">
        <Card className="divide-y divide-ink-100 px-4 py-2 dark:divide-ink-800">
          {row('Status', <Badge tone={booking.status === 'confirmed' ? 'blue' : booking.status === 'completed' ? 'green' : late ? 'amber' : 'slate'}>{STATUS_META[booking.status]?.label ?? booking.status}</Badge>)}
          {row('When', `${formatDate(booking.startAt, tz)}, ${formatTimeRange(booking.startAt, booking.endAt, tz)}`)}
          {row('Learner', booking.learnerName)}
          {row('Instructor', booking.instructorName)}
          {row('Pick up', booking.pickupLocation)}
          {row('Drop off', booking.dropoffLocation && booking.dropoffLocation !== booking.pickupLocation ? booking.dropoffLocation : null)}
          {row('Price', booking.price !== undefined ? formatMoney(booking.price) : null)}
          {row('Paid from wallet', booking.walletPaid ? formatMoney(booking.walletPaid) : null)}
          {row('Payment', booking.paymentStatus)}
          {row('Cancellation reason', booking.cancellationReason)}
        </Card>

        {canEdit && (cancellable || movable) && (
          <div className="flex flex-wrap gap-2">
            {cancellable && <Button variant={late ? 'primary' : 'secondary'} icon={<XCircle className="size-4" />} onClick={() => open('cancel')}>{late ? 'Decide late cancellation' : 'Cancel lesson'}</Button>}
            {movable && <Button variant="secondary" icon={<CalendarClock className="size-4" />} onClick={() => open('move')}>Move to another time</Button>}
            <Button variant="ghost" icon={<NotebookPen className="size-4" />} onClick={() => open('note')}>Add office note</Button>
          </div>
        )}
        {canEdit && !cancellable && !movable && <Button variant="ghost" icon={<NotebookPen className="size-4" />} onClick={() => open('note')}>Add office note</Button>}

        {panel === 'cancel' && (
          <Card className="space-y-3 p-4">
            <p className="text-sm font-bold">{late ? `${booking.learnerName} asked to cancel less than 24 hours before the lesson.` : 'Cancel this lesson'}</p>
            <div className="space-y-2 text-sm">
              {([['refund', `Refund the learner${booking.walletPaid ? ` (${formatMoney(booking.walletPaid)} back to their wallet)` : ' (nothing was paid from the wallet)'}`],
                 ['fee', 'Keep a cancellation fee (anything paid from the wallet is kept)']] as const).map(([v, label]) => (
                <label key={v} className={cx('flex cursor-pointer items-start gap-2 rounded-xl border p-3', refund === v ? 'border-brand-500 bg-brand-50/50 dark:bg-brand-500/10' : 'border-ink-200 dark:border-ink-700')}>
                  <input type="radio" name="refund" className="mt-0.5" checked={refund === v} onChange={() => setRefund(v)} />{label}
                </label>
              ))}
            </div>
            <Textarea label="Reason (shown to the learner and instructor, and recorded)" value={reason} onChange={e => setReason(e.target.value)} />
            <div className="flex gap-2">
              <Button variant="danger" loading={busy} disabled={!refund || reason.trim().length < 3}
                onClick={() => run(() => api.adminCancelBooking({ bookingId: booking.id, refund: refund as 'refund' | 'fee', reason: reason.trim() }), 'Lesson cancelled; learner and instructor notified')}>
                {late ? 'Confirm decision' : 'Cancel lesson'}
              </Button>
              <Button variant="ghost" onClick={() => setPanel(null)}>Back</Button>
            </div>
          </Card>
        )}

        {panel === 'move' && (
          <Card className="space-y-3 p-4">
            <p className="text-sm font-bold">Move to another time with {booking.instructorName}</p>
            <p className="text-xs text-ink-500">Times are in the instructor’s time zone ({tz}). Payment and commission stay the same. The system won’t allow a time that clashes with another booking.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Date" type="date" value={day} min={dayKey(new Date(), tz)} onChange={e => setDay(e.target.value)} />
              <Input label="Start time" type="time" step={900} value={time} onChange={e => setTime(e.target.value)} />
            </div>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={outsideHours} onChange={e => setOutsideHours(e.target.checked)} />Allow a time outside the instructor’s usual hours (only if they agreed)</label>
            <Textarea label="Reason (shown to the learner and instructor, and recorded)" value={reason} onChange={e => setReason(e.target.value)} />
            <div className="flex gap-2">
              <Button loading={busy} disabled={!day || !time || reason.trim().length < 3}
                onClick={() => run(() => api.adminMoveBooking({ bookingId: booking.id, startAt: atLocalTime(day, time, tz).toISOString(), reason: reason.trim(), outsideHours }), 'Lesson moved; learner and instructor notified')}>
                Move lesson
              </Button>
              <Button variant="ghost" onClick={() => setPanel(null)}>Back</Button>
            </div>
          </Card>
        )}

        {panel === 'note' && (
          <Card className="space-y-3 p-4">
            <Textarea label="Office note (only administrators can see it)" value={reason} onChange={e => setReason(e.target.value)} />
            <div className="flex gap-2">
              <Button loading={busy} disabled={!reason.trim()} onClick={() => run(() => api.adminBookingNote({ bookingId: booking.id, text: reason.trim() }), 'Note saved')}>Save note</Button>
              <Button variant="ghost" onClick={() => setPanel(null)}>Back</Button>
            </div>
          </Card>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-bold">History</h3>
            {(booking.history ?? []).length === 0 ? <p className="text-sm text-ink-500">No history recorded.</p> : (
              <ul className="space-y-1.5 text-sm">
                {[...(booking.history ?? [])].reverse().map((h, i) => (
                  <li key={i}><span className="text-xs text-ink-500">{h.at ? `${formatDate(h.at, tz)} ${formatTime(h.at, tz)}` : ''}</span><br />{h.action}{h.byName ? <span className="text-ink-500"> · {h.byName}</span> : null}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-bold">Office notes</h3>
            {notes.length === 0 ? <p className="text-sm text-ink-500">No office notes.</p> : (
              <ul className="space-y-1.5 text-sm">
                {notes.map(n => <li key={n.id}><span className="text-xs text-ink-500">{n.at ? n.at.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : ''} · {n.by}</span><br />{n.text}</li>)}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
