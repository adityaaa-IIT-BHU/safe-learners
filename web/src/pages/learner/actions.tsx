import { CalendarClock, Check, ChevronRight, Phone, RefreshCw, Star, UserRoundSearch, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { FREE_CANCELLATION_HOURS, hoursUntil, learnerCanReschedule, learnerCanReview, type Booking } from '@shared/domain';
import { formatDate, formatTime } from '@shared/time';
import { useAuth } from '@/auth/AuthProvider';
import { Button, ButtonLink, Modal, Textarea, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export function reschedulePath(b: Booking): string {
  return `/learner/book/${b.instructorId}?reschedule=${b.id}&type=${b.lessonType ?? 'lesson-1h'}`;
}

/** Find a different instructor; the booking made there replaces this one. */
export function switchInstructorPath(b: Booking): string {
  return `/learner/instructors?reschedule=${b.id}&type=${b.lessonType ?? 'lesson-1h'}`;
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

/** Rebook a cancelled lesson, or change the time or instructor of an upcoming one. */
export function RescheduleButton({ booking, size = 'sm' }: { booking: Booking; size?: 'sm' | 'md' }) {
  const { readOnly } = useAuth();
  const [open, setOpen] = useState(false);
  if (readOnly || booking.kind !== 'lesson') return null;
  if (booking.status === 'cancelled') {
    if (!learnerCanReschedule(booking)) return null;
    return <ButtonLink to={reschedulePath(booking)} size={size}><RefreshCw className="size-4" /> Rebook</ButtonLink>;
  }
  if (booking.status !== 'confirmed' || booking.startAt.getTime() <= Date.now()) return null;

  const name = booking.instructorName ?? 'your instructor';
  const canMove = learnerCanReschedule(booking);
  return (
    <>
      <Button size={size} variant="secondary" icon={<RefreshCw className="size-4" />} onClick={() => setOpen(true)}>Change</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Change this lesson" footer={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>}>
        <p className="text-sm text-ink-600 dark:text-ink-300">
          {formatDate(booking.startAt, booking.timezone)} at {formatTime(booking.startAt, booking.timezone)} with {name}.
        </p>
        {canMove ? (
          <div className="mt-4 space-y-3">
            <ChangeOption to={reschedulePath(booking)} icon={<CalendarClock className="size-5" />} title={`New time with ${name}`} body="Pick another time from their live calendar." />
            <ChangeOption to={switchInstructorPath(booking)} icon={<UserRoundSearch className="size-5" />} title="Different instructor" body="Find another instructor in your area and choose a time." />
            <p className="text-xs text-ink-500">
              Your current lesson stays booked until you confirm the new one{booking.paymentStatus === 'paid' ? ', then its credit is returned to your wallet' : ''}.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
              This lesson is less than {FREE_CANCELLATION_HOURS} hours away, so it can’t be moved online. Please contact {name} to arrange a new time,
              or use <strong>Cancel</strong> to request a cancellation — {name} decides whether a late fee applies.
            </div>
            {booking.instructorMobile && (
              <a href={`tel:${booking.instructorMobile.replace(/\s/g, '')}`} className="mt-3 flex items-center gap-2 rounded-xl bg-ink-50 px-4 py-3 text-sm font-semibold hover:bg-ink-100 dark:bg-ink-800 dark:hover:bg-ink-700">
                <Phone className="size-4" />Call {name} on {booking.instructorMobile}
              </a>
            )}
          </>
        )}
      </Modal>
    </>
  );
}

function ChangeOption({ to, icon, title, body }: { to: string; icon: React.ReactNode; title: string; body: string }) {
  return (
    <Link to={to} className="flex items-center gap-4 rounded-2xl border-2 border-ink-200 p-4 transition hover:border-ink-400 dark:border-ink-700 dark:hover:border-ink-500">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-ink-900 dark:bg-brand-500/10 dark:text-brand-300">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold">{title}</span>
        <span className="block text-sm text-ink-500">{body}</span>
      </span>
      <ChevronRight className="size-5 text-ink-400" />
    </Link>
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
            : <>Free cancellation: {booking.paymentStatus === 'paid' ? `${formatMoney(booking.price)} goes straight back to your wallet.` : 'nothing will be charged.'} Want a different time or instructor instead? Use Change.</>}
        </div>
        <Textarea wrapperClassName="mt-4" label="Reason (optional)" rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Let your instructor know why" />
      </Modal>
    </>
  );
}

/** Opens the rating form for a finished lesson that hasn't been reviewed. */
export function RateButton({ booking, size = 'sm' }: { booking: Booking; size?: 'sm' | 'md' }) {
  const { readOnly } = useAuth();
  if (readOnly || !learnerCanReview(booking)) return null;
  return <ButtonLink to={`/learner/bookings/${booking.id}?review=1`} size={size}><Star className="size-4" /> Rate lesson</ButtonLink>;
}

export function ReviewModal({ booking, open, onClose }: { booking: Booking; open: boolean; onClose: () => void }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setRating(0); setComment(''); } }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Rate your lesson with ${booking.instructorName}`}
      footer={<Button disabled={!rating} loading={busy} onClick={async () => {
        setBusy(true);
        try {
          await api.submitReview({ bookingId: booking.id, rating, comment: comment.trim() || undefined });
          toast.success('Thanks for your review!');
          onClose();
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}>Submit review</Button>}
    >
      <p className="text-center text-sm text-ink-500">{formatDate(booking.startAt, booking.timezone)} · {formatTime(booking.startAt, booking.timezone)}</p>
      <div className="flex justify-center gap-2 py-2" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map(n => (
          <button key={n} type="button" onClick={() => setRating(n)} onMouseEnter={() => setHover(n)} aria-label={`${n} star${n > 1 ? 's' : ''}`}>
            <Star className={`size-10 transition ${(hover || rating) >= n ? 'fill-brand-500 text-brand-500' : 'text-ink-200 dark:text-ink-700'}`} />
          </button>
        ))}
      </div>
      <Textarea wrapperClassName="mt-4" label="Tell other learners about it (optional)" value={comment} onChange={e => setComment(e.target.value)} placeholder="What went well? What could be better?" />
      <p className="mt-2 text-xs text-ink-500">Reviews are public on {booking.instructorName}’s profile.</p>
    </Modal>
  );
}
