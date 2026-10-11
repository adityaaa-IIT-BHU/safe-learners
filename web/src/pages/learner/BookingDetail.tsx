import { ArrowLeft, CarFront, Clock, MapPin, Phone, Star, StickyNote } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { LESSON_TYPES, displayRef, fullName, type Booking } from '@shared/domain';
import { formatDate, formatTimeRange } from '@shared/time';
import { useAuth } from '@/auth/AuthProvider';
import { AddToCalendarButton, BookingTimeline, PaymentBadge, StatusBadge } from '@/components/booking';
import { Avatar, Button, ButtonLink, Card, CardHeader, EmptyState, Modal, PageHeader, PageLoader, Textarea, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useBooking, useUser } from '@/lib/data';
import { CancelButton, ProposalActions, RescheduleButton } from './actions';

export function LearnerBookingDetail() {
  const { id } = useParams();
  const { uid } = useAuth();
  const [params, setParams] = useSearchParams();
  const { data: booking, loading } = useBooking(id);
  const { data: instructor } = useUser(booking?.instructorId);

  if (loading) return <PageLoader />;
  if (!booking || booking.learnerId !== uid) {
    return <Card><EmptyState title="Booking not found" action={<ButtonLink to="/learner">Back to dashboard</ButtonLink>} /></Card>;
  }

  const canReview = !booking.reviewed && (booking.status === 'completed' || (booking.status === 'confirmed' && booking.endAt.getTime() < Date.now()));

  return (
    <>
      <PageHeader
        back={<Link to="/learner" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white"><ArrowLeft className="size-4" />Dashboard</Link>}
        title={<span className="flex flex-wrap items-center gap-3">Booking <span className="font-mono">{displayRef(booking)}</span> <StatusBadge booking={booking} /></span>}
        actions={
          <>
            {booking.status === 'proposed' && <ProposalActions booking={booking} size="md" />}
            <RescheduleButton booking={booking} size="md" />
            {canReview && <Button icon={<Star className="size-4" />} onClick={() => setParams({ review: '1' })}>Rate lesson</Button>}
            <CancelButton booking={booking} size="md" />
          </>
        }
      />

      <StatusExplainer booking={booking} />

      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title={LESSON_TYPES[booking.lessonType ?? 'lesson-1h'].label} subtitle={`${booking.transmission ?? 'Auto'} transmission`} />
            <dl className="grid gap-5 p-5 sm:grid-cols-2">
              <Detail icon={<Clock className="size-4" />} label="When">
                {formatDate(booking.startAt, booking.timezone)}<br />{formatTimeRange(booking.startAt, booking.endAt, booking.timezone)}
              </Detail>
              <Detail icon={<MapPin className="size-4" />} label="Pick up">{booking.pickupLocation || '—'}</Detail>
              {booking.dropoffLocation && booking.dropoffLocation !== booking.pickupLocation && <Detail icon={<MapPin className="size-4" />} label="Drop off">{booking.dropoffLocation}</Detail>}
              {booking.testLocation && <Detail icon={<CarFront className="size-4" />} label="Test centre">{booking.testLocation}</Detail>}
              {booking.notes && <Detail icon={<StickyNote className="size-4" />} label="Your notes">{booking.notes}</Detail>}
            </dl>
            {['confirmed', 'proposed'].includes(booking.status) && (
              <div className="border-t border-ink-100 px-5 py-4 dark:border-ink-800"><AddToCalendarButton booking={booking} withName={booking.instructorName} /></div>
            )}
          </Card>

          <Card>
            <CardHeader title="Payment" />
            <div className="flex items-center justify-between p-5">
              <div className="space-y-1">
                <PaymentBadge booking={booking} />
                {booking.createdAt && <p className="text-sm text-ink-500">Booked {formatDate(booking.createdAt, booking.timezone)}</p>}
              </div>
              <p className="text-3xl font-extrabold">{formatMoney(booking.price)}</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Activity" />
            <div className="p-5"><BookingTimeline booking={booking} /></div>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader title="Instructor" />
          <div className="space-y-4 p-5">
            <Link to={`/learner/instructors/${booking.instructorId}`} className="flex items-center gap-3">
              <Avatar name={fullName(instructor) || booking.instructorName} src={instructor?.photoUrl} size={52} />
              <div>
                <p className="font-bold">{fullName(instructor) || booking.instructorName}</p>
                <p className="text-sm text-ink-500">{[instructor?.vehicle?.make, instructor?.vehicle?.model].filter(Boolean).join(' ') || 'Instructor'}</p>
              </div>
            </Link>
            {instructor?.mobile && (
              <a href={`tel:${instructor.mobile.replace(/\s/g, '')}`} className="flex items-center gap-2 rounded-xl bg-ink-50 px-4 py-3 text-sm font-semibold hover:bg-ink-100 dark:bg-ink-800 dark:hover:bg-ink-700">
                <Phone className="size-4" />{instructor.mobile}
              </a>
            )}
          </div>
        </Card>
      </div>

      <ReviewModal booking={booking} open={params.get('review') === '1' && canReview} onClose={() => setParams({})} />
    </>
  );
}

function StatusExplainer({ booking: b }: { booking: Booking }) {
  const messages: Partial<Record<Booking['status'], string>> = {
    proposed: `${b.instructorName} proposed this time. Accept to confirm it, or decline if it doesn’t suit.`,
    late_cancel_requested: `You asked to cancel inside 24 hours. ${b.instructorName} will decide whether a fee applies — you’ll be notified.`,
    cancelled: b.rescheduledTo ? 'This lesson was moved to a new time.' : 'This lesson was cancelled. You can rebook a new time any time.',
  };
  const message = messages[b.status];
  if (!message) return null;
  const from = b.cancelledBy === 'instructor' ? b.instructorName ?? 'Your instructor' : b.cancelledBy === 'learner' ? 'You' : 'Safe Learners';
  return (
    <div className="mb-6 flex items-center justify-between gap-4 rounded-2xl border border-brand-200 bg-brand-50 p-4 text-sm text-brand-900 dark:border-brand-500/20 dark:bg-brand-500/10 dark:text-brand-200">
      <span>
        {message}
        {b.status === 'cancelled' && b.cancellationReason && (
          <span className="mt-2 block rounded-xl bg-white/70 p-3 text-ink-800 dark:bg-ink-900/50 dark:text-ink-200">
            <strong>Message from {from}:</strong> “{b.cancellationReason}”
          </span>
        )}
      </span>
      {b.rescheduledTo && <ButtonLink to={`/learner/bookings/${b.rescheduledTo}`} size="sm" variant="secondary">View new booking</ButtonLink>}
    </div>
  );
}

function Detail({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300">{icon}</span>
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</dt>
        <dd className="mt-0.5 font-medium">{children}</dd>
      </div>
    </div>
  );
}

function ReviewModal({ booking, open, onClose }: { booking: Booking; open: boolean; onClose: () => void }) {
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
