import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import type { DrivingExperience, LessonType, PlaceInput, ServiceArea, VerificationStepKey } from '@shared/domain';

/** Upcoming extra hours an instructor opened for one suburb. */
export interface AreaHours { start: string; end: string; areas: ServiceArea[] }
import { functions } from './firebase';

function callable<Req, Res>(name: string) {
  const fn = httpsCallable<Req, Res>(functions, name);
  return async (data: Req): Promise<Res> => (await fn(data)).data;
}

/** A human-readable message for any error thrown by Firebase or a callable. */
export function errorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    const known: Record<string, string> = {
      'auth/invalid-credential': 'Email or password is incorrect.',
      'auth/wrong-password': 'Email or password is incorrect.',
      'auth/user-not-found': 'No account found with that email.',
      'auth/email-already-in-use': 'An account with that email already exists. Try signing in.',
      'auth/weak-password': 'Please choose a password with at least 6 characters.',
      'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
      'auth/network-request-failed': 'Network error. Check your connection and try again.',
      'permission-denied': 'You don’t have permission to do that.',
      'functions/internal': 'Something went wrong on our side. Please try again.',
    };
    if (known[err.code]) return known[err.code];
    // Callable errors carry our own message.
    return err.message.replace(/^Firebase:\s*/, '').replace(/\s*\(.*\)\.?$/, '') || 'Something went wrong.';
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export const api = {
  onboardUser: callable<{ referralCode?: string }, { claimsChanged: boolean; admin: boolean; claimed?: number }>('onboardUser'),

  getAvailability: callable<
    { instructorId: string; lessonType: LessonType; fromDay?: string; days?: number; excludeBookingId?: string; pickup?: PlaceInput },
    {
      timezone: string;
      slots: Record<string, string[]>;
      offered?: boolean;
      maxAdvanceDays?: number;
      smartScheduling?: number;
      areaHours?: AreaHours[];
      pickupCovered?: boolean;
    }
  >('getAvailability'),

  createBooking: callable<
    {
      instructorId: string;
      lessonType: LessonType;
      startAt: string;
      pickupLocation: string;
      pickupLat?: number;
      pickupLng?: number;
      dropoffLocation?: string;
      dropoffLat?: number;
      dropoffLng?: number;
      testLocation?: string;
      notes?: string;
      experience?: DrivingExperience;
      testBooked?: boolean;
      rescheduleOf?: string;
    },
    { bookingId: string; ref: string; paymentStatus: string }
  >('createBooking'),

  proposeBooking: callable<
    {
      learnerId: string;
      lessonType: LessonType;
      startAt: string;
      pickupLocation: string;
      pickupLat?: number;
      pickupLng?: number;
      notes?: string;
      rescheduleOf?: string;
      allowOutsideHours?: boolean;
    },
    { bookingId: string; ref: string }
  >('proposeBooking'),

  respondToProposal: callable<{ bookingId: string; accept: boolean }, { status: string }>('respondToProposal'),
  withdrawProposal: callable<{ bookingId: string }, { ok: true }>('withdrawProposal'),
  cancelBooking: callable<{ bookingId: string; reason?: string }, { result: 'cancelled' | 'requested' | 'deleted' }>('cancelBooking'),
  resolveLateCancel: callable<{ bookingId: string; decision: 'refund' | 'charge' }, { ok: true }>('resolveLateCancel'),
  createEvent: callable<
    {
      kind?: 'event' | 'open';
      title?: string;
      startAt: string;
      endAt: string;
      location?: string;
      notes?: string;
      applyBuffer?: boolean;
      areas?: ServiceArea[];
      repeat?: 'daily' | 'weekly' | 'fortnightly';
      occurrences?: number;
    },
    { bookingId: string; count: number }
  >('createEvent'),
  updateEvent: callable<
    { bookingId: string; title?: string; startAt: string; endAt: string; location?: string; notes?: string; applyBuffer?: boolean; areas?: ServiceArea[] },
    { ok: true }
  >('updateEvent'),
  deleteEvent: callable<{ bookingId: string; series?: boolean }, { deleted: number }>('deleteEvent'),

  inviteLearner: callable<
    { firstName: string; surname?: string; email: string; mobile?: string },
    { learnerId: string; existing: boolean; emailed: boolean }
  >('inviteLearner'),
  requestPriceChange: callable<
    { lesson: number; testPackage?: number; privateLesson?: number; privateTestPackage?: number },
    { effectiveAt: string }
  >('requestPriceChange'),
  cancelPriceChange: callable<Record<string, never>, { ok: true }>('cancelPriceChange'),
  submitVerification: callable<Record<string, never>, { ok: true }>('submitVerification'),
  submitReview: callable<{ bookingId: string; rating: number; comment?: string }, { ok: true }>('submitReview'),

  reviewVerification: callable<{ uid: string; approve: boolean; reason?: string }, { ok: true }>('reviewVerification'),
  setAccountStatus: callable<{ uid: string; status: 'active' | 'disabled' }, { ok: true }>('setAccountStatus'),
  adjustWallet: callable<
    { uid: string; amount: number; note?: string; category?: 'payment_received' | 'goodwill' | 'correction'; paymentMethod?: string; paymentReference?: string },
    { balance: number }
  >('adjustWallet'),
  migrateLegacyBookings: callable<Record<string, never>, { migrated: number; skipped: number }>('migrateLegacyBookings'),
  xeroConfigStatus: callable<Record<string, never>, { missing: string[]; scopes: string[]; redirectUri: string; needsReconnect: boolean }>('xeroConfigStatus'),
  financeSaveSettings: callable<Record<string, unknown>, { ok: true; missing: string[] }>('financeSaveSettings'),
  financeRetry: callable<{ txId?: string }, { retried: number }>('financeRetry'),
  financeReconcileNow: callable<Record<string, never>, { issues: number; checked: Record<string, number>; skippedCustomers: number }>('financeReconcileNow'),
  resolveReconciliationIssue: callable<{ id: string; note: string }, { ok: true }>('resolveReconciliationIssue'),
  resolveCustomerMatch: callable<{ customerId: string; action: 'link' | 'create' }, { ok: true }>('resolveCustomerMatch'),
  payInvoiceFromWallet: callable<{ invoiceId: string }, { paid: number }>('payInvoiceFromWallet'),
  requestRefund: callable<{ amount: number; reason: string; sourceTxId?: string; invoiceId?: string; customerId?: string }, { id: string; number: string }>('requestRefund'),
  decideRefund: callable<{ id: string; approve: boolean; reason?: string }, { ok: true }>('decideRefund'),
  confirmRefundTransfer: callable<{ id: string; transferReference: string; transferDate: string }, { ok: true }>('confirmRefundTransfer'),
  cancelApprovedRefund: callable<{ id: string; reason: string }, { ok: true }>('cancelApprovedRefund'),
  xeroConnectUrl: callable<Record<string, never>, { url: string }>('xeroConnectUrl'),
  xeroDisconnect: callable<Record<string, never>, { ok: true }>('xeroDisconnect'),
  xeroCheckConnection: callable<Record<string, never>, { ok: true; name: string; organisationClass: string }>('xeroCheckConnection'),
  xeroSyncNow: callable<Record<string, never>, { processed: number; stopped?: string }>('xeroSyncNow'),
  xeroRetry: callable<{ jobId?: string }, { retried: number }>('xeroRetry'),
  scanDocument: callable<
    { key: VerificationStepKey; path: string },
    { found: boolean; reason?: string; number?: string; expiry?: string; state?: string }
  >('scanDocument'),
  submitDocument: callable<{ key: VerificationStepKey }, { ok: true }>('submitDocument'),
  reviewDocument: callable<{ uid: string; key: VerificationStepKey; approve: boolean; note?: string }, { ok: true }>('reviewDocument'),
  setReviewHidden: callable<{ reviewId: string; hidden: boolean }, { ratingAvg: number; ratingCount: number }>('setReviewHidden'),

  // Instructor documents
  uploadDocumentVersion: callable<
    { type: string; files: { path: string; name: string; contentType: string; side?: string }[]; number?: string; expiry?: string; state?: string; issueDate?: string },
    { docId: string; version: number }
  >('uploadDocumentVersion'),
  getDocumentFile: callable<{ docId: string; version: number; index?: number }, { name: string; contentType: string; data: string }>('getDocumentFile'),
  decideDocument: callable<{ docId: string; version: number; action: string; reason?: string }, { status: string }>('decideDocument'),
  correctDocumentFields: callable<{ docId: string; version: number; corrections: Record<string, string>; note?: string }, { ok: true }>('correctDocumentFields'),
  changeDocumentCategory: callable<{ docId: string; version: number; newType: string; reason?: string }, { docId: string; version: number }>('changeDocumentCategory'),
  addDocumentNote: callable<{ docId: string; version: number; text: string }, { ok: true }>('addDocumentNote'),
  recordOfficialCheck: callable<{ docId: string; version: number; result: string; reference?: string; note?: string }, { ok: true }>('recordOfficialCheck'),
  retryDocumentProcessing: callable<{ docId: string; version: number; fresh?: boolean }, { outcome: string; message: string }>('retryDocumentProcessing'),
  saveDocumentSettings: callable<{ settings: Record<string, unknown>; reason?: string }, { ok: true; changes: number }>('saveDocumentSettings'),
  setTestAccount: callable<{ uid: string; testAccount: boolean }, { ok: true }>('setTestAccount'),
  importLegacyDocuments: callable<{ uid?: string }, { created: number; skipped: number }>('importLegacyDocuments'),
  runDocumentExpiryNow: callable<{ asOf?: string }, { skipped?: string; checked: number; generated: number; emailed: number; statusChanges: number; eligibilityChecked: number }>('runDocumentExpiryNow'),
  documentUsage: callable<Record<string, never>, { pages: number; estimatedUsd: number; queued: number; waiting: number; failed: number }>('documentUsage'),

  // Commission
  saveCommissionSettings: callable<{ defaultRate: number; introEnabled: boolean; introRate: number; introPlaces: number; effectiveFrom: string; reason: string }, { ok: true; allocation: { allocated: string[]; excluded: string[]; remaining: number } | null }>('saveCommissionSettings'),
  setInstructorCommission: callable<{ uid: string; rate: number | null; effectiveFrom: string; reason: string }, { ok: true; effective: { rate: number; category: string; effectiveFrom: string } }>('setInstructorCommission'),
  cancelScheduledCommission: callable<{ id: string; uid?: string; reason: string }, { ok: true }>('cancelScheduledCommission'),
  allocateIntroNow: callable<Record<string, never>, { allocated: string[]; excluded: string[]; remaining: number; places: number }>('allocateIntroNow'),

  // Cybria Super Admin
  recordAdminLogin: callable<Record<string, never>, { ok: boolean }>('recordAdminLogin'),
  superDashboard: callable<{ from: string; to: string }, SuperDashboard>('superDashboard'),
  adminDashboard: callable<{ from: string; to: string }, AdminDashboard>('adminDashboard'),
  createClientAdmin: callable<{ email: string; firstName: string; surname: string; roleId: string }, { uid: string; setPasswordLink: string }>('createClientAdmin'),
  updateClientAdmin: callable<{ uid: string; firstName: string; surname: string }, { ok: true }>('updateClientAdmin'),
  setClientAdminStatus: callable<{ uid: string; status: string; reason: string }, { ok: true }>('setClientAdminStatus'),
  setClientAdminAccess: callable<{ uid: string; roleId?: string; perms?: Record<string, string>; reason: string }, { ok: true; customised: boolean }>('setClientAdminAccess'),
  revokeAdminSessions: callable<{ uid: string; reason: string }, { ok: true }>('revokeAdminSessions'),
  addAdminNote: callable<{ uid: string; text: string }, { ok: true }>('addAdminNote'),
  adminPasswordLink: callable<{ uid: string; reason?: string }, { link: string }>('adminPasswordLink'),
  saveAdminRole: callable<{ id?: string; name: string; description: string; perms: Record<string, string>; reason: string }, { id: string; accountsUpdated: number }>('saveAdminRole'),
  deleteAdminRole: callable<{ id: string; reason: string }, { ok: true }>('deleteAdminRole'),
  ensureAdminRoles: callable<Record<string, never>, { ok: true }>('ensureAdminRoles'),
};

