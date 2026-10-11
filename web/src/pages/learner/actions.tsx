import { Check, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { FREE_CANCELLATION_HOURS, hoursUntil, learnerCanReschedule, type Booking } from '@shared/domain';
import { formatDate, formatTime } from '@shared/time';
import { useAuth } from '@/auth/AuthProvider';
import { Button, ButtonLink, Modal, Textarea, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export function reschedulePath(b: Booking): string {
  return `/learner/book/${b.instructorId}?reschedule=${b.id}&type=${b.lessonType ?? 'lesson-1h'}`;
}

export function ProposalActions({ booking, size = 'sm' }: { booking: Booking; size?: 'sm' | 'md' }) {
  const { readOnly } = useAuth();
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const respond = async (accept: boolean) => {
    setBusy(accept ? 'accept' : 'decline');
    try {
      const res = await api.respondToProposal({ bookingId: booking.id, accept });
      toast.success(accept ? `Booking ${booking.ref ?? ''} confirmed!` : 'Proposal declined.');
      if (accept && res.status === 'confirmed') navigator.vibrate?.(30);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button size={size} variant="secondary" icon={<X className="size-4" />} loading={busy === 'decline'} disabled={!!busy || readOnly} onClick={() => respond(false)}>Decline</Button>
      <Button size={size} variant="success" icon={<Check className="size-4" />} loading={busy === 'accept'} disabled={!!busy || readOnly} onClick={() => respond(true)}>Accept</Button>
    </>
  );
}

export function RescheduleButton({ booking, size = 'sm' }: { booking: Booking; size?: 'sm' | 'md' }) {
  const { readOnly } = useAuth();
  if (!learnerCanReschedule(booking) || readOnly) return null;
  return (
    <ButtonLink to={reschedulePath(booking)} size={size} variant={booking.status === 'cancelled' ? 'primary' : 'secondary'}>
      <RefreshCw className="size-4" /> {booking.status === 'cancelled' ? 'Rebook' : 'Reschedule'}
    </ButtonLink>
  );
}

export function CancelButton({ booking, size = 'sm' }: { booking: Booking; size?: 'sm' | 'md' }) {
  const { readOnly } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (booking.status !== 'confirmed' || readOnly) return null;
  const late = hoursUntil(booking.startAt) < FREE_CANCELLATION_HOURS;

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.cancelBooking({ bookingId: booking.id, reason: reason.trim() || undefined });
      toast.success(res.result === 'requested'
        ? 'Cancellation request sent to your instructor.'
        : booking.paymentStatus === 'paid' ? 'Booking cancelled — the credit is back in your wallet.' : 'Booking cancelled.');
      setOpen(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size={size} variant="ghost" className="text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10" onClick={() => setOpen(true)}>
        Cancel
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={late ? 'Request a late cancellation' : 'Cancel this lesson?'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Keep lesson</Button>
            <Button variant="danger" loading={busy} onClick={submit}>{late ? 'Send request' : 'Cancel lesson'}</Button>
          </>
        }
      >
        <p className="text-sm text-ink-600 dark:text-ink-300">
          {formatDate(booking.startAt, booking.timezone)} at {formatTime(booking.startAt, booking.timezone)} with {booking.instructorName}.
        </p>
        <div className={`mt-4 rounded-xl p-4 text-sm ${late ? 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200' : 'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200'}`}>
          {late
            ? <>This lesson is less than {FREE_CANCELLATION_HOURS} hours away. Your instructor will decide whether to refund you or charge a late cancellation fee{booking.price ? ` (up to ${formatMoney(booking.price)})` : ''}.</>
            : <>Free cancellation: {booking.paymentStatus === 'paid' ? `${formatMoney(booking.price)} goes straight back to your wallet.` : 'nothing will be charged.'} Want a different time instead? Use Reschedule.</>}
        </div>
        <Textarea wrapperClassName="mt-4" label="Reason (optional)" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Let your instructor know why" />
      </Modal>
    </>
  );
}
