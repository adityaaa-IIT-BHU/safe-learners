// Instructor documents: types, statuses, automation settings, expiry reminders and eligibility.
// Shared by the web app and Cloud Functions so both apply exactly the same rules.
import { DEFAULT_TIMEZONE, dayKey } from './time';

// ---------- Document types ----------

export type DocTypeKey =
  | 'driverLicence'
  | 'instructorLicence'
  | 'wwc'
  | 'vehicleRego'
  | 'firstAid'
  | 'insurance'
  | 'identity'
  | 'other';

export interface DocTypeInfo {
  key: DocTypeKey;
  label: string;
  /** Category name used in admin screens and reports. */
  category: string;
  hint: string;
  twoSided?: boolean;
  needsState?: boolean;
  /** Whether instructors must enter an expiry date when uploading. */
  expiryRequired: boolean;
  /** Fields OCR looks for on this type (in display order). */
  fields: string[];
}

export const DOC_TYPES: DocTypeInfo[] = [
  { key: 'driverLicence', label: "Driver's licence", category: 'Australian Driving Licence', hint: 'Front and back of your current Australian driver licence', twoSided: true, needsState: true, expiryRequired: true,
    fields: ['fullName', 'number', 'dateOfBirth', 'expiryDate', 'licenceClass', 'state', 'cardNumber'] },
  { key: 'instructorLicence', label: 'Driving instructor licence', category: 'Instructor Accreditation', hint: 'Your state-issued driving instructor licence or accreditation', needsState: true, expiryRequired: true,
    fields: ['fullName', 'number', 'accreditationType', 'issuingAuthority', 'issueDate', 'expiryDate', 'state'] },
  { key: 'wwc', label: 'Working With Children Check', category: 'Working With Children Check', hint: 'Required to teach learners under 18', needsState: true, expiryRequired: true,
    fields: ['fullName', 'number', 'checkType', 'issuingAuthority', 'issueDate', 'expiryDate', 'checkStatus', 'state'] },
  { key: 'vehicleRego', label: 'Vehicle registration', category: 'Vehicle Registration', hint: 'Certificate of registration for your lesson vehicle', expiryRequired: true,
    fields: ['ownerName', 'plate', 'vin', 'expiryDate', 'state'] },
  { key: 'firstAid', label: 'First aid certificate', category: 'First Aid Certificate', hint: 'Statement of attainment or first aid certificate', expiryRequired: false,
    fields: ['fullName', 'number', 'qualification', 'trainingProvider', 'issueDate', 'expiryDate'] },
  { key: 'insurance', label: 'Insurance certificate', category: 'Insurance Certificate', hint: 'Certificate of currency for your insurance', expiryRequired: true,
    fields: ['insuredName', 'insurer', 'number', 'coverType', 'startDate', 'expiryDate', 'coverDetails'] },
  { key: 'identity', label: 'Identity document', category: 'Identity Document', hint: 'Passport or photo card', expiryRequired: false,
    fields: ['fullName', 'dateOfBirth', 'number', 'issuingAuthority', 'expiryDate'] },
  { key: 'other', label: 'Other supporting document', category: 'Other Supporting Document', hint: 'Anything else the team asked you for', expiryRequired: false,
    fields: ['fullName', 'number', 'issueDate', 'expiryDate'] },
];

export const DOC_TYPE_KEYS = DOC_TYPES.map(t => t.key);
export const docType = (key: string): DocTypeInfo | undefined => DOC_TYPES.find(t => t.key === key);
export const docTypeLabel = (key: string | null | undefined): string => (key && docType(key)?.label) || 'Unknown type';

/** The four document types the original verification flow has always required. */
export const LEGACY_DOC_TYPES: DocTypeKey[] = ['driverLicence', 'instructorLicence', 'wwc', 'vehicleRego'];

