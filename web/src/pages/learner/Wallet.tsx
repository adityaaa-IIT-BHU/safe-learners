import { collection, limit, orderBy, query } from 'firebase/firestore';
import { ArrowDownLeft, ArrowUpRight, CreditCard, Mail, Undo2, Wallet as WalletIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CREDIT_HOURLY_RATE, CREDIT_PACKAGES, STATUS_META, creditPackagePrice, displayRef, type CreditPackageId } from '@shared/domain';
import { refundableAmount } from '@shared/finance';
import { formatDate } from '@shared/time';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { PaymentBadge, PaymentLines, lessonLabel } from '@/components/booking';
import { RefundStatusBadge } from '@/components/finance';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Modal, PageHeader, Select, Textarea, cx, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useMyRefunds } from '@/lib/finance';
import { mapTransaction, useBookings, useQuery } from '@/lib/data';
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
            <p className="mt-3 text-sm text-ink-400">Used automatically when you book: the whole lesson if it covers it, otherwise part of it, with the rest due before the lesson. Cancellations more than 24 hours ahead are refunded here.</p>
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
            <CardHeader title="Activity" subtitle="Every change to your balance." />
            {transactions.length === 0 ? (
              <EmptyState title="No activity yet" body="Credit added, lessons paid from your wallet, refunds and rewards will show here." />
            ) : (
              <ul className="divide-y divide-ink-100 dark:divide-ink-800">
                {transactions.map(t => (
                  <li key={t.id} className="flex items-center gap-3 px-5 py-3">
                    <span className={cx('flex size-9 items-center justify-center rounded-full', t.amount >= 0 ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10' : 'bg-ink-100 text-ink-600 dark:bg-ink-800')}>
                      {t.amount >= 0 ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-semibold">{t.note}</p>
                      <p className="text-xs text-ink-500">{[SOURCE_LABEL[t.type], t.createdAt ? formatDate(t.createdAt) : ''].filter(Boolean).join(' · ')}</p>
                    </div>
                    <span className={cx('text-sm font-bold', t.amount >= 0 && 'text-emerald-600')}>{t.amount >= 0 ? '+' : ''}{formatMoney(t.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <LessonPayments learnerId={uid} />
          <Refunds balance={me.walletBalance ?? 0} topups={transactions.filter(t => t.type === 'topup' && t.amount > 0)} />
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

const SOURCE_LABEL: Record<string, string> = {
  topup: 'Credit added', booking: 'Lesson payment', refund: 'Credit returned', referral: 'Referral reward',
  adjustment: 'Correction', refund_payout: 'Refund', charge: 'Fee',
};

/** Ask for unused credit back (approved by an admin, paid by bank transfer), and past requests. */
function Refunds({ balance, topups }: { balance: number; topups: { id: string; amount: number; note: string; createdAt?: Date }[] }) {
  const { uid } = useAuth();
  const { data: refunds } = useMyRefunds(uid);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const max = refundableAmount(balance, refunds.filter(r => r.status === 'awaiting_approval').map(r => r.amount));
  return (
    <Card>
      <CardHeader title="Refunds" subtitle="Ask for unused credit back. An admin reviews every request; approved refunds are paid by bank transfer."
        action={<Button size="sm" variant="secondary" icon={<Undo2 className="size-4" />} disabled={max <= 0} onClick={() => { setAmount(max.toFixed(2)); setOpen(true); }}>Request a refund</Button>} />
      {refunds.length === 0 ? <EmptyState title="No refund requests" body={max > 0 ? `You can ask for up to ${formatMoney(max)}.` : 'Refunds are available when you have unused credit.'} /> : (
        <ul className="divide-y divide-ink-100 dark:divide-ink-800">
          {refunds.map(r => (
            <li key={r.id} className="space-y-1 px-5 py-3 text-sm">
              <div className="flex items-center justify-between gap-3"><span className="font-semibold">{r.number} · {formatMoney(r.amount)}</span><RefundStatusBadge status={r.status} /></div>
              <p className="text-xs text-ink-500">Requested {r.requestedAt ? formatDate(r.requestedAt) : ''}{r.transferReference ? ` · paid, transfer ${r.transferReference}` : ''}</p>
              {r.rejectionReason && <p className="text-xs text-red-700">Reason: {r.rejectionReason}</p>}
            </li>
          ))}
        </ul>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Request a refund"
        footer={<Button loading={busy} disabled={!(Number(amount) > 0) || Number(amount) > max + 0.005 || reason.trim().length < 3} onClick={async () => {
          setBusy(true);
          try {
            const r = await api.requestRefund({ amount: Number(amount), reason: reason.trim(), ...(source ? { sourceTxId: `credit__${source}` } : {}) });
            toast.success(`Refund request ${r.number} sent. We’ll let you know once it’s reviewed.`);
            setOpen(false); setReason(''); setSource('');
          } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
        }}>Send request</Button>}>
        <div className="space-y-3">
          <Input label="Amount (AUD)" type="number" step="0.01" min="0.01" max={max} value={amount} onChange={e => setAmount(e.target.value)} hint={`Up to ${formatMoney(max)} of unused credit.`} />
          {topups.length > 0 && (
            <Select label="Which payment is this about? (optional)" value={source} onChange={e => setSource(e.target.value)}>
              <option value="">Any unused credit</option>
              {topups.map(t => <option key={t.id} value={t.id}>{t.createdAt ? formatDate(t.createdAt) : ''} · {formatMoney(t.amount)} · {t.note}</option>)}
            </Select>
          )}
          <Textarea label="Reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. I’ve finished my lessons and have credit left over." />
          <p className="text-xs text-ink-500">Approved credit is taken out of your wallet straight away, then paid to you by bank transfer.</p>
        </div>
      </Modal>
    </Card>
  );
}

/** Recent lessons and how each was paid, including ones paid outside the wallet. */
function LessonPayments({ learnerId }: { learnerId: string | null }) {
  const { data: bookings } = useBookings('learnerId', learnerId);
  const lessons = bookings
    .filter(b => b.kind === 'lesson' && b.price && ['confirmed', 'late_cancel_requested', 'completed', 'cancelled'].includes(b.status))
    .sort((a, b) => b.startAt.getTime() - a.startAt.getTime())
    .slice(0, 10);
  return (
    <Card>
      <CardHeader title="Lesson payments" subtitle="How each lesson was paid." />
      {lessons.length === 0 ? (
        <EmptyState title="No lessons yet" body="Booked and cancelled lessons will show here." />
      ) : (
        <ul className="divide-y divide-ink-100 dark:divide-ink-800">
          {lessons.map(b => (
            <li key={b.id}>
              <Link to={`/learner/bookings/${b.id}`} className="block space-y-2 px-5 py-3 hover:bg-ink-50 dark:hover:bg-ink-800/50">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{displayRef(b)} · {lessonLabel(b)}</p>
                    <p className="text-xs text-ink-500">{formatDate(b.startAt, b.timezone)} · {STATUS_META[b.status].label}</p>
                  </div>
                  <span className="text-sm font-bold">{formatMoney(b.price)}</span>
                </div>
                <PaymentBadge booking={b} />
                <PaymentLines booking={b} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
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
