// Domain model and business rules shared by the web app and Cloud Functions.
import {
  DEFAULT_TIMEZONE,
  WEEKDAYS,
  addDaysToKey,
  atLocalTime,
  dayKey,
  startOfDayKey,
  weekdayOfKey,
  type Weekday,
} from './time';

// ---------- Users ----------

export type Role = 'learner' | 'instructor' | 'admin';
export type VerificationStatus = 'not_submitted' | 'pending_review' | 'verified' | 'rejected';
export type Transmission = 'Auto' | 'Manual' | 'Auto & Manual';

export interface TimeRange {
  start: string; // "HH:mm"
  end: string;
}

export type OperatingHours = Partial<Record<Weekday, TimeRange[]>>;

export interface Pricing {
  lesson: number; // per hour, Safe Learners marketplace learners
  testPackage: number;
  privateLesson?: number; // per hour, learners the instructor invited themselves
  privateTestPackage?: number;
}

export interface ServiceArea {
  name: string; // e.g. "Schofields"
  state?: string;
  postcode?: string;
  lat?: number;
  lng?: number;
}

export interface CalendarSettings {
  lessonTypes?: LessonType[];
  bufferMinutes?: number; // travel time kept free between lessons
  minNoticeHours?: number;
  maxAdvanceDays?: number;
  smartScheduling?: boolean; // avoid leaving unbookable gaps
  smartGapMinutes?: number; // gaps shorter than this are avoided
  defaultView?: 'day' | 'week';
}

export const DEFAULT_PRICING: Pricing = { lesson: 75, testPackage: 225 };

export interface UserProfile {
  id: string;
  role: Role;
  firstName: string;
  surname?: string;
  email?: string;
  mobile?: string;
  dob?: string;
  gender?: string;
  photoUrl?: string;
  timezone?: string;
  accountStatus?: 'active' | 'disabled';
  status?: 'invited' | 'claimed';
  invitedBy?: string;
  inviteEmail?: string;
  createdAt?: Date;

  // Learner
  instructorId?: string;
  walletBalance?: number;
  referralCode?: string;
  referredBy?: string;
  referralCount?: number;
  homeSuburb?: string;

  // Instructor
  bio?: string;
  languages?: string;
  startYear?: string;
  transmission?: Transmission;
  pricing?: Pricing;
  pendingPriceChange?: {
    newPrice: number;
    newTestPackage?: number;
    newPrivateLesson?: number;
    newPrivateTestPackage?: number;
    effectiveAt: Date;
    requestedAt?: Date;
  };
  operatingHours?: OperatingHours;
  servicedSuburbs?: string[];
  serviceAreas?: ServiceArea[];
  calendarSettings?: CalendarSettings;
  documentsPending?: boolean;
  privateInstructorIds?: string[];
  bookedInstructorIds?: string[];
  vehicle?: VehicleDetails;
  verificationStatus?: VerificationStatus;
  verification?: VerificationDetails;
  verificationRejectionReason?: string;
  documentReviews?: Partial<Record<VerificationStepKey, DocumentReview>>;
  ratingAvg?: number;
  ratingCount?: number;
  bankingDetails?: { accountName: string; bsb: string; accountNumber: string; abn?: string };
}

export interface VehicleDetails {
  make?: string;
  model?: string;
  year?: string;
  colour?: string;
  ancap?: string;
  dualControls?: boolean;
  plateNumber?: string;
  photoUrl?: string;
}

export interface DocumentReview {
  status: 'pending' | 'approved' | 'rejected';
  note?: string;
  submittedAt?: Date;
  reviewedAt?: Date;
}

export interface VerificationDocument {
  url?: string;
  backUrl?: string;
  number?: string;
  expiry?: string;
  state?: string;
  submittedAt?: Date;
}

export interface VerificationDetails {
  driverLicence?: VerificationDocument;
  instructorLicence?: VerificationDocument;
  wwc?: VerificationDocument;
  vehicleRego?: VerificationDocument;
  rejectionReason?: string;
}