export const FIELD_LABELS: Record<string, string> = {
  fullName: 'Full name',
  number: 'Document number',
  dateOfBirth: 'Date of birth',
  expiryDate: 'Expiry date',
  issueDate: 'Issue date',
  startDate: 'Cover start date',
  licenceClass: 'Licence class',
  state: 'State or territory',
  cardNumber: 'Card number',
  accreditationType: 'Accreditation type',
  issuingAuthority: 'Issuing authority',
  checkType: 'Check type',
  checkStatus: 'Status shown',
  ownerName: 'Registered operator',
  plate: 'Plate number',
  vin: 'VIN',
  qualification: 'Qualification',
  trainingProvider: 'Training provider',
  insuredName: 'Insured name',
  insurer: 'Insurance provider',
  coverType: 'Insurance type',
  coverDetails: 'Cover details',
};

export const fieldLabel = (f: string) => FIELD_LABELS[f] ?? f;

/** Docs ids are one per instructor and type. */
export const documentId = (uid: string, type: DocTypeKey) => `${uid}__${type}`;
export const versionId = (n: number) => `v${String(n).padStart(3, '0')}`;
export const jobId = (docId: string, n: number) => `${docId}__${versionId(n)}`;

// ---------- Statuses ----------

export type DocStatus =
  | 'uploaded'
  | 'awaiting_ocr'
  | 'processing'
  | 'processing_paused'
  | 'processing_failed'
  | 'pending_verification'
  | 'manual_verification'
  | 'needs_correction'
  | 'reupload_required'
  | 'verified'
  | 'rejected'
  | 'expiring_soon'
  | 'expired'
  | 'moved';

export type Tone = 'slate' | 'green' | 'amber' | 'red' | 'blue' | 'yellow';

export const DOC_STATUS: Record<DocStatus, { label: string; tone: Tone; instructor: string }> = {
  uploaded: { label: 'Uploaded', tone: 'blue', instructor: 'Uploaded' },
  awaiting_ocr: { label: 'Awaiting OCR', tone: 'slate', instructor: 'Waiting to be checked' },
  processing: { label: 'Processing', tone: 'blue', instructor: 'Being checked' },
  processing_paused: { label: 'Processing paused', tone: 'slate', instructor: 'Waiting to be checked' },
  processing_failed: { label: 'Processing failed', tone: 'amber', instructor: 'Waiting for an admin' },
  pending_verification: { label: 'Pending verification', tone: 'amber', instructor: 'Under review' },
  manual_verification: { label: 'Manual verification required', tone: 'amber', instructor: 'Under review' },
  needs_correction: { label: 'Needs instructor correction', tone: 'red', instructor: 'Correction needed' },
  reupload_required: { label: 'Re-upload required', tone: 'red', instructor: 'New upload needed' },
  verified: { label: 'Verified', tone: 'green', instructor: 'Verified' },
  rejected: { label: 'Rejected', tone: 'red', instructor: 'Rejected' },
  expiring_soon: { label: 'Expiring soon', tone: 'yellow', instructor: 'Expiring soon' },
  expired: { label: 'Expired', tone: 'red', instructor: 'Expired' },
  moved: { label: 'Moved to another category', tone: 'slate', instructor: 'Moved' },
};

/** Statuses an admin still has to act on. */
export const REVIEW_QUEUE: DocStatus[] = ['pending_verification', 'manual_verification', 'processing_failed', 'awaiting_ocr', 'processing_paused', 'uploaded', 'processing'];

/** Statuses a version can be decided into, and which earlier statuses allow it. */
export type DecisionAction = 'approve' | 'reject' | 'reupload' | 'correction' | 'manual';
export const DECISION_RESULT: Record<DecisionAction, DocStatus> = {
  approve: 'verified',
  reject: 'rejected',
  reupload: 'reupload_required',
  correction: 'needs_correction',
  manual: 'manual_verification',
};
export const DECISION_LABEL: Record<DecisionAction, string> = {
  approve: 'Approve',
  reject: 'Reject',
  reupload: 'Request re-upload',
  correction: 'Request correction',
  manual: 'Mark for manual verification',
};
/**
 * Allowed decisions: any change to a different status, at any stage (an admin can review manually
 * while OCR is paused or still running), except on a version that was moved to another category.
 */
