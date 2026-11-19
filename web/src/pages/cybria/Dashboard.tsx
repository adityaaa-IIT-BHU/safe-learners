// Super Admin dashboard: platform-wide figures from live data, for a chosen period. Each figure opens
// the matching records.
import { AlertTriangle, BadgeCheck, CalendarDays, Landmark, Plug, RefreshCw, Users } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Input, PageHeader, Select, cx, formatMoney } from '@/components/ui';
import { api, errorMessage, type SuperDashboard } from '@/lib/api';

import { addDays, dayOf, rangeFor, type Preset } from '@/lib/dateRange';

function Stat({ label, value, to, tone, sub }: { label: string; value: ReactNode; to: string; tone?: 'warn' | 'bad'; sub?: string }) {
  return (
    <Link to={to} className={cx('block rounded-xl border bg-white p-4 transition hover:-translate-y-0.5 hover:shadow-md dark:bg-ink-900',
      tone === 'bad' ? 'border-red-300 dark:border-red-500/40' : tone === 'warn' ? 'border-amber-300 dark:border-amber-500/40' : 'border-ink-200 dark:border-ink-700')}>
      <p className="text-xs font-semibold text-ink-500">{label}</p>
      <p className="mt-1 text-2xl font-extrabold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-500">{sub}</p>}
    </Link>
  );
}
const Group = ({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) => (
  <section className="space-y-2"><h2 className="flex items-center gap-2 text-sm font-bold text-ink-600 dark:text-ink-300">{icon}{title}</h2><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div></section>
);

export function CybriaDashboard() {
  const [preset, setPreset] = useState<Preset>('30d');
  const today = dayOf(new Date());
  const [custom, setCustom] = useState({ from: addDays(today, -29), to: today });
  const [data, setData] = useState<SuperDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const range = rangeFor(preset, custom);
  const load = async () => {
    setBusy(true); setError(null);
    try { setData(await api.superDashboard({ from: range.from, to: range.to })); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [preset, custom.from, custom.to]);
  const d = data;
  const n = (v: number | undefined) => (v === undefined ? '…' : v.toLocaleString('en-AU'));
  const $ = (v: number | undefined) => (v === undefined ? '…' : formatMoney(v));
  const alerts = d ? d.alerts.documentJobsFailed + d.alerts.xeroJobsFailed + d.alerts.reconciliationOpen + d.alerts.financeSyncAttention : 0;

  return (
    <>
      <PageHeader title="Platform dashboard" subtitle={`${range.label} · live data. Lesson figures use the lesson date; money figures use the transaction date.`}
        actions={<Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy} onClick={load}>Refresh</Button>} />
      <Card className="mb-6 flex flex-wrap items-end gap-3 p-4">
        <Select label="Period" value={preset} onChange={e => setPreset(e.target.value as Preset)} wrapperClassName="w-48">
          <option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option>
          <option value="month">This month</option><option value="prevMonth">Previous month</option><option value="custom">Custom range</option>
        </Select>
        {preset === 'custom' && <><Input label="From" type="date" value={custom.from} max={custom.to} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))} /><Input label="To" type="date" value={custom.to} min={custom.from} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))} /></>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </Card>
      <div className="space-y-6">
        <Group title="People" icon={<Users className="size-4" />}>
          <Stat label="Learners" value={n(d?.users.learners)} sub={d ? `${d.users.learnersActive} active · ${d.users.learnersInactive} inactive` : undefined} to="/admin/users" />
          <Stat label="Instructors" value={n(d?.users.instructors)} sub={d ? `${d.users.instructorsActive} verified · ${d.users.instructorsSuspended} suspended` : undefined} to="/admin/users" />
          <Stat label="Pending instructor approvals" value={n(d?.users.instructorsPending)} tone={d?.users.instructorsPending ? 'warn' : undefined} to="/admin/verifications?tab=pending_review" />
          <Stat label="Suspended users" value={n(d?.users.suspended)} to="/admin/users" />
          <Stat label="Client administrators" value={n(d?.users.admins)} sub={d ? `${d.users.adminsActive} active` : undefined} to="/cybria/admins" />
        </Group>
        <Group title="Bookings and lessons" icon={<CalendarDays className="size-4" />}>
          <Stat label="Lessons in period" value={n(d?.bookings.inRange)} to="/admin/bookings" />
          <Stat label="Upcoming lessons" value={n(d?.bookings.upcoming)} to="/admin/bookings" />
          <Stat label="Completed (in period)" value={n(d?.bookings.completed)} to="/admin/bookings" />
          <Stat label="Cancelled (in period)" value={n(d?.bookings.cancelled)} to="/admin/bookings" />
          <Stat label="Pending (proposals and late-cancel requests)" value={n(d?.bookings.pending)} tone={d?.bookings.pending ? 'warn' : undefined} to="/admin/bookings" />
        </Group>
        <Group title="Money" icon={<Landmark className="size-4" />}>
          <Stat label="Wallet balances (all learners)" value={$(d?.finance.walletTotal)} to="/admin/finance?tab=customers" />
          <Stat label="Payments recorded (period)" value={$(d?.finance.paymentsRecorded)} sub={d && !d.finance.financeEnabled ? 'Finance records are switched off' : undefined} to="/admin/finance?tab=transactions" />
          <Stat label="Outstanding invoices" value={$(d?.finance.outstanding)} sub={d ? `${d.finance.outstandingCount} invoice(s)` : undefined} to="/admin/finance?tab=invoices" />
          <Stat label="Platform commission (period)" value={$(d?.finance.commission)} to="/cybria/commission" />
          <Stat label="Instructor earnings (period)" value={$(d?.finance.earnings)} to="/cybria/commission" />
          <Stat label="Pending refunds" value={n(d?.finance.pendingRefunds)} sub={d ? formatMoney(d.finance.pendingRefundAmount) : undefined} tone={d?.finance.pendingRefunds ? 'warn' : undefined} to="/admin/finance?tab=refunds" />
          <Stat label="Financial adjustments (period)" value={n(d?.finance.adjustments)} sub={d ? formatMoney(d.finance.adjustmentAmount) : undefined} to="/admin/finance?tab=transactions" />
        </Group>
        <Group title="Documents and notifications" icon={<BadgeCheck className="size-4" />}>
          <Stat label="Documents awaiting verification" value={n(d?.documents.awaiting)} tone={d?.documents.awaiting ? 'warn' : undefined} to="/cybria/documents?tab=documents" />
          <Stat label="Documents expiring soon" value={n(d?.documents.expiringSoon)} tone={d?.documents.expiringSoon ? 'warn' : undefined} to="/cybria/documents?tab=compliance" />
          <Stat label="Expired documents" value={n(d?.documents.expired)} tone={d?.documents.expired ? 'bad' : undefined} to="/cybria/documents?tab=compliance" />
          <Stat label="Reminder emails (period)" value={n(d?.notifications.total)} sub={d ? (d.notifications.emailConfigured ? `${d.notifications.sent} sent · ${d.notifications.failed} failed` : 'Email service not set up: recorded, not sent') : undefined} to="/cybria/documents?tab=compliance" />
        </Group>
        <Group title="Integrations and alerts" icon={<Plug className="size-4" />}>
          <Stat label="Xero" value={d ? (d.integrations.xero.connected ? 'Connected' : 'Not connected') : '…'} sub={d?.integrations.xero.organisation ? `${d.integrations.xero.organisation}${d.integrations.xero.demo ? ' (Demo)' : ''}` : undefined} to="/cybria/xero" />
          <Stat label="OCR" value={d ? (d.integrations.ocr.configured ? 'Configured' : 'Not configured') : '…'} to="/cybria/ocr" />
          <Stat label="Email service" value={d ? (d.integrations.email.configured ? 'Configured' : 'Not set up') : '…'} tone={d && !d.integrations.email.configured ? 'warn' : undefined} to="/cybria" />
          <Stat label="System alerts" value={d ? alerts : '…'} tone={alerts ? 'bad' : undefined} to="/cybria/xero"
            sub={d ? `${d.alerts.documentJobsFailed} document jobs failed · ${d.alerts.xeroJobsFailed} Xero jobs · ${d.alerts.reconciliationOpen} reconciliation · ${d.alerts.financeSyncAttention} finance sync` : undefined} />
        </Group>
        {d && alerts > 0 && <p className="flex items-center gap-2 text-sm text-red-700"><AlertTriangle className="size-4" />There are items needing attention; open System alerts.</p>}
        {d && <p className="text-xs text-ink-500">{/australiadrivingproj|localhost|127\.0\.0\.1/.test(window.location.host) && <Badge className="mr-2">Test environment</Badge>}Figures come from the live database each time you refresh.</p>}
      </div>
    </>
  );
}
