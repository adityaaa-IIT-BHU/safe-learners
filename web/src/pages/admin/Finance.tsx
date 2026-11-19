import { collection, doc, limit, orderBy, query } from 'firebase/firestore';
import { AlertTriangle, ArrowLeftRight, CheckCircle2, FileText, RefreshCw, RotateCcw, Scale, Search, Settings2, ShieldCheck, Undo2, Users as UsersIcon, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { FINANCE_TX, INVOICE_STATUS, REFUND_STATUS, SYNC_STATUS, missingSettings, money, settingsFrom, type AccountingSettings, type FinanceTxType } from '@shared/finance';
import { InvoiceDetail, InvoiceStatusBadge, RefundStatusBadge, SyncBadge, auDate } from '@/components/finance';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Modal, PageHeader, Select, Stat, Tabs, Textarea, cx, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { toDate, useDoc, useQuery } from '@/lib/data';
import { mapFinanceTx, mapInvoice, mapRefund, type FinanceTx, type InvoiceView, type RefundView } from '@/lib/finance';
import { db } from '@/lib/firebase';
import { useAllUsers } from './Overview';

type Tab = 'overview' | 'invoices' | 'transactions' | 'refunds' | 'customers' | 'reconciliation' | 'audit' | 'settings';

const sydneyToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
const when = (d?: Date) => (d ? d.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function useFinanceData() {
  const invoices = useQuery(query(collection(db, 'invoices'), orderBy('createdAt', 'desc'), limit(1000)), mapInvoice, 'admin:invoices');
  const txs = useQuery(query(collection(db, 'financeTransactions'), orderBy('createdMs', 'desc'), limit(1000)), mapFinanceTx, 'admin:financeTx');
  const refunds = useQuery(query(collection(db, 'refundRequests'), orderBy('requestedAt', 'desc'), limit(300)), mapRefund, 'admin:refunds');
  const customers = useQuery(query(collection(db, 'financeCustomers')), (id, d) => ({ id, ...d } as Record<string, any> & { id: string }), 'admin:financeCustomers');
  const issues = useQuery(query(collection(db, 'reconciliationIssues')), (id, d) => ({ id, ...d, firstDetected: toDate(d.firstDetected), lastSeen: toDate(d.lastSeen), resolvedAt: toDate(d.resolvedAt) } as Record<string, any> & { id: string }), 'admin:reconIssues');
  const runs = useQuery(query(collection(db, 'reconciliationRuns'), orderBy('at', 'desc'), limit(5)), (id, d) => ({ id, ...d, at: toDate(d.at) } as Record<string, any> & { id: string }), 'admin:reconRuns');
  return { invoices: invoices.data, txs: txs.data, refunds: refunds.data, customers: customers.data, issues: issues.data, runs: runs.data };
}

export function AdminFinance() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const setTab = (t: Tab) => setParams({ tab: t });
  const data = useFinanceData();
  const { data: users } = useAllUsers();
  const { data: rawSettings } = useDoc(doc(db, 'integrations', 'xeroSettings'), (_, d) => d);
  const s = settingsFrom(rawSettings);
  const { data: status } = useDoc(doc(db, 'integrations', 'xeroStatus'), (_, d) => ({ ...d, lastSyncAt: toDate(d.lastSyncAt) } as Record<string, any>));
  const [syncing, setSyncing] = useState(false);

  const openIssues = data.issues.filter(i => i.status === 'open');
  const failed = data.txs.filter(t => ['failed', 'attention'].includes(t.syncStatus));
  const awaiting = data.refunds.filter(r => r.status === 'awaiting_approval');

  return (
    <>
      <PageHeader title="Finance" subtitle="Invoices, wallet credit, refunds and reconciliation, synced one way from SafeLearners to Xero."
        actions={<>
          <Link to="/admin/xero" className="inline-flex items-center gap-1.5 text-sm font-semibold underline"><ArrowLeftRight className="size-4" />Xero connection</Link>
          <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={syncing} disabled={!status?.connected || !s.enabled} onClick={async () => {
            setSyncing(true);
            try { const r = await api.xeroSyncNow({}); toast.success(`Synced ${r.processed} item${r.processed === 1 ? '' : 's'}${r.stopped ? ` (stopped: ${r.stopped})` : ''}`); } catch (err) { toast.error(errorMessage(err)); } finally { setSyncing(false); }
          }}>Sync now</Button>
        </>} />
      {!s.enabled && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" />
          <p>Finance records are switched off. Nothing is recorded or sent to Xero until every accounting setting is chosen and finance is switched on under <button className="font-semibold underline" onClick={() => setTab('settings')}>Accounting settings</button>.</p>
        </div>
      )}
      {s.enabled && !s.accountantConfirmed && (
        <div className="mb-4 flex items-start gap-3 rounded-2xl bg-sky-50 p-4 text-sm text-sky-900 dark:bg-sky-500/10 dark:text-sky-200">
          <ShieldCheck className="mt-0.5 size-5 shrink-0" />
          <p>The accounting treatment has not been confirmed by the client’s accountant yet. Use a Xero demo or test organisation only until it is.</p>
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'overview', label: 'Overview' },
        { value: 'invoices', label: 'Invoices', count: data.invoices.length },
        { value: 'transactions', label: 'Transactions', count: failed.length || undefined },
        { value: 'refunds', label: 'Refunds', count: awaiting.length || undefined },
        { value: 'customers', label: 'Customers', count: data.customers.filter(c => c.matchStatus === 'review').length || undefined },
        { value: 'reconciliation', label: 'Reconciliation', count: openIssues.length || undefined },
        { value: 'audit', label: 'Audit trail' },
        { value: 'settings', label: 'Accounting settings' },
      ]} />
      <div className="mt-4">
        {tab === 'overview' && <Overview data={data} users={users} status={status} onTab={setTab} />}
        {tab === 'invoices' && <Invoices invoices={data.invoices} />}
        {tab === 'transactions' && <Transactions txs={data.txs} customers={data.customers} />}
        {tab === 'refunds' && <Refunds refunds={data.refunds} txs={data.txs} users={users} />}
        {tab === 'customers' && <Customers customers={data.customers} txs={data.txs} />}
        {tab === 'reconciliation' && <Reconciliation issues={data.issues} runs={data.runs} enabled={s.enabled} />}
        {tab === 'audit' && <Audit />}
        {tab === 'settings' && <SettingsForm settings={s} />}
      </div>
    </>
  );
}

