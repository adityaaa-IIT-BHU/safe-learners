import { Table2, ChartColumn } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PLATFORM_FEE_RATE, displayRef, type Booking } from '@shared/domain';
import { DEFAULT_TIMEZONE, formatDate, toZoned } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { lessonLabel } from '@/components/booking';
import { Button, Card, CardHeader, EmptyState, PageHeader, Stat, cx, formatMoney } from '@/components/ui';
import { useBookings } from '@/lib/data';

// Validated single-series bar colour (passes contrast/lightness on both light and dark surfaces).
const BAR = '#b38100';

const net = (b: Booking) => (b.price ?? 0) * (1 - PLATFORM_FEE_RATE);

export function Reports() {
  const me = useProfile();
  const { uid } = useAuth();
  const tz = me.timezone ?? DEFAULT_TIMEZONE;
  const { data: bookings } = useBookings('instructorId', uid);
  const [asTable, setAsTable] = useState(false);

  const r = useMemo(() => {
    const now = new Date();
    const lessons = bookings.filter(b => b.kind === 'lesson');
    const completed = lessons.filter(b => b.status === 'completed' || (b.status === 'confirmed' && b.endAt < now));
    const z = toZoned(now, tz);
    const fyStartYear = z.month >= 7 ? z.year : z.year - 1; // Australian FY starts 1 July
    const inMonth = (b: Booking, y: number, m: number) => { const bz = toZoned(b.startAt, tz); return bz.year === y && bz.month === m; };
    const inFy = (b: Booking) => { const bz = toZoned(b.startAt, tz); return bz.year * 100 + bz.month >= fyStartYear * 100 + 7 && bz.year * 100 + bz.month <= (fyStartYear + 1) * 100 + 6; };

    const months = Array.from({ length: 6 }, (_, i) => {
      let y = z.year;
      let m = z.month - (5 - i);
      while (m < 1) { m += 12; y -= 1; }
      const list = completed.filter(b => inMonth(b, y, m));
      return {
        key: `${y}-${m}`,
        label: new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-AU', { month: 'short', timeZone: 'UTC' }),
        long: new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
        value: list.reduce((s, b) => s + net(b), 0),
        lessons: list.length,
      };
    });

    const since90 = now.getTime() - 90 * 86_400_000;
    const recent = lessons.filter(b => b.startAt.getTime() >= since90 && ['completed', 'confirmed', 'cancelled'].includes(b.status));
    const cancelledByMe = recent.filter(b => b.status === 'cancelled' && b.cancelledBy === 'instructor' && !b.rescheduledTo).length;
    const learnerIds = new Set(completed.map(b => b.learnerId));
    const hours = completed.reduce((s, b) => s + (b.endAt.getTime() - b.startAt.getTime()) / 3_600_000, 0);

    return {
      months,
      thisMonth: months.at(-1)!.value,
      fy: completed.filter(inFy).reduce((s, b) => s + net(b), 0),
      fyLabel: `FY ${fyStartYear}/${String(fyStartYear + 1).slice(2)}`,
      cancelRate: recent.length ? (cancelledByMe / recent.length) * 100 : 0,
      hoursPerLearner: learnerIds.size ? hours / learnerIds.size : 0,
      upcomingValue: lessons.filter(b => b.status === 'confirmed' && b.startAt > now).reduce((s, b) => s + net(b), 0),
      recentCompleted: [...completed].sort((a, b) => b.startAt.getTime() - a.startAt.getTime()).slice(0, 15),
    };
  }, [bookings, tz]);

  return (
    <>
      <PageHeader title="Reports" subtitle={`Earnings are shown after the ${PLATFORM_FEE_RATE * 100}% Safe Learners service fee.`} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="This month" value={formatMoney(r.thisMonth)} />
        <Stat label={r.fyLabel} value={formatMoney(r.fy)} sub="Financial year to date" />
        <Stat label="Booked ahead" value={formatMoney(r.upcomingValue)} sub="Confirmed future lessons" />
        <Stat label="Your cancellation rate" value={`${r.cancelRate.toFixed(1)}%`} sub={`Last 90 days · ${r.hoursPerLearner.toFixed(1)} hrs per learner`} />
      </div>

      <Card className="mt-6">
        <CardHeader
          title="Earnings by month"
          subtitle="Completed lessons, last 6 months"
          action={<Button size="sm" variant="ghost" icon={asTable ? <ChartColumn className="size-4" /> : <Table2 className="size-4" />} onClick={() => setAsTable(t => !t)}>{asTable ? 'Chart' : 'Table'}</Button>}
        />
        <div className="p-5">
          {asTable ? (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-ink-500"><th className="pb-2">Month</th><th className="pb-2 text-right">Lessons</th><th className="pb-2 text-right">Earnings</th></tr></thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {r.months.map(m => <tr key={m.key}><td className="py-2">{m.long}</td><td className="py-2 text-right">{m.lessons}</td><td className="py-2 text-right font-semibold">{formatMoney(m.value)}</td></tr>)}
              </tbody>
            </table>
          ) : <MonthlyBars months={r.months} />}
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Recent completed lessons" />
        {r.recentCompleted.length === 0 ? <EmptyState title="No completed lessons yet" body="Earnings appear here after each lesson finishes." /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead><tr className="border-b border-ink-100 text-left text-xs uppercase text-ink-500 dark:border-ink-800"><th className="px-5 py-2">Date</th><th className="px-5 py-2">Learner</th><th className="px-5 py-2">Lesson</th><th className="px-5 py-2 text-right">Price</th><th className="px-5 py-2 text-right">You earn</th></tr></thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {r.recentCompleted.map(b => (
                  <tr key={b.id} className="hover:bg-ink-50 dark:hover:bg-ink-800/50">
                    <td className="px-5 py-3"><Link to={`/instructor/bookings/${b.id}`} className="font-medium hover:underline">{formatDate(b.startAt, b.timezone)}</Link><span className="block font-mono text-xs text-ink-400">{displayRef(b)}</span></td>
                    <td className="px-5 py-3">{b.learnerName}</td>
                    <td className="px-5 py-3">{lessonLabel(b)}</td>
                    <td className="px-5 py-3 text-right">{formatMoney(b.price)}</td>
                    <td className="px-5 py-3 text-right font-semibold">{formatMoney(net(b))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function MonthlyBars({ months }: { months: { key: string; label: string; long: string; value: number; lessons: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...months.map(m => m.value), 1);
  // A rounded axis maximum so gridlines land on tidy values.
  const step = 10 ** Math.floor(Math.log10(max));
  const axisMax = Math.ceil(max / step) * step || 100;
  const ticks = [0, 0.5, 1].map(f => axisMax * f);
  const H = 200;

  return (
    <div className="relative">
      <div className="relative ml-12" style={{ height: H }}>
        {ticks.map(t => (
          <div key={t} className="absolute inset-x-0 border-t border-ink-100 dark:border-ink-800" style={{ bottom: (t / axisMax) * H }}>
            <span className="absolute -left-12 -translate-y-1/2 text-[11px] text-ink-400">{formatMoney(t)}</span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {months.map((m, i) => (
            <div
              key={m.key}
              className="relative flex h-full flex-1 cursor-default items-end justify-center"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              aria-label={`${m.long}: ${formatMoney(m.value)} from ${m.lessons} lessons`}
            >
              <div
                className={cx('w-full max-w-14 rounded-t-[4px] transition-opacity', hover !== null && hover !== i && 'opacity-50')}
                style={{ height: m.value ? Math.max(2, (m.value / axisMax) * H) : 0, background: BAR }}
              />
              {hover === i && (
                <div className="pointer-events-none absolute z-10 w-max rounded-xl border border-ink-200 bg-white px-3 py-2 text-xs shadow-lift dark:border-ink-700 dark:bg-ink-900" style={{ bottom: Math.min(H - 40, (m.value / axisMax) * H + 8) }}>
                  <p className="font-bold text-ink-900 dark:text-white">{m.long}</p>
                  <p className="text-ink-600 dark:text-ink-300">{formatMoney(m.value)} · {m.lessons} lesson{m.lessons === 1 ? '' : 's'}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="ml-12 mt-2 flex gap-[2px]">
        {months.map(m => <span key={m.key} className="flex-1 text-center text-xs font-medium text-ink-500">{m.label}</span>)}
      </div>
    </div>
  );
}
