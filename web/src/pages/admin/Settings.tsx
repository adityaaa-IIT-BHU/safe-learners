// Admin → Settings → Document Verification Settings. Every switch is enforced on the server; this page
// only asks for confirmation (explaining the impact) and records who changed what and why.
import { collection, limit, query, where } from 'firebase/firestore';
import { FlaskConical, Gauge, History, Pause, Play, ScanText, Settings2, ShieldCheck, Workflow } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DOC_TYPES, FEATURE_INFO, isActive, type AutomationFeature, type DocTypeKey, type DocumentSettings } from '@shared/documents';
import { Badge, Button, Card, CardHeader, Input, Modal, PageHeader, Select, Tabs, Textarea, cx } from '@/components/ui';
import { useSearchParams } from 'react-router-dom';
import { CommissionManagement } from './CommissionManagement';
import { api, errorMessage } from '@/lib/api';
import { toDate, useQuery } from '@/lib/data';
import { useDocumentSettings } from '@/lib/documents';
import { db } from '@/lib/firebase';

interface Pending { patch: Record<string, unknown>; title: string; body: string; action: string }

const IMPACT: Record<string, { pause: string; resume: string }> = {
  ocr: {
    pause: 'New documents will continue to be uploaded and securely stored, but automatic document reading will stop. Pending OCR jobs will be preserved and can be processed when OCR is resumed.',
    resume: 'Documents waiting for OCR will be read now, and new uploads will be read automatically. Each document is read only once, so nothing is processed twice.',
  },
  automation: {
    pause: 'All new automated document processing stops. Uploads, secure storage, existing records and manual verification stay available, and no documents or history are deleted. Waiting jobs are kept. Expiry monitoring and eligibility updates follow their own settings.',
    resume: 'Waiting documents will be processed using the individual settings below, then new uploads automatically. Nothing is processed twice.',
  },
  expiryMonitoring: {
    pause: 'No expiry reminders will be created and Expiring soon / Expired statuses won’t update until this is resumed. Existing documents and reminder history are not changed.',
    resume: 'Verified documents will be checked for expiry again on the next run (hourly). Reminders already sent are not sent again.',
  },
  eligibilityUpdates: {
    pause: 'Instructor eligibility stays exactly as it is now. Nobody is blocked or unblocked automatically until this is resumed.',
    resume: 'Eligibility will be recalculated for every instructor now, using the mandatory documents below. Instructors with an expired or missing mandatory document can’t take new bookings.',
  },
};
const label = (k: string) => (k === 'automation' ? 'Complete document automation' : FEATURE_INFO.find(f => f.key === k)?.label ?? k);

export function AdminSettings() {
  const [params, setParams] = useSearchParams();
  const section = params.get('section') === 'commission' ? 'commission' : 'documents';
  return (
    <>
      <PageHeader title="Settings" subtitle={section === 'commission' ? 'Commission Management' : 'Document Verification Settings'} />
      <Tabs value={section} onChange={v => setParams({ section: v })} tabs={[
        { value: 'documents', label: 'Document verification' },
        { value: 'commission', label: 'Commission management' },
      ]} />
      <div className="mt-4">{section === 'commission' ? <CommissionManagement /> : <DocumentVerificationSettings />}</div>
    </>
  );
}

