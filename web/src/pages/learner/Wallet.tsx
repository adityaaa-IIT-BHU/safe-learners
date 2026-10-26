import { collection, limit, orderBy, query } from 'firebase/firestore';
import { ArrowDownLeft, ArrowUpRight, CreditCard, Mail, Wallet as WalletIcon } from 'lucide-react';
import { useState } from 'react';
import { CREDIT_HOURLY_RATE, CREDIT_PACKAGES, creditPackagePrice, type CreditPackageId } from '@shared/domain';
import { formatDate } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Badge, Button, Card, CardHeader, EmptyState, Modal, PageHeader, cx, formatMoney } from '@/components/ui';
import { mapTransaction, useQuery } from '@/lib/data';
import { db } from '@/lib/firebase';
import { SUPPORT_EMAIL } from '../public/Layout';

export function Wallet() {
  const me = useProfile();
  const { uid } = useAuth();
  const { data: transactions } = useQuery(
    uid ? query(collection(db, 'users', uid, 'transactions'), orderBy('createdAt', 'desc'), limit(50)) : null,
    mapTransaction,
    `transactions:${uid}`,
  );
  const [choice, setChoice] = useState<CreditPackageId>('package-10h');
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const quote = creditPackagePrice(choice);
  const hours = quote.hours;

  return (
    <>
      <PageHeader title="Wallet" subtitle="Lesson credit, refunds and referral rewards in one place." />
      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card className="relative overflow-hidden bg-ink-950 p-6 text-white dark:bg-ink-900">
            <div className="absolute -right-10 -top-10 size-48 rounded-full bg-brand-500/25 blur-2xl" />
            <p className="flex items-center gap-2 text-sm font-semibold text-ink-300"><WalletIcon className="size-4" />Available balance</p>
            <p className="mt-2 text-5xl font-extrabold tracking-tight">{formatMoney(me.walletBalance ?? 0)}</p>
            <p className="mt-3 text-sm text-ink-400">Used automatically when you book. Cancellations more than 24 hours ahead are refunded here.</p>
          </Card>

          <Card>
            <CardHeader title="Add lesson credit" subtitle={`Choose a lesson or save with a package. Standard rate ${formatMoney(CREDIT_HOURLY_RATE)}/hr.`} />
            <div className="space-y-3 p-5">
              {CREDIT_PACKAGES.map(p => {
                const { discount } = creditPackagePrice(p.id);
                return (
                  <PackageOption key={p.id} selected={choice === p.id} onSelect={() => setChoice(p.id)}
                    title={p.title} blurb={p.blurb} tag={discount > 0 ? `Save ${formatMoney(discount)}` : undefined}>
                    <span className="text-lg font-extrabold">{formatMoney(p.price)}</span>
                  </PackageOption>
                );
              })}
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="sticky top-24">
            <CardHeader title="Order summary" />
            <div className="space-y-3 p-5 text-sm">
              <div className="flex justify-between"><span>{hours} hr lesson credit</span><span>{formatMoney(quote.gross)}</span></div>
              {quote.discount > 0 && <div className="flex justify-between text-emerald-600"><span>Package discount</span><span>−{formatMoney(quote.discount)}</span></div>}
              <div className="flex items-baseline justify-between border-t border-ink-100 pt-3 dark:border-ink-800">
                <span className="font-semibold">Total</span>
                <span className="text-2xl font-extrabold">{formatMoney(quote.total)}</span>
              </div>
              <Button size="lg" className="w-full" icon={<CreditCard className="size-5" />} onClick={() => setCheckoutOpen(true)}>Continue to payment</Button>
            </div>
          </Card>

          <Card>
            <CardHeader title="Activity" />
            {transactions.length === 0 ? (
              <EmptyState title="No activity yet" body="Bookings, refunds and rewards will show here." />
            ) : (
              <ul className="divide-y divide-ink-100 dark:divide-ink-800">
                {transactions.map(t => (
                  <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                    <span className={cx('flex size-9 items-center justify-center rounded-full', t.amount >= 0 ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10' : 'bg-ink-100 text-ink-600 dark:bg-ink-800')}>
                      {t.amount >= 0 ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{t.note}</p>
                      <p className="text-xs text-ink-500">{t.createdAt ? formatDate(t.createdAt) : ''}</p>
                    </div>
                    <span className={cx('text-sm font-bold', t.amount >= 0 && 'text-emerald-600')}>{t.amount >= 0 ? '+' : ''}{formatMoney(t.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Modal open={checkoutOpen} onClose={() => setCheckoutOpen(false)} title="Card payments are coming soon" footer={<Button variant="secondary" onClick={() => setCheckoutOpen(false)}>Got it</Button>}>
        <p className="text-sm text-ink-600 dark:text-ink-300">
          We’re connecting secure card payments. Until then, you can still book lessons — payment is simply due before the lesson.
        </p>
        <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Add ${hours} hours of credit`)}`} className="mt-4 flex items-center gap-2 rounded-xl bg-ink-50 p-4 text-sm font-semibold hover:bg-ink-100 dark:bg-ink-800 dark:hover:bg-ink-700">
          <Mail className="size-4" /> Email {SUPPORT_EMAIL} to add {hours} hours ({formatMoney(quote.total)}) now
        </a>
      </Modal>
    </>
  );
}

function PackageOption({ selected, onSelect, title, blurb, tag, children }: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  blurb: string;
  tag?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onSelect()}
      className={cx(
        'flex cursor-pointer items-center gap-4 rounded-2xl border-2 p-4 transition',
        selected ? 'border-ink-950 bg-brand-50 dark:border-brand-500 dark:bg-brand-500/10' : 'border-ink-200 hover:border-ink-300 dark:border-ink-700',
      )}
    >
      <span className={cx('flex size-5 shrink-0 items-center justify-center rounded-full border-2', selected ? 'border-ink-950 dark:border-brand-500' : 'border-ink-300')}>
        {selected && <span className="size-2.5 rounded-full bg-ink-950 dark:bg-brand-500" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-bold">{title}</p>
          {tag && <Badge tone="green">{tag}</Badge>}
        </div>
        <p className="text-sm text-ink-500">{blurb}</p>
      </div>
      {children}
    </div>
  );
}
