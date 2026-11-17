// Shared plumbing for instructor documents: settings, references, the audit trail and OCR usage.
import { getStorage } from 'firebase-admin/storage';
import type { CallableRequest } from 'firebase-functions/v2/https';
import {
  DEFAULT_DOCUMENT_SETTINGS,
  documentSettingsFrom,
  versionId,
  type DocStatus,
  type DocumentSettings,
} from '../../../shared/documents';
import { FieldValue, Timestamp, db, logger } from '../core';

export const SETTINGS_DOC = 'integrations/documentSettings';

/** The project's default storage bucket (DOCUMENT_BUCKET overrides it for the local emulator, where the web app uses the real bucket name). */
export const docBucket = () => (process.env.DOCUMENT_BUCKET ? getStorage().bucket(process.env.DOCUMENT_BUCKET) : getStorage().bucket());

let cached: { at: number; value: DocumentSettings } | null = null;

/** Current automation settings (cached for a few seconds; `fresh` reads straight from the database). */
export async function getDocumentSettings(fresh = false): Promise<DocumentSettings> {
  if (!fresh && cached && Date.now() - cached.at < 5_000) return cached.value;
  const snap = await db.doc(SETTINGS_DOC).get();
  const value = snap.exists ? documentSettingsFrom(snap.data()) : DEFAULT_DOCUMENT_SETTINGS;
  cached = { at: Date.now(), value };
  return value;
}
export function forgetCachedSettings() { cached = null; }

export const docRef = (docId: string) => db.doc(`instructorDocuments/${docId}`);
export const versionRef = (docId: string, n: number) => db.doc(`instructorDocuments/${docId}/versions/${versionId(n)}`);
export const reviewRef = (docId: string, n: number) => db.doc(`instructorDocuments/${docId}/versions/${versionId(n)}/admin/review`);
export const jobRef = (id: string) => db.doc(`documentJobs/${id}`);

export interface Actor { uid: string; name: string; role: 'admin' | 'instructor' | 'system' }
export const SYSTEM: Actor = { uid: 'system', name: 'System', role: 'system' };

export function actorFrom(req: CallableRequest, role: Actor['role']): Actor {
  const t = req.auth?.token as { name?: string; email?: string } | undefined;
  return { uid: req.auth!.uid, name: t?.name || t?.email || req.auth!.uid, role };
}

export type AuditAction =
  | 'document_uploaded'
  | 'upload_rejected'
  | 'ocr_started'
  | 'ocr_completed'
  | 'ocr_failed'
  | 'processing_waiting'
  | 'processing_completed'
  | 'processing_retried'
  | 'fields_corrected'
  | 'category_changed'
  | 'note_added'
  | 'official_check_recorded'
  | 'document_approved'
  | 'document_rejected'
  | 'reupload_requested'
  | 'correction_requested'
  | 'manual_verification'
  | 'document_replaced'
  | 'expiry_status_changed'
  | 'expiry_notification_generated'
  | 'expiry_notification_sent'
  | 'eligibility_changed'
  | 'settings_changed'
  | 'test_account_changed'
  | 'legacy_imported';

export interface AuditEntry {
  action: AuditAction;
  actor: Actor;
  instructorId?: string;
  docId?: string;
  version?: number;
  before?: unknown;
  after?: unknown;
  reason?: string;
  details?: Record<string, unknown>;
}

/** Appends to the document audit trail (never edited or deleted: the database rules forbid it). */
export async function audit(e: AuditEntry): Promise<void> {
  try {
    await db.collection('documentAudit').add({
      ...e,
      ...(e.before === undefined ? {} : { before: e.before }),
      ...(e.after === undefined ? {} : { after: e.after }),
      at: FieldValue.serverTimestamp(),
      atMs: Date.now(),
    });
  } catch (err) {
    logger.error('document audit write failed', { action: e.action, docId: e.docId, error: String(err) });
  }
}

/** Updates a version's status and keeps the parent document's summary in step. */
export async function setVersionStatus(docId: string, n: number, status: DocStatus, extra: Record<string, unknown> = {}) {
  // update() so dotted keys ('processing.lastError') address nested fields.
  await versionRef(docId, n).update({ status, statusAt: FieldValue.serverTimestamp(), ...extra });
  const parent = await docRef(docId).get();
  if (parent.exists && parent.data()!.latestVersion === n) {
    await docRef(docId).set({ latestStatus: status, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
}

// ---------- OCR usage ----------

export const usageMonth = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit' }).format(d);
const usageRef = (month = usageMonth()) => db.doc(`ocrUsage/${month}`);

/** Approximate list price per page after the free allowance, in USD (shown as an estimate only). */
export const OCR_PRICE = { freePagesPerMonth: 1000, usdPer1000: 1.5 };

export async function pagesUsedThisMonth(): Promise<number> {
  return Number((await usageRef().get()).data()?.pages ?? 0);
}

export async function recordOcrUsage(pages: number, cached: boolean) {
  const month = usageMonth();
  await usageRef(month).set({
    month,
    pages: FieldValue.increment(cached ? 0 : pages),
    cachedPages: FieldValue.increment(cached ? pages : 0),
    calls: FieldValue.increment(cached ? 0 : 1),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export function estimateCostUsd(pages: number): number {
  const billable = Math.max(0, pages - OCR_PRICE.freePagesPerMonth);
  return Math.round(billable * OCR_PRICE.usdPer1000 / 10) / 100;
}

export { Timestamp };
