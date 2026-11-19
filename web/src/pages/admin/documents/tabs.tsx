// Admin → Verifications: the document queue, the compliance dashboard and the automation status strip.
import { collection, query, where } from 'firebase/firestore';
import { AlertTriangle, CalendarClock, CheckCircle2, CircleSlash, Clock, Copy, FileWarning, Files, Import, Pause, Play, RefreshCw, ShieldAlert, Users as UsersIcon, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  DOC_STATUS,
  DOC_TYPES,
  FEATURE_INFO,
  REVIEW_QUEUE,
  computeCompliance,
  daysUntil,
  docTypeLabel,
  formatDocDate,
  isActive,
  type DocStatus,
  type DocTypeKey,
} from '@shared/documents';
import { fullName, type UserProfile } from '@shared/domain';
import { Badge, Button, Card, EmptyState, Input, Select, Stat, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useQuery } from '@/lib/data';
import { DocStatusBadge, recordStatus, useAllDocuments, useDocumentNotifications, useDocumentSettings, type DocRecord } from '@/lib/documents';
import { db } from '@/lib/firebase';
import { DocumentReview } from './DocumentReview';

const when = (d?: Date) => (d ? d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export function useDocumentJobs() {
  return useQuery(query(collection(db, 'documentJobs'), where('status', 'in', ['queued', 'running', 'failed'])), (id, d) => ({ id, ...d } as Record<string, any> & { id: string }), 'docJobs:open');
}

/** Always-visible state of the automation, so nobody wonders why something didn't run. */
export function AutomationStrip() {
  const s = useDocumentSettings();
  const { data: jobs } = useDocumentJobs();
  const { data: docs } = useAllDocuments();
  const waiting = jobs.filter(j => j.status === 'queued').length;
  const failed = docs.filter(d => d.latestStatus === 'processing_failed').length;
  const manual = docs.filter(d => d.latestStatus === 'manual_verification').length;
  const active = FEATURE_INFO.filter(f => f.master && isActive(s, f.key)).length;
  const masterCount = FEATURE_INFO.filter(f => f.master).length;
  return (
    <div className="mb-4 space-y-2">
      {!s.automation && (
        <div className="flex items-center gap-3 rounded-2xl bg-amber-50 p-3 text-sm font-semibold text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <Pause className="size-5" />Document Automation Paused – Manual Verification Available
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-ink-200 p-3 text-xs dark:border-ink-700">
        <Badge tone={isActive(s, 'ocr') ? 'green' : 'slate'}>{isActive(s, 'ocr') ? <Play className="size-3" /> : <Pause className="size-3" />}OCR {isActive(s, 'ocr') ? 'enabled' : 'paused'}</Badge>
        <Badge tone={s.automation ? 'green' : 'amber'}>Automation {s.automation ? 'enabled' : 'paused'} · {active}/{masterCount} functions active</Badge>
        <Badge tone={s.features.expiryMonitoring ? 'green' : 'amber'}>Expiry monitoring {s.features.expiryMonitoring ? 'on' : 'paused'}</Badge>
        <Badge tone={s.features.eligibilityUpdates ? 'green' : 'amber'}>Eligibility updates {s.features.eligibilityUpdates ? 'on' : 'paused'}</Badge>
        {s.testMode && <Badge tone="blue">Test mode: test accounts only</Badge>}
        <span className="flex-1" />
        <span>{waiting} awaiting processing</span><span>·</span><span>{manual} need manual verification</span><span>·</span><span className={cx(failed && 'font-bold text-red-600')}>{failed} failed</span>
        <Link to="/cybria/ocr" className="font-semibold underline">Settings</Link>
      </div>
    </div>
  );
}

type ExpiryFilter = 'all' | 'valid' | 'd30' | 'd15' | 'd7' | 'expired' | 'none';
type ProcFilter = 'all' | 'waiting' | 'processing' | 'failed' | 'done';

function expiryBucket(r: DocRecord): ExpiryFilter {
  if (!r.verifiedExpiry) return 'none';
  const d = daysUntil(r.verifiedExpiry);
  return d < 0 ? 'expired' : d <= 7 ? 'd7' : d <= 15 ? 'd15' : d <= 30 ? 'd30' : 'valid';
}
function procBucket(s: DocStatus): ProcFilter {
  if (s === 'awaiting_ocr' || s === 'processing_paused' || s === 'uploaded') return 'waiting';
  if (s === 'processing') return 'processing';
  if (s === 'processing_failed') return 'failed';
  return 'done';
}

export function DocumentsTab() {
  const { data: docs } = useAllDocuments();
  const [params, setParams] = useSearchParams();
  const open = params.get('doc');
  const openV = params.get('v') ? Number(params.get('v')) : undefined;
  const [q, setQ] = useState(params.get('instructor') ?? '');
  const [type, setType] = useState<'all' | DocTypeKey>('all');
  const [status, setStatus] = useState<'queue' | 'all' | DocStatus>('queue');
  const [expiry, setExpiry] = useState<ExpiryFilter>('all');
  const [proc, setProc] = useState<ProcFilter>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useMemo(() => docs
    .filter(r => !q || r.instructorName?.toLowerCase().includes(q.toLowerCase()) || r.instructorId === q)
    .filter(r => type === 'all' || r.type === type)
    .filter(r => status === 'all' ? true : status === 'queue' ? REVIEW_QUEUE.includes(r.latestStatus) : recordStatus(r) === status)
    .filter(r => expiry === 'all' || expiryBucket(r) === expiry)
    .filter(r => proc === 'all' || procBucket(r.latestStatus) === proc)
    .filter(r => (!from || (r.uploadedAt && r.uploadedAt >= new Date(from))) && (!to || (r.uploadedAt && r.uploadedAt <= new Date(`${to}T23:59:59`))))
    .sort((a, b) => (b.uploadedAt?.getTime() ?? 0) - (a.uploadedAt?.getTime() ?? 0)), [docs, q, type, status, expiry, proc, from, to]);
  const record = docs.find(r => r.id === open) ?? null;
  const setOpen = (id: string | null) => { const p = new URLSearchParams(params); if (id) p.set('doc', id); else { p.delete('doc'); p.delete('v'); } setParams(p); };

  return (
    <>
      <Card className="mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
          <Input label="Instructor" value={q} onChange={e => setQ(e.target.value)} placeholder="Name" wrapperClassName="lg:col-span-2" />
          <Select label="Document type" value={type} onChange={e => setType(e.target.value as never)}><option value="all">All types</option>{DOC_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}</Select>
          <Select label="Verification status" value={status} onChange={e => setStatus(e.target.value as never)}>
            <option value="queue">Needs action</option><option value="all">All</option>
            {(Object.keys(DOC_STATUS) as DocStatus[]).map(s => <option key={s} value={s}>{DOC_STATUS[s].label}</option>)}
          </Select>
          <Select label="Expiry" value={expiry} onChange={e => setExpiry(e.target.value as ExpiryFilter)}>
            <option value="all">Any</option><option value="d30">Within 30 days</option><option value="d15">Within 15 days</option><option value="d7">Within 7 days</option><option value="expired">Expired</option><option value="valid">Valid (30+ days)</option><option value="none">No verified expiry</option>
          </Select>
          <Select label="Processing" value={proc} onChange={e => setProc(e.target.value as ProcFilter)}>
            <option value="all">Any</option><option value="waiting">Waiting / paused</option><option value="processing">Processing</option><option value="failed">Failed</option><option value="done">Done</option>
          </Select>
          <div className="grid grid-cols-2 gap-2"><Input label="Uploaded from" type="date" value={from} onChange={e => setFrom(e.target.value)} /><Input label="to" type="date" value={to} onChange={e => setTo(e.target.value)} /></div>
        </div>
      </Card>
      <Card>
        {!list.length ? <EmptyState icon={<Files className="size-6" />} title="No documents match" body={status === 'queue' ? 'Nothing is waiting for review.' : undefined} /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-ink-100 text-left text-xs uppercase text-ink-400 dark:border-ink-800"><th className="px-4 py-3">Instructor</th><th className="px-4 py-3">Document</th><th className="px-4 py-3">Uploaded</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Verified expiry</th><th className="px-4 py-3">Warnings</th></tr></thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {list.map(r => {
                  const left = r.verifiedExpiry ? daysUntil(r.verifiedExpiry) : null;
                  return (
                    <tr key={r.id} onClick={() => setOpen(r.id)} className="cursor-pointer hover:bg-ink-50 dark:hover:bg-ink-800/40">
                      <td className="px-4 py-3 font-semibold">{r.instructorName}{r.testAccount && <Badge tone="blue" className="ml-2">Test</Badge>}</td>
                      <td className="px-4 py-3">{docTypeLabel(r.type)} <span className="text-xs text-ink-400">v{r.latestVersion}</span></td>
                      <td className="px-4 py-3">{when(r.uploadedAt)}</td>
                      <td className="px-4 py-3"><DocStatusBadge status={recordStatus(r)} /></td>
                      <td className={cx('px-4 py-3', left !== null && left < 0 && 'font-semibold text-red-600', left !== null && left >= 0 && left <= 30 && 'font-semibold text-amber-600')}>{formatDocDate(r.verifiedExpiry)}</td>
                      <td className="px-4 py-3"><div className="flex flex-wrap gap-1">
                        {!!r.flags?.duplicates && <Badge tone="red"><Copy className="size-3" />{r.flags.duplicates} duplicate</Badge>}
                        {!!r.flags?.risks && <Badge tone="amber"><AlertTriangle className="size-3" />{r.flags.risks} risk</Badge>}
                        {!!r.flags?.mismatches && <Badge tone="amber">{r.flags.mismatches} mismatch</Badge>}
                        {!!r.flags?.quality && <Badge tone="amber"><FileWarning className="size-3" />quality</Badge>}
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <DocumentReview record={record} initialVersion={openV} onClose={() => setOpen(null)} />
    </>
  );
}

export function ComplianceTab({ users }: { users: UserProfile[] }) {
  const { data: docs } = useAllDocuments();
  const settings = useDocumentSettings();
  const { data: reminders } = useDocumentNotifications();
  const [params, setParams] = useSearchParams();
  const [onlyAction, setOnlyAction] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const instructors = users.filter(u => u.role === 'instructor');
  const mandatory = DOC_TYPES.filter(t => settings.requirements[t.key] === 'mandatory');
  const latest = docs;
  const count = (fn: (r: DocRecord) => boolean) => latest.filter(fn).length;
  const left = (r: DocRecord) => (r.verifiedExpiry ? daysUntil(r.verifiedExpiry) : null);
  const rows = instructors.map(u => {
    const mine = docs.filter(d => d.instructorId === u.id);
    const c = computeCompliance(mine.map(d => ({ type: d.type, latestStatus: d.latestStatus, verifiedExpiry: d.verifiedExpiry, hasVerified: d.verifiedVersion != null })), settings.requirements);
    if (u.compliance?.enforced) c.eligible = u.compliance.eligible;
    // Instructors whose documents are only in the earlier records can't be judged until they're imported.
    const known = mine.length > 0 || !!u.compliance?.enforced;
    return { u, mine, c, stored: !!u.compliance?.enforced, known };
  });
  const needing = rows.filter(r => r.known && !r.c.eligible);
  const notImported = rows.filter(r => !r.known).length;
  const focus = params.get('instructor');
  const shown = (focus ? rows.filter(r => r.u.id === focus) : onlyAction ? needing : rows).sort((a, b) => fullName(a.u).localeCompare(fullName(b.u)));

  const cards: { label: string; value: number; icon: React.ReactNode; status?: string }[] = [
    { label: 'Total instructors', value: instructors.length, icon: <UsersIcon className="size-5" /> },
    { label: 'Pending verification', value: count(r => r.latestStatus === 'pending_verification'), icon: <Clock className="size-5" /> },
    { label: 'Verified documents', value: count(r => r.verifiedVersion != null && (left(r) ?? 1) >= 0), icon: <CheckCircle2 className="size-5" /> },
    { label: 'Rejected', value: count(r => r.latestStatus === 'rejected'), icon: <XCircle className="size-5" /> },
    { label: 'Needs instructor correction', value: count(r => r.latestStatus === 'needs_correction' || r.latestStatus === 'reupload_required'), icon: <FileWarning className="size-5" /> },
    { label: 'Expiring within 30 days', value: count(r => { const d = left(r); return d !== null && d >= 0 && d <= 30; }), icon: <CalendarClock className="size-5" /> },
    { label: 'Expiring within 15 days', value: count(r => { const d = left(r); return d !== null && d >= 0 && d <= 15; }), icon: <CalendarClock className="size-5" /> },
    { label: 'Expiring within 7 days', value: count(r => { const d = left(r); return d !== null && d >= 0 && d <= 7; }), icon: <CalendarClock className="size-5" /> },
    { label: 'Expired documents', value: count(r => { const d = left(r); return d !== null && d < 0; }), icon: <CircleSlash className="size-5" /> },
    { label: 'Manual review needed', value: count(r => r.latestStatus === 'manual_verification'), icon: <ShieldAlert className="size-5" /> },
    { label: 'Failed OCR processing', value: count(r => r.latestStatus === 'processing_failed'), icon: <AlertTriangle className="size-5" /> },
    { label: 'Duplicate warnings', value: count(r => !!r.flags?.duplicates), icon: <Copy className="size-5" /> },
    { label: 'Possibly suspicious', value: count(r => !!r.flags?.risks), icon: <AlertTriangle className="size-5" /> },
    { label: 'Incomplete mandatory documents', value: rows.filter(r => r.known && r.c.missing.length).length, icon: <Files className="size-5" /> },
    { label: 'Instructors needing compliance action', value: needing.length, icon: <ShieldAlert className="size-5" /> },
  ];

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map(c => <Stat key={c.label} label={c.label} value={c.value} icon={c.icon} />)}
      </div>
      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-3 border-b border-ink-100 p-4 dark:border-ink-800">
          <h3 className="font-bold">Instructor compliance</h3>
          <span className="text-xs text-ink-500">Mandatory: {mandatory.map(t => t.label).join(', ') || 'none'} (change in Settings){notImported ? ` · ${notImported} instructor${notImported === 1 ? '' : 's'} with earlier records not imported yet` : ''}</span>
          <span className="flex-1" />
          {focus ? <Button size="sm" variant="ghost" onClick={() => { const p = new URLSearchParams(params); p.delete('instructor'); setParams(p); }}>Show all</Button>
            : <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyAction} onChange={e => setOnlyAction(e.target.checked)} />Only instructors needing action</label>}
          <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy === 'expiry'} onClick={async () => {
            setBusy('expiry');
            try { const r = await api.runDocumentExpiryNow({}); toast.success(r.skipped ? r.skipped : `Checked ${r.checked} · ${r.generated} reminder${r.generated === 1 ? '' : 's'} · ${r.statusChanges} status change${r.statusChanges === 1 ? '' : 's'}`); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(null); }
          }}>Run expiry check now</Button>
          <Button size="sm" variant="secondary" icon={<Import className="size-4" />} loading={busy === 'import'} onClick={async () => {
            setBusy('import');
            try { const r = await api.importLegacyDocuments({}); toast.success(`Imported ${r.created} earlier document${r.created === 1 ? '' : 's'} (${r.skipped} already had records)`); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(null); }
          }}>Import earlier documents</Button>
        </div>
        {!shown.length ? <EmptyState icon={<CheckCircle2 className="size-6" />} title="Every instructor meets the mandatory document rules" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-3">Instructor</th><th className="px-4 py-3">Eligibility</th>{mandatory.map(t => <th key={t.key} className="px-4 py-3">{t.label}</th>)}<th className="px-4 py-3">Test account</th></tr></thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {shown.map(({ u, mine, c, stored, known }) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3 font-semibold"><Link to={`/cybria/documents?tab=documents&instructor=${encodeURIComponent(fullName(u))}`} className="underline">{fullName(u)}</Link></td>
                    <td className="px-4 py-3">{!known ? <Badge>Earlier records</Badge> : c.eligible ? <Badge tone="green">Meets rules</Badge> : <Badge tone="red">Action needed</Badge>}
                      {!known ? <span className="block text-xs text-ink-400">Not imported yet</span> : !stored && <span className="block text-xs text-ink-400">{settings.features.eligibilityUpdates ? 'Not yet calculated' : 'Not enforced (updates paused)'}</span>}</td>
                    {mandatory.map(t => {
                      const d = mine.find(x => x.type === t.key);
                      return <td key={t.key} className="px-4 py-3">{d ? <DocStatusBadge status={recordStatus(d)} /> : !known ? <span className="text-xs text-ink-400">Earlier record</span> : c.missing.includes(t.key) ? <Badge>Missing</Badge> : <Badge>Earlier record</Badge>}</td>;
                    })}
                    <td className="px-4 py-3"><input type="checkbox" checked={!!u.testAccount} onChange={async e => {
                      try { await api.setTestAccount({ uid: u.id, testAccount: e.target.checked }); toast.success(e.target.checked ? 'Marked as a test account' : 'No longer a test account'); } catch (err) { toast.error(errorMessage(err)); }
                    }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <div className="border-b border-ink-100 p-4 font-bold dark:border-ink-800">Expiry notification history</div>
        {!reminders.length ? <EmptyState icon={<CalendarClock className="size-6" />} title="No expiry reminders yet" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-3">Created</th><th className="px-4 py-3">Instructor</th><th className="px-4 py-3">Document</th><th className="px-4 py-3">Reminder</th><th className="px-4 py-3">Expiry</th><th className="px-4 py-3">Dashboard</th><th className="px-4 py-3">Email</th></tr></thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {reminders.map(r => (
                  <tr key={r.id}><td className="px-4 py-2">{r.createdAt ? r.createdAt.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td><td className="px-4 py-2">{r.instructorName}</td><td className="px-4 py-2">{docTypeLabel(r.type)}</td>
                    <td className="px-4 py-2">{r.stageLabel}</td><td className="px-4 py-2">{formatDocDate(r.expiry)}</td><td className="px-4 py-2"><Badge tone="green">Instructor + admin</Badge></td>
                    <td className="px-4 py-2">{r.email?.status === 'sent' ? <Badge tone="green">Sent</Badge> : r.email?.status === 'not_configured' ? <Badge>Email service not set up</Badge> : r.email?.status === 'failed' ? <Badge tone="red">Failed ({r.email.attempts})</Badge> : <Badge>{r.email?.status ?? '—'}</Badge>}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