export function canDecide(from: DocStatus, action: DecisionAction): boolean {
  if (from === 'moved') return false;
  return DECISION_RESULT[action] !== from;
}

/**
 * What the admin and instructor see for a document: the latest version's own status, except that a
 * verified current document shows Expiring soon / Expired once its expiry date is close or past.
 */
export function displayStatus(versionStatus: DocStatus, daysLeft: number | undefined): DocStatus {
  if (versionStatus !== 'verified' || daysLeft === undefined) return versionStatus;
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= DOCUMENT_REMINDER_SCHEDULE.soonDays) return 'expiring_soon';
  return 'verified';
}

/** The four levels of trust the admin screen keeps apart. */
export const TRUST_LEVELS = [
  { key: 'extracted', label: 'Read by OCR', help: 'Text was read from the file. This says nothing about whether the document is genuine.' },
  { key: 'checked', label: 'Passed automatic checks', help: 'Format, dates and consistency checks found no problems. Not proof of authenticity.' },
  { key: 'reviewed', label: 'Reviewed by an admin', help: 'An admin compared the document with the extracted details and the profile.' },
  { key: 'confirmed', label: 'Confirmed with the issuer', help: 'An admin recorded an official check with the issuing authority.' },
] as const;

// ---------- Automation settings ----------

export type AutomationFeature =
  | 'ocr'
  | 'typeDetection'
  | 'extraction'
  | 'profileComparison'
  | 'duplicateDetection'
  | 'qualityChecks'
  | 'riskIndicators'
  | 'expiryMonitoring'
  | 'eligibilityUpdates';

export interface DocumentSettings {
  /** Master switch for automated document processing (not expiry monitoring or eligibility). */
  automation: boolean;
  features: Record<AutomationFeature, boolean>;
  /** While on, automation, reminders and eligibility changes apply only to accounts marked as test accounts. */
  testMode: boolean;
  /** OCR pages allowed per calendar month before automatic OCR waits (0 = no limit). */
  monthlyPageLimit: number;
  /** Mandatory or optional, per document type. Approved by the business. */
  requirements: Record<DocTypeKey, 'mandatory' | 'optional'>;
}

export const FEATURE_INFO: { key: AutomationFeature; label: string; help: string; master: boolean }[] = [
  { key: 'ocr', label: 'OCR', help: 'Reads the text of new uploads.', master: true },
  { key: 'typeDetection', label: 'Document type identification', help: 'Works out which kind of document was uploaded.', master: true },
  { key: 'extraction', label: 'Information extraction', help: 'Finds names, numbers and dates in the text.', master: true },
  { key: 'profileComparison', label: 'Profile comparison', help: 'Compares extracted details with the instructor’s profile and typed details.', master: true },
  { key: 'duplicateDetection', label: 'Duplicate detection', help: 'Looks for the same file or document number elsewhere.', master: true },
  { key: 'qualityChecks', label: 'Document quality checks', help: 'Checks the file opens and the image is clear and complete.', master: true },
  { key: 'riskIndicators', label: 'Automated risk indicators', help: 'Flags warning signs for a person to investigate.', master: true },
  { key: 'expiryMonitoring', label: 'Expiry monitoring', help: 'Reminders at 30, 15 and 7 days, on the day and after expiry. Runs whatever the other switches say.', master: false },
  { key: 'eligibilityUpdates', label: 'Automatic eligibility updates', help: 'Updates whether an instructor can take new bookings, using the mandatory documents below.', master: false },
];

