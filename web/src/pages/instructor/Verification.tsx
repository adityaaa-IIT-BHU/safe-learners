import { doc, setDoc } from 'firebase/firestore';
import { BadgeCheck, CheckCircle2, Clock, ExternalLink, FileUp, History, Loader2, ScanText, ShieldAlert, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  VERIFICATION_STEPS,
  isExpired,
  legacyVerificationDocs,
  normaliseExpiry,
  type DocumentReview,
  type VerificationDocument,
  type VerificationStepKey,
} from '@shared/domain';
import { dayKey } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Badge, Button, ButtonLink, Card, CardHeader, Input, Modal, PageHeader, Select, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { toDate, useDoc } from '@/lib/data';
import { db } from '@/lib/firebase';
import { uploadFile } from '@/lib/upload';

type Docs = Partial<Record<VerificationStepKey, VerificationDocument>>;
interface HistoryEntry extends VerificationDocument { key: VerificationStepKey; replacedAt?: Date; status?: DocumentReview['status'] }

const STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT'];
const NEEDS_STATE: VerificationStepKey[] = ['driverLicence', 'instructorLicence', 'wwc'];
const HAS_BACK: VerificationStepKey[] = ['driverLicence'];

const formatExpiry = (v?: string) => {
  const iso = normaliseExpiry(v);
  return iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : v ?? '—';
};


