import { collection, doc, limit, orderBy, query } from 'firebase/firestore';
import { ArrowLeftRight, CircleAlert, Link2, PlugZap, RefreshCw, RotateCcw, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Modal, PageHeader, Segmented, Stat } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { toDate, useDoc, useQuery } from '@/lib/data';
import { db } from '@/lib/firebase';
import { timeAgo } from '@/lib/format';

interface XeroStatus {
  connected?: boolean;
  tenantName?: string | null;
  organisationClass?: string | null;
  connectedByXeroUser?: string | null;
  connectedAt?: Date;
  refreshExpiresAt?: Date;
  lastSyncAt?: Date;
  lastCheckAt?: Date;
  lastCheckOk?: boolean;
  problem?: string | null;
  otherOrganisations?: number;
}
interface Job { id: string; type: string; recordId: string; status: string; attempts: number; lastError?: string | null; updatedAt?: Date }
interface LogEntry { id: string; kind: 'sync' | 'audit'; job?: string; type?: string; action?: string; ok?: boolean; detail: string; willRetry?: boolean; at?: Date }

/** Record types that will sync once the client confirms the accounting rules. */
const RECORD_TYPES = [
  { key: 'contact', label: 'Customers (contacts)' },
  { key: 'invoice', label: 'Invoices' },
  { key: 'payment', label: 'Payments' },
  { key: 'creditnote', label: 'Refunds (credit notes)' },
];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmt = (d?: Date) => d ? d.toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

