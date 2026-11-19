// Client Admin dashboard: what is happening across SafeLearners and what needs attention. Figures come
// from the adminDashboard server function, which only calculates the sections this administrator is
// allowed to see. Each administrator can reorder and hide sections; the layout is saved for them.
import { collection, doc, limit, orderBy, query, serverTimestamp, setDoc, where } from 'firebase/firestore';
import {
  AlertTriangle, ArrowDown, ArrowUp, BadgeCheck, CalendarCheck2, CalendarDays, CalendarX2, CheckCircle2, CircleDollarSign, Clock, Eye, EyeOff,
  GraduationCap, Landmark, LayoutGrid, MessageSquareText, Percent, RefreshCw, RotateCcw, UserPlus, Users, Wallet, Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FINANCE_TX, type FinanceTxType } from '@shared/finance';
import { useAuth } from '@/auth/AuthProvider';
import { ColumnChart, SplitBar, type Point } from '@/components/charts';
import { Badge, Button, Card, CardHeader, EmptyState, Input, PageHeader, Select, cx, formatMoney } from '@/components/ui';
import { api, errorMessage, type AdminDashboard, type DashDay } from '@/lib/api';
import { mapBooking, mapUser, toDate, useDoc, useQuery } from '@/lib/data';
import { PRESETS, addDays, dayOf, rangeFor, type Preset } from '@/lib/dateRange';
import { db } from '@/lib/firebase';
import { timeAgo } from '@/lib/format';

/** Every user the signed-in admin may see: Cybria sees all; client admins get learners and/or instructors per their access. */
export function useAllUsers() {
  const { isSuper, can } = useAuth();
  const seeL = !isSuper && can('learners'), seeI = !isSuper && can('instructors');
  const all = useQuery(isSuper ? query(collection(db, 'users')) : null, mapUser, `admin:users:all:${isSuper}`);
  const l = useQuery(seeL ? query(collection(db, 'users'), where('role', '==', 'learner')) : null, mapUser, `admin:users:learners:${seeL}`);
  const i = useQuery(seeI ? query(collection(db, 'users'), where('role', '==', 'instructor')) : null, mapUser, `admin:users:instructors:${seeI}`);
  const data = useMemo(() => (isSuper ? all.data : [...l.data, ...i.data]), [isSuper, all.data, l.data, i.data]);
  return { data, loading: isSuper ? all.loading : l.loading || i.loading, error: all.error ?? l.error ?? i.error };
}

export function useAllBookings() {
  const { can } = useAuth();
  const see = can('bookings');
  const live = useQuery(see ? query(collection(db, 'bookings')) : null, mapBooking, `admin:bookings:${see}`);
  const data = useMemo(() => [...live.data].sort((a, b) => b.startAt.getTime() - a.startAt.getTime()), [live.data]);
  return { ...live, data };
}

// ---------- Layout preferences ----------

type WidgetId = 'summary' | 'attention' | 'today' | 'analytics' | 'people' | 'finance' | 'activity' | 'feedback' | 'quick';
const DEFAULT_ORDER: WidgetId[] = ['summary', 'attention', 'today', 'analytics', 'people', 'finance', 'activity', 'feedback', 'quick'];
const WIDGET_TITLE: Record<WidgetId, string> = {
  summary: 'Overview', attention: 'Needs your attention', today: 'Today’s operations', analytics: 'Booking and lesson analytics',
  people: 'Learner and instructor insights', finance: 'Financial overview', activity: 'Recent activity', feedback: 'Feedback & support requests', quick: 'Quick actions',
};
interface Layout { order: WidgetId[]; hidden: WidgetId[] }

function useLayout() {
  const { user } = useAuth();
  const ref = user ? doc(db, 'adminPrefs', user.uid) : null;
  const { data } = useDoc(ref, (_, d) => d as { dashboard?: Partial<Layout> }, [user?.uid]);
  const saved = data?.dashboard;
  const layout: Layout = useMemo(() => {
    const order = (saved?.order ?? []).filter((w): w is WidgetId => DEFAULT_ORDER.includes(w as WidgetId));
    return { order: [...order, ...DEFAULT_ORDER.filter(w => !order.includes(w))], hidden: (saved?.hidden ?? []).filter((w): w is WidgetId => DEFAULT_ORDER.includes(w as WidgetId)) };
  }, [saved]);
  const save = (next: Layout | null) => ref && setDoc(ref, { dashboard: next ?? { order: DEFAULT_ORDER, hidden: [] }, updatedAt: serverTimestamp() }, { merge: true }).catch(() => undefined);
  return { layout, save };
}

