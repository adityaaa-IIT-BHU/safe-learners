import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import type { LessonType, VerificationStepKey } from '@shared/domain';
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
    { instructorId: string; lessonType: LessonType; fromDay?: string; days?: number; excludeBookingId?: string },
    { timezone: string; slots: Record<string, string[]>; offered?: boolean; maxAdvanceDays?: number }
  >('getAvailability'),

  createBooking: callable<
    {
      instructorId: string;
      lessonType: LessonType;
      startAt: string;
      pickupLocation: string;
      dropoffLocation?: string;
      testLocation?: string;
      notes?: string;
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
      repeat?: 'daily' | 'weekly' | 'fortnightly';
      occurrences?: number;
    },
    { bookingId: string; count: number }
  >('createEvent'),
  updateEvent: callable<
    { bookingId: string; title?: string; startAt: string; endAt: string; location?: string; notes?: string; applyBuffer?: boolean },
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
  adjustWallet: callable<{ uid: string; amount: number; note?: string }, { balance: number }>('adjustWallet'),
  migrateLegacyBookings: callable<Record<string, never>, { migrated: number; skipped: number }>('migrateLegacyBookings'),
  scanDocument: callable<
    { key: VerificationStepKey; path: string },
    { found: boolean; reason?: string; number?: string; expiry?: string; state?: string }
  >('scanDocument'),
  submitDocument: callable<{ key: VerificationStepKey }, { ok: true }>('submitDocument'),
  reviewDocument: callable<{ uid: string; key: VerificationStepKey; approve: boolean; note?: string }, { ok: true }>('reviewDocument'),
  setReviewHidden: callable<{ reviewId: string; hidden: boolean }, { ratingAvg: number; ratingCount: number }>('setReviewHidden'),
};
