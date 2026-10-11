import { Clock, Info, Store, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { LESSON_TYPES, PLATFORM_FEE_RATE, calendarOf, lessonPrice, priceChangeEffectiveAt, pricingOf, type Pricing as PriceSet } from '@shared/domain';
import { DEFAULT_TIMEZONE, formatDate } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Button, Card, CardHeader, Input, PageHeader, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { timeUntil } from '@/lib/format';

export function Pricing() {
  const me = useProfile();
  const { readOnly } = useAuth();
  const tz = me.timezone ?? DEFAULT_TIMEZONE;
  const current = pricingOf(me);
  const pending = me.pendingPriceChange && me.pendingPriceChange.effectiveAt.getTime() > Date.now() ? me.pendingPriceChange : undefined;
  const [form, setForm] = useState({
    lesson: String(current.lesson),
    testPackage: String(current.testPackage),
    privateLesson: String(current.privateLesson ?? current.lesson),
    privateTestPackage: String(current.privateTestPackage ?? current.testPackage),
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));
  const n = (v: string) => Number(v) || 0;

  const marketplace: PriceSet = { lesson: n(form.lesson), testPackage: n(form.testPackage) };
  const privateRates: PriceSet = { lesson: n(form.privateLesson), testPackage: n(form.privateTestPackage) };
  const changed = marketplace.lesson !== current.lesson || marketplace.testPackage !== current.testPackage
    || privateRates.lesson !== (current.privateLesson ?? current.lesson) || privateRates.testPackage !== (current.privateTestPackage ?? current.testPackage);
  const goesLive = priceChangeEffectiveAt(new Date(), tz);
  const offered = calendarOf(me).lessonTypes;

  return (
    <>
      <PageHeader title="Pricing" subtitle={`Price changes start at midnight — save today and new prices apply from ${formatDate(goesLive, tz)}. Existing bookings keep their price.`} />

      {pending && (
        <div className="mb-6 flex flex-col gap-3 rounded-2xl bg-sky-50 p-5 text-sky-900 sm:flex-row sm:items-center dark:bg-sky-500/10 dark:text-sky-200">
          <Clock className="size-6 shrink-0" />
          <div className="flex-1">
            <p className="font-bold">New prices start at midnight ({timeUntil(pending.effectiveAt)})</p>
            <p className="text-sm opacity-80">
              From {formatDate(pending.effectiveAt, tz)}: {formatMoney(pending.newPrice)}/hr
              {pending.newTestPackage ? `, ${formatMoney(pending.newTestPackage)} test package` : ''}
              {pending.newPrivateLesson ? ` · private learners ${formatMoney(pending.newPrivateLesson)}/hr` : ''}
              {pending.newPrivateTestPackage ? `, ${formatMoney(pending.newPrivateTestPackage)} test package` : ''}.
            </p>
          </div>
          <Button variant="secondary" size="sm" disabled={readOnly} onClick={async () => {
            try {
              await api.cancelPriceChange({});
              toast.success('Scheduled price change cancelled.');
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}>Cancel change</Button>
        </div>
      )}

      <form onSubmit={async e => {
        e.preventDefault();
        setBusy(true);
        try {
          const res = await api.requestPriceChange({
            lesson: marketplace.lesson,
            testPackage: marketplace.testPackage,
            privateLesson: privateRates.lesson,
            privateTestPackage: privateRates.testPackage,
          });
          toast.success(`Saved. New prices start at midnight (${formatDate(new Date(res.effectiveAt), tz)}).`);
        } catch (err) {
          toast.error(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}>
        <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-2">
          <TierCard
            icon={<Store className="size-4" />}
            title="Safe Learners learners"
            subtitle="Learners who find and book you through Safe Learners."
            lessonValue={form.lesson} onLesson={set('lesson')}
            testValue={form.testPackage} onTest={set('testPackage')}
            prices={marketplace} offered={offered}
          />
          <TierCard
            icon={<UserPlus className="size-4" />}
            title="Private learners"
            subtitle="Learners you invited yourself (“Invite learner”). Often a lower rate."
            lessonValue={form.privateLesson} onLesson={set('privateLesson')}
            testValue={form.privateTestPackage} onTest={set('privateTestPackage')}
            prices={privateRates} offered={offered}
          />
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Button type="submit" loading={busy} disabled={!changed || readOnly}>Schedule price change</Button>
          <p className="flex items-center gap-2 text-sm text-ink-500"><Info className="size-4" />Applies from midnight tonight. Bookings already made keep the price they were booked at.</p>
        </div>
      </form>
    </>
  );
}

function TierCard({ icon, title, subtitle, lessonValue, onLesson, testValue, onTest, prices, offered }: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  lessonValue: string;
  onLesson: (e: React.ChangeEvent<HTMLInputElement>) => void;
  testValue: string;
  onTest: (e: React.ChangeEvent<HTMLInputElement>) => void;
  prices: PriceSet;
  offered: ReturnType<typeof calendarOf>['lessonTypes'];
}) {
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">{icon}{title}</span>} subtitle={subtitle} />
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <Input label="Hourly lesson price (AUD)" type="number" min={30} max={300} step={1} value={lessonValue} onChange={onLesson} />
        <Input label="Test package (AUD)" type="number" min={50} max={1000} step={1} value={testValue} onChange={onTest} />
      </div>
      <ul className="divide-y divide-ink-100 border-t border-ink-100 dark:divide-ink-800 dark:border-ink-800">
        {offered.map(t => {
          const price = lessonPrice(t, prices);
          return (
            <li key={t} className="flex items-center justify-between px-5 py-2.5 text-sm">
              <span>{LESSON_TYPES[t].label}</span>
              <span className="text-right">
                <span className="font-bold">{formatMoney(price)}</span>
                <span className="block text-xs text-ink-500">you earn {formatMoney(price * (1 - PLATFORM_FEE_RATE))}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
