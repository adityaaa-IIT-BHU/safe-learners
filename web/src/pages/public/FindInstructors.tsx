import { CarFront, MapPin, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { coversArea, fullName, pricingOf, serviceAreasOf, type UserProfile } from '@shared/domain';
import { geocodeArea, type LocatedArea } from '@/lib/maps';
import { useAuth } from '@/auth/AuthProvider';
import { Avatar, Badge, ButtonLink, Card, EmptyState, PageHeader, Select, Skeleton, Stars, formatMoney } from '@/components/ui';
import { useVerifiedInstructors } from '@/lib/data';
import { PublicLayout } from './Layout';

type Sort = 'recommended' | 'price' | 'rating';

export function bookPath(instructorId: string, signedInLearner: boolean, rescheduleQuery = ''): string {
  const target = `/learner/book/${instructorId}${rescheduleQuery}`;
  return signedInLearner ? target : `/login?next=${encodeURIComponent(target)}`;
}

/** "Schofields" or "Schofields, Colebee and 3 more" for the suburbs sharing a searched postcode. */
function suburbsLabel(area: LocatedArea): string {
  const names = area.localities?.length ? area.localities : [area.name];
  return names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
}

export function FindInstructors({ embedded }: { embedded?: boolean }) {
  const [params, setParams] = useSearchParams();
  const [transmission, setTransmission] = useState('any');
  const [sort, setSort] = useState<Sort>('recommended');
  const { profile } = useAuth();
  const { data: instructors, loading } = useVerifiedInstructors();
  const q = params.get('q') ?? '';
  // Switching instructor for an existing booking: the new booking replaces it.
  const reschedule = embedded ? params.get('reschedule') : null;
  const rescheduleQuery = reschedule ? `?reschedule=${encodeURIComponent(reschedule)}${params.get('type') ? `&type=${encodeURIComponent(params.get('type')!)}` : ''}` : '';
  // Locate the search (suburb or postcode) so nearby instructors and postcode areas match too.
  const [located, setLocated] = useState<LocatedArea | null>(null);
  useEffect(() => {
    setLocated(null);
    if (!q.trim()) return;
    let cancelled = false;
    geocodeArea(q).then(area => !cancelled && setLocated(area)).catch(() => undefined);
    return () => { cancelled = true; };
  }, [q]);

  const results = useMemo(() => {
    const list = instructors
      .filter(i => i.accountStatus !== 'disabled')
      .filter(i => coversArea(i, q, located && located.lat !== undefined ? { lat: located.lat, lng: located.lng!, postcode: located.postcode, name: located.name, localities: located.localities } : null))
      .filter(i => transmission === 'any' || (i.transmission ?? 'Auto').includes(transmission));
    const score = (i: UserProfile) => (i.ratingAvg ?? 4) * Math.log2(2 + (i.ratingCount ?? 0));
    return list.sort((a, b) =>
      sort === 'price' ? pricingOf(a).lesson - pricingOf(b).lesson
        : sort === 'rating' ? (b.ratingAvg ?? 0) - (a.ratingAvg ?? 0)
          : score(b) - score(a));
  }, [instructors, q, located, transmission, sort]);

  const isLearner = profile?.role === 'learner';
  const base = embedded ? '/learner/instructors' : '/instructors';

  const content = (
    <>
      <PageHeader
        title={q ? `Instructors covering ${located && located.name !== q ? `${q} (${suburbsLabel(located)})` : `“${q}”`}` : 'Find a driving instructor'}
        subtitle="Every instructor is verified. Prices are per hour; the test package includes the car on test day."
      />
      {reschedule && (
        <div className="mb-6 rounded-2xl bg-sky-50 p-4 text-sm text-sky-900 dark:bg-sky-500/10 dark:text-sky-200">
          Choose a new instructor and time. Your current lesson stays booked until you confirm the new one, then it’s cancelled automatically.
        </div>
      )}
      <Card className="mb-6 grid gap-3 p-4 sm:grid-cols-[1fr_auto_auto]">
        <form
          onSubmit={e => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get('q') as string;
            setParams(value.trim() ? { q: value.trim() } : {});
          }}
          className="relative"
        >
          <MapPin className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
          <input name="q" defaultValue={q} key={q} placeholder="Suburb or postcode" className="input pl-10" aria-label="Suburb or postcode" />
          <button type="submit" className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-lg bg-ink-950 p-2 text-white dark:bg-brand-500 dark:text-ink-950" aria-label="Search"><Search className="size-4" /></button>
        </form>
        <Select value={transmission} onChange={e => setTransmission(e.target.value)} aria-label="Transmission">
          <option value="any">Any transmission</option>
          <option value="Auto">Automatic</option>
          <option value="Manual">Manual</option>
        </Select>
        <Select value={sort} onChange={e => setSort(e.target.value as Sort)} aria-label="Sort by">
          <option value="recommended">Recommended</option>
          <option value="rating">Highest rated</option>
          <option value="price">Lowest price</option>
        </Select>
      </Card>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-48" />)}</div>
      ) : results.length === 0 ? (
        <Card>
          <EmptyState
            icon={<SlidersHorizontal className="size-6" />}
            title="No instructors match yet"
            body={q ? `No verified instructor covers “${q}” with these filters. Try a nearby suburb or clear the filters.` : 'Check back soon — new instructors are joining.'}
            action={q ? <ButtonLink to={base} variant="secondary">Clear search</ButtonLink> : undefined}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {results.map(i => <InstructorCard key={i.id} instructor={i} profileLink={`${base}/${i.id}`} bookLink={bookPath(i.id, isLearner, rescheduleQuery)} isMine={profile?.instructorId === i.id} />)}
        </div>
      )}
    </>
  );

  if (embedded) return content;
  return (
    <PublicLayout>
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{content}</div>
    </PublicLayout>
  );
}