export const VERIFICATION_STEPS = [
  { key: 'driverLicence', label: "Driver's licence", hint: 'Front of your current Australian driver licence' },
  { key: 'instructorLicence', label: 'Driving instructor licence', hint: 'Your state-issued driving instructor licence' },
  { key: 'wwc', label: 'Working With Children Check', hint: 'Required to teach learners under 18' },
  { key: 'vehicleRego', label: 'Vehicle registration', hint: 'Certificate of registration for your lesson vehicle' },
] as const;
export type VerificationStepKey = (typeof VERIFICATION_STEPS)[number]['key'];

export function fullName(u: Pick<UserProfile, 'firstName' | 'surname'> | undefined | null): string {
  if (!u) return '';
  return [u.firstName, u.surname].filter(Boolean).join(' ');
}

export function initials(name: string | undefined): string {
  return (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(p => p[0]!.toUpperCase())
    .join('');
}

/** Current prices, including a scheduled change once its start time has passed (before the job persists it). */
export function pricingOf(u: Pick<UserProfile, 'pricing' | 'pendingPriceChange'> | undefined | null, now: Date = new Date()): Pricing {
  const p: Pricing = { ...DEFAULT_PRICING, ...(u?.pricing || {}) };
  const pending = u?.pendingPriceChange;
  if (pending && pending.effectiveAt.getTime() <= now.getTime()) {
    p.lesson = pending.newPrice;
    if (pending.newTestPackage !== undefined) p.testPackage = pending.newTestPackage;
    if (pending.newPrivateLesson !== undefined) p.privateLesson = pending.newPrivateLesson;
    if (pending.newPrivateTestPackage !== undefined) p.privateTestPackage = pending.newPrivateTestPackage;
  }
  return p;
}

/** Learners an instructor invited themselves pay that instructor's private rates. */
export function isPrivateLearner(learner: Pick<UserProfile, 'invitedBy' | 'privateInstructorIds'> | undefined | null, instructorId: string): boolean {
  return !!learner && (learner.invitedBy === instructorId || !!learner.privateInstructorIds?.includes(instructorId));
}

/** The lesson/test prices a particular learner pays this instructor. */
export function pricingFor(
  instructor: Pick<UserProfile, 'id' | 'pricing' | 'pendingPriceChange'> | undefined | null,
  learner?: Pick<UserProfile, 'invitedBy' | 'privateInstructorIds'> | null,
  now: Date = new Date(),
): Pricing {
  const p = pricingOf(instructor, now);
  if (instructor && isPrivateLearner(learner, instructor.id)) {
    return { lesson: p.privateLesson ?? p.lesson, testPackage: p.privateTestPackage ?? p.testPackage };
  }
  return { lesson: p.lesson, testPackage: p.testPackage };
}

// ---------- Lessons ----------

export type LessonType = 'lesson-1h' | 'lesson-1.5h' | 'lesson-2h' | 'lesson-3h' | 'test-package';

export const LESSON_TYPES: Record<LessonType, { label: string; short: string; minutes: number }> = {
  'lesson-1h': { label: '1 Hour Driving Lesson', short: '1 hr lesson', minutes: 60 },
  'lesson-1.5h': { label: '1.5 Hour Driving Lesson', short: '1.5 hr lesson', minutes: 90 },
  'lesson-2h': { label: '2 Hour Driving Lesson', short: '2 hr lesson', minutes: 120 },
  'lesson-3h': { label: '3 Hour Driving Lesson', short: '3 hr lesson', minutes: 180 },
  'test-package': { label: 'Driving Test Package', short: 'Test package', minutes: 150 },
};

export const LESSON_TYPE_ORDER: LessonType[] = ['lesson-1h', 'lesson-1.5h', 'lesson-2h', 'lesson-3h', 'test-package'];

/** Every instructor offers these; the rest are optional in calendar settings. */
export const REQUIRED_LESSON_TYPES: LessonType[] = ['lesson-1h', 'lesson-2h'];

export const DEFAULT_CALENDAR_SETTINGS: Required<CalendarSettings> = {
  lessonTypes: ['lesson-1h', 'lesson-1.5h', 'lesson-2h', 'test-package'],
  bufferMinutes: 0,
  minNoticeHours: 2,
  maxAdvanceDays: 60,
  smartScheduling: false,
  smartGapMinutes: 60,
  defaultView: 'week',
};

export function calendarOf(u: Pick<UserProfile, 'calendarSettings'> | undefined | null): Required<CalendarSettings> {
  const c = { ...DEFAULT_CALENDAR_SETTINGS, ...(u?.calendarSettings || {}) };
  const offered = new Set<LessonType>([...REQUIRED_LESSON_TYPES, ...(c.lessonTypes || [])]);
  c.lessonTypes = LESSON_TYPE_ORDER.filter(t => offered.has(t));
  return c;
}

export function lessonPrice(type: LessonType, pricing: Pricing): number {
  if (type === 'test-package') return round2(pricing.testPackage);
  return round2((LESSON_TYPES[type].minutes / 60) * pricing.lesson);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Platform service fee taken from instructor earnings. */
export const PLATFORM_FEE_RATE = 0.15;

/** Learners can cancel for a refund up to this many hours before a lesson. */
export const FREE_CANCELLATION_HOURS = 24;

/** Price changes requested by instructors take effect at the next local midnight. */
export function priceChangeEffectiveAt(now: Date, timeZone: string = DEFAULT_TIMEZONE): Date {
  return startOfDayKey(addDaysToKey(dayKey(now, timeZone), 1), timeZone);
}

// ---------- Credit packages ----------

export const CREDIT_PACKAGES = [
  { hours: 10, discount: 0.1, title: '10 hours', blurb: 'Perfect for new learners starting their driving journey from scratch' },
  { hours: 6, discount: 0.05, title: '6 hours', blurb: 'Ideal for new learners, overseas licence holders, or a skills refresh' },
] as const;

export function creditPackagePrice(hours: number, hourlyRate: number): { gross: number; discount: number; total: number } {
  const pkg = CREDIT_PACKAGES.find(p => p.hours === hours);
  const gross = round2(hours * hourlyRate);
  const discount = round2(gross * (pkg?.discount ?? 0));
  return { gross, discount, total: round2(gross - discount) };
}

// ---------- Referrals ----------

export const REFERRAL_REWARD_REFERRER = 20;
export const REFERRAL_REWARD_FRIEND = 10;

// ---------- Bookings ----------

export type BookingStatus =
  | 'proposed' // instructor proposed, waiting for learner
  | 'confirmed'
  | 'late_cancel_requested' // learner asked to cancel inside the free-cancellation window
  | 'cancelled'
  | 'completed'
  | 'declined' // learner declined a proposal
  | 'withdrawn'; // instructor withdrew a proposal

// events: instructor-only blocks (personal time / time off); open: extra open hours outside the weekly schedule
export type BookingKind = 'lesson' | 'event' | 'open';

export type PaymentStatus = 'unpaid' | 'paid' | 'refunded' | 'charged';

export interface BookingHistoryEntry {
  at: Date;
  action: string;
  by: 'learner' | 'instructor' | 'admin' | 'system';
  byName?: string;
}

export interface Booking {
  id: string;
  ref?: string;
  kind: BookingKind;
  status: BookingStatus;
  instructorId: string;
  instructorName?: string;
  instructorMobile?: string;
  learnerId?: string;
  learnerName?: string;
  lessonType?: LessonType;
  title?: string; // events
  startAt: Date;
  endAt: Date;
  timezone: string;
  transmission?: string;
  pickupLocation?: string;
  dropoffLocation?: string;
  testLocation?: string;
  notes?: string;
  price?: number;
  paymentStatus?: PaymentStatus;
  proposedBy?: 'learner' | 'instructor';
  cancelledBy?: 'learner' | 'instructor' | 'admin';
  cancellationReason?: string;
  rescheduledFrom?: string;
  rescheduledTo?: string;
  reviewed?: boolean;
  instructorNotes?: string;
  createdAt?: Date;
  history?: BookingHistoryEntry[];
  legacy?: boolean;
}

export const STATUS_META: Record<BookingStatus, { label: string; tone: 'green' | 'amber' | 'red' | 'blue' | 'slate' }> = {
  proposed: { label: 'Awaiting response', tone: 'amber' },
  confirmed: { label: 'Confirmed', tone: 'green' },
  late_cancel_requested: { label: 'Cancellation requested', tone: 'amber' },
  cancelled: { label: 'Cancelled', tone: 'red' },
  completed: { label: 'Completed', tone: 'blue' },
  declined: { label: 'Declined', tone: 'slate' },
  withdrawn: { label: 'Withdrawn', tone: 'slate' },
};

/** Statuses that occupy the instructor's time. */
export const SLOT_HOLDING: BookingStatus[] = ['proposed', 'confirmed', 'late_cancel_requested'];

export function holdsSlot(b: Pick<Booking, 'status' | 'kind'>): boolean {
  return b.kind !== 'open' && SLOT_HOLDING.includes(b.status);
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export function hoursUntil(date: Date, now: Date = new Date()): number {
  return (date.getTime() - now.getTime()) / 3_600_000;
}

/** A learner can rebook a cancelled lesson, or move a confirmed one outside the free-cancellation window. */
export function learnerCanReschedule(b: Booking, now: Date = new Date()): boolean {
  if (b.kind !== 'lesson' || b.rescheduledTo) return false;
  if (b.status === 'cancelled') return true;
  return b.status === 'confirmed' && hoursUntil(b.startAt, now) >= FREE_CANCELLATION_HOURS;
}

export function displayRef(b: Pick<Booking, 'ref' | 'id'>): string {
  return b.ref ? `#${b.ref}` : `#${b.id.slice(0, 6).toUpperCase()}`;
}

/** Booking reference: lesson day + month, then that day's sequence, e.g. 0909-01. */
export function formatBookingRef(startAt: Date, sequence: number, timeZone: string = DEFAULT_TIMEZONE): string {
  const key = dayKey(startAt, timeZone); // YYYY-MM-DD
  return `${key.slice(8, 10)}${key.slice(5, 7)}-${String(sequence).padStart(2, '0')}`;
}

// ---------- Service areas & search ----------

const STATES = ['NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT'];

/** Parses "Kellyville NSW 2155", "Kellyville 2155", "Kellyville" or "2769" into a service area. */
export function parseAreaString(value: string): ServiceArea {
  const parts = value.trim().replace(/,/g, ' ').split(/\s+/);
  let postcode: string | undefined;
  let state: string | undefined;
  if (/^\d{4}$/.test(parts[parts.length - 1] ?? '')) postcode = parts.pop();
  if (STATES.includes((parts[parts.length - 1] ?? '').toUpperCase())) state = parts.pop()!.toUpperCase();
  return { name: parts.join(' ') || postcode || value.trim(), state, postcode };
}

/** Service areas with location data, falling back to the old plain suburb names. */
export function serviceAreasOf(u: Pick<UserProfile, 'serviceAreas' | 'servicedSuburbs'> | undefined | null): ServiceArea[] {
  if (u?.serviceAreas?.length) return u.serviceAreas;
  return (u?.servicedSuburbs ?? []).map(parseAreaString);
}

export function areaLabel(a: ServiceArea): string {
  if (/^\d{4}$/.test(a.name)) return a.name;
  return [a.name, a.state, a.postcode].filter(Boolean).join(' ');
}

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** How close a searched place must be to one of an instructor's suburbs to count as covered. */
export const NEARBY_KM = 3;

/**
 * Does an instructor cover a searched suburb or postcode?
 * Matches on postcode, on suburb name, or (when the search was located) on distance.
 */
export function coversArea(
  u: Pick<UserProfile, 'serviceAreas' | 'servicedSuburbs'>,
  query: string,
  located?: { lat: number; lng: number; postcode?: string; name?: string } | null,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const areas = serviceAreasOf(u);
  const postcode = /^\d{4}$/.test(q) ? q : located?.postcode;
  const name = /^\d{4}$/.test(q) ? located?.name?.toLowerCase() : q.replace(/\s+(nsw|act|vic|qld|sa|wa|tas|nt)\b.*$/i, '').replace(/\s+\d{4}$/, '');
  return areas.some(a => {
    const an = a.name.toLowerCase();
    if (postcode && (a.postcode === postcode || an === postcode)) return true;
    if (name && (an === name || an.includes(name) || (name.length > 3 && name.includes(an)))) return true;
    if (located && a.lat !== undefined && a.lng !== undefined && distanceKm(located, { lat: a.lat, lng: a.lng }) <= NEARBY_KM) return true;
    return false;
  });
}

// ---------- Availability ----------

export interface Slot {
  start: Date;
  end: Date;
}

export interface BusyInterval {
  start: Date;
  end: Date;
}

interface Span {
  start: number; // ms
  end: number;
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter(x => x.end > x.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const sp of sorted) {
    const last = out[out.length - 1];
    if (last && sp.start <= last.end) last.end = Math.max(last.end, sp.end);
    else out.push({ ...sp });
  }
  return out;
}

function subtractSpans(from: Span[], remove: Span[]): Span[] {
  let result = from;
  for (const r of mergeSpans(remove)) {
    const next: Span[] = [];
    for (const f of result) {
      if (r.end <= f.start || r.start >= f.end) next.push(f);
      else {
        if (r.start > f.start) next.push({ start: f.start, end: r.start });
        if (r.end < f.end) next.push({ start: r.end, end: f.end });
      }
    }
    result = next;
  }
  return result;
}

/**
 * Open start times for one local day.
 * Free time = weekly hours (plus any extra open hours) minus busy time, where each busy block is
 * padded by the travel buffer. Starts step through each free gap and also include the start that
 * finishes exactly at the end of the gap. With smart scheduling, starts that would strand a gap
 * too short for another lesson (shorter than `smartGapMinutes` plus the travel buffer) are skipped.
 */
export function openSlotsForDay(opts: {
  day: string; // YYYY-MM-DD in the instructor's zone
  durationMinutes: number;
  hours: OperatingHours;
  busy: BusyInterval[];
  extraOpen?: BusyInterval[];
  timeZone?: string;
  stepMinutes?: number;
  bufferMinutes?: number;
  minNoticeMinutes?: number;
  smartGapMinutes?: number; // 0 = off
  latest?: Date;
  now?: Date;
}): Slot[] {
  const {
    day,
    durationMinutes,
    hours,
    busy,
    extraOpen = [],
    timeZone = DEFAULT_TIMEZONE,
    stepMinutes = 30,
    bufferMinutes = 0,
    minNoticeMinutes = 120,
    smartGapMinutes = 0,
    latest,
    now = new Date(),
  } = opts;
  const MIN = 60_000;
  const dayStart = startOfDayKey(day, timeZone).getTime();
  const dayEnd = startOfDayKey(addDaysToKey(day, 1), timeZone).getTime();

  const open = mergeSpans([
    ...(hours[weekdayOfKey(day)] || []).map(r => ({
      start: atLocalTime(day, r.start, timeZone).getTime(),
      end: atLocalTime(day, r.end, timeZone).getTime(),
    })),
    ...extraOpen.map(x => ({ start: Math.max(x.start.getTime(), dayStart), end: Math.min(x.end.getTime(), dayEnd) })),
  ]);
  const free = subtractSpans(open, busy.map(b => ({
    start: b.start.getTime() - bufferMinutes * MIN,
    end: b.end.getTime() + bufferMinutes * MIN,
  })));

  const duration = durationMinutes * MIN;
  const earliest = now.getTime() + minNoticeMinutes * MIN;
  // A gap is only usable if another lesson fits in it *with* its own travel buffer.
  const gap = smartGapMinutes > 0 ? (smartGapMinutes + bufferMinutes) * MIN : 0;
  const starts = new Set<number>();
  for (const f of free) {
    const candidates: number[] = [];
    for (let t = f.start; t + duration <= f.end; t += stepMinutes * MIN) candidates.push(t);
    if (f.end - duration >= f.start) candidates.push(f.end - duration);
    for (const t of candidates) {
      if (t < earliest || (latest && t > latest.getTime())) continue;
      if (gap > 0) {
        const before = t - f.start;
        const after = f.end - (t + duration);
        // Lessons flush against either edge of the free window never strand a new gap there.
        const flush = before === 0 || after === 0;
        if (!flush && (before < gap || after < gap)) continue;
      }
      starts.add(t);
    }
  }
  return [...starts].sort((a, b) => a - b).map(t => ({ start: new Date(t), end: new Date(t + duration) }));
}

export function openSlotsForRange(opts: {
  fromDay: string;
  days: number;
  durationMinutes: number;
  hours: OperatingHours;
  busy: BusyInterval[];
  extraOpen?: BusyInterval[];
  timeZone?: string;
  bufferMinutes?: number;
  minNoticeMinutes?: number;
  smartGapMinutes?: number;
  latest?: Date;
  now?: Date;
}): Record<string, Slot[]> {
  const out: Record<string, Slot[]> = {};
  for (let i = 0; i < opts.days; i++) {
    const day = addDaysToKey(opts.fromDay, i);
    const slots = openSlotsForDay({ ...opts, day });
    if (slots.length) out[day] = slots;
  }
  return out;
}

export function hasAnyHours(hours: OperatingHours | undefined): boolean {
  return !!hours && WEEKDAYS.some(d => (hours[d] || []).length > 0);
}

// ---------- Legacy data (bookings written by the old single-page site) ----------

const LEGACY_STATUS: Record<string, BookingStatus> = {
  CONFIRMED: 'confirmed',
  PROPOSED: 'proposed',
  PENDING: 'proposed',
  pending: 'proposed',
  LATE_CANCEL_PENDING: 'late_cancel_requested',
  CANCELLED: 'cancelled',
  CANCELLED_CHARGED: 'cancelled',
  RESCHEDULED: 'cancelled',
  COMPLETED: 'completed',
  DECLINED: 'declined',
  declined: 'declined',
  confirmed: 'confirmed',
  WITHDRAWN: 'withdrawn',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Parses "Wed, 9 Sep 2026" or "2026-09-09" into a day key. */
export function parseLegacyDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return value;
  const m = value.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** Parses "10:00 am", "1:30 PM" or "14:30" into "HH:mm". */
export function parseLegacyTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export function legacyLessonType(value: unknown): LessonType {
  const v = String(value || '').toLowerCase();
  if (v.includes('test')) return 'test-package';
  if (v.includes('1.5')) return 'lesson-1.5h';
  if (v.includes('3')) return 'lesson-3h';
  if (v.includes('2')) return 'lesson-2h';
  return 'lesson-1h';
}

export function mapLegacyStatus(status: unknown): BookingStatus {
  if (typeof status === 'string' && status in STATUS_META) return status as BookingStatus;
  return LEGACY_STATUS[String(status)] ?? 'confirmed';
}

/**
 * Normalises a raw booking document (new or legacy shape). `toDate` converts the store's timestamp type.
 * Returns null for documents that can't be placed on a calendar.
 */
export function normaliseBooking(id: string, raw: Record<string, any>, toDate: (v: any) => Date | undefined): Booking | null {
  const timezone: string = raw.timezone || DEFAULT_TIMEZONE;
  let startAt = toDate(raw.startAt);
  let endAt = toDate(raw.endAt);
  let legacy = false;

  if (!startAt) {
    const day = parseLegacyDate(raw.date);
    const time = parseLegacyTime(raw.startTime ?? raw.time);
    if (!day || !time) return null;
    legacy = true;
    startAt = atLocalTime(day, time, timezone);
    const endTime = parseLegacyTime(raw.endTime);
    endAt = endTime ? atLocalTime(day, endTime, timezone) : undefined;
    if (!endAt || endAt <= startAt) {
      const minutes = raw.duration ? Number(raw.duration) * 60 : LESSON_TYPES[legacyLessonType(raw.lessonType)].minutes;
      endAt = new Date(startAt.getTime() + minutes * 60_000);
    }
  }
  if (!endAt) endAt = new Date(startAt.getTime() + 60 * 60_000);

  const kind: BookingKind = raw.kind ?? (raw.type === 'personal' ? 'event' : 'lesson');
  return {
    id,
    ref: raw.ref ?? raw.bookingRef,
    kind,
    status: mapLegacyStatus(raw.status),
    instructorId: raw.instructorId,
    instructorName: raw.instructorName,
    instructorMobile: raw.instructorMobile,
    learnerId: raw.learnerId,
    learnerName: raw.learnerName,
    lessonType: kind === 'lesson' ? (raw.lessonType in LESSON_TYPES ? raw.lessonType : legacyLessonType(raw.lessonType)) : undefined,
    title: raw.title ?? (kind === 'event' ? raw.learnerName : undefined),
    startAt,
    endAt,
    timezone,
    transmission: raw.transmission,
    pickupLocation: raw.pickupLocation ?? raw.location,
    dropoffLocation: raw.dropoffLocation,
    testLocation: raw.testLocation,
    notes: raw.notes,
    price: typeof raw.price === 'number' ? raw.price : undefined,
    paymentStatus: raw.paymentStatus ?? (raw.status === 'CANCELLED_CHARGED' ? 'charged' : undefined),
    proposedBy: raw.proposedBy,
    cancelledBy: raw.cancelledBy,
    cancellationReason: raw.cancellationReason,
    rescheduledFrom: raw.rescheduledFrom,
    rescheduledTo: raw.rescheduledTo,
    reviewed: raw.reviewed,
    instructorNotes: raw.instructorNotes,
    createdAt: toDate(raw.createdAt),
    history: Array.isArray(raw.history)
      ? raw.history.map((h: any) => ({ ...h, at: toDate(h.at) ?? new Date(0) }))
      : undefined,
    legacy,
  };
}

/**
 * Normalises a document expiry date to "YYYY-MM-DD", or null if it can't be read.
 * Accepts ISO dates, Australian DD/MM/YYYY, "03 JUL 2029", and two-digit years (a date
 * input typed as "08/04/29" arrives as year 0029, which would otherwise look long expired).
 */
export function normaliseExpiry(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim();
  let y: number, m: number, d: number;
  let match: RegExpMatchArray | null;
  if ((match = v.match(/^(\d{1,6})-(\d{1,2})-(\d{1,2})$/))) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])]; // Australian order
  } else if ((match = v.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{2}|\d{4})$/))) {
    d = Number(match[1]);
    m = MONTHS.indexOf(match[2].toLowerCase()) + 1;
    y = Number(match[3]);
  } else {
    return null;
  }
  if (y < 100) y += 2000;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCMonth() !== m - 1) return null; // e.g. 31/02
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** True when an expiry date is before today (in the given zone). Unreadable dates are not "expired". */
export function isExpired(value: unknown, timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): boolean {
  const iso = normaliseExpiry(value);
  return !!iso && iso < dayKey(now, timeZone);
}