export function AdminXero() {
  const [params, setParams] = useSearchParams();
  const { data: status } = useDoc(doc(db, 'integrations', 'xeroStatus'), (_, d) => ({
    ...d,
    connectedAt: toDate(d.connectedAt), refreshExpiresAt: toDate(d.refreshExpiresAt), lastSyncAt: toDate(d.lastSyncAt), lastCheckAt: toDate(d.lastCheckAt),
  }) as XeroStatus);
  const { data: settings } = useDoc(doc(db, 'integrations', 'xeroSettings'), (_, d) => d as { startDate: string | null; invoiceStatus: 'DRAFT' | 'AUTHORISED'; requireApproval: boolean });
  const { data: lookups } = useDoc(doc(db, 'integrations', 'xeroLookups'), (_, d) => ({ taxRates: (d.taxRates ?? []).length as number, accounts: (d.accounts ?? []).length as number, items: (d.items ?? []).length as number, updatedAt: toDate(d.updatedAt) }));
  const { data: jobs } = useQuery(query(collection(db, 'xeroSyncJobs'), limit(1000)),
    (id, d) => ({ id, type: d.type, recordId: d.recordId, status: d.status, attempts: d.attempts ?? 0, lastError: d.lastError, updatedAt: toDate(d.updatedAt) }) as Job, 'xero:jobs');
  const { data: log } = useQuery(query(collection(db, 'xeroSyncLog'), orderBy('at', 'desc'), limit(30)),
    (id, d) => ({ id, ...d, at: toDate(d.at) }) as LogEntry, 'xero:log');
  const [config, setConfig] = useState<{ missing: string[]; scopes: string[]; redirectUri: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => { api.xeroConfigStatus({}).then(setConfig).catch(err => toast.error(errorMessage(err))); }, []);
  // Result of the Xero consent page (it returns here).
  useEffect(() => {
    const result = params.get('xero');
    if (!result) return;
    if (result === 'connected') toast.success('Xero connected');
    else if (result === 'cancelled') toast.info('Xero connection was cancelled');
    else toast.error(params.get('reason') || 'Xero connection failed');
    setParams({}, { replace: true });
  }, [params, setParams]);

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast.success(done);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const count = (pred: (j: Job) => boolean) => jobs.filter(pred).length;
  const failed = jobs.filter(j => j.status === 'failed');
  const connected = !!status?.connected;
  const notConfigured = !!config?.missing.length;
  const demo = status?.organisationClass === 'DEMO';

  return (
    <>
      <PageHeader
        title="Xero"
        subtitle="Accounting sync · data flows one way, Safe Learners → Xero"
        actions={connected ? (
          <>
            <Button variant="secondary" icon={<Unplug className="size-4" />} onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>
            <Button icon={<RefreshCw className="size-4" />} loading={busy === 'sync'} onClick={() => run('sync', async () => {
              const r = await api.xeroSyncNow({});
              toast.success(r.stopped ? `Processed ${r.processed} (${r.stopped})` : `Processed ${r.processed}`);
            })}>Sync now</Button>
          </>
        ) : (
          <Button icon={<PlugZap className="size-4" />} disabled={notConfigured || !config} loading={busy === 'connect'} onClick={() => run('connect', async () => {
            const { url } = await api.xeroConnectUrl({});
            window.location.assign(url);
          })}>Connect to Xero</Button>
        )}
      />

      {notConfigured && (
        <div className="mb-6 flex gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-semibold">Xero isn’t set up on the server yet.</p>
            <p>Missing settings: {config!.missing.join(', ')}. These come from the Safe Learners Xero developer app and are added to the server configuration, never to this page.</p>
          </div>
        </div>
      )}

      <Card className="mb-6">
        <CardHeader title={<span className="flex items-center gap-2"><Link2 className="size-4" />Connection</span>}
          action={connected && <Button size="sm" variant="secondary" loading={busy === 'check'} onClick={() => run('check', () => api.xeroCheckConnection({}), 'Connection OK')}>Check connection</Button>} />
        <div className="flex flex-wrap items-center justify-between gap-4 p-5 text-sm">
          <div className="space-y-1">
            <p className="flex flex-wrap items-center gap-2">
              {connected ? <Badge tone="green">Connected</Badge> : <Badge tone="slate">Not connected</Badge>}
              {connected && <span className="font-bold">{status?.tenantName}</span>}
              {connected && demo && <Badge tone="blue">Demo company</Badge>}
            </p>
            {connected && <p className="text-ink-500">Connected {fmt(status?.connectedAt)}{status?.connectedByXeroUser ? ` by Xero user ${status.connectedByXeroUser}` : ''}. Keeps itself active; reconnect only needed if unused until {fmt(status?.refreshExpiresAt)}.</p>}
            {connected && (status?.otherOrganisations ?? 0) > 0 && <p className="text-amber-700">More than one Xero organisation was authorised; the newest one is used.</p>}
            {status?.problem && <p className="font-semibold text-red-600">{status.problem}</p>}
            {!connected && !notConfigured && <p className="text-ink-500">Connecting opens Xero’s own sign-in page. A Xero administrator of the organisation approves access there; Safe Learners never sees the Xero password.</p>}
          </div>
          <div className="text-right text-ink-500">
            <p>Last sync: {status?.lastSyncAt ? timeAgo(status.lastSyncAt) : '—'}</p>
            <p>Last check: {status?.lastCheckAt ? `${timeAgo(status.lastCheckAt)}${status.lastCheckOk === false ? ' (failed)' : ''}` : '—'}</p>
          </div>
        </div>
      </Card>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Invoices synced" value={count(j => j.type === 'invoice' && j.status === 'done')} icon={<ArrowLeftRight className="size-4" />} />
        <Stat label="Payments synced" value={count(j => j.type === 'payment' && j.status === 'done')} icon={<ArrowLeftRight className="size-4" />} />
        <Stat label="Pending" value={count(j => j.status === 'pending' || j.status === 'processing')} />
        <Stat label="Failed" value={failed.length}
          sub={failed.length > 0 && <button className="font-semibold underline" onClick={() => run('retry', () => api.xeroRetry({}), 'Failed items queued again')}>Retry failed</button>} />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <Card>
          <CardHeader title="What syncs" subtitle="Each type is switched on once the accounting rules are agreed." />
          <ul className="divide-y divide-ink-100 dark:divide-ink-800">
            {RECORD_TYPES.map(t => (
              <li key={t.key} className="flex items-center justify-between px-5 py-3 text-sm">
                <span>{t.label}</span><Badge tone="amber">Awaiting client decision</Badge>
              </li>
            ))}
            <li className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
              <span>Tax rates, accounts and items (read only)</span>
              {lookups ? <span className="text-ink-500">{plural(lookups.taxRates, 'tax rate')} · {plural(lookups.accounts, 'account')} · {plural(lookups.items, 'item')}{lookups.updatedAt ? ` · ${timeAgo(lookups.updatedAt)}` : ''}</span> : <Badge tone="slate">After connecting</Badge>}
            </li>
          </ul>
        </Card>
        <SettingsCard initial={settings} />
      </div>

      <Card>
        <CardHeader title="Sync history" subtitle="Every sync attempt and admin action." />
        {log.length === 0 ? <EmptyState title="Nothing yet" body="Connection events and synced records will appear here." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-ink-500"><th className="px-5 py-2">When</th><th className="px-5 py-2">What</th><th className="px-5 py-2">Result</th><th className="px-5 py-2" /></tr></thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {log.map(e => {
                  const job = e.job ? jobs.find(j => j.id === e.job) : undefined;
                  return (
                    <tr key={e.id}>
                      <td className="whitespace-nowrap px-5 py-2.5 text-ink-500">{fmt(e.at)}</td>
                      <td className="px-5 py-2.5">{e.kind === 'audit' ? <span className="capitalize">{e.action?.replace(/-/g, ' ')}</span> : <span className="capitalize">{e.type}</span>}<span className="block text-xs text-ink-500">{e.detail}</span></td>
                      <td className="px-5 py-2.5">{e.kind === 'audit' ? <Badge tone="slate">Admin</Badge> : e.ok ? <Badge tone="green">Synced</Badge> : <Badge tone={e.willRetry ? 'amber' : 'red'}>{e.willRetry ? 'Will retry' : 'Failed'}</Badge>}</td>
                      <td className="px-5 py-2.5 text-right">{job?.status === 'failed' && e.ok === false && !e.willRetry && (
                        <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" />} onClick={() => run(`retry-${job.id}`, () => api.xeroRetry({ jobId: job.id }), 'Queued again')}>Retry</Button>
                      )}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {config && <p className="mt-4 text-xs text-ink-400">Permissions requested: {config.scopes.join(', ')}.</p>}

      <Modal open={confirmDisconnect} onClose={() => setConfirmDisconnect(false)} title="Disconnect Xero?"
        footer={<>
          <Button variant="secondary" onClick={() => setConfirmDisconnect(false)}>Keep connected</Button>
          <Button variant="danger" loading={busy === 'disconnect'} onClick={() => run('disconnect', async () => { await api.xeroDisconnect({}); setConfirmDisconnect(false); }, 'Xero disconnected')}>Disconnect</Button>
        </>}>
        <p className="text-sm text-ink-600 dark:text-ink-300">Safe Learners’ access to Xero is revoked and the stored keys are deleted. Sync stops until an admin connects again. Nothing already in Xero is changed.</p>
      </Modal>
    </>
  );
}

function SettingsCard({ initial }: { initial: { startDate: string | null; invoiceStatus: 'DRAFT' | 'AUTHORISED'; requireApproval: boolean } | null }) {
  const [startDate, setStartDate] = useState('');
  const [invoiceStatus, setInvoiceStatus] = useState<'DRAFT' | 'AUTHORISED'>('DRAFT');
  const [requireApproval, setRequireApproval] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!initial) return;
    setStartDate(initial.startDate ?? '');
    setInvoiceStatus(initial.invoiceStatus ?? 'DRAFT');
    setRequireApproval(initial.requireApproval !== false);
  }, [initial]);
  return (
    <Card>
      <CardHeader title="Settings" subtitle="Defaults are the safest options." />
      <div className="space-y-4 p-5 text-sm">
        <Input label="Start date" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} hint="Nothing dated before this is ever sent to Xero." />
        <div>
          <p className="mb-1.5 font-semibold">New invoices in Xero</p>
          <Segmented value={invoiceStatus} onChange={v => setInvoiceStatus(v as 'DRAFT' | 'AUTHORISED')} options={[{ value: 'DRAFT', label: 'Draft (checked in Xero)' }, { value: 'AUTHORISED', label: 'Approved' }]} className="[&_button]:text-center" />
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-4 accent-brand-500" checked={requireApproval} onChange={e => setRequireApproval(e.target.checked)} />
          An admin approves each record before it is sent
        </label>
        <Button loading={saving} onClick={async () => {
          setSaving(true);
          try {
            await api.xeroSaveSettings({ startDate: startDate || null, invoiceStatus, requireApproval });
            toast.success('Settings saved');
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setSaving(false);
          }
        }}>Save settings</Button>
      </div>
    </Card>
  );
}
