import { useEffect, useMemo, useState } from 'react';
import {
  Timestamp,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  type DocumentData,
  type DocumentReference,
  type Query,
} from 'firebase/firestore';
import { normaliseBooking, normaliseUser, type Booking, type UserProfile } from '@shared/domain';
import { db } from './firebase';

export function toDate(v: unknown): Date | undefined {
  if (!v) return undefined;
  if (v instanceof Timestamp) return v.toDate();
  if (v instanceof Date) return v;
  if (typeof (v as { toDate?: unknown }).toDate === 'function') return (v as { toDate: () => Date }).toDate();
  return undefined;
}

export interface Live<T> {
  data: T;
  loading: boolean;
  error?: Error;
}

/** Realtime single document. Pass null to skip. */
export function useDoc<T>(ref: DocumentReference | null, map: (id: string, d: DocumentData) => T, deps: unknown[] = []): Live<T | null> {
  const [state, setState] = useState<Live<T | null>>({ data: null, loading: !!ref });
  useEffect(() => {
    if (!ref) {
      setState({ data: null, loading: false });
      return;
    }
    setState(s => ({ ...s, loading: true }));
    return onSnapshot(
      ref,
      snap => setState({ data: snap.exists() ? map(snap.id, snap.data()) : null, loading: false }),
      error => setState({ data: null, loading: false, error }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref?.path, ...deps]);
  return state;
}

/** Realtime query. Pass null to skip. `key` must change whenever the query changes. */
export function useQuery<T>(q: Query | null, map: (id: string, d: DocumentData) => T | null, key: string): Live<T[]> {
  const [state, setState] = useState<Live<T[]>>({ data: [], loading: !!q });
  useEffect(() => {
    if (!q) {
      setState({ data: [], loading: false });
      return;
    }
    setState(s => ({ ...s, loading: true }));
    return onSnapshot(
      q,
      snap => setState({
        data: snap.docs.map(d => map(d.id, d.data())).filter((x): x is T => x !== null),
        loading: false,
      }),
      error => {
        console.error(`Query ${key} failed`, error);
        setState({ data: [], loading: false, error });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

// ---------- Mappers ----------

export const mapUser = (id: string, d: DocumentData) => normaliseUser(id, d, toDate);
export const mapBooking = (id: string, d: DocumentData) => normaliseBooking(id, d, toDate);

export interface AppNotification {
  id: string;
  title: string;
  body: string;
  link?: string;
  type: string;
  read: boolean;
  createdAt?: Date;
}

export const mapNotification = (id: string, d: DocumentData): AppNotification => ({
  id,
  title: d.title,
  body: d.body,
  link: d.link ?? undefined,
  type: d.type ?? 'general',
  read: !!d.read,
  createdAt: toDate(d.createdAt),
});

export interface Review {
  id: string;
  instructorId: string;
  learnerName: string;
  rating: number;
  comment: string;
  reply?: string;
  replyAt?: Date;
  hidden?: boolean;
  createdAt?: Date;
}

export const mapReview = (id: string, d: DocumentData): Review => ({
  id,
  instructorId: d.instructorId,
  learnerName: d.learnerName || 'Learner',
  rating: Number(d.rating) || 0,
  comment: d.comment ?? d.feedbackText ?? '',
  reply: d.reply || undefined,
  replyAt: toDate(d.replyAt),
  hidden: d.hidden === true,
  createdAt: toDate(d.createdAt),
});

export interface WalletTransaction {
  id: string;
  amount: number;
  balanceAfter: number;
  type: string;
  note: string;
  bookingId?: string;
  createdAt?: Date;
}

export const mapTransaction = (id: string, d: DocumentData): WalletTransaction => ({
  id,
  amount: Number(d.amount) || 0,
  balanceAfter: Number(d.balanceAfter) || 0,
  type: d.type,
  note: d.note,
  bookingId: d.bookingId,
  createdAt: toDate(d.createdAt),
});

// ---------- Common hooks ----------

export function useUser(uid: string | null | undefined): Live<UserProfile | null> {
  return useDoc(uid ? doc(db, 'users', uid) : null, mapUser);
}

const byStart = (a: Booking, b: Booking) => a.startAt.getTime() - b.startAt.getTime();

/** All bookings for a learner or instructor, sorted by start time (small per-user volumes, so no range query). */
export function useBookings(field: 'learnerId' | 'instructorId', uid: string | null | undefined): Live<Booking[]> {
  const live = useQuery(
    uid ? query(collection(db, 'bookings'), where(field, '==', uid)) : null,
    mapBooking,
    `bookings:${field}:${uid}`,
  );
  const data = useMemo(() => [...live.data].sort(byStart), [live.data]);
  return { ...live, data };
}

/** users/{uid}/private/profile: contact, date of birth, documents (readable by the user and admins). */
export function usePrivateProfile(uid: string | null | undefined): Live<Record<string, any> | null> {
  return useDoc(uid ? doc(db, 'users', uid, 'private', 'profile') : null, (_, d) => d as Record<string, any>);
}

export function useBooking(id: string | undefined): Live<Booking | null> {
  return useDoc(id ? doc(db, 'bookings', id) : null, mapBooking);
}

export function useNotifications(userId: string | null | undefined): Live<AppNotification[]> {
  return useQuery(
    userId ? query(collection(db, 'notifications'), where('userId', '==', userId), orderBy('createdAt', 'desc'), limit(40)) : null,
    mapNotification,
    `notifications:${userId}`,
  );
}

export function useInstructorReviews(instructorId: string | undefined): Live<Review[]> {
  return useQuery(
    instructorId ? query(collection(db, 'reviews'), where('instructorId', '==', instructorId), orderBy('createdAt', 'desc'), limit(50)) : null,
    mapReview,
    `reviews:${instructorId}`,
  );
}

export function useVerifiedInstructors(): Live<UserProfile[]> {
  return useQuery(
    query(collection(db, 'users'), where('role', '==', 'instructor'), where('verificationStatus', '==', 'verified')),
    mapUser,
    'instructors:verified',
  );
}