// ---------- Building blocks ----------

const n = (v: number | undefined | null) => (v === undefined || v === null ? '—' : v.toLocaleString('en-AU'));
const fmtTime = (iso: string) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const fmtWhen = (iso: string) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'slate'> = { confirmed: 'blue', completed: 'green', cancelled: 'red', proposed: 'amber', late_cancel_requested: 'amber' };
const STATUS_LABEL: Record<string, string> = { confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', proposed: 'Proposed', late_cancel_requested: 'Late-cancel request', declined: 'Declined', withdrawn: 'Withdrawn', expired: 'Expired' };

function Tile({ label, value, sub, to, href, icon, tone }: { label: string; value: ReactNode; sub?: ReactNode; to?: string; href?: string; icon: ReactNode; tone?: 'warn' | 'bad' }) {
  const cls = cx('group block min-w-0 rounded-2xl border bg-white p-3 shadow-card sm:p-4 transition hover:-translate-y-0.5 hover:shadow-md dark:bg-ink-900',
    tone === 'bad' ? 'border-red-300 dark:border-red-500/40' : tone === 'warn' ? 'border-amber-300 dark:border-amber-500/40' : 'border-ink-200/70 dark:border-ink-800');
  const body = (
    <>
      <p className="flex items-center justify-between text-xs font-semibold text-ink-500"><span>{label}</span><span className="text-ink-400 group-hover:text-ink-600">{icon}</span></p>
      <p className="mt-1.5 truncate text-xl font-extrabold tracking-tight text-ink-950 sm:text-2xl dark:text-white">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-500">{sub}</p>}
    </>
  );
  return href ? <a href={href} className={cls}>{body}</a> : <Link to={to!} className={cls}>{body}</Link>;
}
const Grid = ({ children }: { children: ReactNode }) => <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">{children}</div>;
const Mini = ({ label, value, to }: { label: string; value: ReactNode; to: string }) => (
  <Link to={to} className="rounded-xl border border-ink-200 px-3 py-2 hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800/60">
    <p className="text-xs text-ink-500">{label}</p><p className="text-lg font-extrabold">{value}</p>
  </Link>
);

/** Days for short periods; weeks (starting Monday) beyond two months, so columns stay readable. */
function toPoints(series: DashDay[]): Point[] {
  const day = (k: string) => new Date(`${k}T12:00:00Z`);
  const short = (k: string) => day(k).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  if (series.length <= 62) return series.map(s => ({ label: short(s.day), long: day(s.day).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }), values: { ...s } as unknown as Record<string, number> }));
  const weeks: Point[] = [];
  series.forEach((s, i) => {
    if (i === 0 || day(s.day).getUTCDay() === 1) weeks.push({ label: short(s.day), long: `Week from ${short(s.day)}`, values: { booked: 0, completed: 0, cancelled: 0, upcoming: 0, other: 0 } });
    const w = weeks.at(-1)!.values;
    (['booked', 'completed', 'cancelled', 'upcoming', 'other'] as const).forEach(k => { w[k] += s[k]; });
  });
  return weeks;
}

// ---------- Page ----------

