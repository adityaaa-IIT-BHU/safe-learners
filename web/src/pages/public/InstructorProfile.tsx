import { ArrowLeft, BadgeCheck, CalendarClock, CarFront, MapPin, MessageSquareReply, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { LESSON_TYPES, areaLabel, calendarOf, fullName, initials, lessonPrice, pricingOf, serviceAreasOf } from '@shared/domain';
import { ServiceAreaMap } from '@/components/ServiceAreaEditor';
import { WEEKDAYS } from '@shared/time';
import { useAuth } from '@/auth/AuthProvider';
import { Badge, ButtonLink, Card, CardHeader, EmptyState, PageLoader, Stars, formatMoney } from '@/components/ui';
import { useInstructorReviews, useUser } from '@/lib/data';
import { timeAgo } from '@/lib/format';
import { bookPath } from './FindInstructors';
import { PublicLayout } from './Layout';

export function InstructorProfile({ embedded }: { embedded?: boolean }) {
  const { id } = useParams();
  const { profile } = useAuth();
  const { data: i, loading } = useUser(id);
  const { data: allReviews } = useInstructorReviews(id);
  const reviews = allReviews.filter(r => !r.hidden);

  const wrap = (node: React.ReactNode) => embedded ? node : <PublicLayout><div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">{node}</div></PublicLayout>;

  if (loading) return wrap(<PageLoader />);
  if (!i || i.role !== 'instructor') return wrap(<Card><EmptyState title="Instructor not found" body="This profile may have been removed." action={<ButtonLink to="/instructors">Browse instructors</ButtonLink>} /></Card>);

  const pricing = pricingOf(i);
  const verified = i.verificationStatus === 'verified';
  const bookLink = bookPath(i.id, profile?.role === 'learner');
  const vehicleName = [i.vehicle?.year, i.vehicle?.make, i.vehicle?.model].filter(Boolean).join(' ');
  const years = i.startYear ? new Date().getFullYear() - Number(i.startYear) : null;
  const offered = calendarOf(i).lessonTypes;
  const areas = serviceAreasOf(i);

  return wrap(
    <div className="animate-slide-up">
      <Link to={embedded ? '/learner/instructors' : '/instructors'} className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white">
        <ArrowLeft className="size-4" /> All instructors
      </Link>

      <Card className="relative overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-1.5 bg-[repeating-linear-gradient(90deg,#ffc700_0_32px,transparent_32px_64px)]" />
        <div className="grid gap-6 p-6 sm:grid-cols-[220px_1fr] sm:p-8">
          {/* Portrait photo, anchored to the top so heads aren't cropped */}
          <div className="mx-auto w-full max-w-[220px]">
            {i.photoUrl ? (
              <img src={i.photoUrl} alt={fullName(i)} className="aspect-[4/5] w-full rounded-3xl object-cover object-top shadow-lift ring-4 ring-brand-500" />
            ) : (
              <div className="flex aspect-[4/5] w-full items-center justify-center rounded-3xl bg-gradient-to-br from-brand-300 to-brand-500 text-6xl font-extrabold text-ink-950 ring-4 ring-brand-500">
                {initials(fullName(i))}
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-col justify-center">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{fullName(i)}</h1>
              {verified && <Badge tone="green"><BadgeCheck className="size-3.5" />Verified</Badge>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-500">
              {i.ratingCount ? <span className="flex items-center gap-1.5"><Stars value={i.ratingAvg ?? 0} size={16} /><strong className="text-ink-900 dark:text-white">{i.ratingAvg?.toFixed(1)}</strong> · {i.ratingCount} review{i.ratingCount === 1 ? '' : 's'}</span> : <span>New instructor</span>}
              <span>{i.transmission ?? 'Auto'}</span>
              {years !== null && years >= 0 && <span>{years ? `${years} year${years === 1 ? '' : 's'} teaching` : 'Started this year'}</span>}
              {i.languages && <span>Speaks {i.languages}</span>}
            </div>
            <div className="mt-5 grid max-w-xl grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-ink-50 p-3 dark:bg-ink-800/60"><p className="text-xs font-semibold text-ink-500">From</p><p className="text-xl font-extrabold">{formatMoney(pricing.lesson)}<span className="text-sm font-medium text-ink-500">/hr</span></p></div>
              <div className="rounded-2xl bg-ink-50 p-3 dark:bg-ink-800/60"><p className="text-xs font-semibold text-ink-500">Vehicle</p><p className="truncate font-bold">{[i.vehicle?.make, i.vehicle?.model].filter(Boolean).join(' ') || '—'}</p></div>
              <div className="col-span-2 rounded-2xl bg-ink-50 p-3 sm:col-span-1 dark:bg-ink-800/60"><p className="text-xs font-semibold text-ink-500">Covers</p><p className="truncate font-bold">{areas.length ? `${areas.length} suburb${areas.length === 1 ? '' : 's'}` : '—'}</p></div>
            </div>
            {verified && <div className="mt-6"><ButtonLink to={bookLink} size="lg"><CalendarClock className="size-5" />Book a lesson</ButtonLink></div>}
          </div>
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="About" />
            <div className="space-y-4 p-5">
              <p className="whitespace-pre-line text-ink-700 dark:text-ink-300">{i.bio || `${i.firstName} hasn’t written a bio yet.`}</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Reviews" subtitle={i.ratingCount ? `${i.ratingAvg?.toFixed(1)} average from ${i.ratingCount} learners` : undefined} />
            {reviews.length === 0 ? (
              <EmptyState title="No reviews yet" body="Reviews appear after learners complete lessons." />
            ) : (
              <ul className="divide-y divide-ink-100 dark:divide-ink-800">
                {reviews.slice(0, 10).map(r => (
                  <li key={r.id} className="p-5">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{r.learnerName}</span>
                      <span className="text-xs text-ink-400">{r.createdAt ? timeAgo(r.createdAt) : ''}</span>
                    </div>
                    <Stars value={r.rating} />
                    {r.comment && <p className="mt-2 text-sm text-ink-600 dark:text-ink-300">{r.comment}</p>}
                    {r.reply && (
                      <div className="mt-3 rounded-xl border-l-4 border-brand-500 bg-ink-50 p-3 text-sm dark:bg-ink-800/60">
                        <p className="flex items-center gap-1.5 text-xs font-bold text-ink-500"><MessageSquareReply className="size-3.5" />Reply from {i.firstName}</p>
                        <p className="mt-1 text-ink-700 dark:text-ink-300">{r.reply}</p>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Prices" />
            <ul className="divide-y divide-ink-100 dark:divide-ink-800">
              {offered.map(t => (
                <li key={t} className="flex items-center justify-between px-5 py-3 text-sm">
                  <span>{LESSON_TYPES[t].label}</span>
                  <span className="font-bold">{formatMoney(lessonPrice(t, pricing))}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader title="Vehicle" />
            <div className="p-5">
              {i.vehicle?.photoUrl && <img src={i.vehicle.photoUrl} alt={vehicleName} className="mb-4 aspect-video w-full rounded-xl object-cover" />}
              <p className="flex items-center gap-2 font-semibold"><CarFront className="size-4" />{vehicleName || 'Vehicle details coming soon'}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <Badge>{i.transmission ?? 'Auto'}</Badge>
                {i.vehicle?.ancap && <Badge><ShieldCheck className="size-3" />{i.vehicle.ancap} ANCAP</Badge>}
                {i.vehicle?.dualControls && <Badge tone="green">Dual controls</Badge>}
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Service area" />
            <div className="flex flex-wrap gap-1.5 p-5">
              {areas.length ? areas.map((a, n) => <Badge key={n}><MapPin className="size-3" />{areaLabel(a)}</Badge>) : <p className="text-sm text-ink-500">Not set yet.</p>}
              {areas.some(a => a.lat !== undefined) && <ServiceAreaMap areas={areas} className="mt-2 h-48" />}
            </div>
          </Card>

          {!!i.testLocations?.length && (
            <Card>
              <CardHeader title="Driving test centres" />
              <ul className="space-y-1.5 p-5 text-sm">
                {i.testLocations.map(l => <li key={l.name}><strong>{l.name}</strong>{l.address && <span className="block text-xs text-ink-500">{l.address}</span>}</li>)}
              </ul>
            </Card>
          )}

          <Card>
            <CardHeader title="Usual hours" />
            <ul className="space-y-1.5 p-5 text-sm">
              {WEEKDAYS.map(d => {
                const ranges = i.operatingHours?.[d] ?? [];
                return (
                  <li key={d} className="flex justify-between">
                    <span className="capitalize text-ink-500">{d}</span>
                    <span className="font-medium">{ranges.length ? ranges.map(r => `${r.start}–${r.end}`).join(', ') : 'Closed'}</span>
                  </li>
                );
              })}
            </ul>
            {verified && (
              <div className="border-t border-ink-100 p-4 dark:border-ink-800">
                <ButtonLink to={bookLink} variant="dark" className="w-full"><CalendarClock className="size-4" />See available times</ButtonLink>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>,
  );
}
