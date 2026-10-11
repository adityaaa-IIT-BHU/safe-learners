import { CalendarOff, CalendarPlus, ChevronDown, ChevronLeft, ChevronRight, Lock, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { calendarOf, type Booking } from '@shared/domain';
import {
  DEFAULT_TIMEZONE,
  addDaysToKey,
  atLocalTime,
  dayKey,
  formatInZone,
  formatTime,
  hhmmToMinutes,
  startOfDayKey,
  toZoned,
  weekdayOfKey,
} from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Button, Card, PageHeader, Segmented, cx } from '@/components/ui';
import { useBookings } from '@/lib/data';
import { EventModal, type EventMode } from './actions';

const HOUR_PX = 56;

function mondayOf(key: string): string {
  const offset = (['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const).indexOf(weekdayOfKey(key) as never);
  return addDaysToKey(key, -offset);
}

function minutesInDay(date: Date, tz: string): number {
  const z = toZoned(date, tz);
  return z.hour * 60 + z.minute;
}

export function Calendar() {
  const me = useProfile();
  const { uid, readOnly } = useAuth();
  const navigate = useNavigate();
  const tz = me.timezone ?? DEFAULT_TIMEZONE;
  const today = dayKey(new Date(), tz);
  const [view, setView] = useState<'week' | 'day'>(() => (window.innerWidth < 768 ? 'day' : calendarOf(me).defaultView));
  const [anchor, setAnchor] = useState(today);
  const [menu, setMenu] = useState<{ start: Date; x: number; y: number } | null>(null);
  const [eventDialog, setEventDialog] = useState<{ mode: EventMode; start: Date } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const { data: bookings } = useBookings('instructorId', uid);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const days = view === 'week' ? Array.from({ length: 7 }, (_, i) => addDaysToKey(mondayOf(anchor), i)) : [anchor];

  // Visible hours: cover operating hours and any bookings, at least 7am–7pm.
  const [startHour, endHour] = useMemo(() => {
    let min = 7 * 60;
    let max = 19 * 60;
    Object.values(me.operatingHours ?? {}).flat().forEach(r => {
      if (!r) return;
      min = Math.min(min, hhmmToMinutes(r.start));
      max = Math.max(max, hhmmToMinutes(r.end));
    });
    bookings.forEach(b => {
      if (!days.includes(dayKey(b.startAt, tz))) return;
      min = Math.min(min, minutesInDay(b.startAt, tz));
      max = Math.max(max, minutesInDay(b.endAt, tz) || 24 * 60);
    });
    return [Math.max(0, Math.floor(min / 60)), Math.min(24, Math.ceil(max / 60))];
  }, [me.operatingHours, bookings, days.join(), tz]); // eslint-disable-line react-hooks/exhaustive-deps

  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  // Cancelled, declined and withdrawn bookings don't occupy time, so they're left off the calendar.
  const firstDay = startOfDayKey(days[0], tz);
  const lastDayEnd = startOfDayKey(addDaysToKey(days[days.length - 1], 1), tz);
  const visible = bookings.filter(b => b.startAt < lastDayEnd && b.endAt > firstDay && !['declined', 'withdrawn', 'cancelled'].includes(b.status));
  const top = (mins: number) => ((mins - startHour * 60) / 60) * HOUR_PX;

  const step = view === 'week' ? 7 : 1;
  const title = view === 'week'
    ? `${formatInZone(startOfDayKey(days[0], tz), { day: 'numeric', month: 'short' }, tz)} – ${formatInZone(startOfDayKey(days[6], tz), { day: 'numeric', month: 'short', year: 'numeric' }, tz)}`
    : formatInZone(startOfDayKey(anchor, tz), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, tz);

  return (
    <>
      <PageHeader
        title="Calendar"
        subtitle="Click any empty time to propose a lesson or block it out."
        actions={
          <>
            <Segmented value={view} onChange={setView} options={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }]} className="w-40 [&_button]:py-1.5 [&_button]:text-center" />
            <div className="relative">
              <Button variant="secondary" icon={<CalendarPlus className="size-4" />} onClick={() => setNewOpen(o => !o)} disabled={readOnly}>New <ChevronDown className="size-4" /></Button>
              {newOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setNewOpen(false)} />
                  <div className="absolute right-0 top-12 z-40 w-56 animate-slide-up rounded-2xl border border-ink-200 bg-white p-1.5 shadow-lift dark:border-ink-700 dark:bg-ink-900">
                    <MenuButton icon={<Send className="size-4" />} onClick={() => navigate('/instructor/propose')}>Propose a lesson</MenuButton>
                    <MenuButton icon={<CalendarPlus className="size-4" />} onClick={() => { setNewOpen(false); setEventDialog({ mode: 'open', start: new Date() }); }}>Extra open hours</MenuButton>
                    <MenuButton icon={<Lock className="size-4" />} onClick={() => { setNewOpen(false); setEventDialog({ mode: 'event', start: new Date() }); }}>Personal event</MenuButton>
                    <MenuButton icon={<CalendarOff className="size-4" />} onClick={() => { setNewOpen(false); setEventDialog({ mode: 'timeoff', start: new Date() }); }}>Time off</MenuButton>
                  </div>
                </>
              )}
            </div>
          </>
        }
      />
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-ink-100 px-4 py-3 dark:border-ink-800">
          <Button size="sm" variant="secondary" onClick={() => setAnchor(today)}>Today</Button>
          <Button size="sm" variant="ghost" aria-label="Previous" onClick={() => setAnchor(a => addDaysToKey(a, -step))}><ChevronLeft className="size-4" /></Button>
          <Button size="sm" variant="ghost" aria-label="Next" onClick={() => setAnchor(a => addDaysToKey(a, step))}><ChevronRight className="size-4" /></Button>
          <p className="ml-2 font-bold">{title}</p>
          <div className="ml-auto hidden items-center gap-3 text-xs text-ink-500 sm:flex">
            <Legend className="bg-emerald-100 dark:bg-emerald-500/15" label="Available" />
            <Legend className="bg-brand-400" label="Lesson" />
            <Legend className="border border-dashed border-amber-500 bg-amber-100" label="Proposed" />
            <Legend className="bg-ink-300" label="Blocked" />
            <Legend className="border border-dashed border-emerald-500 bg-emerald-50" label="Extra hours" />
          </div>
        </div>

        <div className="scroll-thin overflow-x-auto">
          <div className={cx('grid', view === 'week' ? 'min-w-[760px]' : '')} style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
            <div />
            {days.map(d => (
              <div key={d} className={cx('border-b border-l border-ink-100 py-2 text-center dark:border-ink-800', d === today && 'bg-brand-50 dark:bg-brand-500/10')}>
                <p className="text-[11px] font-bold uppercase text-ink-500">{formatInZone(startOfDayKey(d, tz), { weekday: 'short' }, tz)}</p>
                <p className={cx('mx-auto mt-0.5 flex size-8 items-center justify-center rounded-full text-lg font-extrabold', d === today && 'bg-ink-950 text-brand-400 dark:bg-brand-500 dark:text-ink-950')}>
                  {formatInZone(startOfDayKey(d, tz), { day: 'numeric' }, tz)}
                </p>
              </div>
            ))}

            {/* Hour labels */}
            <div className="relative" style={{ height: hours.length * HOUR_PX }}>
              {hours.map(h => (
                <span key={h} className="absolute right-2 -translate-y-1/2 text-[11px] font-medium text-ink-400" style={{ top: (h - startHour) * HOUR_PX }}>
                  {h === 0 ? '' : `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`}
                </span>
              ))}
            </div>

            {days.map(d => {
              const ranges = me.operatingHours?.[weekdayOfKey(d)] ?? [];
              const dayStart = startOfDayKey(d, tz);
              const dayEnd = startOfDayKey(addDaysToKey(d, 1), tz);
              // Events spanning several days (time off) are drawn on each day they cover.
              const dayBookings = visible.filter(b => b.startAt < dayEnd && b.endAt > dayStart);
              return (
                <div
                  key={d}
                  className="relative cursor-pointer border-l border-ink-100 dark:border-ink-800"
                  style={{ height: hours.length * HOUR_PX }}
                  onClick={e => {
                    if (readOnly || e.target !== e.currentTarget && !(e.target as HTMLElement).dataset.slotBg) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const mins = startHour * 60 + Math.floor(((e.clientY - rect.top) / HOUR_PX) * 2) * 30;
                    const start = atLocalTime(d, `${Math.floor(mins / 60)}:${mins % 60}`, tz);
                    setMenu({ start, x: e.clientX, y: e.clientY });
                  }}
                >
                  {hours.map(h => <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-ink-100 dark:border-ink-800" style={{ top: (h - startHour) * HOUR_PX }} />)}
                  {ranges.map((r, i) => (
                    <div key={i} data-slot-bg="1" className="absolute inset-x-0 bg-emerald-50 dark:bg-emerald-500/[0.07]" style={{ top: top(hhmmToMinutes(r.start)), height: top(hhmmToMinutes(r.end)) - top(hhmmToMinutes(r.start)) }} />
                  ))}
                  {d === today && minutesInDay(now, tz) >= startHour * 60 && minutesInDay(now, tz) <= endHour * 60 && (
                    <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-red-500" style={{ top: top(minutesInDay(now, tz)) }}>
                      <span className="absolute -left-1 -top-[5px] size-2 rounded-full bg-red-500" />
                    </div>
                  )}
                  {dayBookings.map(b => {
                    const startMin = b.startAt <= dayStart ? startHour * 60 : Math.max(startHour * 60, minutesInDay(b.startAt, tz));
                    const endMin = b.endAt >= dayEnd ? endHour * 60 : Math.min(endHour * 60, minutesInDay(b.endAt, tz));
                    return <EventBlock key={b.id} booking={b} tz={tz} top={top(startMin)} height={Math.max(22, ((endMin - startMin) / 60) * HOUR_PX - 2)} onOpen={() => navigate(`/instructor/bookings/${b.id}`)} />;
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          <div className="fixed z-50 w-56 animate-slide-up rounded-2xl border border-ink-200 bg-white p-1.5 shadow-lift dark:border-ink-700 dark:bg-ink-900" style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 140) }}>
            <p className="px-3 py-2 text-xs font-bold text-ink-500">{formatInZone(menu.start, { weekday: 'short', day: 'numeric', month: 'short' }, tz)} · {formatTime(menu.start, tz)}</p>
            <button className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold hover:bg-ink-100 dark:hover:bg-ink-800" onClick={() => navigate(`/instructor/propose?start=${encodeURIComponent(menu.start.toISOString())}`)}>
              <Send className="size-4" />Propose a lesson here
            </button>
            <button className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold hover:bg-ink-100 dark:hover:bg-ink-800" onClick={() => { setEventDialog({ mode: 'open', start: menu.start }); setMenu(null); }}>
              <CalendarPlus className="size-4" />Open extra hours here
            </button>
            <button className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold hover:bg-ink-100 dark:hover:bg-ink-800" onClick={() => { setEventDialog({ mode: 'event', start: menu.start }); setMenu(null); }}>
              <Lock className="size-4" />Block this time
            </button>
          </div>
        </>
      )}
      {eventDialog && <EventModal key={`${eventDialog.mode}-${eventDialog.start.toISOString()}`} open mode={eventDialog.mode} initialStart={eventDialog.start} timeZone={tz} onClose={() => setEventDialog(null)} />}
    </>
  );
}

function EventBlock({ booking: b, tz, top, height, onOpen }: { booking: Booking; tz: string; top: number; height: number; onOpen: () => void }) {
  const style = b.kind === 'open'
    ? 'border border-dashed border-emerald-500 bg-emerald-50/80 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200'
    : b.kind === 'event'
    ? 'bg-ink-200 text-ink-700 dark:bg-ink-700 dark:text-ink-200'
    : b.status === 'proposed' ? 'border border-dashed border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200'
      : b.status === 'cancelled' ? 'bg-red-50 text-red-700 line-through opacity-70 dark:bg-red-500/10 dark:text-red-300'
        : b.status === 'late_cancel_requested' ? 'bg-red-500 text-white'
          : 'bg-brand-400 text-ink-950';
  return (
    <button
      onClick={e => { e.stopPropagation(); onOpen(); }}
      className={cx('absolute inset-x-1 z-[5] overflow-hidden rounded-lg px-2 py-1 text-left text-xs shadow-sm transition hover:z-20 hover:shadow-lift', style)}
      style={{ top: top + 1, height }}
    >
      <p className="truncate font-bold">{b.kind === 'lesson' ? b.learnerName : b.title}</p>
      {height > 34 && <p className="truncate opacity-80">{formatTime(b.startAt, tz)} – {formatTime(b.endAt, tz)}</p>}
      {height > 52 && b.pickupLocation && <p className="truncate opacity-70">{b.pickupLocation.split(',')[0]}</p>}
    </button>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className={cx('size-3 rounded', className)} />{label}</span>;
}

function MenuButton({ icon, onClick, children }: { icon: React.ReactNode; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-semibold hover:bg-ink-100 dark:hover:bg-ink-800">
      {icon}{children}
    </button>
  );
}