/**
 * Verification documents uploaded on the previous website, from the old flat fields
 * (now kept in users/{uid}/private/profile.legacy).
 */
export function legacyVerificationDocs(r: Record<string, any> | undefined | null): Partial<Record<VerificationStepKey, VerificationDocument>> {
  const out: Partial<Record<VerificationStepKey, VerificationDocument>> = {};
  if (!r) return out;
  if (r.driverLicenseUrl) out.driverLicence = { url: r.driverLicenseUrl, number: r.licenseNumber, expiry: r.licenseExpiry };
  if (r.instructorLicenseUrl) out.instructorLicence = { url: r.instructorLicenseUrl, number: r.instructorLicenseNumber, expiry: r.instructorLicenseExpiry };
  if (r.wwcCheckUrl) out.wwc = { url: r.wwcCheckUrl, number: r.wwcNumber, expiry: r.wwcExpiry };
  if (r.vehicleRegoUrl) out.vehicleRego = { url: r.vehicleRegoUrl, number: r.plateNumber, expiry: r.regoExpiry };
  return out;
}

/** Vehicle details from new or legacy (flat) user fields. */
export function vehicleOf(raw: Record<string, any>): VehicleDetails {
  return {
    make: raw.vehicle?.make ?? raw.vehicleMake,
    model: raw.vehicle?.model ?? raw.vehicleModel,
    year: raw.vehicle?.year,
    colour: raw.vehicle?.colour,
    ancap: raw.vehicle?.ancap ?? raw.ancap,
    dualControls: raw.vehicle?.dualControls ?? (raw.dualControls === undefined ? undefined : raw.dualControls === 'Yes' || raw.dualControls === true),
    plateNumber: raw.vehicle?.plateNumber ?? raw.plateNumber,
    photoUrl: raw.vehicle?.photoUrl ?? raw.vehiclePhotoUrl,
  };
}