function DocumentVerificationSettings() {
  const s = useDocumentSettings();
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<{ pages: number; estimatedUsd: number; queued: number; waiting: number; failed: number } | null>(null);
  const [limitDraft, setLimitDraft] = useState<string>('');
  const [reqDraft, setReqDraft] = useState<DocumentSettings['requirements'] | null>(null);
  const { data: history } = useQuery(query(collection(db, 'documentAudit'), where('action', '==', 'settings_changed'), limit(100)),
    (id, d) => ({ id, ...d, at: toDate(d.at) } as Record<string, any> & { id: string }), 'audit:settings');
  useEffect(() => { api.documentUsage({}).then(setUsage).catch(() => undefined); }, [s]);
  useEffect(() => { setLimitDraft(String(s.monthlyPageLimit)); setReqDraft(null); }, [s.monthlyPageLimit, JSON.stringify(s.requirements)]);

  const ask = (key: 'automation' | AutomationFeature | 'testMode', next: boolean) => {
    const patch = key === 'automation' || key === 'testMode' ? { [key]: next } : { features: { [key]: next } };
    const impact = IMPACT[key]?.[next ? 'resume' : 'pause']
      ?? (key === 'testMode'
        ? next ? 'Automation, expiry reminders and eligibility changes will apply only to accounts marked as test accounts.' : 'Automation, expiry reminders and eligibility changes will apply to every instructor. Make sure the business has approved this.'
        : next ? `${label(key)} will run for documents processed from now on.` : `${label(key)} will be skipped for documents processed from now on. Existing results are kept.`);
    const verb = key === 'testMode' ? (next ? 'Turn on test mode' : 'Turn off test mode') : `${next ? 'Resume' : 'Pause'} ${label(key)}`;
    setReason('');
    setPending({ patch, title: `${verb}?`, body: impact, action: verb });
  };

  const save = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await api.saveDocumentSettings({ settings: pending.patch, reason: reason.trim() || undefined });
      toast.success(r.changes ? 'Settings saved' : 'No changes');
      setPending(null);
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  const Switch = ({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) => (
    <Button size="sm" variant={on ? 'secondary' : 'primary'} disabled={disabled} icon={on ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={onClick}>{on ? 'Pause' : 'Enable'}</Button>
  );

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><ScanText className="size-5" />OCR status</span>} subtitle="Automatic reading of uploaded documents" />
          <div className="flex flex-wrap items-center gap-4 p-5">
            <span className={cx('rounded-xl px-4 py-2 text-lg font-extrabold tracking-wide', isActive(s, 'ocr') ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200')}>
              {s.features.ocr ? (s.automation ? 'ENABLED' : 'ENABLED (automation paused)') : 'PAUSED'}
            </span>
            <span className="flex-1 text-sm text-ink-500">{s.features.ocr ? 'New uploads are read automatically.' : 'Uploads are stored and wait as Awaiting OCR.'}</span>
            <Button variant={s.features.ocr ? 'secondary' : 'primary'} icon={s.features.ocr ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={() => ask('ocr', !s.features.ocr)}>{s.features.ocr ? 'Pause OCR' : 'Resume OCR'}</Button>
          </div>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Workflow className="size-5" />Complete document automation</span>} subtitle="Master switch for all automated document processing" />
          <div className="flex flex-wrap items-center gap-4 p-5">
            <span className={cx('rounded-xl px-4 py-2 text-lg font-extrabold tracking-wide', s.automation ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300')}>{s.automation ? 'ENABLED' : 'PAUSED'}</span>
            <span className="flex-1 text-sm text-ink-500">{s.automation ? 'Processing runs using the individual settings below.' : 'Document Automation Paused – Manual Verification Available'}</span>
            <Button variant={s.automation ? 'secondary' : 'primary'} icon={s.automation ? <Pause className="size-4" /> : <Play className="size-4" />} onClick={() => ask('automation', !s.automation)}>{s.automation ? 'Pause automation' : 'Resume automation'}</Button>
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title={<span className="flex items-center gap-2"><Settings2 className="size-5" />Individual automation controls</span>}
          subtitle="Processing steps need the master switch. Expiry monitoring and eligibility updates run independently of OCR and automation." />
        <div className="divide-y divide-ink-100 dark:divide-ink-800">
          {FEATURE_INFO.map(f => {
            const on = s.features[f.key];
            const effective = isActive(s, f.key);
            return (
              <div key={f.key} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{f.label} {!f.master && <Badge tone="blue">Independent</Badge>}</p>
                  <p className="text-xs text-ink-500">{f.help}</p>
                </div>
                <Badge tone={effective ? 'green' : on ? 'amber' : 'slate'}>{effective ? 'Active' : on ? 'Enabled · waiting for automation' : 'Paused'}</Badge>
                <Switch on={on} onClick={() => ask(f.key, !on)} />
              </div>
            );
          })}
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><FlaskConical className="size-5" />Test mode</span>} subtitle="Safe testing before automation is used on real instructor records" />
          <div className="space-y-3 p-5 text-sm">
            <p>{s.testMode ? 'ON — automation, expiry reminders and eligibility changes apply only to accounts marked as test accounts (Verifications → Compliance). Everyone else is reviewed manually as before.' : 'OFF — automation applies to every instructor.'}</p>
            <Button variant="secondary" onClick={() => ask('testMode', !s.testMode)}>{s.testMode ? 'Turn off test mode' : 'Turn on test mode'}</Button>
          </div>
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Gauge className="size-5" />OCR usage this month</span>} subtitle="Automatic OCR waits when the monthly page limit is reached" />
          <div className="space-y-3 p-5 text-sm">
            <p><strong>{usage?.pages ?? '…'}</strong> pages read · estimated cost <strong>US${usage ? usage.estimatedUsd.toFixed(2) : '…'}</strong> <span className="text-xs text-ink-500">(estimate; repeated files are reused, not re-read)</span></p>
            <p className="text-xs text-ink-500">Queue: {usage?.queued ?? '…'} open ({usage?.waiting ?? '…'} waiting) · {usage?.failed ?? '…'} failed</p>
            <div className="flex items-end gap-2">
              <Input label="Monthly page limit (0 = no limit)" type="number" min={0} value={limitDraft} onChange={e => setLimitDraft(e.target.value)} wrapperClassName="w-60" />
              <Button variant="secondary" disabled={Number(limitDraft) === s.monthlyPageLimit || !(Number(limitDraft) >= 0)} onClick={() => { setReason(''); setPending({ patch: { monthlyPageLimit: Math.floor(Number(limitDraft)) }, title: 'Change the monthly OCR page limit?', body: `Automatic OCR will wait once ${Number(limitDraft) || 'unlimited'} pages have been read in a month. Waiting documents can still be reviewed manually.`, action: 'Save limit' }); }}>Save</Button>
            </div>
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title={<span className="flex items-center gap-2"><ShieldCheck className="size-5" />Mandatory documents</span>}
          subtitle="Used by automatic eligibility updates. Optional documents never block an instructor. These rules must be approved by the business — the system does not decide legal requirements." />
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {DOC_TYPES.map(t => (
            <Select key={t.key} label={t.label} value={(reqDraft ?? s.requirements)[t.key]} onChange={e => setReqDraft({ ...(reqDraft ?? s.requirements), [t.key]: e.target.value as 'mandatory' | 'optional' })}>
              <option value="mandatory">Mandatory</option><option value="optional">Optional</option>
            </Select>
          ))}
        </div>
        <div className="px-5 pb-5">
          <Button variant="secondary" disabled={!reqDraft} onClick={() => {
            const changed = (Object.keys(reqDraft!) as DocTypeKey[]).filter(k => reqDraft![k] !== s.requirements[k]);
            setReason('');
            setPending({ patch: { requirements: reqDraft }, title: 'Change mandatory documents?', action: 'Save requirements',
              body: `${changed.map(k => `${DOC_TYPES.find(t => t.key === k)!.label}: ${reqDraft![k]}`).join(' · ')}. ${s.features.eligibilityUpdates ? 'Eligibility will be recalculated for every instructor now.' : 'Eligibility updates are paused, so nobody’s eligibility changes until they are resumed.'}` });
          }}>Save requirements</Button>
        </div>
      </Card>

      <Card className="mt-4">
        <CardHeader title={<span className="flex items-center gap-2"><History className="size-5" />Settings history</span>} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-5 py-2">When</th><th className="px-5 py-2">Administrator</th><th className="px-5 py-2">Setting</th><th className="px-5 py-2">Before</th><th className="px-5 py-2">After</th><th className="px-5 py-2">Reason</th></tr></thead>
            <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
              {[...history].sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0)).map(h => {
                const key = h.details?.setting as string;
                const fmt = (o: any) => { const v = o?.[key]; return typeof v === 'boolean' ? (v ? (key === 'testMode' ? 'On' : 'Enabled') : (key === 'testMode' ? 'Off' : 'Paused')) : String(v ?? '—'); };
                return <tr key={h.id}><td className="px-5 py-2">{h.at ? h.at.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td><td className="px-5 py-2">{h.actor?.name}</td><td className="px-5 py-2">{key?.startsWith('requirements.') ? `Mandatory: ${DOC_TYPES.find(t => t.key === key.split('.')[1])?.label}` : key === 'monthlyPageLimit' ? 'Monthly page limit' : key === 'testMode' ? 'Test mode' : label(key)}</td><td className="px-5 py-2">{fmt(h.before)}</td><td className="px-5 py-2">{fmt(h.after)}</td><td className="px-5 py-2">{h.reason ?? '—'}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={!!pending} onClose={() => setPending(null)} title={pending?.title ?? ''}
        footer={<><Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button><Button loading={busy} onClick={save}>{pending?.action ?? 'Confirm'}</Button></>}>
        <p className="mb-3 text-sm">{pending?.body}</p>
        <Textarea label="Reason (recorded in the audit log)" value={reason} onChange={e => setReason(e.target.value)} placeholder="Optional" />
      </Modal>
    </>
  );
}
