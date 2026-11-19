// Instructor document records for the web app: live data hooks, status badges and a secure viewer
// (files are fetched through the server for the owner or an admin; there are no public links).
import { collection, doc, limit, orderBy, query, where, type DocumentData } from 'firebase/firestore';
import { FileText, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DOC_STATUS, daysUntil, displayStatus, documentSettingsFrom, type DocStatus, type DocTypeKey, type DocumentSettings } from '@shared/documents';
import { Badge, Modal } from '@/components/ui';
import { api, errorMessage } from './api';
import { toDate, useDoc, useQuery } from './data';
import { db } from './firebase';

export interface DocRecord {
  id: string;
  instructorId: string;
  instructorName: string;
  type: DocTypeKey;
  latestVersion: number;
  latestStatus: DocStatus;
  verifiedVersion: number | null;
  verifiedExpiry: string | null;
  verifiedNumber?: string | null;
  expiryState?: 'valid' | 'expiring_soon' | 'expired';
  flags?: { duplicates?: number; risks?: number; mismatches?: number; quality?: number };
  testAccount?: boolean;
  uploadedAt?: Date;
  updatedAt?: Date;
  imported?: boolean;
}

export interface FieldRecord {
  value: string | null;
  method: string;
  confidence: number | null;
  band: 'high' | 'medium' | 'low' | 'unknown';
  page: number | null;
  review: 'unreviewed' | 'confirmed' | 'corrected';
  correctedValue?: string | null;
  correctedByName?: string;
}

export interface VersionRecord {
  id: string;
  n: number;
  type: DocTypeKey;
  files: { path?: string; url?: string; name: string; contentType?: string; side?: string | null; size?: number; pages?: number }[];
  entered: { number?: string | null; expiry?: string | null; state?: string | null; issueDate?: string | null };
  status: DocStatus;
  uploadedAt?: Date;
  detected?: { type: DocTypeKey | null; certainty: string; scores: Record<string, number> } | null;
  fields: Record<string, FieldRecord>;
  missingFields?: string[];
  quality?: { issues: { code: string; message: string; severity: string }[] };
  instructorMessage?: string | null;
  reviewReasons?: string[];
  summary?: { mismatches: number; duplicates: number; risks: number; quality: number; lowConfidence: number };
  trust?: { extracted: boolean; checked: boolean; reviewed: boolean; confirmed: boolean };
  processing?: { attempts?: number; lastError?: string | null; waitingFor?: string | null; note?: string; skipped?: string; pages?: number; steps?: Record<string, string> };
  decision?: { action: string; reason: string | null; byName: string; at?: Date };
  officialCheck?: { result: string; reference: string | null; note: string | null; byName: string; at?: Date };
  approved?: { expiry: string | null; number: string | null };
  verifiedBeforeOcr?: boolean;
  imported?: boolean;
  movedTo?: { docId: string; version: number };
  movedFrom?: { docId: string; version: number };
  supersededBy?: number;
}

export const mapDocRecord = (id: string, d: DocumentData): DocRecord => ({ id, ...d, uploadedAt: toDate(d.uploadedAt), updatedAt: toDate(d.updatedAt) } as DocRecord);
export const mapVersion = (id: string, d: DocumentData): VersionRecord => ({
  id, ...d, fields: d.fields ?? {}, uploadedAt: toDate(d.uploadedAt),
  decision: d.decision ? { ...d.decision, at: toDate(d.decision.at) } : undefined,
  officialCheck: d.officialCheck ? { ...d.officialCheck, at: toDate(d.officialCheck.at) } : undefined,
} as VersionRecord);

/** What a field's value is now: the admin's correction if any, otherwise what OCR read. */
export const currentValue = (f: FieldRecord | undefined) => (f ? (f.correctedValue ?? f.value) : null);

export function useDocumentSettings(): DocumentSettings {
  const { data } = useDoc(doc(db, 'integrations', 'documentSettings'), (_, d) => d);
  return documentSettingsFrom(data);
}

export function useInstructorDocuments(uid: string | null | undefined) {
  return useQuery(uid ? query(collection(db, 'instructorDocuments'), where('instructorId', '==', uid)) : null, mapDocRecord, `docs:${uid}`);
}

