// Admin review of one instructor document: the original file, what OCR read (with confidence), the
// profile comparison, duplicate and risk warnings, notes, history and the verification actions.
import { AlertTriangle, CheckCircle2, CircleDashed, Copy, FileSearch, History, Pencil, QrCode, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  DECISION_LABEL,
  DOC_STATUS,
  DOC_TYPES,
  TRUST_LEVELS,
  canDecide,
  docType,
  docTypeLabel,
  fieldLabel,
  formatDocDate,
  type DecisionAction,
} from '@shared/documents';
import { Badge, Button, Input, Modal, Select, Textarea, cx } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { DocStatusBadge, DocumentViewer, FileButton, currentValue, recordStatus, useDocumentAudit, useDocumentNotifications, useReview, useVersions, type DocRecord, type VersionRecord } from '@/lib/documents';

const BAND: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }> = {
  high: { label: 'High', tone: 'green' },
  medium: { label: 'Medium – confirm', tone: 'amber' },
  low: { label: 'Low – check carefully', tone: 'red' },
  unknown: { label: 'Not reported', tone: 'slate' },
};
const MATCH: Record<string, { label: string; tone: 'green' | 'red' | 'amber' | 'slate' }> = {
  match: { label: 'Match', tone: 'green' },
  mismatch: { label: 'Mismatch', tone: 'red' },
  missing: { label: 'Missing information', tone: 'slate' },
  review: { label: 'Requires manual review', tone: 'amber' },
};
const ACTIONS: { action: DecisionAction; variant: 'success' | 'danger' | 'secondary' }[] = [
  { action: 'approve', variant: 'success' },
  { action: 'reject', variant: 'danger' },
  { action: 'reupload', variant: 'secondary' },
  { action: 'correction', variant: 'secondary' },
  { action: 'manual', variant: 'secondary' },
];
const STEP_LABEL: Record<string, string> = {
  typeDetection: 'Type identification', extraction: 'Extraction', profileComparison: 'Profile comparison', duplicateDetection: 'Duplicates', qualityChecks: 'Quality', riskIndicators: 'Risk indicators',
};
const when = (d?: Date) => (d ? d.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export function DocumentReview({ record, initialVersion, onClose }: { record: DocRecord | null; initialVersion?: number; onClose: () => void }) {
  const { data: versions } = useVersions(record?.id ?? null);
  const [n, setN] = useState<number | null>(null);
  useEffect(() => { setN(initialVersion ?? record?.latestVersion ?? null); }, [record?.id, initialVersion, record?.latestVersion]);
  const v = versions.find(x => x.n === n) ?? versions[0];
  const { data: review } = useReview(record?.id ?? null, v?.n ?? null);
  const [tab, setTab] = useState<'review' | 'history'>('review');
  if (!record) return null;
  return (
    <Modal open={!!record} onClose={onClose} size="xl" title={<span className="flex flex-wrap items-center gap-2">{record.instructorName} · {docTypeLabel(record.type)} <DocStatusBadge status={recordStatus(record)} />{record.testAccount && <Badge tone="blue">Test account</Badge>}</span> as unknown as string}>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-500">Instructor ID: <code className="text-xs">{record.instructorId}</code></span>
        <span className="flex-1" />
        <Select value={String(v?.n ?? '')} onChange={e => setN(Number(e.target.value))} wrapperClassName="w-56">
          {versions.map(x => <option key={x.n} value={x.n}>Version {x.n}{x.n === record.verifiedVersion ? ' · verified (in use)' : ''}{x.n === record.latestVersion ? ' · latest' : ''}</option>)}
        </Select>
        <div className="flex rounded-lg border border-ink-200 p-0.5 dark:border-ink-700">
          {(['review', 'history'] as const).map(t => <button key={t} onClick={() => setTab(t)} className={cx('rounded-md px-3 py-1 text-xs font-semibold', tab === t ? 'bg-ink-900 text-white dark:bg-white dark:text-ink-900' : 'text-ink-500')}>{t === 'review' ? 'Review' : 'History'}</button>)}
        </div>
      </div>
      {!v ? <p className="text-sm text-ink-500">Loading…</p> : tab === 'review'
        ? <VersionReview record={record} v={v} review={review ?? {}} versions={versions} />
        : <DocHistory record={record} versions={versions} />}
    </Modal>
  );
}

function Section({ title, icon, children, tone }: { title: string; icon?: React.ReactNode; children: React.ReactNode; tone?: 'warn' }) {
  return (
    <section className={cx('rounded-xl border p-4', tone === 'warn' ? 'border-amber-300 bg-amber-50/50 dark:border-amber-500/40 dark:bg-amber-500/5' : 'border-ink-200 dark:border-ink-700')}>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold">{icon}{title}</h3>
      {children}
    </section>
  );
}

function VersionReview({ record, v, review, versions }: { record: DocRecord; v: VersionRecord; review: Record<string, any>; versions: VersionRecord[] }) {
  const [viewer, setViewer] = useState<{ index: number; url?: string } | null>(null);
  const [acting, setActing] = useState<DecisionAction | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [moveTo, setMoveTo] = useState('');
  const [check, setCheck] = useState({ result: 'confirmed', reference: '', note: '' });
  const info = docType(record.type);
  const fieldsShown = [...new Set([...(info?.fields ?? []), ...Object.keys(v.fields ?? {})])];
  const prev = record.verifiedVersion && record.verifiedVersion !== v.n ? versions.find(x => x.n === record.verifiedVersion) : undefined;

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast.success(ok); return true; } catch (err) { toast.error(errorMessage(err)); return false; } finally { setBusy(null); }
  };
  const decide = async () => {
    if (!acting) return;
    if (await run(acting, () => api.decideDocument({ docId: record.id, version: v.n, action: acting, reason: reason.trim() || undefined }), `${DECISION_LABEL[acting]}: done`)) { setActing(null); setReason(''); }
  };

  const steps = v.processing?.steps ?? {};
  const waiting = v.processing?.waitingFor;
  return (
    <div className="space-y-4">
      {/* Trust levels: kept apart on purpose */}
      <div className="grid gap-2 sm:grid-cols-4">
        {TRUST_LEVELS.map(t => {
          const on = !!v.trust?.[t.key as keyof NonNullable<VersionRecord['trust']>];
          return (
            <div key={t.key} title={t.help} className={cx('flex items-start gap-2 rounded-xl border p-3 text-xs', on ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-500/40 dark:bg-emerald-500/10' : 'border-ink-200 text-ink-500 dark:border-ink-700')}>
              {on ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600" /> : <CircleDashed className="size-4 shrink-0" />}
              <span><strong className="block">{t.label}</strong>{on ? 'Yes' : 'Not yet'}</span>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-ink-500">OCR and automatic checks do not prove a document is genuine. Approve only after looking at the original document.</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Document" icon={<FileSearch className="size-4" />}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-500">Category</dt><dd>{docTypeLabel(v.type)}</dd>
            <dt className="text-ink-500">Uploaded</dt><dd>{when(v.uploadedAt)}</dd>
            <dt className="text-ink-500">Instructor typed</dt><dd>{[v.entered?.number, v.entered?.expiry && `exp. ${formatDocDate(v.entered.expiry)}`, v.entered?.state].filter(Boolean).join(' · ') || '—'}</dd>
            <dt className="text-ink-500">Version status</dt><dd><DocStatusBadge status={v.status} /></dd>
            {v.decision && <><dt className="text-ink-500">Last decision</dt><dd>{v.decision.action === 'move' ? 'Moved' : DECISION_LABEL[v.decision.action as DecisionAction] ?? v.decision.action} by {v.decision.byName}{v.decision.reason ? ` — “${v.decision.reason}”` : ''}</dd></>}
            {v.verifiedBeforeOcr && <><dt className="text-ink-500">Note</dt><dd>Verified before automatic processing existed</dd></>}
            {v.movedTo && <><dt className="text-ink-500">Moved</dt><dd>to {docTypeLabel(v.movedTo.docId.split('__')[1])}, version {v.movedTo.version}</dd></>}
          </dl>
          <div className="mt-3 flex flex-wrap gap-3">
            {v.files.map((f, i) => <FileButton key={i} label={`${f.side === 'back' ? 'Back' : v.files.length > 1 ? 'Front' : 'Original document'}${f.pages && f.pages > 1 ? ` (${f.pages} pages)` : ''}`} onClick={() => setViewer(f.url ? { index: i, url: f.url } : { index: i })} />)}
          </div>
        </Section>

        <Section title="Processing" icon={<RefreshCw className="size-4" />}>
          <div className="space-y-1.5 text-sm">
            <p className="flex items-center gap-2"><span className="w-40 text-ink-500">OCR</span>
              {v.processing?.skipped === 'test_mode' ? <Badge>Not run (test mode)</Badge>
                : v.processing?.skipped === 'imported' ? <Badge>Not run (imported)</Badge>
                : waiting === 'ocr_paused' ? <Badge>Awaiting OCR (paused)</Badge>
                : waiting === 'automation_paused' ? <Badge>Automation paused</Badge>
                : waiting === 'limit' ? <Badge tone="amber">Monthly limit reached</Badge>
                : v.status === 'processing_failed' ? <Badge tone="red">Failed</Badge>
                : v.status === 'processing' || v.status === 'uploaded' ? <Badge tone="blue">Processing</Badge>
                : v.processing?.pages !== undefined ? <Badge tone="green">Done · {v.processing.pages} page{v.processing.pages === 1 ? '' : 's'} read{(v.processing as any).cachedPages ? ` (+${(v.processing as any).cachedPages} reused)` : ''}</Badge>
                : <Badge>—</Badge>}
            </p>
            <p className="flex items-center gap-2"><span className="w-40 text-ink-500">Type identification</span>
              {!v.detected ? <Badge>{steps.typeDetection === 'paused' ? 'Paused' : 'Not run'}</Badge>
                : v.detected.certainty === 'confident' && v.detected.type === v.type ? <Badge tone="green">Matches category</Badge>
                : v.detected.certainty === 'confident' ? <Badge tone="amber">Reads like {docTypeLabel(v.detected.type)}</Badge>
                : <Badge tone="amber">Manual document type verification required</Badge>}
            </p>
            {Object.entries(STEP_LABEL).filter(([k]) => k !== 'typeDetection').map(([k, label]) => (
              <p key={k} className="flex items-center gap-2"><span className="w-40 text-ink-500">{label}</span><Badge tone={steps[k] === 'done' ? 'green' : 'slate'}>{steps[k] === 'done' ? 'Done' : steps[k] === 'paused' ? 'Paused' : 'Not run'}</Badge></p>
            ))}
            {v.processing?.lastError && <p className="text-xs text-red-600">Last error: {v.processing.lastError} (attempt {v.processing.attempts ?? 1})</p>}
            {v.reviewReasons?.length ? <ul className="mt-2 list-inside list-disc text-xs text-amber-800 dark:text-amber-300">{v.reviewReasons.map(r => <li key={r}>{r}</li>)}</ul> : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={<RefreshCw className="size-4" />} loading={busy === 'retry'} disabled={v.status === 'moved'}
              onClick={async () => { setBusy('retry'); try { const r = await api.retryDocumentProcessing({ docId: record.id, version: v.n }); toast.message(r.message); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(null); } }}>
              {v.status === 'processing_failed' ? 'Retry processing' : 'Re-run processing'}
            </Button>
          </div>
        </Section>
      </div>

      <Section title="Extracted information" icon={<FileSearch className="size-4" />}>
        {Object.keys(v.fields ?? {}).length === 0 && !editing
          ? <p className="text-sm text-ink-500">Nothing extracted yet{waiting ? ' (processing is waiting)' : ''}. You can review the original document manually{info?.expiryRequired ? ' and enter the details with Correct details' : ''}.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="pb-2">Field</th><th className="pb-2">Value</th><th className="pb-2">OCR confidence</th><th className="pb-2">Found by</th><th className="pb-2">Review</th></tr></thead>
                <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                  {fieldsShown.map(k => {
                    const f = v.fields?.[k];
                    if (!f && !editing) return null;
                    return (
                      <tr key={k} className={cx(f?.band === 'low' && 'bg-red-50/60 dark:bg-red-500/5', f?.band === 'medium' && 'bg-amber-50/60 dark:bg-amber-500/5')}>
                        <td className="py-2 pr-3 font-medium">{fieldLabel(k)}</td>
                        <td className="py-2 pr-3">{editing
                          ? <Input value={edits[k] ?? currentValue(f) ?? ''} onChange={e => setEdits(x => ({ ...x, [k]: e.target.value }))} placeholder={/Date$|dateOfBirth/.test(k) ? 'DD/MM/YYYY' : ''} />
                          : <>{/Date$|dateOfBirth/.test(k) ? formatDocDate(currentValue(f)) : currentValue(f) ?? '—'}{f?.correctedValue !== undefined && f?.correctedValue !== null && <span className="block text-xs text-ink-400">OCR read: {f.value ?? '—'} · corrected by {f.correctedByName}</span>}</>}
                        </td>
                        <td className="py-2 pr-3">{f ? <Badge tone={BAND[f.band]?.tone ?? 'slate'}>{BAND[f.band]?.label ?? f.band}{f.confidence !== null ? ` · ${Math.round(f.confidence * 100)}%` : ''}</Badge> : <span className="text-ink-400">Not found</span>}</td>
                        <td className="py-2 pr-3 text-xs text-ink-500">{f ? (f.method === 'label' ? 'Printed label' : f.method === 'pattern' ? 'Printed pattern' : 'Admin') : ''}</td>
                        <td className="py-2 text-xs">{f ? (f.review === 'corrected' ? 'Corrected' : f.review === 'confirmed' ? 'Confirmed' : 'Not reviewed') : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!!v.missingFields?.length && <p className="mt-2 text-xs text-amber-700">Could not be read: {v.missingFields.map(fieldLabel).join(', ')}</p>}
            </div>
          )}
        <div className="mt-3 flex gap-2">
          {editing
            ? <>
                <Button size="sm" loading={busy === 'correct'} onClick={async () => {
                  const changed = Object.fromEntries(Object.entries(edits).filter(([k, val]) => val !== (currentValue(v.fields?.[k]) ?? '')));
                  if (!Object.keys(changed).length) { setEditing(false); return; }
                  if (await run('correct', () => api.correctDocumentFields({ docId: record.id, version: v.n, corrections: changed }), 'Details corrected')) { setEditing(false); setEdits({}); }
                }}>Save corrections</Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setEdits({}); }}>Cancel</Button>
              </>
            : <Button size="sm" variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Correct details</Button>}
        </div>
      </Section>

      <Section title="Profile comparison" icon={<ShieldCheck className="size-4" />}>
        {!review.comparison?.length ? <p className="text-sm text-ink-500">Not compared{steps.profileComparison === 'paused' ? ' (profile comparison is paused)' : ''}.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="pb-2">Field</th><th className="pb-2">Instructor profile</th><th className="pb-2">Uploaded document</th><th className="pb-2">Status</th></tr></thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {review.comparison.map((r: any) => (
                  <tr key={r.field}>
                    <td className="py-2 pr-3 font-medium">{r.label}</td>
                    <td className="py-2 pr-3">{/Date|expiry/i.test(r.field) ? formatDocDate(r.profile) : r.profile ?? '—'}</td>
                    <td className="py-2 pr-3">{/Date|expiry/i.test(r.field) ? formatDocDate(r.document) : r.document ?? '—'}</td>
                    <td className="py-2"><Badge tone={MATCH[r.status]?.tone ?? 'slate'}>{MATCH[r.status]?.label ?? r.status}</Badge>{r.note && <span className="block text-xs text-ink-400">{r.note}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {prev && <p className="mt-2 text-xs text-ink-500">Previously verified (version {prev.n}): number {prev.approved?.number ?? prev.entered?.number ?? '—'}, expiry {formatDocDate(prev.approved?.expiry ?? prev.entered?.expiry ?? null)}.</p>}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Quality and duplicates" icon={<Copy className="size-4" />} tone={(v.quality?.issues?.length || review.duplicates?.some((d: any) => !d.sameInstructor)) ? 'warn' : undefined}>
          {!v.quality?.issues?.length && !review.duplicates?.length ? <p className="text-sm text-ink-500">No quality issues or duplicates found{steps.qualityChecks === 'paused' || steps.duplicateDetection === 'paused' ? ' (some checks are paused)' : ''}.</p> : null}
          <ul className="space-y-1.5 text-sm">
            {v.quality?.issues?.map(q => <li key={q.code} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />{q.message}</li>)}
            {review.duplicates?.map((d: any, i: number) => (
              <li key={i} className="flex gap-2"><Copy className={cx('mt-0.5 size-4 shrink-0', d.sameInstructor ? 'text-ink-400' : 'text-red-600')} />
                <span>{d.message}{!d.sameInstructor && d.instructorName ? ` — ${d.instructorName} (${docTypeLabel(d.docId.split('__')[1])}, version ${d.version})` : ''}</span></li>
            ))}
          </ul>
        </Section>
        <Section title="Risk indicators" icon={<AlertTriangle className="size-4" />} tone={review.risks?.length ? 'warn' : undefined}>
          {!review.risks?.length && !review.qr?.length ? <p className="text-sm text-ink-500">No warning signs found{steps.riskIndicators === 'paused' ? ' (risk indicators are paused)' : ''}. This does not prove the document is genuine.</p> : null}
          <ul className="space-y-1.5 text-sm">
            {review.risks?.map((r: any) => <li key={r.code + r.message} className="flex gap-2"><AlertTriangle className={cx('mt-0.5 size-4 shrink-0', r.severity === 'high' ? 'text-red-600' : 'text-amber-600')} />{r.message}</li>)}
            {review.qr?.map((q: any, i: number) => (
              <li key={`qr${i}`} className="flex gap-2"><QrCode className="mt-0.5 size-4 shrink-0 text-ink-500" />
                <span>QR code: <code className="break-all text-xs">{q.content}</code>{q.official ? <Badge tone="green" className="ml-1">Government address</Badge> : <Badge tone="amber" className="ml-1">Unverified destination</Badge>}
                  <span className="block text-xs text-ink-400">Not opened automatically. Check it yourself only if the address is the issuing authority’s.</span></span></li>
            ))}
          </ul>
        </Section>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Official check with the issuer" icon={<ShieldCheck className="size-4" />}>
          {v.officialCheck && <p className="mb-2 text-sm">{v.officialCheck.result === 'confirmed' ? 'Confirmed' : v.officialCheck.result === 'not_confirmed' ? 'Not confirmed' : 'Not available'} by {v.officialCheck.byName} · {when(v.officialCheck.at)}{v.officialCheck.reference ? ` · ref ${v.officialCheck.reference}` : ''}</p>}
          <div className="grid gap-2 sm:grid-cols-3">
            <Select value={check.result} onChange={e => setCheck(c => ({ ...c, result: e.target.value }))}>
              <option value="confirmed">Confirmed by issuer</option><option value="not_confirmed">Not confirmed</option><option value="unavailable">No online check</option>
            </Select>
            <Input placeholder="Reference / receipt" value={check.reference} onChange={e => setCheck(c => ({ ...c, reference: e.target.value }))} />
            <Button size="sm" variant="secondary" loading={busy === 'check'} onClick={() => run('check', () => api.recordOfficialCheck({ docId: record.id, version: v.n, ...check }), 'Official check recorded')}>Record</Button>
          </div>
        </Section>
        <Section title="Internal notes" icon={<Pencil className="size-4" />}>
          <ul className="mb-2 max-h-32 space-y-1 overflow-y-auto text-sm">
            {(review.notes ?? []).map((x: any, i: number) => <li key={i}><span className="text-xs text-ink-400">{x.byName} · {new Date(x.at).toLocaleString('en-AU')}</span><br />{x.text}</li>)}
          </ul>
          <div className="flex gap-2">
            <Input placeholder="Add a note (admins only)" value={note} onChange={e => setNote(e.target.value)} wrapperClassName="flex-1" />
            <Button size="sm" variant="secondary" loading={busy === 'note'} disabled={!note.trim()} onClick={async () => { if (await run('note', () => api.addDocumentNote({ docId: record.id, version: v.n, text: note }), 'Note added')) setNote(''); }}>Add</Button>
          </div>
        </Section>
      </div>

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t border-ink-200 bg-white px-1 pt-3 dark:border-ink-700 dark:bg-ink-900">
        {ACTIONS.map(a => (
          <Button key={a.action} size="sm" variant={a.variant} disabled={!canDecide(v.status, a.action)} onClick={() => { setActing(a.action); setReason(''); }}
            icon={a.action === 'approve' ? <CheckCircle2 className="size-4" /> : a.action === 'reject' ? <XCircle className="size-4" /> : undefined}>{DECISION_LABEL[a.action]}</Button>
        ))}
        <span className="flex-1" />
        <Select value={moveTo} onChange={e => setMoveTo(e.target.value)} wrapperClassName="w-52" disabled={v.status === 'moved'}>
          <option value="">Change category…</option>
          {DOC_TYPES.filter(t => t.key !== record.type).map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </Select>
        {moveTo && <Button size="sm" variant="secondary" loading={busy === 'move'} onClick={async () => { if (await run('move', () => api.changeDocumentCategory({ docId: record.id, version: v.n, newType: moveTo, reason: 'Category corrected by admin' }), `Moved to ${docTypeLabel(moveTo)}`)) setMoveTo(''); }}>Move</Button>}
      </div>

      <Modal open={!!acting} onClose={() => setActing(null)} title={acting ? `${DECISION_LABEL[acting]} – ${docTypeLabel(record.type)}` : ''}
        footer={<Button variant={acting === 'approve' ? 'success' : acting === 'reject' ? 'danger' : 'primary'} loading={!!acting && busy === acting} disabled={acting !== 'approve' && !reason.trim()} onClick={decide}>{acting ? DECISION_LABEL[acting] : ''}</Button>}>
        {acting === 'approve'
          ? <p className="text-sm">This records the document as verified with expiry <strong>{formatDocDate(v.fields?.expiryDate?.correctedValue ?? v.entered?.expiry ?? v.fields?.expiryDate?.value ?? null)}</strong> and number <strong>{v.fields?.number?.correctedValue ?? v.entered?.number ?? currentValue(v.fields?.number) ?? '—'}</strong>. Use Correct details first if either is wrong. Confirm you have checked the original document.</p>
          : <Textarea label={acting === 'manual' ? 'Why does it need manual verification?' : acting === 'correction' ? 'What should the instructor correct?' : acting === 'reupload' ? 'Why is a new upload needed?' : 'Reason for rejection'} value={reason} onChange={e => setReason(e.target.value)}
              placeholder={acting === 'reupload' ? 'e.g. The photo is blurry and the expiry date can’t be read.' : ''} />}
        {acting && acting !== 'approve' && acting !== 'manual' && <p className="mt-2 text-xs text-ink-500">The instructor sees this reason.</p>}
      </Modal>
      <DocumentViewer open={!!viewer} onClose={() => setViewer(null)} docId={record.id} version={v.n} index={viewer?.index} legacyUrl={viewer?.url} title={`${docTypeLabel(record.type)} · version ${v.n}`} />
    </div>
  );
}

const AUDIT_LABEL: Record<string, string> = {
  document_uploaded: 'Uploaded', document_replaced: 'New version uploaded', upload_rejected: 'Upload refused (file problem)', ocr_started: 'OCR started', ocr_completed: 'OCR completed', ocr_failed: 'OCR failed',
  processing_waiting: 'Processing waiting', processing_completed: 'Automatic checks completed', processing_retried: 'Processing retried', fields_corrected: 'Details corrected', category_changed: 'Category changed',
  note_added: 'Note added', official_check_recorded: 'Official check recorded', document_approved: 'Approved', document_rejected: 'Rejected', reupload_requested: 'Re-upload requested',
  correction_requested: 'Correction requested', manual_verification: 'Marked for manual verification', expiry_status_changed: 'Expiry status changed', expiry_notification_generated: 'Expiry reminder created',
  expiry_notification_sent: 'Expiry reminder emailed', eligibility_changed: 'Eligibility changed', legacy_imported: 'Imported from earlier records',
};
export const auditLabel = (a: string) => AUDIT_LABEL[a] ?? a.replace(/_/g, ' ');

function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return DOC_STATUS[v as keyof typeof DOC_STATUS]?.label ?? v;
  return JSON.stringify(v);
}

function DocHistory({ record, versions }: { record: DocRecord; versions: VersionRecord[] }) {
  const { data: entries } = useDocumentAudit({ docId: record.id });
  const { data: reminders } = useDocumentNotifications(record.id);
  return (
    <div className="space-y-4">
      <Section title="Versions" icon={<History className="size-4" />}>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="pb-2">Version</th><th className="pb-2">Uploaded</th><th className="pb-2">Number</th><th className="pb-2">Expiry</th><th className="pb-2">Status</th></tr></thead>
          <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
            {versions.map(x => (
              <tr key={x.n}><td className="py-1.5">{x.n}{x.n === record.verifiedVersion && <Badge tone="green" className="ml-2">In use</Badge>}</td><td>{when(x.uploadedAt)}</td>
                <td>{x.approved?.number ?? x.fields?.number?.correctedValue ?? x.fields?.number?.value ?? x.entered?.number ?? '—'}</td>
                <td>{formatDocDate(x.approved?.expiry ?? x.fields?.expiryDate?.correctedValue ?? x.entered?.expiry ?? x.fields?.expiryDate?.value ?? null)}</td>
                <td><DocStatusBadge status={x.status} /></td></tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Expiry reminders" icon={<History className="size-4" />}>
        {!reminders.length ? <p className="text-sm text-ink-500">No reminders yet.</p> : (
          <ul className="space-y-1 text-sm">{reminders.map(r => <li key={r.id}>{r.stageLabel} · expiry {formatDocDate(r.expiry)} · in-app sent · email: {r.email?.status === 'not_configured' ? 'email service not set up' : r.email?.status ?? '—'} · {when(r.createdAt)}</li>)}</ul>
        )}
      </Section>
      <Section title="Audit trail" icon={<History className="size-4" />}>
        <ul className="space-y-2 text-sm">
          {entries.map(e => (
            <li key={e.id} className="border-b border-ink-100 pb-2 last:border-0 dark:border-ink-800">
              <span className="text-xs text-ink-400">{when(e.at)} · {e.actor?.name ?? 'System'}{e.version ? ` · version ${e.version}` : ''}</span><br />
              <strong>{auditLabel(e.action)}</strong>{e.before !== undefined || e.after !== undefined ? ` — ${show(e.before)} → ${show(e.after)}` : ''}{e.reason ? ` · “${e.reason}”` : ''}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