export function normaliseUser(id: string, raw: Record<string, any>, toDate: (v: any) => Date | undefined): UserProfile {
  const pending = raw.pendingPriceChange;
  return {
    ...raw,
    id,
    role: raw.role === 'admin' || raw.role === 'instructor' ? raw.role : 'learner',
    firstName: raw.firstName || (raw.email ? String(raw.email).split('@')[0] : 'User'),
    photoUrl: raw.photoUrl ?? raw.instructorPhotoUrl,
    vehicle: vehicleOf(raw),
    verificationStatus: raw.verificationStatus ?? (raw.role === 'instructor' ? 'not_submitted' : undefined),
    pendingPriceChange: pending
      ? {
        newPrice: Number(pending.newPrice),
        newTestPackage: pending.newTestPackage === undefined ? undefined : Number(pending.newTestPackage),
        newPrivateLesson: pending.newPrivateLesson === undefined ? undefined : Number(pending.newPrivateLesson),
        newPrivateTestPackage: pending.newPrivateTestPackage === undefined ? undefined : Number(pending.newPrivateTestPackage),
        effectiveAt: toDate(pending.effectiveAt) ?? new Date(), requestedAt: toDate(pending.requestedAt) }
      : undefined,
    createdAt: toDate(raw.createdAt),
    documentReviews: raw.documentReviews
      ? Object.fromEntries(Object.entries(raw.documentReviews as Record<string, Record<string, unknown>>).map(([k, r]) => [
        k, { ...r, submittedAt: toDate(r.submittedAt), reviewedAt: toDate(r.reviewedAt) },
      ]))
      : undefined,
  } as UserProfile;
}

/** Firestore range-query helper: the local day key for "today" in a zone. */
export function todayKey(timeZone: string = DEFAULT_TIMEZONE, now: Date = new Date()): string {
  return dayKey(now, timeZone);
}