export function AdminOverview() {
  const { can, profile } = useAuth();
  const [preset, setPreset] = useState<Preset>('30d');
  const today = dayOf(new Date());
  const [custom, setCustom] = useState({ from: addDays(today, -29), to: today });
  const range = rangeFor(preset, custom);
  const [d, setD] = useState<AdminDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [allActivity, setAllActivity] = useState(false);
  const { layout, save } = useLayout();
  // Feedback and support requests sent from the app (kept from the previous overview).
  const { data: feedback } = useQuery(
    query(collection(db, 'feedback'), orderBy('createdAt', 'desc'), limit(10)),
    (id, x) => ({ id, name: x.name as string, role: x.role as string, topic: x.topic as string, message: x.message as string, createdAt: toDate(x.createdAt) }),
    'admin:feedback',
  );

  const load = async () => {
    setBusy(true); setError(null);
    try { setD(await api.adminDashboard({ from: range.from, to: range.to })); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [preset, custom.from, custom.to]);

  const period = `when=period&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  const L = d?.lessons, P = d?.people, F = d?.finance;
  const pendingTotal = d?.pending.reduce((s, p) => s + p.count, 0) ?? 0;

  // Sections render only when the server returned their data (i.e. the admin has access).
  const widgets: Partial<Record<WidgetId, ReactNode>> = {
    summary: d && (P || L || F) ? (
      <Grid>
        {P?.learners && <Tile label="Total learners" value={n(P.learners.total)} sub={`${P.learners.new} new in period`} to="/admin/users?role=learner" icon={<GraduationCap className="size-4" />} />}
        {P?.learners && <Tile label="Active learners" value={n(P.learners.active)} sub={`${P.learners.inactive} suspended`} to="/admin/users?role=learner&status=active" icon={<GraduationCap className="size-4" />} />}
        {P?.instructors && <Tile label="Total instructors" value={n(P.instructors.total)} sub={`${P.instructors.new} new in period`} to="/admin/users?role=instructor" icon={<Users className="size-4" />} />}
        {P?.instructors && <Tile label="Active instructors" value={n(P.instructors.active)} sub="Approved and not suspended" to="/admin/users?role=instructor&status=active" icon={<Users className="size-4" />} />}
        {P?.instructors && <Tile label="Pending instructor approvals" value={n(P.instructors.approval.pending_review)} tone={P.instructors.approval.pending_review ? 'warn' : undefined} to="/admin/verifications?tab=pending_review" icon={<BadgeCheck className="size-4" />} />}
        {L && <Tile label="Total bookings" value={n(L.total)} sub={`${L.inPeriod} lessons in period`} to="/admin/bookings" icon={<CalendarDays className="size-4" />} />}
        {L && <Tile label="Upcoming lessons" value={n(L.upcoming)} to="/admin/bookings?when=upcoming" icon={<Clock className="size-4" />} />}
        {L && <Tile label="Completed lessons" value={n(L.completed)} sub={range.label} to={`/admin/bookings?status=completed&${period}`} icon={<CalendarCheck2 className="size-4" />} />}
        {L && <Tile label="Cancelled lessons" value={n(L.cancelled)} sub={range.label} to={`/admin/bookings?status=cancelled&${period}`} icon={<CalendarX2 className="size-4" />} />}
        {L && <Tile label="Pending bookings" value={n(L.pending)} sub={`${L.proposed} proposed · ${L.lateCancel} late-cancel`} tone={L.pending ? 'warn' : undefined} to="/admin/bookings?status=pending" icon={<Clock className="size-4" />} />}
        {F?.payments !== null && F?.payments !== undefined && <Tile label="Payments recorded" value={formatMoney(F.payments)} sub={F.financeEnabled ? range.label : 'Finance records are switched off'} to="/admin/finance?tab=transactions" icon={<CircleDollarSign className="size-4" />} />}
        {F?.outstanding && <Tile label="Outstanding payments" value={formatMoney(F.outstanding.amount)} sub={`${F.outstanding.count} unpaid invoice(s)`} tone={F.outstanding.count ? 'warn' : undefined} to="/admin/finance?tab=invoices" icon={<Landmark className="size-4" />} />}
        {F?.commission && <Tile label="Platform commission" value={formatMoney(F.commission.commission)} sub={`${range.label} · ${F.commission.lessons} lesson(s)`} to="/admin/settings" icon={<Percent className="size-4" />} />}
        <Tile label="Pending admin actions" value={n(pendingTotal)} tone={pendingTotal ? 'warn' : undefined} sub={pendingTotal ? 'See Needs your attention' : 'Nothing waiting'} href="#attention" icon={<AlertTriangle className="size-4" />} />
      </Grid>
    ) : null,

    attention: d ? (
      <Card id="attention">
        <CardHeader title={<span className="flex items-center gap-2"><AlertTriangle className="size-5 text-amber-500" />Needs your attention</span>} subtitle="Only items waiting for an administrator. Click one to open it." />
        {d.pending.length === 0 ? <EmptyState icon={<CheckCircle2 className="size-6 text-emerald-500" />} title="All clear" body="Nothing is waiting for an administrator right now." /> : (
          <ul className="divide-y divide-ink-100 dark:divide-ink-800">
            {d.pending.map(p => (
              <li key={p.key}>
                <Link to={p.to} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-ink-50 dark:hover:bg-ink-800/50">
                  <span className="flex items-center gap-3 text-sm font-semibold">
                    <span className={cx('grid size-8 place-items-center rounded-full text-sm font-extrabold', p.tone === 'bad' ? 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300')}>{p.count}</span>
                    {p.label}
                  </span>
                  <span className="text-xs font-bold text-ink-500">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    ) : null,

    today: L ? (
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><CalendarDays className="size-5" />Today’s operations</span>} subtitle={new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Australia/Sydney' })} />
        <div className="grid grid-cols-2 gap-2 px-5 sm:grid-cols-5">
          <Mini label="Scheduled today" value={L.today.scheduled} to="/admin/bookings?when=today" />
          <Mini label="In progress now" value={L.today.ongoing} to="/admin/bookings?when=today" />
          <Mini label="Still to start" value={L.today.upcoming} to="/admin/bookings?when=today&status=confirmed" />
          <Mini label="Completed" value={L.today.completed} to="/admin/bookings?when=today&status=completed" />
          <Mini label="Cancelled" value={L.today.cancelled} to="/admin/bookings?when=today&status=cancelled" />
        </div>
        <div className="grid gap-5 p-5 lg:grid-cols-[3fr_2fr]">
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-bold">Today’s lessons</h3>
            {L.today.lessons.length === 0 ? <p className="rounded-xl bg-ink-50 p-4 text-sm text-ink-500 dark:bg-ink-800/40">No lessons today.</p> : (
              <div className="overflow-x-auto rounded-xl border border-ink-200 dark:border-ink-700">
                <table className="w-full text-sm">
                  <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500 dark:bg-ink-800/60"><tr><th className="px-3 py-2">Time</th><th className="px-3 py-2">Learner</th><th className="px-3 py-2">Instructor</th><th className="px-3 py-2">Status</th></tr></thead>
                  <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                    {L.today.lessons.map(l => (
                      <tr key={l.id} className="hover:bg-ink-50 dark:hover:bg-ink-800/40">
                        <td className="whitespace-nowrap px-3 py-2"><Link to={`/admin/bookings?when=today&q=${encodeURIComponent(l.ref ?? l.learnerName ?? '')}`} className="font-semibold underline">{fmtTime(l.startAt)}–{fmtTime(l.endAt)}</Link></td>
                        <td className="px-3 py-2">{l.learnerName ?? '—'}</td>
                        <td className="px-3 py-2">{l.instructorName ?? '—'}</td>
                        <td className="px-3 py-2">{l.ongoing ? <Badge tone="green">In progress</Badge> : <Badge tone={STATUS_TONE[l.status] ?? 'slate'}>{STATUS_LABEL[l.status] ?? l.status}</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h3 className="mb-2 mt-5 flex items-center gap-2 text-sm font-bold">Scheduling conflicts {L.conflictCount > 0 && <Badge tone="red">{L.conflictCount}</Badge>}</h3>
            {L.conflicts.length === 0 ? <p className="text-sm text-ink-500">No overlapping bookings in the next 60 days.</p> : (
              <ul className="space-y-2">
                {L.conflicts.map(c => (
                  <li key={`${c.first.id}-${c.second.id}`} className="rounded-xl border border-red-200 bg-red-50/60 p-3 text-sm dark:border-red-500/30 dark:bg-red-500/5">
                    <p className="font-semibold">{c.instructorName ?? 'Instructor'}: {fmtWhen(c.first.startAt)}</p>
                    <p className="text-ink-600 dark:text-ink-300">{c.first.ref ?? 'Lesson'} ({c.first.learnerName ?? 'learner'}) overlaps {c.second.kind === 'event' ? `personal time “${c.second.title ?? 'Busy'}”` : `${c.second.ref ?? 'another lesson'} (${c.second.learnerName ?? 'learner'})`} at {fmtTime(c.second.startAt)}.</p>
                    <Link to={`/admin/bookings?q=${encodeURIComponent(c.first.ref ?? c.instructorName ?? '')}`} className="text-xs font-bold underline">Open booking</Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-bold">Instructor availability today</h3>
            {!L.availability ? <p className="text-sm text-ink-500">Needs Instructor Management access.</p> : L.availability.length === 0 ? <p className="text-sm text-ink-500">No approved instructors yet.</p> : (
              <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200 dark:divide-ink-800 dark:border-ink-700">
                {L.availability.slice(0, 10).map(a => (
                  <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <Link to={`/admin/users/${a.id}`} className="font-semibold hover:underline">{a.name}</Link>
                    <span className="text-right text-xs text-ink-500">
                      {a.hours.length ? a.hours.join(', ') : a.extraHours ? 'Extra hours only' : 'Not working today'}{a.extraHours && a.hours.length ? ` + ${a.extraHours} extra` : ''}
                      <br /><b className="text-ink-800 dark:text-ink-200">{a.lessonsToday} lesson(s)</b>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>
    ) : null,

    analytics: L ? (
      <Card>
        <CardHeader title="Booking and lesson analytics" subtitle={`${range.label}. Lesson activity uses the lesson date; new bookings use the date they were made.`} />
        <div className="grid gap-6 p-5 xl:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-1 text-sm font-bold">Lesson activity</h3>
            <ColumnChart title="Lesson activity" points={toPoints(L.series)} series={[
              { key: 'completed', label: 'Completed', slot: 1 }, { key: 'cancelled', label: 'Cancelled', slot: 2 },
              { key: 'upcoming', label: 'Upcoming', slot: 3 }, { key: 'other', label: 'Other (proposed, past unconfirmed)', slot: 4 },
            ]} />
          </div>
          <div>
            <h3 className="mb-1 text-sm font-bold">New bookings made</h3>
            <ColumnChart title="New bookings made" points={toPoints(L.series)} series={[{ key: 'booked', label: 'Bookings made', slot: 1 }]} />
            <p className="mt-2 text-xs text-ink-500">{L.series.reduce((s, x) => s + x.booked, 0)} booking(s) made in this period.</p>
          </div>
        </div>
      </Card>
    ) : null,

    people: P ? (
      <Card>
        <CardHeader title="Learner and instructor insights" subtitle={range.label} />
        <div className="grid gap-6 p-5 lg:grid-cols-3">
          {P.learners && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold">Learners</h3>
              <Link to="/admin/users?role=learner" className="block text-sm"><b className="text-2xl">{P.learners.new}</b> new registration(s)</Link>
              <SplitBar parts={[{ label: 'Active', value: P.learners.active, slot: 1 }, { label: 'Suspended', value: P.learners.inactive, slot: 2 }]} />
            </div>
          )}
          {P.instructors && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold">Instructors</h3>
              <Link to="/admin/users?role=instructor" className="block text-sm"><b className="text-2xl">{P.instructors.new}</b> new registration(s)</Link>
              <SplitBar parts={[{ label: 'Approved', value: P.instructors.approval.verified, slot: 1 }, { label: 'Awaiting approval', value: P.instructors.approval.pending_review, slot: 4 },
                { label: 'Needs changes', value: P.instructors.approval.rejected, slot: 2 }, { label: 'Not submitted', value: P.instructors.approval.not_submitted, slot: 3 }]} />
              <Link to="/admin/verifications?tab=pending_review" className="text-xs font-bold underline">Review approvals</Link>
            </div>
          )}
          {L && (
            <div className="min-w-0 overflow-x-auto">
              <h3 className="mb-2 text-sm font-bold">Instructor booking activity</h3>
              {L.instructorActivity.length === 0 ? <p className="text-sm text-ink-500">No lessons in this period.</p> : (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase text-ink-500"><tr><th className="py-1">Instructor</th><th className="py-1 text-right">Lessons</th><th className="py-1 text-right">Done</th><th className="py-1 text-right">Cancelled</th></tr></thead>
                  <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                    {L.instructorActivity.map(a => <tr key={a.id}><td className="py-1.5">{P.instructors ? <Link to={`/admin/users/${a.id}`} className="hover:underline">{a.name}</Link> : a.name}</td><td className="py-1.5 text-right tabular-nums">{a.lessons}</td><td className="py-1.5 text-right tabular-nums">{a.completed}</td><td className="py-1.5 text-right tabular-nums">{a.cancelled}</td></tr>)}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </Card>
    ) : null,

    finance: F ? (
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Landmark className="size-5" />Financial overview</span>} subtitle={F.financeEnabled ? range.label : `${range.label} · finance records are switched off, so payment figures may be incomplete`} />
        <div className="grid gap-3 px-5 pb-2 sm:grid-cols-2 lg:grid-cols-4">
          {F.payments !== null && <Mini label="Payments received" value={formatMoney(F.payments)} to="/admin/finance?tab=transactions" />}
          {F.outstanding && <Mini label={`Outstanding (${F.outstanding.count} invoices)`} value={formatMoney(F.outstanding.amount)} to="/admin/finance?tab=invoices" />}
          {F.wallet && <Mini label="Wallet credit added" value={formatMoney(F.wallet.credits)} to="/admin/finance?tab=customers" />}
          {F.wallet && <Mini label="Wallet credit used on lessons" value={formatMoney(F.wallet.spent)} to="/admin/finance?tab=customers" />}
          {F.commission && <Mini label="Instructor earnings" value={formatMoney(F.commission.earnings)} to="/admin/settings" />}
          {F.commission && <Mini label="Platform commission" value={formatMoney(F.commission.commission)} to="/admin/settings" />}
          {F.refunds && <Mini label={`Refunds pending (${F.refunds.awaitingApproval + F.refunds.awaitingTransfer})`} value={formatMoney(F.refunds.amount)} to="/admin/finance?tab=refunds" />}
          {F.refunds && <Mini label="Refunds paid" value={formatMoney(F.refunds.completed)} to="/admin/finance?tab=refunds" />}
        </div>
        <p className="px-5 text-xs text-ink-500">Amounts in AUD.</p>
        {F.recent && (
          <div className="p-5">
            <h3 className="mb-2 text-sm font-bold">Recent financial transactions</h3>
            {F.recent.length === 0 ? <p className="text-sm text-ink-500">No transactions in this period.</p> : (
              <div className="overflow-x-auto rounded-xl border border-ink-200 dark:border-ink-700">
                <table className="w-full text-sm">
                  <thead className="bg-ink-50 text-left text-xs uppercase text-ink-500 dark:bg-ink-800/60"><tr><th className="px-3 py-2">When</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Details</th><th className="px-3 py-2 text-right">Amount</th></tr></thead>
                  <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                    {F.recent.map(t => <tr key={t.id}><td className="whitespace-nowrap px-3 py-2">{fmtWhen(t.at)}</td><td className="px-3 py-2">{FINANCE_TX[t.type as FinanceTxType]?.label ?? t.type}</td><td className="px-3 py-2 text-ink-600 dark:text-ink-300">{t.description ?? '—'}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(Math.abs(t.amount))}</td></tr>)}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>
    ) : null,

    activity: d ? (
      <Card>
        <CardHeader title="Recent activity" subtitle={range.label} />
        {d.activity.length === 0 ? <EmptyState title="No activity in this period" /> : (
          <ul className="divide-y divide-ink-100 dark:divide-ink-800">
            {(allActivity ? d.activity : d.activity.slice(0, 12)).map((a, i) => (
              <li key={`${a.at}-${i}`}>
                <Link to={a.to} className="flex items-start justify-between gap-3 px-5 py-2.5 hover:bg-ink-50 dark:hover:bg-ink-800/50">
                  <span className="text-sm"><b>{a.title}</b><span className="block text-xs text-ink-500">{a.detail}</span></span>
                  <span className="whitespace-nowrap text-xs text-ink-500">{fmtWhen(a.at)}</span>
                </Link>
              </li>
            ))}
            {d.activity.length > 12 && (
              <li className="px-5 py-2"><Button size="sm" variant="ghost" onClick={() => setAllActivity(v => !v)}>{allActivity ? 'Show fewer' : `Show all ${d.activity.length}`}</Button></li>
            )}
          </ul>
        )}
      </Card>
    ) : null,

    feedback: (
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><MessageSquareText className="size-4" />Feedback & support requests</span>} subtitle="Latest 10 messages sent from the app" />
        {feedback.length === 0 ? <EmptyState title="No feedback yet" /> : (
          <ul className="divide-y divide-ink-100 dark:divide-ink-800">
            {feedback.map(f => (
              <li key={f.id} className="px-5 py-3">
                <p className="text-xs font-semibold uppercase text-ink-400">{f.topic} · {f.name} ({f.role}){f.createdAt ? ` · ${timeAgo(f.createdAt)}` : ''}</p>
                <p className="mt-1 whitespace-pre-line text-sm">{f.message}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    ),

    quick: (() => {
      const actions = [
        can('bookings') && { to: '/admin/bookings', label: 'View bookings', icon: <CalendarDays className="size-4" /> },
        can('bookings') && { to: '/admin/bookings?when=today', label: 'Today’s lessons', icon: <Clock className="size-4" /> },
        can('instructors') && { to: '/admin/verifications?tab=pending_review', label: 'Instructor approvals', icon: <BadgeCheck className="size-4" /> },
        can('instructors') && { to: '/admin/users?role=instructor', label: 'Manage instructors', icon: <Users className="size-4" /> },
        can('learners') && { to: '/admin/users?role=learner', label: 'Manage learners', icon: <UserPlus className="size-4" /> },
        (can('finance') || can('invoices') || can('wallet')) && { to: '/admin/finance', label: 'View payments', icon: <Wallet className="size-4" /> },
        can('commission') && { to: '/admin/settings', label: 'Commission management', icon: <Percent className="size-4" /> },
      ].filter(Boolean) as { to: string; label: string; icon: ReactNode }[];
      return actions.length ? (
        <Card className="p-5">
          <h2 className="mb-3 flex items-center gap-2 font-bold"><Zap className="size-4" />Quick actions</h2>
          <div className="flex flex-wrap gap-2">{actions.map(a => <Link key={a.to} to={a.to} className="inline-flex items-center gap-2 rounded-xl border border-ink-200 px-3 py-2 text-sm font-semibold hover:bg-ink-50 dark:border-ink-700 dark:hover:bg-ink-800">{a.icon}{a.label}</Link>)}</div>
        </Card>
      ) : null;
    })(),
  };

  const available = layout.order.filter(w => widgets[w]);
  const move = (w: WidgetId, by: -1 | 1) => {
    const order = [...layout.order]; const i = order.indexOf(w), j = i + by;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    void save({ ...layout, order });
  };
  const toggle = (w: WidgetId) => void save({ ...layout, hidden: layout.hidden.includes(w) ? layout.hidden.filter(x => x !== w) : [...layout.hidden, w] });

  return (
    <>
      <PageHeader title={`Dashboard${profile?.firstName ? ` · ${profile.firstName}` : ''}`} subtitle={`${range.label} · live data${d ? `, updated ${fmtTime(d.generatedAt)}` : ''}`}
        actions={<div className="flex gap-2">
          <Button variant={editing ? 'primary' : 'secondary'} icon={<LayoutGrid className="size-4" />} onClick={() => setEditing(e => !e)}>{editing ? 'Done' : 'Customise'}</Button>
          <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy} onClick={load}>Refresh</Button>
        </div>} />
      <Card className="mb-5 flex flex-wrap items-end gap-3 p-4">
        <Select label="Period" value={preset} onChange={e => setPreset(e.target.value as Preset)} wrapperClassName="w-48">
          {PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </Select>
        {preset === 'custom' && <>
          <Input label="From" type="date" value={custom.from} max={custom.to} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} />
          <Input label="To" type="date" value={custom.to} min={custom.from} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} />
        </>}
        {editing && <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => void save(null)}>Restore default layout</Button>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </Card>
      {!d && !error ? <Card><EmptyState title="Loading dashboard…" /></Card> : (
        <div className="space-y-5">
          {available.map((w, idx) => {
            const hidden = layout.hidden.includes(w);
            if (hidden && !editing) return null;
            return (
              <section key={w} aria-label={WIDGET_TITLE[w]} className={cx(editing && 'rounded-2xl border-2 border-dashed border-ink-300 p-2 dark:border-ink-700', hidden && 'opacity-60')}>
                {editing && (
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
                    <p className="text-sm font-bold">{WIDGET_TITLE[w]}{hidden && <Badge className="ml-2">Hidden</Badge>}</p>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" icon={<ArrowUp className="size-4" />} disabled={idx === 0} onClick={() => move(w, -1)} aria-label={`Move ${WIDGET_TITLE[w]} up`}>Up</Button>
                      <Button size="sm" variant="ghost" icon={<ArrowDown className="size-4" />} disabled={idx === available.length - 1} onClick={() => move(w, 1)} aria-label={`Move ${WIDGET_TITLE[w]} down`}>Down</Button>
                      <Button size="sm" variant="secondary" icon={hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />} onClick={() => toggle(w)}>{hidden ? 'Show' : 'Hide'}</Button>
                    </div>
                  </div>
                )}
                {!hidden && widgets[w]}
              </section>
            );
          })}
          {available.length === 0 && <Card><EmptyState title="Nothing to show yet" body="Your access doesn’t include any dashboard information. Cybria manages your access." /></Card>}
        </div>
      )}
    </>
  );
}