function InstructorCard({ instructor: i, profileLink, bookLink, isMine }: { instructor: UserProfile; profileLink: string; bookLink: string; isMine: boolean }) {
  const pricing = pricingOf(i);
  const vehicle = [i.vehicle?.make, i.vehicle?.model].filter(Boolean).join(' ');
  return (
    <Card className="flex flex-col p-5 transition hover:shadow-lift">
      <div className="flex items-start gap-4">
        <Avatar name={fullName(i)} src={i.photoUrl} size={64} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={profileLink} className="truncate text-lg font-bold hover:underline">{fullName(i)}</Link>
            {isMine && <Badge tone="yellow">Your instructor</Badge>}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-sm text-ink-500">
            {i.ratingCount ? <><Stars value={i.ratingAvg ?? 0} /><span>{i.ratingAvg?.toFixed(1)} ({i.ratingCount})</span></> : <span>New instructor</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge>{i.transmission ?? 'Auto'}</Badge>
            {vehicle && <Badge><CarFront className="size-3" />{vehicle}</Badge>}
            {i.vehicle?.dualControls && <Badge tone="green">Dual controls</Badge>}
          </div>
        </div>
        <div className="text-right">
          <p className="text-2xl font-extrabold">{formatMoney(pricing.lesson)}</p>
          <p className="text-xs text-ink-500">per hour</p>
        </div>
      </div>
      {i.bio && <p className="mt-4 line-clamp-2 text-sm text-ink-600 dark:text-ink-300">{i.bio}</p>}
      {serviceAreasOf(i).length > 0 && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-500">
          <MapPin className="mt-0.5 size-3.5 shrink-0" />
          {serviceAreasOf(i).slice(0, 5).map(a => a.name).join(' · ')}{serviceAreasOf(i).length > 5 ? ` +${serviceAreasOf(i).length - 5} more` : ''}
        </p>
      )}
      <div className="mt-5 flex gap-2 pt-1">
        <ButtonLink to={profileLink} variant="secondary" className="flex-1">View profile</ButtonLink>
        <ButtonLink to={bookLink} className="flex-1">Book a lesson</ButtonLink>
      </div>
    </Card>
  );
}