// ---------- Overview ----------

function Overview({ data, users, status, onTab }: { data: ReturnType<typeof useFinanceData>; users: { role: string; walletBalance?: number; status?: string }[]; status: Record<string, any> | null; onTab: (t: Tab) => void }) {
  const v = useMemo(() => {
    const live = data.invoices.filter(i => !i.voided);
    const cust = data.txs.filter(t => t.type === 'customer');
    return {
      customers: cust.filter(t => t.syncStatus === 'synced').length,
      customersTotal: cust.length,
      invoices: data.invoices.filter(i => i.kind !== 'adjustment').length,
      paid: live.filter(i => i.status === 'paid').length,
      outstanding: live.filter(i => i.amountDue > 0.005),
      prepayments: money(data.txs.filter(t => t.type === 'credit_purchase').reduce((a, t) => a + Number(t.creditRemaining ?? 0), 0)),
      wallets: money(users.filter(u => u.role === 'learner' && u.status !== 'claimed').reduce((a, u) => a + (u.walletBalance ?? 0), 0)),
      credits: data.txs.filter(t => t.type === 'credit_note' || t.type === 'invoice_void').length,
      refundsAwaiting: data.refunds.filter(r => r.status === 'awaiting_approval'),
      refundsToPay: data.refunds.filter(r => r.status === 'awaiting_transfer'),
      refundsDone: data.refunds.filter(r => r.status === 'completed'),
      failed: data.txs.filter(t => ['failed', 'attention'].includes(t.syncStatus)).length,
      pending: data.txs.filter(t => ['pending', 'processing', 'waiting'].includes(t.syncStatus)).length,
      issues: data.issues.filter(i => i.status === 'open').length,
    };
  }, [data, users]);
  const sum = (rs: RefundView[]) => formatMoney(rs.reduce((a, r) => a + r.amount, 0));
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Customers synced" value={`${v.customers} / ${v.customersTotal}`} icon={<UsersIcon className="size-4" />} />
        <Stat label="Invoices" value={v.invoices} icon={<FileText className="size-4" />} sub={`${v.paid} paid`} />
        <Stat label="Outstanding invoices" value={v.outstanding.length} icon={<FileText className="size-4" />} sub={formatMoney(v.outstanding.reduce((a, i) => a + i.amountDue, 0))} />
        <Stat label="Cancellations & credit notes" value={v.credits} icon={<Undo2 className="size-4" />} />
        <Stat label="Customer prepayments (unused)" value={formatMoney(v.prepayments)} icon={<Wallet className="size-4" />} sub="Credit bought with money" />
        <Stat label="Wallet credit outstanding" value={formatMoney(v.wallets)} icon={<Wallet className="size-4" />} sub="All learner wallets" />
        <Stat label="Refunds awaiting approval" value={v.refundsAwaiting.length} icon={<Undo2 className="size-4" />} sub={sum(v.refundsAwaiting)} />
        <Stat label="Refunds awaiting payment" value={v.refundsToPay.length} icon={<Undo2 className="size-4" />} sub={sum(v.refundsToPay)} />
        <Stat label="Refunds completed" value={v.refundsDone.length} icon={<CheckCircle2 className="size-4" />} sub={sum(v.refundsDone)} />
        <Stat label="Failed synchronisations" value={v.failed} icon={<AlertTriangle className="size-4" />} sub={<button className="underline" onClick={() => onTab('transactions')}>Review</button>} />
        <Stat label="Pending synchronisations" value={v.pending} icon={<RefreshCw className="size-4" />} />
        <Stat label="Reconciliation issues" value={v.issues} icon={<Scale className="size-4" />} sub={<button className="underline" onClick={() => onTab('reconciliation')}>Open</button>} />
      </div>
      <p className="text-xs text-ink-500">Xero: {status?.connected ? `connected to ${status.tenantName ?? 'organisation'}` : 'not connected'} · last successful sync {when(status?.lastSyncAt)}. All figures are read live from the records; nothing is estimated.</p>
    </div>
  );
}

// ---------- Invoices ----------