export const DEFAULT_DOCUMENT_SETTINGS: DocumentSettings = {
  automation: true,
  features: {
    ocr: true,
    typeDetection: true,
    extraction: true,
    profileComparison: true,
    duplicateDetection: true,
    qualityChecks: true,
    riskIndicators: true,
    expiryMonitoring: true,
    eligibilityUpdates: true,
  },
  testMode: true,
  monthlyPageLimit: 1000,
  requirements: {
    driverLicence: 'mandatory',
    instructorLicence: 'mandatory',
    wwc: 'mandatory',
    vehicleRego: 'mandatory',
    firstAid: 'optional',
    insurance: 'optional',
    identity: 'optional',
    other: 'optional',
  },
};

export function documentSettingsFrom(raw: Record<string, any> | null | undefined): DocumentSettings {
  const d = DEFAULT_DOCUMENT_SETTINGS;
  const features = { ...d.features };
  for (const f of FEATURE_INFO) if (typeof raw?.features?.[f.key] === 'boolean') features[f.key] = raw.features[f.key];
  const requirements = { ...d.requirements };
  for (const t of DOC_TYPE_KEYS) if (raw?.requirements?.[t] === 'mandatory' || raw?.requirements?.[t] === 'optional') requirements[t] = raw.requirements[t];
  return {
    automation: typeof raw?.automation === 'boolean' ? raw.automation : d.automation,
    features,
    testMode: typeof raw?.testMode === 'boolean' ? raw.testMode : d.testMode,
    monthlyPageLimit: Number.isFinite(raw?.monthlyPageLimit) && raw!.monthlyPageLimit >= 0 ? Math.floor(raw!.monthlyPageLimit) : d.monthlyPageLimit,
    requirements,
  };
}

/**
 * Whether an automated step may run right now. Processing steps need the master switch and their own
 * switch; expiry monitoring and eligibility updates depend only on their own switch.
 */
export function isActive(s: DocumentSettings, feature: AutomationFeature): boolean {
  const info = FEATURE_INFO.find(f => f.key === feature)!;
  return info.master ? s.automation && s.features[feature] : s.features[feature];
}

/** Whether automation applies to this instructor (in test mode, only to test accounts). */
export function appliesTo(s: DocumentSettings, user: { testAccount?: boolean } | null | undefined): boolean {
  return !s.testMode || user?.testAccount === true;
}

/** The status a new upload waits in when processing can't start. */
export function waitingStatus(s: DocumentSettings): DocStatus {
  return s.automation ? 'awaiting_ocr' : 'processing_paused';
}

// ---------- Confidence ----------

/** Bands for the OCR reading confidence of a field (0–1, as reported by OCR). */
export type ConfidenceBand = 'high' | 'medium' | 'low' | 'unknown';
export function confidenceBand(c: number | null | undefined): ConfidenceBand {
  if (c === null || c === undefined || !Number.isFinite(c)) return 'unknown';
  if (c >= 0.9) return 'high';
  if (c >= 0.75) return 'medium';
  return 'low';
}

// ---------- Expiry reminders ----------

export const DOCUMENT_REMINDER_SCHEDULE = {
  /** Days before expiry that a reminder is sent (largest first). */
  beforeDays: [30, 15, 7],
  /** After expiry: a reminder every this many days … */
  expiredEveryDays: 7,
  /** … for this many weeks. */
  expiredWeeks: 4,
  /** "Expiring soon" from this many days out. */
  soonDays: 30,
} as const;

export type ReminderSchedule = { beforeDays: readonly number[]; expiredEveryDays: number; expiredWeeks: number };

/**
 * The reminder stage that applies today for a document `daysLeft` days from expiry, or null.
 * Stages: "d30", "d15", "d7" before expiry, "d0" on the expiry date, then "w1"…"w4" weekly after.
 * Only the latest stage applies, so a missed run never sends a burst of old reminders.
 */
