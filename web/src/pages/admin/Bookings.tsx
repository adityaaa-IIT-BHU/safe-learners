import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { STATUS_META, displayRef, type BookingStatus } from '@shared/domain';
import { BookingRow } from '@/components/booking';
import { Badge, Button, Card, EmptyState, PageHeader, Select } from '@/components/ui';
import { useAllBookings } from './Overview';

type WhenFilter = 'upcoming' | 'today' | 'period';
const WHEN_LABEL: Record<WhenFilter, string> = { upcoming: 'Upcoming lessons', today: 'Today’s lessons', period: 'Lessons in the dashboard period' };

export function AdminBookings() {
  const { data: bookings } = useAllBookings();
  // Filters can arrive in the link (for example from the dashboard): status, when and q.
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<'all' | 'pending' | BookingStatus>(() => (params.get('status') as BookingStatus | 'pending') || 'all');
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const when = params.get('when') as WhenFilter | null;
  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    const now = Date.now();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date());
    const from = params.get('from') ? Date.parse(params.get('from')!) : null, to = params.get('to') ? Date.parse(params.get('to')!) : null;
    return bookings
      .filter(b => b.kind === 'lesson')
      .filter(b => status === 'all' || (status === 'pending' ? b.status === 'proposed' || b.status === 'late_cancel_requested' : b.status === status))
      .filter(b => !when || (when === 'upcoming' ? b.status === 'confirmed' && b.startAt.getTime() >= now
        : when === 'today' ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(b.startAt) === today
        : (from === null || b.startAt.getTime() >= from) && (to === null || b.startAt.getTime() < to)))
      .filter(b => !q || [displayRef(b), b.learnerName, b.instructorName, b.pickupLocation].some(v => v?.toLowerCase().includes(q)))
      .sort((a, b) => (when === 'upcoming' || when === 'today' ? a.startAt.getTime() - b.startAt.getTime() : 0));
  }, [bookings, status, search, when, params]);

  return (
    <>
      <PageHeader title="All bookings" subtitle={`${list.length} shown`} />
      <Card className="mb-4 grid gap-3 p-3 sm:grid-cols-[1fr_220px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Ref, learner, instructor or suburb" className="input pl-10" aria-label="Search bookings" />
        </div>
        <Select value={status} onChange={e => setStatus(e.target.value as 'all' | 'pending' | BookingStatus)} aria-label="Status">
          <option value="all">All statuses</option>
          <option value="pending">Awaiting a response (proposed or late-cancel request)</option>
          {(Object.keys(STATUS_META) as BookingStatus[]).map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </Select>
      </Card>
      {when && (
        <p className="mb-3 flex items-center gap-2 text-sm">
          <Badge tone="blue">{WHEN_LABEL[when]}</Badge>
          <Button size="sm" variant="ghost" onClick={() => { params.delete('when'); params.delete('from'); params.delete('to'); setParams(params); }}>Show all dates</Button>
        </p>
      )}
      <div className="space-y-3">
        {list.length === 0 ? <Card><EmptyState title="No bookings match" /></Card> : list.slice(0, 100).map(b => (
          <BookingRow key={b.id} booking={b} to="#" person={{ name: `${b.learnerName ?? '?'} ↔ ${b.instructorName ?? '?'}` }} />
        ))}
      </div>
    </>
  );
}
