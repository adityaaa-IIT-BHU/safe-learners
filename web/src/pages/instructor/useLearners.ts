import { collection, doc, getDoc, query, where } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import type { Booking, UserProfile } from '@shared/domain';
import { mapUser, useQuery } from '@/lib/data';
import { db } from '@/lib/firebase';

/** Learners linked to an instructor (assigned or invited) plus anyone they've had bookings with. */
export function useMyLearners(instructorId: string | null, bookings: Booking[]) {
  const assigned = useQuery(
    instructorId ? query(collection(db, 'users'), where('role', '==', 'learner'), where('instructorId', '==', instructorId)) : null,
    mapUser,
    `learners:${instructorId}`,
  );
  const [extra, setExtra] = useState<Record<string, UserProfile | null>>({});

  const bookingLearnerIds = useMemo(
    () => [...new Set(bookings.map(b => b.learnerId).filter((x): x is string => !!x))].sort().join(','),
    [bookings],
  );

  useEffect(() => {
    if (assigned.loading) return;
    const known = new Set(assigned.data.map(u => u.id));
    const missing = bookingLearnerIds.split(',').filter(id => id && !known.has(id) && !(id in extra));
    if (!missing.length) return;
    let cancelled = false;
    Promise.all(missing.map(id => getDoc(doc(db, 'users', id)).then(s => [id, s.exists() ? mapUser(s.id, s.data()) : null] as const).catch(() => [id, null] as const)))
      .then(entries => !cancelled && setExtra(e => ({ ...e, ...Object.fromEntries(entries) })));
    return () => { cancelled = true; };
  }, [assigned.loading, assigned.data, bookingLearnerIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const learners = useMemo(() => {
    const map = new Map<string, UserProfile>();
    assigned.data.forEach(u => map.set(u.id, u));
    Object.values(extra).forEach(u => u && map.set(u.id, u));
    return [...map.values()]
      .filter(u => u.status !== 'claimed')
      .sort((a, b) => (a.firstName || '').localeCompare(b.firstName || ''));
  }, [assigned.data, extra]);

  return { learners, loading: assigned.loading };
}