export interface DashLesson { id: string; ref: string | null; startAt: string; endAt: string; status: string; learnerName: string | null; instructorId: string; instructorName: string | null; ongoing: boolean }
export interface DashDay { day: string; booked: number; completed: number; cancelled: number; upcoming: number; other: number }
/** Client Admin dashboard. A section is null when the administrator has no access to it. */
export interface AdminDashboard {
  access: Record<'learners' | 'instructors' | 'bookings' | 'finance' | 'invoices' | 'wallet' | 'commission' | 'reports', boolean>;
  people: {
    learners: { total: number; active: number; inactive: number; new: number } | null;
    instructors: { total: number; active: number; suspended: number; new: number; approval: Record<'verified' | 'pending_review' | 'rejected' | 'not_submitted', number> } | null;
  } | null;
  lessons: {
    total: number; inPeriod: number; upcoming: number; completed: number; cancelled: number; pending: number; proposed: number; lateCancel: number;
    series: DashDay[];
    today: { lessons: DashLesson[]; scheduled: number; ongoing: number; upcoming: number; completed: number; cancelled: number };
    conflicts: { instructorId: string; instructorName: string | null; first: DashLesson; second: DashLesson & { kind: string; title: string | null } }[];
    conflictCount: number;
    availability: { id: string; name: string; hours: string[]; extraHours: number; lessonsToday: number }[] | null;
    instructorActivity: { id: string; name: string; lessons: number; completed: number; cancelled: number }[];
  } | null;
  finance: {
    financeEnabled: boolean;
    payments: number | null;
    wallet: { credits: number; spent: number; refunded: number } | null;
    outstanding: { amount: number; count: number } | null;
    refunds: { awaitingApproval: number; awaitingTransfer: number; amount: number; completed: number } | null;
    commission: { commission: number; earnings: number; lessons: number } | null;
    recent: { id: string; at: string; type: string; amount: number; description: string | null }[] | null;
    issues: { reconciliation: number; sync: number } | null;
  } | null;
  pending: { key: string; label: string; count: number; to: string; tone: 'warn' | 'bad' }[];
  activity: { at: string; kind: string; title: string; detail: string; to: string }[];
  range: { from: string; to: string };
  generatedAt: string;
}

export interface SuperDashboard {
  users: { learners: number; learnersActive: number; learnersInactive: number; instructors: number; instructorsActive: number; instructorsPending: number; instructorsSuspended: number; suspended: number; admins: number; adminsActive: number };
  bookings: { inRange: number; upcoming: number; completed: number; cancelled: number; pending: number };
  finance: { walletTotal: number; paymentsRecorded: number; outstanding: number; outstandingCount: number; commission: number; earnings: number; pendingRefunds: number; pendingRefundAmount: number; adjustments: number; adjustmentAmount: number; financeEnabled: boolean };
  documents: { awaiting: number; expiringSoon: number; expired: number };
  notifications: { total: number; sent: number; failed: number; notConfigured: number; emailConfigured: boolean };
  integrations: { xero: { connected: boolean; organisation: string | null; demo: boolean; lastSyncAt: string | null }; ocr: { configured: boolean }; email: { configured: boolean } };
  alerts: { documentJobsFailed: number; xeroJobsFailed: number; reconciliationOpen: number; financeSyncAttention: number };
}
