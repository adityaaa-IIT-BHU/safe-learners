import { CalendarPlus, ChevronLeft, ChevronRight, Clock, MapPin } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  LESSON_TYPES,
  STATUS_META,
  displayRef,
  type Booking,
  type LessonType,
} from '@shared/domain';
import { DEFAULT_TIMEZONE, addDaysToKey, dayKey, formatDate, formatInZone, formatTime, formatTimeRange, startOfDayKey } from '@shared/time';
import { api, errorMessage } from '@/lib/api';
import { Avatar, Badge, Button, Skeleton, cx } from './ui';

export function StatusBadge({ booking }: { booking: Pick<Booking, 'status' | 'paymentStatus'> }) {
  const meta = STATUS_META[booking.status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function PaymentBadge({ booking }: { booking: Pick<Booking, 'paymentStatus'> }) {
  const map = {
    paid: { tone: 'green', label: 'Paid from wallet' },
    unpaid: { tone: 'slate', label: 'Payment due' },
    refunded: { tone: 'blue', label: 'Refunded' },
    charged: { tone: 'red', label: 'Late cancellation fee' },
  } as const;
  const m = map[booking.paymentStatus ?? 'unpaid'];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function lessonLabel(b: Booking): string {
  if (b.kind === 'open') return b.title || 'Extra open hours';
  if (b.kind === 'event') return b.title || 'Personal time';
  return LESSON_TYPES[b.lessonType ?? 'lesson-1h'].label;
}

/** Big calendar-style date tile. */
export function DateTile({ date, timeZone }: { date: Date; timeZone: string }) {
  return (
    <div className="flex w-14 shrink-0 flex-col items-center overflow-hidden rounded-xl border border-ink-200 bg-white text-center dark:border-ink-700 dark:bg-ink-900">
      <div className="w-full bg-ink-950 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-400 dark:bg-brand-500 dark:text-ink-950">
        {formatInZone(date, { month: 'short' }, timeZone)}
      </div>
      <div className="pt-1 text-xl font-extrabold leading-none">{formatInZone(date, { day: 'numeric' }, timeZone)}</div>
      <div className="pb-1 text-[10px] font-semibold uppercase text-ink-500">{formatInZone(date, { weekday: 'short' }, timeZone)}</div>
    </div>
  );
}

/** A booking in a list. `person` is the other party shown on the row. */
export function BookingRow({ booking, to, person, actions, highlight }: {
  booking: Booking;
  to: string;
  person?: { name?: string; photo?: string };
  actions?: ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className={cx(
      'card flex flex-col gap-4 p-4 transition hover:shadow-lift sm:flex-row sm:items-center',
      highlight && 'ring-2 ring-brand-500',
    )}>
      <Link to={to} className="flex min-w-0 flex-1 items-center gap-4">
        <DateTile date={booking.startAt} timeZone={booking.timezone} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-ink-950 dark:text-white">{lessonLabel(booking)}</span>
            <StatusBadge booking={booking} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-500">
            <span className="inline-flex items-center gap-1"><Clock className="size-3.5" />{formatTimeRange(booking.startAt, booking.endAt, booking.timezone)}</span>
            {booking.pickupLocation && <span className="inline-flex min-w-0 items-center gap-1"><MapPin className="size-3.5 shrink-0" /><span className="truncate">{booking.pickupLocation}</span></span>}
            <span className="font-mono text-xs text-ink-400">{displayRef(booking)}</span>
          </div>
        </div>
        {person?.name && (
          <div className="hidden items-center gap-2 md:flex">
            <Avatar name={person.name} src={person.photo} size={32} />
            <span className="text-sm font-semibold">{person.name}</span>
          </div>
        )}
      </Link>
      {actions && <div className="flex flex-wrap gap-2 sm:justify-end">{actions}</div>}
    </div>
  );
}

export function BookingTimeline({ booking }: { booking: Booking }) {
  const entries = [...(booking.history ?? [])].sort((a, b) => b.at.getTime() - a.at.getTime());
  if (!entries.length) {
    return <p className="text-sm text-ink-500">{booking.createdAt ? `Created ${formatDate(booking.createdAt, booking.timezone)}` : 'No updates yet.'}</p>;
  }
  return (
    <ol className="relative space-y-5 border-l-2 border-ink-100 pl-6 dark:border-ink-800">
      {entries.map((e, i) => (
        <li key={i} className="relative">
          <span className="absolute -left-[31px] top-1 size-3 rounded-full border-2 border-white bg-brand-500 dark:border-ink-900" />
          <p className="text-sm font-semibold">{e.byName ? `${e.byName}: ` : ''}{e.action}</p>
          <p className="text-xs text-ink-500">{formatDate(e.at, booking.timezone)} · {formatTime(e.at, booking.timezone)}</p>
        </li>
      ))}
    </ol>
  );
}

// ---------- Add to calendar ----------

function icsDate(d: Date) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function downloadIcs(booking: Booking, withName?: string) {
  const title = `${lessonLabel(booking)}${withName ? ` with ${withName}` : ''}`;
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Safe Learners//Booking//EN',
    'BEGIN:VEVENT',
    `UID:${booking.id}@safelearners`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(booking.startAt)}`,
    `DTEND:${icsDate(booking.endAt)}`,
    `SUMMARY:${title} (${displayRef(booking)})`,
    booking.pickupLocation ? `LOCATION:${booking.pickupLocation.replace(/,/g, '\\,')}` : '',
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${title}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `safe-learners-${booking.ref ?? booking.id}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

export function AddToCalendarButton({ booking, withName }: { booking: Booking; withName?: string }) {
  return (
    <Button variant="secondary" icon={<CalendarPlus className="size-4" />} onClick={() => downloadIcs(booking, withName)}>
      Add to calendar
    </Button>
  );
}

// ---------- Slot picker (live availability from the server) ----------

export function SlotPicker({ instructorId, lessonType, value, onChange, excludeBookingId }: {
  instructorId: string;
  lessonType: LessonType;
  value: string | null; // ISO start
  onChange: (iso: string | null) => void;
  excludeBookingId?: string;
}) {
  const [data, setData] = useState<{ timezone: string; slots: Record<string, string[]>; maxAdvanceDays?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api.getAvailability({ instructorId, lessonType, days: 121, excludeBookingId })
      .then(res => {
        if (cancelled) return;
        setData(res);
        const first = Object.keys(res.slots).sort()[0] ?? null;
        setSelectedDay(d => (d && res.slots[d] ? d : first));
      })
      .catch(err => !cancelled && setError(errorMessage(err)));
    return () => { cancelled = true; };
  }, [instructorId, lessonType, excludeBookingId]);

  // A selected start that no longer exists for this lesson length is cleared.
  useEffect(() => {
    if (!data || !value) return;
    const all = Object.values(data.slots).flat();
    if (!all.includes(value)) onChange(null);
  }, [data, value, onChange]);

  const tz = data?.timezone ?? DEFAULT_TIMEZONE;
  const today = dayKey(new Date(), tz);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysToKey(today, weekOffset * 7 + i)), [today, weekOffset]);

  if (error) return <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>;
  if (!data) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-7 gap-2">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>
        <Skeleton className="h-24" />
      </div>
    );
  }

  const totalDays = Object.keys(data.slots).length;
  if (!totalDays) {
    return (
      <p className="rounded-xl bg-ink-100 p-4 text-sm text-ink-600 dark:bg-ink-800 dark:text-ink-300">
        No free times in the next {data.maxAdvanceDays ?? 28} days for this lesson length. Try a shorter lesson or check back soon.
      </p>
    );
  }
  // Weeks the learner can page through: up to the last day with a free slot.
  const lastDay = Object.keys(data.slots).sort().at(-1)!;
  const maxWeek = Math.max(0, Math.floor((startOfDayKey(lastDay, tz).getTime() - startOfDayKey(today, tz).getTime()) / (7 * 86_400_000)));

  const times = selectedDay ? data.slots[selectedDay] ?? [] : [];
  const nextAvailable = Object.keys(data.slots).sort()[0];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-500">
          Next available: <span className="font-semibold text-ink-900 dark:text-white">
            {formatDate(startOfDayKey(nextAvailable, tz), tz)}
          </span>
        </p>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" disabled={weekOffset === 0} onClick={() => setWeekOffset(w => w - 1)} aria-label="Previous week"><ChevronLeft className="size-4" /></Button>
          <Button variant="ghost" size="sm" disabled={weekOffset >= maxWeek} onClick={() => setWeekOffset(w => w + 1)} aria-label="Next week"><ChevronRight className="size-4" /></Button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
        {days.map(day => {
          const count = data.slots[day]?.length ?? 0;
          const date = startOfDayKey(day, tz);
          const active = selectedDay === day;
          return (
            <button
              key={day}
              type="button"
              disabled={!count}
              onClick={() => setSelectedDay(day)}
              className={cx(
                'flex flex-col items-center rounded-xl border py-2 text-center transition',
                active ? 'border-ink-950 bg-ink-950 text-white dark:border-brand-500 dark:bg-brand-500 dark:text-ink-950'
                  : count ? 'border-ink-200 bg-white hover:border-ink-400 dark:border-ink-700 dark:bg-ink-900'
                    : 'cursor-not-allowed border-transparent bg-ink-100/60 text-ink-300 dark:bg-ink-800/50 dark:text-ink-600',
              )}
            >
              <span className="text-[10px] font-bold uppercase">{formatInZone(date, { weekday: 'short' }, tz)}</span>
              <span className="text-lg font-extrabold leading-tight">{formatInZone(date, { day: 'numeric' }, tz)}</span>
              <span className={cx('text-[10px]', active ? 'opacity-80' : 'text-ink-500')}>{count ? `${count} free` : '—'}</span>
            </button>
          );
        })}
      </div>
      {selectedDay && (
        <div>
          <p className="mb-2 text-sm font-semibold">{formatDate(startOfDayKey(selectedDay, tz), tz)}</p>
          {times.length ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {times.map(iso => (
                <button
                  key={iso}
                  type="button"
                  onClick={() => onChange(iso)}
                  className={cx(
                    'rounded-lg border px-2 py-2 text-sm font-semibold transition',
                    value === iso ? 'border-brand-500 bg-brand-500 text-ink-950' : 'border-ink-200 hover:border-ink-400 dark:border-ink-700',
                  )}
                >
                  {formatTime(new Date(iso), tz)}
                </button>
              ))}
            </div>
          ) : <p className="text-sm text-ink-500">No free times on this day.</p>}
        </div>
      )}
      <p className="text-xs text-ink-400">Times shown in {tz.replace('_', ' ').split('/')[1]} time.</p>
    </div>
  );
}
