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
export { setReviewHidden } from './reviews';
