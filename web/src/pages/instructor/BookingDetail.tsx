import { doc, updateDoc } from 'firebase/firestore';
import { ArrowLeft, CalendarCheck, CarFront, Clock, GraduationCap, Mail, MapPin, Phone, RefreshCw, StickyNote } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { DRIVING_EXPERIENCE, PLATFORM_FEE_RATE, displayRef, fullName, type Booking } from '@shared/domain';
import { formatDate, formatTimeRange } from '@shared/time';
import { useAuth } from '@/auth/AuthProvider';
import { AddToCalendarButton, BookingTimeline, PaymentBadge, StatusBadge, lessonLabel } from '@/components/booking';
import { Avatar, Button, ButtonLink, Card, CardHeader, EmptyState, PageHeader, PageLoader, Textarea, formatMoney } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useBooking, useUser } from '@/lib/data';
import { db } from '@/lib/firebase';
import { InstructorCancelButton, LateCancelActions, WithdrawButton } from './actions';
import { EventDetail } from './EventDetail';

export function InstructorBookingDetail() {
  const { id } = useParams();
  const { uid, readOnly } = useAuth();
  const { data: booking, loading } = useBooking(id);
  const { data: learner } = useUser(booking?.learnerId);

  if (loading) return <PageLoader />;
  if (!booking || booking.instructorId !== uid) {
    return <Card><EmptyState title="Booking not found" action={<ButtonLink to="/instructor">Back to dashboard</ButtonLink>} /></Card>;
  }

  // Personal events, time off and extra open hours have their own page.
  if (booking.kind !== 'lesson') return <EventDetail booking={booking} />;

  const canReschedule = booking.kind === 'lesson' && ['confirmed', 'late_cancel_requested'].includes(booking.status) && !readOnly;
  const net = booking.price !== undefined ? booking.price * (1 - PLATFORM_FEE_RATE) : undefined;

  return (
    <>
      <PageHeader
        back={<Link to="/instructor" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white"><ArrowLeft className="size-4" />Dashboard</Link>}
        title={<span className="flex flex-wrap items-center gap-3"><>Booking <span className="font-mono">{displayRef(booking)}</span></> <StatusBadge booking={booking} /></span>}
        actions={
          <>
            <LateCancelActions booking={booking} size="md" />
            <WithdrawButton booking={booking} size="md" />
            {canReschedule && (
              <ButtonLink to={`/instructor/propose?reschedule=${booking.id}`} variant="secondary"><RefreshCw className="size-4" />Reschedule</ButtonLink>
            )}
            <InstructorCancelButton booking={booking} />
          </>
        }
      />

      {booking.status === 'late_cancel_requested' && (
        <div className="mb-6 rounded-2xl bg-red-50 p-4 text-sm text-red-900 dark:bg-red-500/10 dark:text-red-200">
          <strong>{booking.learnerName}</strong> asked to cancel less than 24 hours before the lesson{booking.cancellationReason ? `: “${booking.cancellationReason}”` : '.'} Choose to refund them or charge the late fee.
        </div>
      )}
      {booking.status === 'cancelled' && booking.cancellationReason && (
        <div className="mb-6 rounded-2xl bg-ink-100 p-4 text-sm dark:bg-ink-800">
          <strong>Cancellation message{booking.cancelledBy === 'learner' ? ` from ${booking.learnerName}` : ' sent to the learner'}:</strong> “{booking.cancellationReason}”
        </div>
      )}
      {booking.rescheduledTo && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-2xl bg-sky-50 p-4 text-sm text-sky-900 dark:bg-sky-500/10 dark:text-sky-200">
          This booking was replaced by a new time.
          <ButtonLink to={`/instructor/bookings/${booking.rescheduledTo}`} size="sm" variant="secondary">View new booking</ButtonLink>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title={lessonLabel(booking)} subtitle={booking.kind === 'lesson' ? `${booking.transmission ?? 'Auto'} transmission` : 'Blocked time'} />
            <dl className="grid gap-5 p-5 sm:grid-cols-2">
              <Info icon={<Clock className="size-4" />} label="When">{formatDate(booking.startAt, booking.timezone)}<br />{formatTimeRange(booking.startAt, booking.endAt, booking.timezone)}</Info>
              {booking.pickupLocation && <Info icon={<MapPin className="size-4" />} label="Pick up">{booking.pickupLocation}</Info>}
              {booking.dropoffLocation && booking.dropoffLocation !== booking.pickupLocation && <Info icon={<MapPin className="size-4" />} label="Drop off">{booking.dropoffLocation}</Info>}
              {booking.testLocation && <Info icon={<CarFront className="size-4" />} label="Test centre">{booking.testLocation}</Info>}
              {booking.experience && <Info icon={<GraduationCap className="size-4" />} label="Driving experience">{DRIVING_EXPERIENCE[booking.experience]}</Info>}
              {booking.testBooked !== undefined && <Info icon={<CalendarCheck className="size-4" />} label="Driving test booked?">{booking.testBooked ? 'Yes' : 'No'}</Info>}
              {booking.notes && <Info icon={<StickyNote className="size-4" />} label={booking.experience ? 'Wants to work on' : 'Learner’s notes'}>{booking.notes}</Info>}
            </dl>
            {booking.kind === 'lesson' && ['confirmed', 'proposed'].includes(booking.status) && (
              <div className="border-t border-ink-100 px-5 py-4 dark:border-ink-800"><AddToCalendarButton booking={booking} withName={booking.learnerName} /></div>
            )}
          </Card>

          {booking.kind === 'lesson' && (
            <Card>
              <CardHeader title="Payment" />
              <div className="grid gap-4 p-5 sm:grid-cols-3">
                <div><p className="text-xs font-semibold uppercase text-ink-400">Lesson price</p><p className="text-2xl font-extrabold">{formatMoney(booking.price)}</p></div>
                <div><p className="text-xs font-semibold uppercase text-ink-400">Your earnings</p><p className="text-2xl font-extrabold">{formatMoney(net)}</p><p className="text-xs text-ink-500">after {PLATFORM_FEE_RATE * 100}% service fee</p></div>
                <div className="sm:text-right"><PaymentBadge booking={booking} /></div>
              </div>
            </Card>
          )}

          {booking.kind === 'lesson' && <NotesCard booking={booking} />}

          <Card>
            <CardHeader title="Activity" />
            <div className="p-5"><BookingTimeline booking={booking} /></div>
          </Card>
        </div>

        {booking.kind === 'lesson' && (
          <Card className="h-fit">
            <CardHeader title="Learner" />
            <div className="space-y-3 p-5">
              <Link to={`/instructor/learners/${booking.learnerId}`} className="flex items-center gap-3">
                <Avatar name={fullName(learner) || booking.learnerName} size={52} />
                <div>
                  <p className="font-bold">{fullName(learner) || booking.learnerName}</p>
                  <p className="text-sm text-ink-500">{learner?.status === 'invited' ? 'Invited — not signed up yet' : 'View learner'}</p>
                </div>
              </Link>
              {learner?.mobile && <a href={`tel:${learner.mobile.replace(/\s/g, '')}`} className="flex items-center gap-2 rounded-xl bg-ink-50 px-4 py-3 text-sm font-semibold hover:bg-ink-100 dark:bg-ink-800 dark:hover:bg-ink-700"><Phone className="size-4" />{learner.mobile}</a>}
              {(learner?.email || learner?.inviteEmail) && (
                <a href={`mailto:${learner.email ?? learner.inviteEmail}`} className="flex items-center gap-2 rounded-xl bg-ink-50 px-4 py-3 text-sm font-semibold hover:bg-ink-100 dark:bg-ink-800 dark:hover:bg-ink-700"><Mail className="size-4" /><span className="truncate">{learner.email ?? learner.inviteEmail}</span></a>
              )}
              <ButtonLink to={`/instructor/propose?learner=${booking.learnerId}`} variant="secondary" className="w-full">Propose another lesson</ButtonLink>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

function NotesCard({ booking }: { booking: Booking }) {
  const { readOnly } = useAuth();
  const [notes, setNotes] = useState(booking.instructorNotes ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => setNotes(booking.instructorNotes ?? ''), [booking.instructorNotes]);
  return (
    <Card>
      <CardHeader title="Private notes" subtitle="Only you can see these — e.g. what to practise next time." />
      <div className="space-y-3 p-5">
        <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4} placeholder="Roundabouts were great. Next: reverse parallel parking." disabled={readOnly} />
        <Button variant="secondary" size="sm" loading={saving} disabled={readOnly} onClick={async () => {
          setSaving(true);
          try {
            await updateDoc(doc(db, 'bookings', booking.id), { instructorNotes: notes.trim() });
            toast.success('Notes saved');
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setSaving(false);
          }
        }}>Save notes</Button>
      </div>
    </Card>
  );
}

function Info({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300">{icon}</span>
      <div><dt className="text-xs font-semibold uppercase tracking-wide text-ink-400">{label}</dt><dd className="mt-0.5 font-medium">{children}</dd></div>
    </div>
  );
}
