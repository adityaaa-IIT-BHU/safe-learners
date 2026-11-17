import { setGlobalOptions } from 'firebase-functions/v2';

setGlobalOptions({ region: 'australia-southeast1', maxInstances: 10 });

export {
  cancelBooking,
  createBooking,
  createEvent,
  deleteEvent,
  updateEvent,
  getAvailability,
  proposeBooking,
  resolveLateCancel,
  respondToProposal,
  withdrawProposal,
} from './bookings';
export {
  adjustWallet,
  cancelPriceChange,
  inviteLearner,
  migrateLegacyBookings,
  onboardUser,
  requestPriceChange,
  reviewVerification,
  setAccountStatus,
  submitReview,
  submitVerification,
} from './accounts';
export { applyPriceChanges, completeLessons, expireProposals, lessonReminders } from './scheduled';
export { reviewDocument, scanDocument, submitDocument } from './documents';
export {
  addDocumentNote,
  changeDocumentCategory,
  correctDocumentFields,
  decideDocument,
  documentTestHooks,
  documentUsage,
  getDocumentFile,
  importLegacyDocuments,
  recordOfficialCheck,
  retryDocumentProcessing,
  runDocumentExpiryNow,
  saveDocumentSettings,
  setTestAccount,
  uploadDocumentVersion,
} from './docs/api';
export { documentJobCreated, documentQueueWorker } from './docs/pipeline';
export { documentDataCleanup, documentExpiryMonitor } from './docs/compliance';
export { setReviewHidden } from './reviews';
export {
  cancelApprovedRefund,
  confirmRefundTransfer,
  decideRefund,
  financeOnBookingWrite,
  financeOnLearnerWrite,
  financeOnWalletEntry,
  financeRetry,
  financeSaveSettings,
  payInvoiceFromWallet,
  requestRefund,
  resolveCustomerMatch,
} from './finance';
// Registers the Xero handler for finance ledger entries.
import './financeXero';
export { financeReconcileNightly, financeReconcileNow, resolveReconciliationIssue } from './reconcile';
export {
  xeroCallback,
  xeroCheckConnection,
  xeroConfigStatus,
  xeroConnectUrl,
  xeroDisconnect,
  xeroHealthCheck,
  xeroRetry,
  xeroSaveSettings,
  xeroSyncNow,
  xeroSyncWorker,
} from './xero';