export function reminderStage(daysLeft: number, schedule: ReminderSchedule = DOCUMENT_REMINDER_SCHEDULE): string | null {
  if (!Number.isFinite(daysLeft)) return null;
  if (daysLeft > 0) {
    const due = [...schedule.beforeDays].sort((a, b) => a - b).find(d => daysLeft <= d);
    return due === undefined ? null : `d${due}`;
  }
  if (daysLeft === 0) return 'd0';
  const weeks = Math.floor(-daysLeft / schedule.expiredEveryDays);
  if (weeks === 0) return 'd0';
  return weeks <= schedule.expiredWeeks ? `w${weeks}` : null;
}

export function reminderStageLabel(stage: string): string {
  if (stage === 'd0') return 'Expiry date';
  if (stage.startsWith('w')) return `${stage.slice(1)} week${stage === 'w1' ? '' : 's'} after expiry`;
  return `${stage.slice(1)} days before`;
}

/** Whole days from today (in the zone) to an expiry date; negative once expired. */
export function daysUntil(expiry: string, timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): number {
  const today = dayKey(now, timeZone);
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** "12 Mar 2027" from YYYY-MM-DD (no timezone shift). */
export function formatDocDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

/** "15 December 2026" for notification wording. */
export function formatDocDateLong(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
}

/** "in 9 days" / "today" / "3 days ago". */
export function describeDaysLeft(daysLeft: number): string {
  if (daysLeft === 0) return 'today';
  if (daysLeft === 1) return 'tomorrow';
  if (daysLeft > 0) return `in ${daysLeft} days`;
  return daysLeft === -1 ? 'yesterday' : `${-daysLeft} days ago`;
}

// ---------- Eligibility ----------

export interface DocSummary {
  type: DocTypeKey;
  /** Status of the newest version. */
  latestStatus?: DocStatus;
  /** Expiry of the newest verified version still relied on, YYYY-MM-DD. */
  verifiedExpiry?: string | null;
  hasVerified: boolean;
}

export interface Compliance {
  eligible: boolean;
  missing: DocTypeKey[];
  pending: DocTypeKey[];
  rejected: DocTypeKey[];
  expired: DocTypeKey[];
  expiringSoon: DocTypeKey[];
}

/**
 * Whether an instructor meets the mandatory document rules. A mandatory document is satisfied by a
 * verified version that has not expired (a renewal waiting for review keeps the old one in force).
 * Optional documents never affect eligibility.
 */
export function computeCompliance(
  docs: DocSummary[],
  requirements: DocumentSettings['requirements'],
  timeZone: string = DEFAULT_TIMEZONE,
  now: Date = new Date(),
): Compliance {
  const out: Compliance = { eligible: true, missing: [], pending: [], rejected: [], expired: [], expiringSoon: [] };
  for (const t of DOC_TYPE_KEYS) {
    if (requirements[t] !== 'mandatory') continue;
    const d = docs.find(x => x.type === t);
    if (!d || (!d.hasVerified && !d.latestStatus)) { out.missing.push(t); out.eligible = false; continue; }
    if (d.hasVerified) {
      const left = d.verifiedExpiry ? daysUntil(d.verifiedExpiry, timeZone, now) : undefined;
      if (left !== undefined && left < 0) { out.expired.push(t); out.eligible = false; }
      else if (left !== undefined && left <= DOCUMENT_REMINDER_SCHEDULE.soonDays) out.expiringSoon.push(t);
      continue;
    }
    out.eligible = false;
    if (d.latestStatus === 'rejected' || d.latestStatus === 'reupload_required' || d.latestStatus === 'needs_correction') out.rejected.push(t);
    else out.pending.push(t);
  }
  return out;
}

/** One line for admins: "Expired: Working With Children Check · Missing: First aid certificate". */
export function describeCompliance(c: Pick<Compliance, 'missing' | 'pending' | 'rejected' | 'expired'>): string {
  const part = (label: string, list: DocTypeKey[]) => (list.length ? `${label}: ${list.map(docTypeLabel).join(', ')}` : '');
  return [part('Expired', c.expired), part('Missing', c.missing), part('Rejected', c.rejected), part('Awaiting review', c.pending)].filter(Boolean).join(' · ') || 'All mandatory documents verified';
}