export function useAllDocuments(enabled = true) {
  return useQuery(enabled ? query(collection(db, 'instructorDocuments'), limit(2000)) : null, mapDocRecord, `docs:all:${enabled}`);
}

export function useVersions(docId: string | null) {
  return useQuery(docId ? query(collection(db, 'instructorDocuments', docId, 'versions'), orderBy('n', 'desc')) : null, mapVersion, `versions:${docId}`);
}

export function useReview(docId: string | null, n: number | null) {
  return useDoc(docId && n ? doc(db, 'instructorDocuments', docId, 'versions', `v${String(n).padStart(3, '0')}`, 'admin', 'review') : null, (_, d) => d as Record<string, any>);
}

export function useDocumentAudit(filter: { docId?: string; instructorId?: string } | null) {
  const key = filter ? `audit:${filter.docId ?? ''}:${filter.instructorId ?? ''}` : 'audit:none';
  const q = !filter ? null
    : filter.docId ? query(collection(db, 'documentAudit'), where('docId', '==', filter.docId), limit(300))
    : filter.instructorId ? query(collection(db, 'documentAudit'), where('instructorId', '==', filter.instructorId), limit(300))
    : query(collection(db, 'documentAudit'), orderBy('atMs', 'desc'), limit(300));
  const live = useQuery(q, (id, d) => ({ id, ...d, at: toDate(d.at) } as Record<string, any> & { id: string }), key);
  return { ...live, data: [...live.data].sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0)) };
}

export function useDocumentNotifications(docId?: string) {
  const live = useQuery(docId ? query(collection(db, 'documentNotifications'), where('docId', '==', docId)) : query(collection(db, 'documentNotifications'), orderBy('createdMs', 'desc'), limit(200)),
    (id, d) => ({ id, ...d, createdAt: toDate(d.createdAt) } as Record<string, any> & { id: string }), `docNotes:${docId ?? 'all'}`);
  return { ...live, data: [...live.data].sort((a, b) => (b.createdMs ?? 0) - (a.createdMs ?? 0)) };
}

/** The status shown for a document: a verified current version shows Expiring soon / Expired as it nears expiry. */
export function recordStatus(r: DocRecord): DocStatus {
  if (r.latestVersion !== r.verifiedVersion || r.latestStatus !== 'verified') return r.latestStatus;
  return displayStatus('verified', r.verifiedExpiry ? daysUntil(r.verifiedExpiry) : undefined);
}

export function DocStatusBadge({ status, instructor }: { status: DocStatus; instructor?: boolean }) {
  const s = DOC_STATUS[status] ?? DOC_STATUS.uploaded;
  return <Badge tone={s.tone}>{instructor ? s.instructor : s.label}</Badge>;
}

/** Opens one file of a version through the server and shows it (image or PDF). */
export function DocumentViewer({ open, onClose, docId, version, index = 0, title, legacyUrl }: {
  open: boolean; onClose: () => void; docId?: string; version?: number; index?: number; title: string; legacyUrl?: string;
}) {
  const [state, setState] = useState<{ url: string; type: string } | { error: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    if (legacyUrl) { setState({ url: legacyUrl, type: /\.pdf(\?|$)/i.test(decodeURIComponent(legacyUrl)) ? 'application/pdf' : 'image/*' }); return; }
    if (!docId || !version) return;
    let url = '';
    setState(null);
    api.getDocumentFile({ docId, version, index })
      .then(r => {
        const bytes = Uint8Array.from(atob(r.data), c => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: r.contentType }));
        setState({ url, type: r.contentType });
      })
      .catch(err => setState({ error: errorMessage(err) }));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [open, docId, version, index, legacyUrl]);
  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      {!state ? <div className="flex h-60 items-center justify-center text-ink-400"><Loader2 className="size-6 animate-spin" /></div>
        : 'error' in state ? <p className="text-sm text-red-600">{state.error}</p>
        : state.type === 'application/pdf' ? <iframe src={state.url} title={title} className="h-[65vh] w-full rounded-xl border border-ink-200 dark:border-ink-700" />
        : <img src={state.url} alt={title} className="mx-auto max-h-[65vh] rounded-xl object-contain" />}
    </Modal>
  );
}

export function FileButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-xs font-bold underline"><FileText className="size-3" />{label}</button>;
}