export function Verification() {
  const me = useProfile();
  const { readOnly } = useAuth();
  const { data: priv } = useDoc(doc(db, 'users', me.id, 'private', 'profile'), (_, d) => {
    const v = (d.verification ?? {}) as Record<string, Record<string, unknown>>;
    return {
      docs: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, { ...x, submittedAt: toDate(x.submittedAt) }])) as Docs,
      history: ((d.verificationHistory ?? []) as Record<string, unknown>[]).map(h => ({ ...h, submittedAt: toDate(h.submittedAt), replacedAt: toDate(h.replacedAt) })) as HistoryEntry[],
      // Documents uploaded on the previous website.
      legacy: legacyVerificationDocs(d.legacy as Record<string, unknown> | undefined),
    };
  });
  const docs = priv?.docs ?? {};
  const legacy = priv?.legacy ?? {};
  const status = me.verificationStatus ?? 'not_submitted';
  const current = (key: VerificationStepKey) => docs[key] ?? legacy[key];
  const complete = VERIFICATION_STEPS.filter(s => current(s.key)?.url && current(s.key)?.expiry && !isExpired(current(s.key)?.expiry)).length;
  const [submitting, setSubmitting] = useState(false);

  return (
    <>
      <PageHeader title="Documents & verification" subtitle="We check every instructor before they can take bookings. Your documents are private — only Safe Learners admins can see them." />
      <StatusPanel status={status} reason={me.verificationRejectionReason} />

      <div className="mb-6 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800">
          <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${(complete / VERIFICATION_STEPS.length) * 100}%` }} />
        </div>
        <span className="text-sm font-semibold">{complete}/{VERIFICATION_STEPS.length} current documents</span>
      </div>

      <div className="grid grid-cols-1 gap-4 [&>*]:min-w-0 lg:grid-cols-2">
        {VERIFICATION_STEPS.map(step => (
          <DocumentCard
            key={step.key}
            uid={me.id}
            step={step}
            value={current(step.key)}
            isLegacy={!docs[step.key] && !!legacy[step.key]}
            review={me.documentReviews?.[step.key]}
            verified={status === 'verified'}
            allDocs={docs}
            history={(priv?.history ?? []).filter(h => h.key === step.key)}
            readOnly={readOnly}
          />
        ))}
      </div>

      {(status === 'not_submitted' || status === 'rejected') && (
        <div className="mt-6 flex justify-end">
          <Button size="lg" icon={<BadgeCheck className="size-5" />} disabled={complete < VERIFICATION_STEPS.length || readOnly} loading={submitting} onClick={async () => {
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

function statusBadge(value: VerificationDocument | undefined, review: DocumentReview | undefined, isLegacy: boolean, verified: boolean) {
  if (!value?.url) return <Badge>Not provided</Badge>;
  if (isExpired(value.expiry)) return <Badge tone="red">Expired</Badge>;
  if (review?.status === 'pending') return <Badge tone="amber">Under review</Badge>;
  if (review?.status === 'rejected') return <Badge tone="red">Needs changes</Badge>;
  if (review?.status === 'approved' || (isLegacy && verified)) return <Badge tone="green"><CheckCircle2 className="size-3" />Approved</Badge>;
  return <Badge tone="blue">Saved</Badge>;
}

function DocumentCard({ uid, step, value, isLegacy, review, verified, allDocs, history, readOnly }: {
  uid: string;
  step: (typeof VERIFICATION_STEPS)[number];
  value?: VerificationDocument;
  isLegacy: boolean;
  review?: DocumentReview;
  verified: boolean;
  allDocs: Docs;
  history: HistoryEntry[];
  readOnly: boolean;
}) {
  // Until the instructor opens or closes the form, show it only when there's no document yet
  // (documents load a moment after the page, so this can't be fixed at first render).
  const [editingChoice, setEditing] = useState<boolean | null>(null);
  const editing = editingChoice ?? !value?.url;
  const [showHistory, setShowHistory] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [front, setFront] = useState<{ url: string; path: string; name: string } | null>(null);
  const [back, setBack] = useState<{ url: string; path: string; name: string } | null>(null);
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [state, setState] = useState('NSW');
  const [uploading, setUploading] = useState<'front' | 'back' | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const frontInput = useRef<HTMLInputElement>(null);
  const backInput = useRef<HTMLInputElement>(null);

  const pick = async (side: 'front' | 'back', file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') return toast.error('Please choose a photo or a PDF.');
    setUploading(side);
    try {
      const ext = file.type === 'application/pdf' ? 'pdf' : 'jpg';
      const path = `licenses/${uid}/${step.key}-${side}-${Date.now()}.${ext}`;
      const url = await uploadFile(path, file);
      (side === 'front' ? setFront : setBack)({ url, path, name: file.name });
      if (side === 'front') void scan(path);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(null);
    }
  };

  // Reads the photo and pre-fills anything the instructor hasn't typed yet.
  const scan = async (path: string) => {
    setScanning(true);
    setScanNote(null);
    try {
      const res = await api.scanDocument({ key: step.key, path });
      if (res.found) {
        if (res.number) setNumber(n => n || res.number!);
        if (res.expiry) setExpiry(e => e || res.expiry!);
        if (res.state && NEEDS_STATE.includes(step.key)) setState(res.state);
        setScanNote('We read these details from your photo — please check they’re correct.');
      } else {
        setScanNote(res.reason === 'pdf' ? 'PDFs can’t be read automatically — please enter the details.' : 'We couldn’t read the details automatically — please enter them.');
      }
    } catch {
      setScanNote('We couldn’t read the details automatically — please enter them.');
    } finally {
      setScanning(false);
    }
  };

  const save = async () => {
    if (!front && !value?.url) return toast.error('Please upload a photo or PDF of the document.');
    if (!number.trim()) return toast.error('Please enter the document number.');
    const iso = normaliseExpiry(expiry);
    if (!iso) return toast.error('Please enter the expiry date with a 4-digit year, e.g. 30/06/2029.');
    if (isExpired(iso)) return toast.error(`The expiry date (${iso.split('-').reverse().join('/')}) is in the past. Please check it, or renew the document first.`);
    setSaving(true);
    try {
      const next: VerificationDocument = {
        url: front?.url ?? value!.url,
        ...(back?.url ?? value?.backUrl ? { backUrl: back?.url ?? value?.backUrl } : {}),
        number: number.trim(),
        expiry: iso,
        ...(NEEDS_STATE.includes(step.key) ? { state } : {}),
        submittedAt: new Date(),
      };
      const previous = allDocs[step.key];
      await setDoc(doc(db, 'users', uid, 'private', 'profile'), {
        verification: { ...allDocs, [step.key]: next },
        ...(previous ? { verificationHistory: [...history.map(({ key, ...h }) => ({ key, ...h })), { key: step.key, ...previous, replacedAt: new Date(), ...(review?.status ? { status: review.status } : {}) }] } : {}),
      }, { merge: true });
      await api.submitDocument({ key: step.key });
      toast.success(verified ? `${step.label} sent for review. You stay bookable meanwhile.` : `${step.label} saved`);
      setEditing(false);
      setFront(null);
      setBack(null);
      setScanNote(null);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const startEditing = () => {
    setNumber('');
    setExpiry('');
    setState(value?.state ?? 'NSW');
    setEditing(true);
  };

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><FileUp className="size-5 text-ink-400" />{step.label}</span>}
        subtitle={step.hint}
        action={statusBadge(value, review, isLegacy, verified)}
      />
      <div className="space-y-4 p-5">
        {value?.url && (
          <dl className="grid grid-cols-2 gap-3 rounded-xl bg-ink-50 p-4 text-sm dark:bg-ink-800/60">
            <div><dt className="text-xs font-semibold uppercase text-ink-400">Number</dt><dd className="font-semibold">{value.number || '—'}</dd></div>
            <div><dt className="text-xs font-semibold uppercase text-ink-400">Expires</dt><dd className={cx('font-semibold', isExpired(value.expiry) && 'text-red-600')}>{formatExpiry(value.expiry)}</dd></div>
            <div className="col-span-2 flex flex-wrap gap-3">
              <button onClick={() => setPreview(value.url!)} className="inline-flex items-center gap-1 text-xs font-bold underline"><ExternalLink className="size-3" />{HAS_BACK.includes(step.key) ? 'Front' : 'View document'}</button>
              {value.backUrl && <button onClick={() => setPreview(value.backUrl!)} className="inline-flex items-center gap-1 text-xs font-bold underline"><ExternalLink className="size-3" />Back</button>}
              {isLegacy && <span className="text-xs text-ink-500">Uploaded on the previous website</span>}
            </div>
            {review?.status === 'rejected' && review.note && <p className="col-span-2 text-xs text-red-700">Admin note: {review.note}</p>}
          </dl>
        )}

        {!editing ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="dark" icon={<Upload className="size-4" />} disabled={readOnly} onClick={startEditing}>Submit new document</Button>
            {history.length > 0 && <Button size="sm" variant="ghost" icon={<History className="size-4" />} onClick={() => setShowHistory(h => !h)}>History ({history.length})</Button>}
          </div>
        ) : (
          <div className="space-y-3 rounded-xl border border-ink-200 p-4 dark:border-ink-700">
            <div className={cx('grid gap-2', HAS_BACK.includes(step.key) && 'sm:grid-cols-2')}>
              <UploadBox label={HAS_BACK.includes(step.key) ? 'Front' : 'Photo or PDF'} file={front} busy={uploading === 'front'} disabled={readOnly} onClick={() => frontInput.current?.click()} />
              {HAS_BACK.includes(step.key) && <UploadBox label="Back" file={back} busy={uploading === 'back'} disabled={readOnly} onClick={() => backInput.current?.click()} />}
            </div>
            <input ref={frontInput} type="file" accept="image/*,application/pdf" hidden onChange={e => pick('front', e.target.files?.[0])} />
            <input ref={backInput} type="file" accept="image/*,application/pdf" hidden onChange={e => pick('back', e.target.files?.[0])} />
            {scanning && <p className="flex items-center gap-2 text-xs font-semibold text-ink-500"><Loader2 className="size-3.5 animate-spin" />Reading your document…</p>}
            {scanNote && !scanning && <p className="flex items-center gap-2 text-xs text-sky-800 dark:text-sky-300"><ScanText className="size-3.5" />{scanNote}</p>}
            <div className="grid gap-3 sm:grid-cols-3">
              <Input label="Number" value={number} onChange={e => setNumber(e.target.value)} disabled={readOnly} wrapperClassName={NEEDS_STATE.includes(step.key) ? '' : 'sm:col-span-2'} />
              {NEEDS_STATE.includes(step.key) && (
                <Select label="State" value={state} onChange={e => setState(e.target.value)} disabled={readOnly}>{STATES.map(s => <option key={s}>{s}</option>)}</Select>
              )}
              <Input
                label="Expiry"
                type="date"
                min={dayKey(new Date())}
                max="2100-12-31"
                value={expiry}
                onChange={e => setExpiry(e.target.value)}
                onBlur={e => { const iso = normaliseExpiry(e.target.value); if (iso && iso !== e.target.value) setExpiry(iso); }}
                disabled={readOnly}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" loading={saving} disabled={readOnly || !!uploading} onClick={save}>{verified ? 'Send for review' : 'Save document'}</Button>
              {value?.url && <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setFront(null); setBack(null); setScanNote(null); }}>Cancel</Button>}
            </div>
          </div>
        )}

        {showHistory && (
          <div className="overflow-x-auto border-t border-ink-100 pt-3 dark:border-ink-800">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="pb-1.5">Submitted</th><th className="pb-1.5">Expiry</th><th className="pb-1.5">Status</th><th /></tr></thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {[...history].reverse().map((h, i) => (
                  <tr key={i}>
                    <td className="py-2">{h.submittedAt ? h.submittedAt.toLocaleDateString('en-AU') : '—'}</td>
                    <td className="py-2">{formatExpiry(h.expiry)}</td>
                    <td className="py-2">{h.status === 'approved' ? <Badge tone="green">Approved</Badge> : h.status === 'rejected' ? <Badge tone="red">Rejected</Badge> : h.status === 'pending' ? <Badge tone="amber">Replaced before review</Badge> : <Badge>Replaced</Badge>}</td>
                    <td className="py-2 text-right">{h.url && <button onClick={() => setPreview(h.url!)} className="text-xs font-bold underline">View</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Modal open={!!preview} onClose={() => setPreview(null)} title={step.label} size="lg"
        footer={preview ? <a href={preview} target="_blank" rel="noreferrer" className="text-sm font-semibold underline">Open full size</a> : undefined}>
        {preview && (/\.pdf(\?|$)/i.test(decodeURIComponent(preview))
          ? <iframe src={preview} title={step.label} className="h-[60vh] w-full rounded-xl border border-ink-200 dark:border-ink-700" />
          : <img src={preview} alt={step.label} className="mx-auto max-h-[60vh] rounded-xl object-contain" />)}
      </Modal>
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
