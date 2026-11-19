// Instructor commission: which rate applies, and how a lesson price splits into commission and
// instructor earnings. Shared by the web app and Cloud Functions so both agree.
//
// Priority: 1. the instructor's custom rate, 2. the introductory rate (if the instructor holds an
// introductory place and the offer is on), 3. the default platform rate.
//
// Transaction-date rule: a lesson's commission is fixed when the booking is confirmed, using the rates
// in force on that day (Sydney time). It never changes afterwards, even if rates change before the
// lesson takes place. A rescheduled lesson keeps the rate of the booking it replaces.

/** Rates are percentages with up to two decimals (e.g. 15 or 12.5). */
export type Pct = number;

/** One version of the global commission structure; the latest one in force applies. */
export interface CommissionVersion {
  id: string;
  defaultRate: Pct;
  introEnabled: boolean;
  introRate: Pct;
  /** How many instructors can hold an introductory place. */
  introPlaces: number;
  /** YYYY-MM-DD (Sydney) from which this version applies to newly confirmed lessons. */
  effectiveFrom: string;
  createdMs?: number;
  byName?: string;
  reason?: string;
}

/** A custom rate for one instructor from a date; rate null means "back to the standard rate". */
export interface CustomRateEntry {
  id: string;
  rate: Pct | null;
  effectiveFrom: string;
  createdMs?: number;
  byName?: string;
  reason?: string;
}

export type IntroStatus = 'allocated' | 'excluded';
export interface IntroState {
  status: IntroStatus;
  place?: number;
  /** Onboarding date used for the allocation (YYYY-MM-DD). */
  basisDate?: string;
  reason?: string;
}

export type CommissionCategory = 'custom' | 'introductory' | 'default';
export const CATEGORY_LABEL: Record<CommissionCategory, string> = { custom: 'Custom', introductory: 'Introductory', default: 'Default' };

export interface ResolvedCommission {
  rate: Pct;
  category: CommissionCategory;
  versionId: string;
  customId?: string;
}

/** Before any admin sets a structure: the rate the app has always shown (15%), no introductory offer. */
export const INITIAL_VERSION: CommissionVersion = {
  id: 'initial', defaultRate: 15, introEnabled: false, introRate: 15, introPlaces: 10, effectiveFrom: '2000-01-01',
};

const byDate = <T extends { effectiveFrom: string; createdMs?: number }>(a: T, b: T) =>
  a.effectiveFrom.localeCompare(b.effectiveFrom) || (a.createdMs ?? 0) - (b.createdMs ?? 0);

/** The latest entry in force on `day` (later-created wins on the same date). */
export function inForce<T extends { effectiveFrom: string; createdMs?: number }>(list: T[] | undefined, day: string): T | undefined {
  return [...(list ?? [])].filter(x => x.effectiveFrom <= day).sort(byDate).at(-1);
}

/** The next entry after `day`, if one is scheduled. */
export function nextScheduled<T extends { effectiveFrom: string; createdMs?: number }>(list: T[] | undefined, day: string): T | undefined {
  return [...(list ?? [])].filter(x => x.effectiveFrom > day).sort(byDate)[0];
}

export function activeVersion(versions: CommissionVersion[] | undefined, day: string): CommissionVersion {
  return inForce(versions, day) ?? INITIAL_VERSION;
}

export function resolveCommission(
  input: { versions?: CommissionVersion[]; custom?: CustomRateEntry[]; intro?: IntroState | null },
  day: string,
): ResolvedCommission {
  const v = activeVersion(input.versions, day);
  const c = inForce(input.custom, day);
  if (c && c.rate !== null) return { rate: c.rate, category: 'custom', versionId: v.id, customId: c.id };
  // Instructors who hold a place keep it; the switch stops new places being given.
  if (input.intro?.status === 'allocated') return { rate: v.introRate, category: 'introductory', versionId: v.id };
  return { rate: v.defaultRate, category: 'default', versionId: v.id };
}

/** The first date on or after `day` where the resolved rate or category changes, if any is scheduled. */
export function upcomingChange(
  input: { versions?: CommissionVersion[]; custom?: CustomRateEntry[]; intro?: IntroState | null },
  day: string,
): (ResolvedCommission & { effectiveFrom: string }) | null {
  const now = resolveCommission(input, day);
  const dates = [...new Set([...(input.versions ?? []), ...(input.custom ?? [])].map(x => x.effectiveFrom).filter(d => d > day))].sort();
  for (const d of dates) {
    const r = resolveCommission(input, d);
    if (r.rate !== now.rate || r.category !== now.category) return { ...r, effectiveFrom: d };
  }
  return null;
}

const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Splits a lesson price into the platform's commission and the instructor's earnings (cents exact). */
export function splitCommission(price: number, rate: Pct): { commission: number; earnings: number } {
  const p = money(price);
  const commission = money((p * rate) / 100);
  return { commission, earnings: money(p - commission) };
}

/** A valid percentage: 0 to 100 (below 100), at most two decimals. */
export function validRate(v: unknown): v is Pct {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
}

export const pct = (r: Pct) => `${Number.isInteger(r) ? r : r.toFixed(2).replace(/0$/, '')}%`;

/** Commission ledger entry statuses (one entry per confirmed lesson). */
export type LedgerStatus = 'booked' | 'completed' | 'void' | 'late_fee';
export const LEDGER_LABEL: Record<LedgerStatus, string> = {
  booked: 'Booked', completed: 'Completed', void: 'Cancelled (no commission)', late_fee: 'Late-cancellation fee',
};
/** Statuses whose commission counts towards totals. */
export const COUNTED: LedgerStatus[] = ['booked', 'completed', 'late_fee'];
