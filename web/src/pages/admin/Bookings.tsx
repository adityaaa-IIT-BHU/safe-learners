import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { STATUS_META, displayRef, type BookingStatus } from '@shared/domain';
import { BookingRow } from '@/components/booking';
import { Card, EmptyState, PageHeader, Select } from '@/components/ui';
import { useAllBookings } from './Overview';

export function AdminBookings() {
  const { data: bookings } = useAllBookings();
  const [status, setStatus] = useState<'all' | BookingStatus>('all');
  const [search, setSearch] = useState('');
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return bookings
      .filter(b => b.kind === 'lesson')
      .filter(b => status === 'all' || b.status === status)
      .filter(b => !q || [displayRef(b), b.learnerName, b.instructorName, b.pickupLocation].some(v => v?.toLowerCase().includes(q)));
  }, [bookings, status, search]);

  return (
    <>
      <PageHeader title="All bookings" subtitle={`${list.length} shown`} />
      <Card className="mb-4 grid gap-3 p-3 sm:grid-cols-[1fr_220px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Ref, learner, instructor or suburb" className="input pl-10" aria-label="Search bookings" />
        </div>
        <Select value={status} onChange={e => setStatus(e.target.value as 'all' | BookingStatus)} aria-label="Status">
          <option value="all">All statuses</option>
          {(Object.keys(STATUS_META) as BookingStatus[]).map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </Select>
      </Card>
      <div className="space-y-3">
        {list.length === 0 ? <Card><EmptyState title="No bookings match" /></Card> : list.slice(0, 100).map(b => (
          <BookingRow key={b.id} booking={b} to="#" person={{ name: `${b.learnerName ?? '?'} ↔ ${b.instructorName ?? '?'}` }} />
        ))}
      </div>
    </>
  );
}
