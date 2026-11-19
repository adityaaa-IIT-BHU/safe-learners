// Commission data for the web app: settings and profiles (admins), each lesson's commission record
// (the instructor's own, or all for admins) and the instructor's current-rate summary.
import { collection, doc, limit, orderBy, query, where } from 'firebase/firestore';
import { useMemo } from 'react';
import { INITIAL_VERSION, splitCommission, type CommissionCategory, type CommissionVersion, type CustomRateEntry, type IntroState, type LedgerStatus } from '@shared/commission';
import { toDate, useDoc, useQuery } from './data';
import { db } from './firebase';

export interface LedgerEntry {
  id: string;
  bookingId: string;
  instructorId: string;
  instructorName?: string;
  ref?: string | null;
  lessonDay: string;
  bookedDay: string;
  price: number;
  rate: number;
  category: CommissionCategory;
  commission: number;
  earnings: number;
  status: LedgerStatus;
  inheritedFrom?: string | null;
}

export interface CommissionSummary {
  rate: number;
  category: CommissionCategory;
  upcoming: { rate: number; category: CommissionCategory; effectiveFrom: string } | null;
  introPlace: number | null;
  asOf: string;
}

export interface CommissionProfile { id: string; custom: (CustomRateEntry & { by?: string })[]; intro?: IntroState & { decidedAt?: Date } }

export function useCommissionVersions() {
  const { data } = useDoc(doc(db, 'integrations', 'commissionSettings'), (_, d) => (d.versions ?? []) as CommissionVersion[]);
  return data ?? [];
}

export function useCommissionProfiles() {
  return useQuery(query(collection(db, 'commissionProfiles')), (id, d) => ({ id, custom: d.custom ?? [], intro: d.intro ? { ...d.intro, decidedAt: toDate(d.intro.decidedAt) } : undefined } as CommissionProfile), 'commission:profiles');
}

export function useCommissionProfile(uid: string | null) {
  return useDoc(uid ? doc(db, 'commissionProfiles', uid) : null, (id, d) => ({ id, custom: d.custom ?? [], intro: d.intro ? { ...d.intro, decidedAt: toDate(d.intro.decidedAt) } : undefined } as CommissionProfile));
}

export function useCommissionChanges(instructorId?: string) {
  const live = useQuery(
    instructorId ? query(collection(db, 'commissionChanges'), where('instructorId', '==', instructorId), limit(200)) : query(collection(db, 'commissionChanges'), orderBy('atMs', 'desc'), limit(300)),
    (id, d) => ({ id, ...d, at: toDate(d.at) } as Record<string, any> & { id: string }),
    `commission:changes:${instructorId ?? 'all'}`,
  );
  return [...live.data].sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0));
}

/** Lesson commission records: one instructor's (instructors can only read their own), or all (admins). */
export function useCommissionLedger(instructorId: string | null | 'all') {
  const q = instructorId === 'all' ? query(collection(db, 'commissionLedger'), limit(5000))
    : instructorId ? query(collection(db, 'commissionLedger'), where('instructorId', '==', instructorId)) : null;
  return useQuery(q, (id, d) => ({ id, ...d } as LedgerEntry), `commission:ledger:${instructorId}`);
}

export function useMyCommission(uid: string | null | undefined) {
  return useDoc(uid ? doc(db, 'users', uid, 'private', 'commission') : null, (_, d) => d as CommissionSummary);
}

/** Today in Sydney, YYYY-MM-DD (matches the server's effective-date rule). */
export const sydneyToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());

/**
 * An instructor's commission for display: each confirmed lesson uses the rate fixed when it was
 * booked; anything else (proposals, price previews) uses the instructor's current rate.
 */
export function useInstructorCommission(uid: string | null | undefined) {
  const { data: summary } = useMyCommission(uid);
  const { data: ledger } = useCommissionLedger(uid ?? null);
  const byBooking = useMemo(() => new Map(ledger.map(l => [l.bookingId, l])), [ledger]);
  const rate = summary?.rate ?? INITIAL_VERSION.defaultRate;
  const forBooking = (b: { id: string; price?: number }) => {
    const l = byBooking.get(b.id);
    if (l) return { rate: l.rate, commission: l.commission, earnings: l.earnings, fixed: true };
    return { rate, ...splitCommission(b.price ?? 0, rate), fixed: false };
  };
  return { summary, rate, forBooking };
}