function Invoices({ invoices }: { invoices: InvoiceView[] }) {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const open = invoices.find(i => i.id === params.get('invoice')) ?? null;
  const list = invoices.filter(i =>
    (!q || `${i.number} ${i.learnerName} ${i.learnerEmail ?? ''} ${i.bookingRef ?? ''} ${i.instructorName ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    && (!statusF || (statusF === 'outstanding' ? i.amountDue > 0.005 && !i.voided : i.status === statusF))
    && (!from || i.issueDate >= from) && (!to || i.issueDate <= to));
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-ink-100 p-4 dark:border-ink-800">
        <Input label="Search" value={q} onChange={e => setQ(e.target.value)} placeholder="Number, learner, booking…" wrapperClassName="min-w-[220px] flex-1" />
        <Select label="Status" value={statusF} onChange={e => setStatusF(e.target.value)} wrapperClassName="w-44">
          <option value="">All</option><option value="outstanding">Outstanding balance</option>
          {Object.entries(INVOICE_STATUS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </Select>
        <Input label="Issued from" type="date" value={from} onChange={e => setFrom(e.target.value)} wrapperClassName="w-40" />
        <Input label="to" type="date" value={to} onChange={e => setTo(e.target.value)} wrapperClassName="w-40" />
      </div>
      {list.length === 0 ? <EmptyState icon={<FileText className="size-6" />} title="No invoices" body="Invoices are created automatically when lessons are confirmed (once finance is switched on)." /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-2">Invoice</th><th className="px-4 py-2">Learner</th><th className="px-4 py-2">Issued</th><th className="px-4 py-2">Status</th><th className="px-4 py-2 text-right">Total</th><th className="px-4 py-2 text-right">Paid</th><th className="px-4 py-2 text-right">Due</th><th className="px-4 py-2">Xero</th></tr></thead>
            <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
              {list.map(i => (
                <tr key={i.id} className="cursor-pointer hover:bg-ink-50 dark:hover:bg-ink-800/50" onClick={() => setParams({ tab: 'invoices', invoice: i.id })}>
                  <td className="px-4 py-2 font-semibold">{i.number}<span className="block text-xs font-normal text-ink-500">{i.kind === 'lesson' ? i.description : i.kind === 'cancellation_fee' ? 'Cancellation fee' : 'Wallet correction'}</span></td>
                  <td className="px-4 py-2">{i.learnerName}</td>
                  <td className="px-4 py-2">{auDate(i.issueDate)}</td>
                  <td className="px-4 py-2"><InvoiceStatusBadge invoice={i} /></td>
                  <td className="px-4 py-2 text-right">{formatMoney(i.total)}</td>
                  <td className="px-4 py-2 text-right">{formatMoney(i.amountPaid + i.amountCredited)}</td>
                  <td className={cx('px-4 py-2 text-right font-semibold', i.amountDue > 0.005 && 'text-amber-700 dark:text-amber-400')}>{formatMoney(i.amountDue)}</td>
                  <td className="px-4 py-2 text-xs">{i.xero?.invoiceId ? <Badge tone="green">{i.xero.status ?? 'Synced'}</Badge> : <Badge>Not yet</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!open} onClose={() => setParams({ tab: 'invoices' })} title="Invoice" size="lg">
        {open && <><InvoiceDetail invoice={open} admin /><p className="mt-3 text-xs"><Link className="underline" to={`/admin/users/${open.learnerId}`}>Open customer record</Link></p></>}
      </Modal>
    </Card>
  );
}

// ---------- Transactions ----------

function Transactions({ txs, customers }: { txs: FinanceTx[]; customers: (Record<string, any> & { id: string })[] }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [statusF, setStatusF] = useState('');
  const [customer, setCustomer] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<FinanceTx | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const name = (id: string) => customers.find(c => c.id === id)?.name ?? id.slice(0, 8);
  const list = txs.filter(t =>
    (!q || `${t.description} ${t.reference ?? ''} ${t.invoiceNumber ?? ''} ${t.id} ${name(t.customerId)}`.toLowerCase().includes(q.toLowerCase()))
    && (!type || t.type === type) && (!statusF || t.syncStatus === statusF) && (!customer || t.customerId === customer)
    && (!from || t.date >= from) && (!to || t.date <= to));
  const retry = async (id?: string) => {
    setRetrying(id ?? 'all');
    try { const r = await api.financeRetry(id ? { txId: id } : {}); toast.success(`${r.retried} queued again. Only the Xero step is repeated.`); } catch (err) { toast.error(errorMessage(err)); } finally { setRetrying(null); }
  };
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-ink-100 p-4 dark:border-ink-800">
        <Input label="Search" value={q} onChange={e => setQ(e.target.value)} placeholder="Description, reference, invoice…" wrapperClassName="min-w-[200px] flex-1" />
        <Select label="Type" value={type} onChange={e => setType(e.target.value)} wrapperClassName="w-48">
          <option value="">All types</option>{Object.entries(FINANCE_TX).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </Select>
        <Select label="Sync status" value={statusF} onChange={e => setStatusF(e.target.value)} wrapperClassName="w-44">
          <option value="">All</option>{Object.entries(SYNC_STATUS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </Select>
        <Select label="Customer" value={customer} onChange={e => setCustomer(e.target.value)} wrapperClassName="w-44">
          <option value="">All customers</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Input label="From" type="date" value={from} onChange={e => setFrom(e.target.value)} wrapperClassName="w-36" />
        <Input label="To" type="date" value={to} onChange={e => setTo(e.target.value)} wrapperClassName="w-36" />
        <Button size="sm" variant="secondary" icon={<RotateCcw className="size-4" />} loading={retrying === 'all'} disabled={!txs.some(t => ['failed', 'attention'].includes(t.syncStatus))} onClick={() => retry()}>Retry all failed</Button>
      </div>
      {list.length === 0 ? <EmptyState title="No transactions" /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-2">Date</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">Description</th><th className="px-4 py-2">Customer</th><th className="px-4 py-2 text-right">Amount</th><th className="px-4 py-2">Sync</th></tr></thead>
            <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
              {list.map(t => (
                <tr key={t.id} className="cursor-pointer hover:bg-ink-50 dark:hover:bg-ink-800/50" onClick={() => setOpen(t)}>
                  <td className="px-4 py-2 whitespace-nowrap">{auDate(t.date)}</td>
                  <td className="px-4 py-2">{FINANCE_TX[t.type as FinanceTxType]?.label ?? t.type}</td>
                  <td className="px-4 py-2">{t.description}{t.lastError && <span className="block text-xs text-red-700">{t.lastError}</span>}</td>
                  <td className="px-4 py-2">{name(t.customerId)}</td>
                  <td className="px-4 py-2 text-right">{t.type === 'customer' ? '—' : formatMoney(t.amount)}</td>
                  <td className="px-4 py-2"><SyncBadge status={t.syncStatus} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!open} onClose={() => setOpen(null)} title="Transaction" size="lg"
        footer={open && ['failed', 'attention'].includes(open.syncStatus) ? <Button icon={<RotateCcw className="size-4" />} loading={retrying === open.id} onClick={() => retry(open.id)}>Retry sync</Button> : undefined}>
        {open && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {([
              ['SafeLearners ID', open.id], ['Type', FINANCE_TX[open.type as FinanceTxType]?.label ?? open.type], ['Xero record', FINANCE_TX[open.type as FinanceTxType]?.xero ?? '—'],
              ['Customer', name(open.customerId)], ['Amount', open.type === 'customer' ? '—' : formatMoney(open.amount)], ['Date', auDate(open.date)],
              ['Invoice', open.invoiceNumber ?? '—'], ['Booking', open.bookingId ?? '—'], ['Reference', open.reference ?? '—'],
              ['Source', open.source], ['Created by', open.createdBy], ['Related', open.relatedId ?? '—'],
              ['Sync status', SYNC_STATUS[open.syncStatus as keyof typeof SYNC_STATUS]?.label ?? open.syncStatus], ['Xero ID', open.xeroId ?? '—'],
              ['Attempts', String(open.attempts ?? 0)], ['Last attempt', when(open.lastAttemptAt)],
              ...(open.isCredit ? [['Credit added', formatMoney(open.creditTotal ?? 0)], ['Credit unused', formatMoney(open.creditRemaining ?? 0)]] : []),
              ...(open.paymentReference ? [['Payment', `${open.paymentMethod ?? ''} · ${open.paymentReference}`]] : []),
            ] as [string, string][]).map(([k, v]) => <div key={k}><dt className="text-xs font-semibold uppercase text-ink-400">{k}</dt><dd className="break-all">{v}</dd></div>)}
            {open.pieces && open.pieces.length > 0 && <div className="sm:col-span-2"><dt className="text-xs font-semibold uppercase text-ink-400">Credit used</dt><dd>{open.pieces.map(p => <span key={p.sourceId} className="block">{formatMoney(p.amount)} from {p.sourceId} {p.done ? '✓ in Xero' : '(not yet in Xero)'}</span>)}</dd></div>}
            {open.lastError && <div className="sm:col-span-2 rounded-xl bg-red-50 p-3 text-red-800 dark:bg-red-500/10 dark:text-red-300"><dt className="text-xs font-semibold uppercase">Error</dt><dd>{open.lastError}</dd></div>}
          </dl>
        )}
      </Modal>
    </Card>
  );
}

// ---------- Refunds ----------

function Refunds({ refunds, txs, users }: { refunds: RefundView[]; txs: FinanceTx[]; users: { id: string; walletBalance?: number }[] }) {
  const [statusF, setStatusF] = useState('');
  const [open, setOpen] = useState<RefundView | null>(null);
  const list = refunds.filter(r => !statusF || r.status === statusF);
  const current = open ? refunds.find(r => r.id === open.id) ?? open : null;
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-ink-100 p-4 dark:border-ink-800">
        <Select label="Status" value={statusF} onChange={e => setStatusF(e.target.value)} wrapperClassName="w-56">
          <option value="">All</option>{Object.entries(REFUND_STATUS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </Select>
        <p className="text-xs text-ink-500">Refunds are the only financial step that needs approval. Approved refunds are paid by bank transfer, then confirmed here.</p>
      </div>
      {list.length === 0 ? <EmptyState icon={<Undo2 className="size-6" />} title="No refund requests" /> : (
        <ul className="divide-y divide-ink-100 dark:divide-ink-800">
          {list.map(r => (
            <li key={r.id}>
              <button onClick={() => setOpen(r)} className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left text-sm hover:bg-ink-50 dark:hover:bg-ink-800/50">
                <div className="min-w-0 flex-1"><p className="font-semibold">{r.number} · {r.customerName}</p><p className="truncate text-xs text-ink-500">Requested {when(r.requestedAt)} · {r.reason}</p></div>
                <span className="font-bold">{formatMoney(r.amount)}</span>
                <RefundStatusBadge status={r.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!current} onClose={() => setOpen(null)} title={current ? `Refund ${current.number}` : ''} size="lg">
        {current && <RefundDetail r={current} txs={txs} wallet={users.find(u => u.id === current.customerId)?.walletBalance ?? 0} />}
      </Modal>
    </Card>
  );
}

function RefundDetail({ r, txs, wallet }: { r: RefundView; txs: FinanceTx[]; wallet: number }) {
  const [reason, setReason] = useState('');
  const [ref, setRef] = useState('');
  const [date, setDate] = useState(sydneyToday());
  const [busy, setBusy] = useState<string | null>(null);
  const credit = txs.filter(t => t.customerId === r.customerId && t.isCredit && (t.creditRemaining ?? 0) > 0.005);
  const cash = money(credit.filter(t => t.type === 'credit_purchase').reduce((a, t) => a + Number(t.creditRemaining), 0));
  const other = money(credit.filter(t => t.type !== 'credit_purchase').reduce((a, t) => a + Number(t.creditRemaining), 0));
  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try { await fn(); toast.success(done); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(null); }
  };
  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between"><span className="text-2xl font-extrabold">{formatMoney(r.amount)}</span><RefundStatusBadge status={r.status} /></div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {([
          ['Customer', `${r.customerName}${r.customerEmail ? ` · ${r.customerEmail}` : ''}`], ['Requested', when(r.requestedAt)],
          ['Original payment reference', r.paymentReference ?? 'Not specified (any unused credit)'], ['Related invoice', r.invoiceNumber ?? '—'],
          ['Wallet balance now', formatMoney(wallet)], ['Unused credit', `${formatMoney(cash)} paid for · ${formatMoney(other)} promotional, goodwill or returned`],
          ...(r.transferReference ? [['Bank transfer', `${r.transferReference} on ${auDate(r.transferDate)}`]] : []),
          ...(r.rejectionReason ? [['Rejection reason', r.rejectionReason]] : []),
        ] as [string, string][]).map(([k, v]) => <div key={k}><dt className="text-xs font-semibold uppercase text-ink-400">{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <div className="rounded-xl bg-ink-50 p-3 dark:bg-ink-800/60"><p className="text-xs font-semibold uppercase text-ink-400">Reason</p><p>{r.reason}</p></div>
      {r.amount > cash + 0.005 && r.status === 'awaiting_approval' && <p className="rounded-xl bg-amber-50 p-3 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">This is more than the credit the learner paid for ({formatMoney(cash)}); part of it would be promotional or returned credit.</p>}

      {r.status === 'awaiting_approval' && (
        <div className="space-y-2">
          <Textarea label="Note (required to reject)" rows={2} value={reason} onChange={e => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button variant="success" loading={busy === 'approve'} onClick={() => run('approve', () => api.decideRefund({ id: r.id, approve: true, reason: reason.trim() || undefined }), 'Approved. The credit is held from the wallet until the transfer is confirmed.')}>Approve</Button>
            <Button variant="danger" loading={busy === 'reject'} disabled={reason.trim().length < 3} onClick={() => run('reject', () => api.decideRefund({ id: r.id, approve: false, reason: reason.trim() }), 'Rejected. The learner has been told.')}>Reject</Button>
          </div>
        </div>
      )}
      {r.status === 'awaiting_transfer' && (
        <div className="space-y-2 rounded-xl border border-ink-200 p-3 dark:border-ink-700">
          <p className="font-semibold">Pay {formatMoney(r.amount)} by bank transfer, then record it here.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Transfer reference" value={ref} onChange={e => setRef(e.target.value)} />
            <Input label="Transfer date" type="date" max={sydneyToday()} value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button loading={busy === 'confirm'} disabled={!ref.trim()} onClick={() => run('confirm', () => api.confirmRefundTransfer({ id: r.id, transferReference: ref.trim(), transferDate: date }), 'Refund completed. The Xero entry is queued.')}>Confirm transfer made</Button>
            <Button variant="secondary" loading={busy === 'cancel'} disabled={reason.trim().length < 3} onClick={() => run('cancel', () => api.cancelApprovedRefund({ id: r.id, reason: reason.trim() }), 'Cancelled. The credit is back in the wallet.')}>Cancel refund</Button>
          </div>
          <Textarea label="Reason (to cancel)" rows={2} value={reason} onChange={e => setReason(e.target.value)} />
        </div>
      )}
      <div>
        <p className="text-xs font-semibold uppercase text-ink-400">History</p>
        <ol className="mt-1 space-y-1 text-xs">{r.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })} · <strong>{REFUND_STATUS[h.status as keyof typeof REFUND_STATUS]?.label ?? h.status}</strong>{h.note ? ` · ${h.note}` : ''}{h.by !== 'system' ? ` · by ${h.by.slice(0, 8)}` : ''}</li>)}</ol>
      </div>
    </div>
  );
}

// ---------- Customers ----------

function Customers({ customers, txs }: { customers: (Record<string, any> & { id: string })[]; txs: FinanceTx[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const status = (id: string) => txs.find(t => t.id === `customer__${id}`)?.syncStatus ?? 'pending';
  return (
    <Card>
      <CardHeader title="Customers" subtitle="Matched in Xero by stored contact ID, then the SafeLearners customer reference, then exact email and name. An email-only match waits here for review." />
      {customers.length === 0 ? <EmptyState title="No customers yet" /> : (
        <ul className="divide-y divide-ink-100 dark:divide-ink-800">
          {[...customers].sort((a, b) => (a.matchStatus === 'review' ? -1 : 0) - (b.matchStatus === 'review' ? -1 : 0)).map(c => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1"><p className="font-semibold">{c.name}</p><p className="text-xs text-ink-500">{c.email ?? 'no email'} · {c.customerNumber}{c.xeroContactId ? ` · Xero ${c.xeroContactId}` : ''}</p></div>
              <Badge tone={c.matchStatus === 'review' ? 'amber' : 'slate'}>{({ new: 'New', matched: 'Matched existing', created: 'Created in Xero', review: 'Needs review', linked_by_admin: 'Linked by admin', create_confirmed: 'New contact confirmed' } as Record<string, string>)[c.matchStatus] ?? c.matchStatus}</Badge>
              <SyncBadge status={status(c.id)} />
              {c.matchStatus === 'review' && (
                <div className="flex w-full flex-wrap items-center gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
                  <span className="flex-1">Xero contact “{c.candidateName}” has the same email but a different name.</span>
                  <Button size="sm" variant="secondary" loading={busy === `${c.id}l`} onClick={async () => { setBusy(`${c.id}l`); try { await api.resolveCustomerMatch({ customerId: c.id, action: 'link' }); toast.success('Linked'); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); } }}>Link to that contact</Button>
                  <Button size="sm" loading={busy === `${c.id}c`} onClick={async () => { setBusy(`${c.id}c`); try { await api.resolveCustomerMatch({ customerId: c.id, action: 'create' }); toast.success('A new contact will be created'); } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); } }}>Create a new contact</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------- Reconciliation ----------

function Reconciliation({ issues, runs, enabled }: { issues: (Record<string, any> & { id: string })[]; runs: (Record<string, any> & { id: string })[]; enabled: boolean }) {
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [running, setRunning] = useState(false);
  const [resolving, setResolving] = useState<Record<string, any> | null>(null);
  const [note, setNote] = useState('');
  const list = issues.filter(i => show === 'all' || i.status === 'open').sort((a, b) => (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0));
  const last = runs[0];
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-100 p-4 dark:border-ink-800">
        <div className="flex-1 text-sm">
          <p className="font-semibold">Exception report</p>
          <p className="text-xs text-ink-500">Runs every night at 2:30 am (Sydney) and compares invoices, credit, allocations, refunds, wallets and contacts with Xero. It never changes a record. Last run: {last ? `${when(last.at)} · ${last.issues} issue${last.issues === 1 ? '' : 's'}${last.skippedCustomers ? ` · ${last.skippedCustomers} customer(s) skipped while syncs were pending` : ''}` : 'not yet'}.</p>
        </div>
        <Select value={show} onChange={e => setShow(e.target.value as 'open' | 'all')} wrapperClassName="w-40"><option value="open">Open issues</option><option value="all">All, incl. resolved</option></Select>
        <Button icon={<Scale className="size-4" />} loading={running} disabled={!enabled} onClick={async () => {
          setRunning(true);
          try { const r = await api.financeReconcileNow({}); toast.success(`Reconciliation finished: ${r.issues} issue${r.issues === 1 ? '' : 's'}`); } catch (err) { toast.error(errorMessage(err)); } finally { setRunning(false); }
        }}>Run now</Button>
      </div>
      {list.length === 0 ? <EmptyState icon={<CheckCircle2 className="size-6" />} title={show === 'open' ? 'No open issues' : 'No issues recorded'} body="SafeLearners and Xero agree on everything checked." /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-2">Issue</th><th className="px-4 py-2 text-right">SafeLearners</th><th className="px-4 py-2 text-right">Xero</th><th className="px-4 py-2 text-right">Difference</th><th className="px-4 py-2">First detected</th><th className="px-4 py-2">Status</th><th className="px-4 py-2" /></tr></thead>
            <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
              {list.map(i => (
                <tr key={i.id}>
                  <td className="px-4 py-2"><p className="font-semibold">{i.label}</p><p className="text-xs text-ink-500">{i.kind.replace(/_/g, ' ')} · {i.ref}</p><p className="text-xs">{i.suggestion}</p>{i.resolution && <p className="text-xs text-emerald-700">Resolved: {i.resolution}</p>}</td>
                  <td className="px-4 py-2 text-right">{typeof i.slValue === 'number' ? formatMoney(i.slValue) : i.slValue ?? '—'}</td>
                  <td className="px-4 py-2 text-right">{typeof i.xeroValue === 'number' ? formatMoney(i.xeroValue) : i.xeroValue ?? '—'}</td>
                  <td className="px-4 py-2 text-right">{typeof i.difference === 'number' ? formatMoney(i.difference) : '—'}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{when(i.firstDetected)}</td>
                  <td className="px-4 py-2"><Badge tone={i.status === 'open' ? 'amber' : i.status === 'resolved' ? 'green' : 'slate'}>{i.status}</Badge></td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {i.status === 'open' && i.txId && <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={async () => { try { await api.financeRetry({ txId: i.txId }); toast.success('Queued again'); } catch (e) { toast.error(errorMessage(e)); } }}>Retry</Button>}
                    {i.status === 'open' && <Button size="sm" variant="ghost" onClick={() => { setResolving(i); setNote(''); }}>Resolve</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!resolving} onClose={() => setResolving(null)} title="Resolve discrepancy"
        footer={<Button disabled={note.trim().length < 3} onClick={async () => { try { await api.resolveReconciliationIssue({ id: resolving!.id, note: note.trim() }); toast.success('Resolved (recorded in the audit trail)'); setResolving(null); } catch (e) { toast.error(errorMessage(e)); } }}>Mark resolved</Button>}>
        <p className="mb-3 text-sm">{resolving?.label}</p>
        <Textarea label="How was this resolved?" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Confirmed with the accountant; corrected in Xero." />
      </Modal>
    </Card>
  );
}

// ---------- Audit ----------

function Audit() {
  const { data } = useQuery(query(collection(db, 'financeAudit'), orderBy('at', 'desc'), limit(300)), (id, d) => ({ id, ...d, at: toDate(d.at) } as Record<string, any> & { id: string }), 'admin:financeAudit');
  const [q, setQ] = useState('');
  const list = data.filter(a => !q || JSON.stringify(a).toLowerCase().includes(q.toLowerCase()));
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-ink-100 p-4 dark:border-ink-800">
        <Input label="Search" value={q} onChange={e => setQ(e.target.value)} wrapperClassName="flex-1" />
        <p className="text-xs text-ink-500"><Search className="mr-1 inline size-3" />Append-only: no one can edit or delete these entries.</p>
      </div>
      {list.length === 0 ? <EmptyState title="Nothing recorded yet" /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-2">When</th><th className="px-4 py-2">Action</th><th className="px-4 py-2">Record</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">By</th><th className="px-4 py-2">Detail</th></tr></thead>
            <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
              {list.map(a => (
                <tr key={a.id}>
                  <td className="px-4 py-2 whitespace-nowrap">{when(a.at)}</td>
                  <td className="px-4 py-2">{String(a.action).replace(/_/g, ' ')}</td>
                  <td className="px-4 py-2 text-xs break-all">{a.record}</td>
                  <td className="px-4 py-2 text-xs">{a.previousStatus || a.newStatus ? `${a.previousStatus ?? '—'} → ${a.newStatus ?? '—'}` : '—'}</td>
                  <td className="px-4 py-2 text-xs">{a.mode === 'manual' ? `Admin ${String(a.by).slice(0, 8)}` : 'Automatic'}</td>
                  <td className="px-4 py-2 text-xs">{[a.detail, a.gatewayReference && `Transfer ${a.gatewayReference}`, a.xeroResult && `Xero: ${a.xeroResult}`, a.error && `Error: ${a.error}`].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------- Settings ----------

type Lookups = { accounts: { id: string; code: string | null; name: string; type: string; class: string | null; payments?: boolean }[]; taxRates: { name: string; taxType: string; rate: number | null }[]; organisation?: { name: string | null } };

function SettingsForm({ settings }: { settings: AccountingSettings }) {
  const { data: lookups } = useDoc(doc(db, 'integrations', 'xeroLookups'), (_, d) => d as Lookups);
  const [f, setF] = useState<AccountingSettings>(settings);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof AccountingSettings>(k: K, v: AccountingSettings[K]) => setF(x => ({ ...x, [k]: v }));
  const accounts = (lookups?.accounts ?? []).filter(a => a.code && a.type !== 'BANK');
  const banks = (lookups?.accounts ?? []).filter(a => a.type === 'BANK');
  const taxes = lookups?.taxRates ?? [];
  const missing = missingSettings({ ...f, taxRates: settings.taxRates });
  const acct = (k: keyof AccountingSettings, label: string, hint?: string) => (
    <Select label={label} hint={hint} value={(f[k] as string) ?? ''} onChange={e => set(k, (e.target.value || null) as never)}>
      <option value="">Choose…</option>{accounts.map(a => <option key={a.id} value={a.code!}>{a.code} · {a.name} ({a.type.toLowerCase()})</option>)}
    </Select>
  );
  const bank = (k: keyof AccountingSettings, label: string) => (
    <Select label={label} value={(f[k] as string) ?? ''} onChange={e => set(k, (e.target.value || null) as never)}>
      <option value="">Choose…</option>{banks.map(a => <option key={a.id} value={a.id}>{a.name}{a.code ? ` (${a.code})` : ''}</option>)}
    </Select>
  );
  const tax = (k: keyof AccountingSettings, label: string) => (
    <Select label={label} value={(f[k] as string) ?? ''} onChange={e => set(k, (e.target.value || null) as never)} disabled={f.lineAmountTypes === 'NoTax'}>
      <option value="">Choose…</option>{taxes.map(t => <option key={t.taxType} value={t.taxType}>{t.name} ({t.rate ?? 0}%)</option>)}
    </Select>
  );
  const save = async (enabled: boolean) => {
    setSaving(true);
    try {
      const r = await api.financeSaveSettings({ ...f, enabled, taxRates: undefined });
      toast.success(enabled ? 'Saved. Finance records are on.' : r.missing.length ? `Saved. Still needed before switching on: ${r.missing.length}` : 'Saved.');
    } catch (err) { toast.error(errorMessage(err)); } finally { setSaving(false); }
  };
  if (!lookups) return <Card><EmptyState icon={<Settings2 className="size-6" />} title="Connect Xero first" body="Account and tax choices come from the connected Xero organisation." action={<Link to="/admin/xero" className="font-semibold underline">Xero connection</Link>} /></Card>;
  return (
    <div className="space-y-4">
      <Card className="p-5 text-sm">
        <p className="font-semibold">Choices from {lookups.organisation?.name ?? 'the connected organisation'}</p>
        <p className="text-ink-500">Nothing here is assumed: each account and tax type must be chosen, and the treatment confirmed with the client’s accountant before a live organisation is connected.</p>
      </Card>
      <Card>
        <CardHeader title="Treatment" />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Select label="Who sells the lesson?" value={f.sellerModel ?? ''} onChange={e => set('sellerModel', (e.target.value || null) as AccountingSettings['sellerModel'])} hint="Ask the accountant: this changes what counts as revenue.">
            <option value="">Choose…</option><option value="principal">SafeLearners (principal): full lesson price is revenue</option><option value="agent">Instructor (agent): SafeLearners keeps a booking fee</option>
          </Select>
          <Select label="Lesson prices and GST" value={f.lineAmountTypes ?? ''} onChange={e => set('lineAmountTypes', (e.target.value || null) as AccountingSettings['lineAmountTypes'])}
            hint={f.lineAmountTypes === 'Exclusive' ? 'Warning: GST is then added on top, so learners owe more than the lesson price.' : 'Prices shown to learners are not changed.'}>
            <option value="">Choose…</option><option value="Inclusive">Prices include GST</option><option value="Exclusive">Prices exclude GST (GST added on top)</option><option value="NoTax">No GST</option>
          </Select>
          <Input label="Start date" type="date" value={f.startDate ?? ''} onChange={e => set('startDate', e.target.value || null)} hint="Activity before this date is never recorded or sent." />
          {f.sellerModel === 'agent' && <Input label="Fallback booking fee (%)" hint="Each lesson's fee is its commission (Settings → Commission management). This rate is used only for lessons booked before commission management." type="number" step="0.5" value={String(Math.round(f.platformFeeRate * 1000) / 10)} onChange={e => set('platformFeeRate', Number(e.target.value) / 100)} />}
        </div>
      </Card>
      <Card>
        <CardHeader title="Accounts and tax" />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          {f.sellerModel !== 'agent' && <>{acct('lessonAccount', 'Lesson revenue account')}{tax('lessonTaxType', 'Lesson tax type')}</>}
          {f.sellerModel === 'agent' && <>
            {acct('feeAccount', 'Booking fee revenue account')}{tax('feeTaxType', 'Booking fee tax type')}
            {acct('instructorPayableAccount', 'Amount owed to instructors (liability)')}
            {tax('instructorTaxTypeRegistered', 'Instructor share: GST-registered instructors')}{tax('instructorTaxTypeUnregistered', 'Instructor share: not registered')}
          </>}
          {acct('cancellationFeeAccount', 'Cancellation fee account')}{tax('cancellationFeeTaxType', 'Cancellation fee tax type')}
          {acct('prepaymentAccount', 'Customer prepayment account', 'Credit bought with money sits here until it pays for a lesson.')}
          {tax('creditTaxType', 'Tax type for credit lines (prepayments, promotional credit)')}
          {acct('promotionsAccount', 'Referral / promotional credit account')}{acct('goodwillAccount', 'Goodwill credit account')}
          {acct('adjustmentsAccount', 'Administrative correction account')}{acct('openingCreditAccount', 'Opening credit account', 'For wallet credit that existed before the start date.')}
          {bank('topupBankAccount', 'Bank account manual top-ups are paid into')}{bank('refundBankAccount', 'Bank account refunds are paid from')}
        </div>
      </Card>
      <Card>
        <CardHeader title="Shown on invoices" />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Input label="Business name" value={f.business.name} onChange={e => set('business', { ...f.business, name: e.target.value })} />
          <Input label="ABN" value={f.business.abn} onChange={e => set('business', { ...f.business, abn: e.target.value })} hint="Needed for a tax invoice." />
          <Input label="Address" value={f.business.address} onChange={e => set('business', { ...f.business, address: e.target.value })} />
          <Input label="Email" value={f.business.email} onChange={e => set('business', { ...f.business, email: e.target.value })} />
        </div>
      </Card>
      <Card className="space-y-3 p-5 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.accountantConfirmed} onChange={e => set('accountantConfirmed', e.target.checked)} />The client’s accountant has confirmed this treatment</label>
        {missing.length > 0 && <p className="text-amber-800 dark:text-amber-300">Still needed before switching on: {missing.join(', ')}.</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={saving} onClick={() => save(settings.enabled)}>Save</Button>
          {settings.enabled
            ? <Button variant="danger" loading={saving} onClick={() => save(false)}>Switch finance off</Button>
            : <Button loading={saving} disabled={missing.length > 0} onClick={() => save(true)}>Save and switch finance on</Button>}
        </div>
      </Card>
    </div>
  );
}
