import { AlertTriangle, BadgeCheck, CheckCircle2, Clock, FileUp, History, Loader2, ScanText, ShieldAlert, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  DOC_TYPES,
  LEGACY_DOC_TYPES,
  daysUntil,
  describeDaysLeft,
  docTypeLabel,
  formatDocDate,
  type DocStatus,
  type DocTypeInfo,
  type DocTypeKey,
} from '@shared/documents';
import { isExpired, legacyVerificationDocs, normaliseExpiry, type DocumentReview, type VerificationDocument } from '@shared/domain';
import { dayKey } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Badge, Button, ButtonLink, Card, CardHeader, Input, PageHeader, Select, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useDoc, usePrivateProfile } from '@/lib/data';
import { db } from '@/lib/firebase';
import { doc } from 'firebase/firestore';
import { DocStatusBadge, DocumentViewer, FileButton, recordStatus, useDocumentSettings, useInstructorDocuments, useVersions, type DocRecord } from '@/lib/documents';
import { uploadPrivateDocument } from '@/lib/upload';

const STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT'];
const ACCEPT = 'image/jpeg,image/png,application/pdf';

export function Verification() {
  const me = useProfile();
  const { readOnly } = useAuth();
  const { data: priv } = usePrivateProfile(me.id);
  const { data: records } = useInstructorDocuments(me.id);
  const settings = useDocumentSettings();
  const [params] = useSearchParams();
  const focus = params.get('doc');
  const legacy = { ...legacyVerificationDocs(priv?.legacy), ...((priv?.verification ?? {}) as Record<string, VerificationDocument>) } as Partial<Record<DocTypeKey, VerificationDocument>>;
  const status = me.verificationStatus ?? 'not_submitted';
  const recordOf = (t: DocTypeKey) => records.find(r => r.type === t);
  const core = DOC_TYPES.filter(t => LEGACY_DOC_TYPES.includes(t.key) || settings.requirements[t.key] === 'mandatory');
  const extra = DOC_TYPES.filter(t => !core.includes(t));
  const has = (t: DocTypeKey) => {
    const d = legacy[t];
    return !!(recordOf(t) || ((d?.url || d?.path) && d?.expiry && !isExpired(d.expiry)));
  };
  const complete = core.filter(t => has(t.key)).length;
  const [submitting, setSubmitting] = useState(false);
  const { data: detail } = useDoc(doc(db, 'users', me.id, 'private', 'compliance'), (_, d) => d as { missing?: DocTypeKey[]; pending?: DocTypeKey[]; rejected?: DocTypeKey[]; expired?: DocTypeKey[] });
  const compliance = me.compliance ? { ...me.compliance, missing: detail?.missing ?? [], pending: detail?.pending ?? [], rejected: detail?.rejected ?? [], expired: detail?.expired ?? [] } : undefined;

  return (
    <>
      <PageHeader title="Documents & verification" subtitle="We check every instructor before they can take bookings. Your documents are private — only Safe Learners admins can see them." />
      <StatusPanel status={status} reason={me.verificationRejectionReason} />
      {compliance?.enforced && !compliance.eligible && status === 'verified' && (
        <div className="mb-6 flex items-start gap-3 rounded-2xl bg-red-50 p-4 text-sm text-red-900 dark:bg-red-500/10 dark:text-red-200">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" />
          <p><strong>New bookings are paused.</strong> {[
            compliance.expired.length ? `Expired: ${compliance.expired.map(docTypeLabel).join(', ')}.` : '',
            compliance.missing.length ? `Missing: ${compliance.missing.map(docTypeLabel).join(', ')}.` : '',
            compliance.rejected.length ? `Needs a new upload: ${compliance.rejected.map(docTypeLabel).join(', ')}.` : '',
            compliance.pending.length ? `Waiting for review: ${compliance.pending.map(docTypeLabel).join(', ')}.` : '',
          ].filter(Boolean).join(' ')} Existing lessons are not affected.</p>
        </div>
      )}

      <div className="mb-6 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
          <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${(complete / Math.max(1, core.length)) * 100}%` }} />
        </div>
        <span className="text-sm font-semibold">{complete}/{core.length} required documents</span>
      </div>

      <div className="grid grid-cols-1 gap-4 [&>*]:min-w-0 lg:grid-cols-2">
        {core.map(t => (
          <DocumentCard key={t.key} uid={me.id} info={t} record={recordOf(t.key)} legacy={legacy[t.key]} review={me.documentReviews?.[t.key as keyof typeof me.documentReviews]}
            verified={status === 'verified'} readOnly={readOnly} mandatory={settings.requirements[t.key] === 'mandatory'} focus={focus === t.key} />
        ))}
      </div>

      <h2 className="mb-3 mt-8 text-lg font-bold">Additional documents</h2>
      <p className="mb-4 text-sm text-ink-500">Optional unless the Safe Learners team asks for them.</p>
      <div className="grid grid-cols-1 gap-4 [&>*]:min-w-0 lg:grid-cols-2">
        {extra.map(t => (
          <DocumentCard key={t.key} uid={me.id} info={t} record={recordOf(t.key)} verified={status === 'verified'} readOnly={readOnly} mandatory={false} focus={focus === t.key} />
        ))}
      </div>

      {(status === 'not_submitted' || status === 'rejected') && (
        <div className="mt-6 flex justify-end">
          <Button size="lg" icon={<BadgeCheck className="size-5" />} disabled={complete < core.length || readOnly} loading={submitting} onClick={async () => {
            setSubmitting(true);
            try {
              await api.submitVerification({});
              toast.success('Submitted! We’ll let you know as soon as you’re approved.');
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setSubmitting(false);
            }
          }}>Submit for review</Button>
        </div>
      )}
    </>
  );
}

function StatusPanel({ status, reason }: { status: string; reason?: string }) {
  if (status === 'verified') {
    return (
      <div className="mb-6 flex items-center gap-4 rounded-2xl bg-emerald-50 p-5 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200">
        <BadgeCheck className="size-8 shrink-0" />
        <div className="flex-1"><p className="font-bold">You’re verified</p><p className="text-sm opacity-80">Learners can find and book you. When a document is renewed, submit the new one below — you stay bookable while we review it.</p></div>
        <ButtonLink to="/instructor" variant="secondary" size="sm">Dashboard</ButtonLink>
      </div>
    );
  }
  if (status === 'pending_review') {
    return <div className="mb-6 flex items-center gap-4 rounded-2xl bg-sky-50 p-5 text-sky-900 dark:bg-sky-500/10 dark:text-sky-200"><Clock className="size-8 shrink-0" /><div><p className="font-bold">Under review</p><p className="text-sm opacity-80">An admin is checking your documents. You’ll get a notification when it’s done.</p></div></div>;
  }
  if (status === 'rejected') {
    return <div className="mb-6 flex items-center gap-4 rounded-2xl bg-red-50 p-5 text-red-900 dark:bg-red-500/10 dark:text-red-200"><ShieldAlert className="size-8 shrink-0" /><div><p className="font-bold">Changes needed</p><p className="text-sm opacity-80">{reason || 'Please check your documents and resubmit.'}</p></div></div>;
  }
  return null;
}

function legacyBadge(value: VerificationDocument | undefined, review: DocumentReview | undefined, verified: boolean) {
  if (!value?.url && !value?.path) return <Badge>Not provided</Badge>;
  if (isExpired(value.expiry)) return <Badge tone="red">Expired</Badge>;
  if (review?.status === 'pending') return <Badge tone="amber">Under review</Badge>;
  if (review?.status === 'rejected') return <Badge tone="red">Needs changes</Badge>;
  if (review?.status === 'approved' || verified) return <Badge tone="green"><CheckCircle2 className="size-3" />Approved</Badge>;
  return <Badge tone="blue">Saved</Badge>;
}

interface Picked { path: string; name: string; contentType: string }

function DocumentCard({ uid, info, record, legacy, review, verified, readOnly, mandatory, focus }: {
  uid: string; info: DocTypeInfo; record?: DocRecord; legacy?: VerificationDocument; review?: DocumentReview; verified: boolean; readOnly: boolean; mandatory: boolean; focus: boolean;
}) {
  const hasAny = !!record || !!(legacy?.url || legacy?.path);
  const [editingChoice, setEditing] = useState<boolean | null>(null);
  const editing = editingChoice ?? (!hasAny && mandatory);
  const [showHistory, setShowHistory] = useState(false);
  const [viewer, setViewer] = useState<{ version?: number; index?: number; url?: string } | null>(null);
  const [front, setFront] = useState<Picked | null>(null);
  const [back, setBack] = useState<Picked | null>(null);
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [state, setState] = useState('NSW');
  const [uploading, setUploading] = useState<'front' | 'back' | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const frontInput = useRef<HTMLInputElement>(null);
  const backInput = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const { data: versions } = useVersions(record?.id ?? null);
  const latest = versions[0];
  const current = record?.verifiedVersion ? versions.find(v => v.n === record.verifiedVersion) : undefined;

  useEffect(() => { if (focus) card.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [focus]);

  const pick = async (side: 'front' | 'back', file: File | undefined) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(file.type)) return toast.error('Please choose a JPG, PNG or PDF file.');
    if (file.size > 10 * 1024 * 1024) return toast.error('The file is larger than 10 MB.');
    setUploading(side);
    try {
      const ext = file.type === 'application/pdf' ? 'pdf' : file.type === 'image/png' ? 'png' : 'jpg';
      const path = `verification-documents/${uid}/${info.key}/${Date.now()}-${side}.${ext}`;
      await uploadPrivateDocument(path, file);
      (side === 'front' ? setFront : setBack)({ path, name: file.name, contentType: file.type });
      if (side === 'front' && LEGACY_DOC_TYPES.includes(info.key)) void scan(path);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(null);
    }
  };

  // Suggests details from the photo (only when OCR is switched on); the instructor confirms them.
  const scan = async (path: string) => {
    setScanning(true);
    setScanNote(null);
    try {
      const res = await api.scanDocument({ key: info.key as never, path });
      if (res.found) {
        if (res.number) setNumber(n => n || res.number!);
        if (res.expiry) setExpiry(e => e || res.expiry!);
        if (res.state && info.needsState) setState(res.state);
        setScanNote('We read these details from your photo — please check they’re correct.');
      } else if (res.reason !== 'paused') {
        setScanNote(res.reason === 'pdf' ? 'Please enter the details from your PDF.' : 'We couldn’t read the details automatically — please enter them.');
      }
    } catch {
      setScanNote(null);
    } finally {
      setScanning(false);
    }
  };

  const save = async () => {
    if (!front) return toast.error('Please upload a photo or PDF of the document.');
    if (info.key !== 'other' && !number.trim()) return toast.error('Please enter the document number.');
    const iso = expiry ? normaliseExpiry(expiry) : null;
    if (info.expiryRequired && !iso) return toast.error('Please enter the expiry date with a 4-digit year, e.g. 30/06/2029.');
    if (iso && isExpired(iso)) return toast.error('The expiry date is in the past. Please check it, or renew the document first.');
    setSaving(true);
    try {
      await api.uploadDocumentVersion({
        type: info.key,
        files: [{ ...front, side: 'front' }, ...(back ? [{ ...back, side: 'back' }] : [])],
        number: number.trim() || undefined,
        expiry: iso ?? undefined,
        state: info.needsState ? state : undefined,
      });
      toast.success(verified ? `${info.label} sent for review. You stay bookable meanwhile.` : `${info.label} saved`);
      setEditing(false); setFront(null); setBack(null); setScanNote(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const startEditing = () => { setNumber(''); setExpiry(''); setState(legacy?.state ?? 'NSW'); setEditing(true); };

  const status: DocStatus | null = record ? recordStatus(record) : null;
  const shownNumber = record ? (current?.approved?.number ?? latest?.entered?.number) : legacy?.number;
  const shownExpiry = record ? (record.verifiedExpiry ?? latest?.entered?.expiry ?? null) : normaliseExpiry(legacy?.expiry);
  const left = shownExpiry ? daysUntil(shownExpiry) : null;
  const needsAction = latest && ['needs_correction', 'reupload_required', 'rejected'].includes(latest.status) && latest.n === record?.latestVersion;

  return (
    <Card>
      <div ref={card} data-doc={info.key} className={cx(focus && 'rounded-2xl ring-2 ring-brand-500')}>
        <CardHeader
          title={<span className="flex items-center gap-2"><FileUp className="size-5 text-ink-400" />{info.label}{mandatory && <span className="text-xs font-semibold text-ink-400">Required</span>}</span>}
          subtitle={info.hint}
          action={status ? <DocStatusBadge status={status} instructor /> : legacyBadge(legacy, review, verified)}
        />
        <div className="space-y-4 p-5">
          {(record || legacy?.url || legacy?.path) && (
            <dl className="grid grid-cols-2 gap-3 rounded-xl bg-ink-50 p-4 text-sm dark:bg-ink-800/60">
              <div><dt className="text-xs font-semibold uppercase text-ink-400">Number</dt><dd className="font-semibold">{shownNumber || '—'}</dd></div>
              <div><dt className="text-xs font-semibold uppercase text-ink-400">Expires</dt>
                <dd className={cx('font-semibold', left !== null && left < 0 && 'text-red-600', left !== null && left >= 0 && left <= 30 && 'text-amber-600')}>{shownExpiry ? `${formatDocDate(shownExpiry)}${left !== null && left <= 30 ? ` (${describeDaysLeft(left)})` : ''}` : '—'}</dd></div>
              <div className="col-span-2 flex flex-wrap gap-3">
                {record && latest
                  ? latest.files.map((f, i) => <FileButton key={i} label={latest.files.length > 1 ? (f.side === 'back' ? 'Back' : 'Front') : 'View document'} onClick={() => setViewer(f.url ? { url: f.url } : { version: latest.n, index: i })} />)
                  : <>
                      {legacy?.url && <FileButton label={legacy.backUrl ? 'Front' : 'View document'} onClick={() => setViewer({ url: legacy.url })} />}
                      {legacy?.backUrl && <FileButton label="Back" onClick={() => setViewer({ url: legacy.backUrl })} />}
                    </>}
              </div>
              {needsAction && latest.decision?.reason && <p className="col-span-2 text-xs text-red-700 dark:text-red-300">Admin note: {latest.decision.reason}</p>}
              {!needsAction && review?.status === 'rejected' && review.note && !record && <p className="col-span-2 text-xs text-red-700">Admin note: {review.note}</p>}
              {latest?.instructorMessage && latest.n === record?.latestVersion && !['verified', 'rejected'].includes(latest.status) && (
                <p className="col-span-2 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-300"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{latest.instructorMessage}</p>
              )}
              {record && record.verifiedVersion && record.latestVersion !== record.verifiedVersion && (
                <p className="col-span-2 text-xs text-ink-500">Your verified document (version {record.verifiedVersion}) stays in use while the new upload is reviewed.</p>
              )}
            </dl>
          )}

          {!editing ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="dark" icon={<Upload className="size-4" />} disabled={readOnly} onClick={startEditing}>{hasAny ? 'Submit new document' : 'Upload document'}</Button>
              {versions.length > 1 && <Button size="sm" variant="ghost" icon={<History className="size-4" />} onClick={() => setShowHistory(h => !h)}>History ({versions.length})</Button>}
            </div>
          ) : (
            <div className="space-y-3 rounded-xl border border-ink-200 p-4 dark:border-ink-700">
              <div className={cx('grid gap-2', info.twoSided && 'sm:grid-cols-2')}>
                <UploadBox label={info.twoSided ? 'Front' : 'Photo or PDF'} file={front} busy={uploading === 'front'} disabled={readOnly} onClick={() => frontInput.current?.click()} />
                {info.twoSided && <UploadBox label="Back" file={back} busy={uploading === 'back'} disabled={readOnly} onClick={() => backInput.current?.click()} />}
              </div>
              <input ref={frontInput} type="file" accept={ACCEPT} hidden onChange={e => pick('front', e.target.files?.[0])} />
              <input ref={backInput} type="file" accept={ACCEPT} hidden onChange={e => pick('back', e.target.files?.[0])} />
              <p className="text-xs text-ink-500">JPG, PNG or PDF, up to 10 MB. Make sure the whole document is in view, sharp and without glare.</p>
              {scanning && <p className="flex items-center gap-2 text-xs font-semibold text-ink-500"><Loader2 className="size-3.5 animate-spin" />Reading your document…</p>}
              {scanNote && !scanning && <p className="flex items-center gap-2 text-xs text-sky-800 dark:text-sky-300"><ScanText className="size-3.5" />{scanNote}</p>}
              <div className="grid gap-3 sm:grid-cols-3">
                <Input label={info.key === 'other' ? 'Number (if any)' : 'Number'} value={number} onChange={e => setNumber(e.target.value)} disabled={readOnly} wrapperClassName={info.needsState ? '' : 'sm:col-span-2'} />
                {info.needsState && <Select label="State" value={state} onChange={e => setState(e.target.value)} disabled={readOnly}>{STATES.map(s => <option key={s}>{s}</option>)}</Select>}
                <Input label={info.expiryRequired ? 'Expiry' : 'Expiry (if shown)'} type="date" min={dayKey(new Date())} max="2100-12-31" value={expiry}
                  onChange={e => setExpiry(e.target.value)} onBlur={e => { const iso = normaliseExpiry(e.target.value); if (iso && iso !== e.target.value) setExpiry(iso); }} disabled={readOnly} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" loading={saving} disabled={readOnly || !!uploading} onClick={save}>{verified ? 'Send for review' : 'Save document'}</Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setFront(null); setBack(null); setScanNote(null); }}>Cancel</Button>
              </div>
            </div>
          )}

          {showHistory && (
            <div className="overflow-x-auto border-t border-ink-100 pt-3 dark:border-ink-800">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="pb-1.5">Version</th><th className="pb-1.5">Uploaded</th><th className="pb-1.5">Expiry</th><th className="pb-1.5">Status</th><th /></tr></thead>
                <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                  {versions.map(v => (
                    <tr key={v.id}>
                      <td className="py-2">{v.n}</td>
                      <td className="py-2">{v.uploadedAt ? v.uploadedAt.toLocaleDateString('en-AU') : '—'}</td>
                      <td className="py-2">{formatDocDate(v.approved?.expiry ?? v.entered?.expiry ?? null)}</td>
                      <td className="py-2"><DocStatusBadge status={v.status} instructor /></td>
                      <td className="py-2 text-right">{v.files[0] && <button onClick={() => setViewer(v.files[0].url ? { url: v.files[0].url } : { version: v.n, index: 0 })} className="text-xs font-bold underline">View</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <DocumentViewer open={!!viewer} onClose={() => setViewer(null)} docId={record?.id} version={viewer?.version} index={viewer?.index} legacyUrl={viewer?.url} title={info.label} />
    </Card>
  );
}

function UploadBox({ label, file, busy, disabled, onClick }: { label: string; file: { name: string } | null; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled || busy} onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border-2 border-dashed border-ink-200 p-3 text-left text-sm transition hover:border-ink-400 disabled:opacity-60 dark:border-ink-700">
      {busy ? <Loader2 className="size-5 shrink-0 animate-spin text-ink-400" /> : file ? <CheckCircle2 className="size-5 shrink-0 text-emerald-600" /> : <FileUp className="size-5 shrink-0 text-ink-400" />}
      <span className="min-w-0 flex-1 truncate"><strong>{label}:</strong> {busy ? 'Uploading…' : file ? file.name : 'tap to upload'}</span>
    </button>
  );
}
