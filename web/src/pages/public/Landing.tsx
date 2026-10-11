import { ArrowRight, BellRing, CalendarCheck, CarFront, MapPin, Search, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { fullName, pricingOf } from '@shared/domain';
import { Avatar, ButtonLink, Card, Stars, formatMoney } from '@/components/ui';
import { useVerifiedInstructors } from '@/lib/data';
import { PublicLayout } from './Layout';

export function Landing() {
  const [suburb, setSuburb] = useState('');
  const navigate = useNavigate();
  const { data: instructors } = useVerifiedInstructors();

  const search = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/instructors${suburb.trim() ? `?q=${encodeURIComponent(suburb.trim())}` : ''}`);
  };

  return (
    <PublicLayout>
      {/* Hero */}
      <section className="relative overflow-hidden bg-ink-950 text-white">
        <div className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'repeating-linear-gradient(90deg, #ffc700 0 40px, transparent 40px 80px)', backgroundSize: '80px 4px', backgroundRepeat: 'repeat-x', backgroundPosition: '0 60%' }} />
        <div className="absolute -right-24 -top-24 size-96 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1.2fr_1fr] lg:py-28">
          <div className="animate-slide-up">
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-brand-300">
              <Sparkles className="size-3.5" /> Real-time booking with verified instructors
            </span>
            <h1 className="mt-6 text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
              From <span className="lplate px-3 py-0.5 text-4xl ring-4 ring-white sm:text-6xl">L</span> plates<br />to <span className="text-brand-400">licence</span>.
            </h1>
            <p className="mt-6 max-w-lg text-lg text-ink-300">
              Find a driving instructor who covers your suburb, see their real availability and book a lesson in under a minute.
            </p>
            <form onSubmit={search} className="mt-8 flex max-w-lg flex-col gap-2 rounded-2xl bg-white p-2 shadow-lift sm:flex-row">
              <label className="flex flex-1 items-center gap-2 px-3 text-ink-900">
                <MapPin className="size-5 shrink-0 text-ink-400" />
                <input
                  value={suburb}
                  onChange={e => setSuburb(e.target.value)}
                  placeholder="Your suburb or postcode"
                  className="w-full bg-transparent py-3 text-base outline-none placeholder:text-ink-400"
                  aria-label="Suburb or postcode"
                />
              </label>
              <button type="submit" className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-brand-500 px-6 font-bold text-ink-950 hover:bg-brand-400">
                <Search className="size-4" /> Find instructors
              </button>
            </form>
          </div>
          <HeroCard />
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 className="text-center text-3xl font-extrabold tracking-tight">How it works</h2>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {[
            { icon: Search, title: 'Find your instructor', body: 'Search by suburb, transmission and price. Every instructor’s licence, WWC check and vehicle are verified.' },
            { icon: CalendarCheck, title: 'Pick a real time', body: 'See live availability and book instantly. No back-and-forth messages, no double bookings.' },
            { icon: CarFront, title: 'Learn and track progress', body: 'Reschedule online, get reminders before every lesson and keep your lesson history in one place.' },
          ].map((s, i) => (
            <Card key={s.title} className="relative p-6">
              <span className="absolute right-5 top-5 text-5xl font-extrabold text-ink-100 dark:text-ink-800">{i + 1}</span>
              <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-500 text-ink-950"><s.icon className="size-6" /></span>
              <h3 className="mt-5 text-lg font-bold">{s.title}</h3>
              <p className="mt-2 text-ink-500">{s.body}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Instructors */}
      {instructors.length > 0 && (
        <section className="border-y border-ink-200/60 bg-white py-20 dark:border-ink-800 dark:bg-ink-900/40">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-3xl font-extrabold tracking-tight">Meet our instructors</h2>
                <p className="mt-2 text-ink-500">Verified, insured and ready to teach.</p>
              </div>
              <ButtonLink to="/instructors" variant="secondary">See all <ArrowRight className="size-4" /></ButtonLink>
            </div>
            <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {instructors.slice(0, 3).map(i => (
                <Card key={i.id} className="p-5 transition hover:-translate-y-0.5 hover:shadow-lift">
                  <div className="flex items-center gap-4">
                    <Avatar name={fullName(i)} src={i.photoUrl} size={56} />
                    <div className="min-w-0">
                      <p className="truncate text-lg font-bold">{fullName(i)}</p>
                      <div className="flex items-center gap-2 text-sm text-ink-500">
                        {i.ratingCount ? <><Stars value={i.ratingAvg ?? 0} /> {i.ratingAvg?.toFixed(1)}</> : 'New instructor'}
                      </div>
                    </div>
                  </div>
                  <p className="mt-4 line-clamp-2 text-sm text-ink-500">{i.bio || `${i.transmission ?? 'Auto'} lessons in ${(i.servicedSuburbs ?? []).slice(0, 2).join(', ') || 'your area'}.`}</p>
                  <div className="mt-4 flex items-center justify-between">
                    <span className="text-sm"><span className="text-xl font-extrabold">{formatMoney(pricingOf(i).lesson)}</span> /hr</span>
                    <ButtonLink to={`/instructors/${i.id}`} size="sm" variant="dark">View profile</ButtonLink>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Features */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: ShieldCheck, title: 'Verified instructors', body: 'Licences, WWC checks and vehicle registration reviewed before an instructor can take bookings.' },
            { icon: BellRing, title: 'Never miss a lesson', body: 'Instant updates when a lesson is booked, moved or cancelled, plus a reminder the day before.' },
            { icon: Wallet, title: 'Simple wallet', body: 'Lesson credit, refunds and referral rewards all in one balance.' },
            { icon: CalendarCheck, title: 'Fair cancellations', body: 'Cancel free up to 24 hours before. Inside 24 hours your instructor decides.' },
          ].map(f => (
            <div key={f.title}>
              <f.icon className="size-7 text-brand-600 dark:text-brand-400" />
              <h3 className="mt-4 font-bold">{f.title}</h3>
              <p className="mt-1 text-sm text-ink-500">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Instructor CTA */}
      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl bg-brand-500 p-8 text-ink-950 sm:p-12">
          <div className="absolute -bottom-10 -right-10 size-64 rounded-full border-[24px] border-ink-950/10" />
          <h2 className="max-w-xl text-3xl font-extrabold tracking-tight">Are you a driving instructor?</h2>
          <p className="mt-3 max-w-xl text-ink-900/80">Fill your calendar with learners in your area. Set your own hours, prices and service suburbs — we handle bookings, reminders and payments.</p>
          <ButtonLink to="/instructor/signup" variant="dark" size="lg" className="mt-8">Join as an instructor <ArrowRight className="size-4" /></ButtonLink>
        </div>
      </section>
    </PublicLayout>
  );
}

function HeroCard() {
  return (
    <div className="relative hidden lg:block">
      <div className="rotate-2 rounded-3xl bg-white p-6 text-ink-900 shadow-lift">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold">Your next lesson</p>
          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-700">Confirmed</span>
        </div>
        <div className="mt-5 flex items-center gap-4">
          <div className="flex w-16 flex-col items-center overflow-hidden rounded-xl border border-ink-200">
            <div className="w-full bg-ink-950 py-0.5 text-center text-[10px] font-bold uppercase text-brand-400">Oct</div>
            <div className="text-2xl font-extrabold">14</div>
            <div className="pb-1 text-[10px] font-semibold uppercase text-ink-500">Tue</div>
          </div>
          <div>
            <p className="font-bold">2 Hour Driving Lesson</p>
            <p className="text-sm text-ink-500">10:00 am – 12:00 pm</p>
            <p className="text-sm text-ink-500">Pick up · Rouse Hill</p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-7 gap-1.5">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <div key={i} className={`rounded-lg py-2 text-center text-xs font-bold ${i === 1 ? 'bg-ink-950 text-brand-400' : i > 4 ? 'bg-ink-100 text-ink-300' : 'bg-ink-50'}`}>{d}</div>
          ))}
        </div>
      </div>
      <div className="absolute -bottom-8 -left-8 -rotate-3 rounded-2xl bg-brand-500 px-5 py-4 text-ink-950 shadow-lift">
        <p className="text-xs font-bold uppercase tracking-wider">Reminder</p>
        <p className="font-bold">Lesson tomorrow at 10:00 am</p>
      </div>
    </div>
  );
}
