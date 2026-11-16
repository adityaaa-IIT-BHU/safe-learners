import { Download, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { REFUND_STATUS, SYNC_STATUS, type RefundStatus, type SyncStatus } from '@shared/finance';
import { Badge, Button, cx, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { downloadInvoicePdf, invoiceStatusMeta, type InvoiceView } from '@/lib/finance';

export const auDate = (iso: string | null | undefined) => (iso ? iso.split('-').reverse().join('/') : '—');

export function InvoiceStatusBadge({ invoice }: { invoice: Pick<InvoiceView, 'status'> }) {
  const m = invoiceStatusMeta(invoice.status);
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function RefundStatusBadge({ status }: { status: string }) {
  const m = REFUND_STATUS[status as RefundStatus] ?? { label: status, tone: 'slate' as const };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function SyncBadge({ status }: { status: string }) {
  const m = SYNC_STATUS[status as SyncStatus] ?? { label: status, tone: 'slate' as const };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

const KIND_LABEL: Record<InvoiceView['kind'], string> = { lesson: 'Lesson', cancellation_fee: 'Cancellation fee', adjustment: 'Wallet correction' };

/** One invoice: lines, GST, totals, what was paid or credited, and its history. */
export function InvoiceDetail({ invoice: inv, admin = false, walletBalance }: { invoice: InvoiceView; admin?: boolean; walletBalance?: number }) {
  const [paying, setPaying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const canPay = inv.kind === 'lesson' && !inv.closed && !inv.voided && inv.amountDue > 0.005 && (admin || (walletBalance ?? 0) > 0.005);
  const gstLabel = inv.lineAmountTypes === 'Inclusive' ? 'GST included' : inv.lineAmountTypes === 'Exclusive' ? 'GST' : 'Tax';
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase text-ink-400">{KIND_LABEL[inv.kind]} invoice</p>
          <p className="text-xl font-extrabold">{inv.number}</p>
          <p className="text-ink-500">{inv.learnerName}{admin && inv.learnerEmail ? ` · ${inv.learnerEmail}` : ''}</p>
        </div>
        <InvoiceStatusBadge invoice={inv} />
      </div>

      <dl className="grid grid-cols-2 gap-3 rounded-xl bg-ink-50 p-4 sm:grid-cols-4 dark:bg-ink-800/60">
        <div><dt className="text-xs font-semibold uppercase text-ink-400">Issued</dt><dd className="font-semibold">{auDate(inv.issueDate)}</dd></div>
        <div><dt className="text-xs font-semibold uppercase text-ink-400">Due</dt><dd className="font-semibold">{auDate(inv.dueDate)}</dd></div>
        {inv.lessonDate && <div><dt className="text-xs font-semibold uppercase text-ink-400">Lesson</dt><dd className="font-semibold">{auDate(inv.lessonDate)}{inv.durationMinutes ? ` · ${inv.durationMinutes} min` : ''}</dd></div>}
        {inv.bookingRef && <div><dt className="text-xs font-semibold uppercase text-ink-400">Booking</dt><dd className="font-semibold">{inv.bookingId ? <Link className="underline" to={admin ? `/admin/bookings?booking=${inv.bookingId}` : `/learner/bookings/${inv.bookingId}`}>{inv.bookingRef}</Link> : inv.bookingRef}</dd></div>}
        {inv.instructorName && <div className="col-span-2"><dt className="text-xs font-semibold uppercase text-ink-400">Instructor</dt><dd className="font-semibold">{inv.instructorName}</dd></div>}
      </dl>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px]">
          <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="pb-2">Description</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Price</th><th className="pb-2 text-right">{inv.lineAmountTypes === 'NoTax' ? 'Tax' : 'GST'}</th><th className="pb-2 text-right">Amount</th></tr></thead>
          <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
            {inv.lines.map((l, i) => (
              <tr key={i}>
                <td className="py-2 pr-3">{l.description}{l.discount > 0 && <span className="block text-xs text-emerald-600">Discount {formatMoney(l.discount)}</span>}{admin && <span className="block text-xs text-ink-400">Account {l.accountCode}{l.taxType ? ` · ${l.taxType}` : ''}</span>}</td>
                <td className="py-2 text-right">{l.quantity}</td>
                <td className="py-2 text-right">{formatMoney(l.unitAmount)}</td>
                <td className="py-2 text-right">{formatMoney(l.tax)}</td>
                <td className="py-2 text-right font-semibold">{formatMoney(l.lineAmount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ml-auto max-w-xs space-y-1.5">
        <Row label={inv.lineAmountTypes === 'Inclusive' ? 'Subtotal (excl. GST)' : 'Subtotal'} value={formatMoney(inv.subtotal)} />
        <Row label={gstLabel} value={formatMoney(inv.tax)} />
        {inv.discount > 0 && <Row label="Discounts" value={`−${formatMoney(inv.discount)}`} />}
        <Row label="Total" value={formatMoney(inv.total)} strong />
        <Row label="Paid from wallet credit" value={`−${formatMoney(inv.amountPaid)}`} />
        {inv.amountCredited > 0 && <Row label="Credited" value={`−${formatMoney(inv.amountCredited)}`} />}
        <Row label="Outstanding" value={formatMoney(inv.amountDue)} strong className={inv.amountDue > 0.005 ? 'text-amber-700 dark:text-amber-400' : ''} />
      </div>

      {(inv.allocations.length > 0 || inv.creditNotes.length > 0) && (
        <div className="space-y-1 rounded-xl border border-ink-200 p-3 text-xs dark:border-ink-700">
          <p className="font-semibold uppercase text-ink-400">Payments and credits</p>
          {inv.allocations.map(a => <p key={a.txId}>{auDate(a.date)} · {formatMoney(a.amount)} applied from wallet credit</p>)}
          {inv.creditNotes.map(c => <p key={c.txId}>Credit note {c.number} · {formatMoney(c.amount)}</p>)}
        </div>
      )}

      {inv.history.length > 0 && (
        <details className="text-xs text-ink-500">
          <summary className="cursor-pointer font-semibold">History ({inv.history.length})</summary>
          <ul className="mt-2 space-y-1">{[...inv.history].reverse().map((h, i) => <li key={i}>{new Date(h.at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })} · {h.action}</li>)}</ul>
        </details>
      )}
      {admin && <p className="text-xs text-ink-400">Xero: {inv.xero?.invoiceId ? `${inv.xero.status ?? ''} · ${inv.xero.invoiceId}` : 'not sent yet'}</p>}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<Download className="size-4" />} loading={downloading} onClick={async () => {
          setDownloading(true);
          try { await downloadInvoicePdf(inv); } catch (err) { toast.error(errorMessage(err)); } finally { setDownloading(false); }
        }}>Download PDF</Button>
        {canPay && (
          <Button size="sm" icon={<Wallet className="size-4" />} loading={paying} onClick={async () => {
            setPaying(true);
            try {
              const r = await api.payInvoiceFromWallet({ invoiceId: inv.id });
              toast.success(`${formatMoney(r.paid)} paid from wallet credit.`);
            } catch (err) { toast.error(errorMessage(err)); } finally { setPaying(false); }
          }}>Pay {formatMoney(Math.min(inv.amountDue, admin ? inv.amountDue : walletBalance ?? 0))} from wallet</Button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, strong, className }: { label: string; value: string; strong?: boolean; className?: string }) {
  return <div className={cx('flex justify-between gap-4', strong && 'font-bold', className)}><span className={strong ? '' : 'text-ink-500'}>{label}</span><span>{value}</span></div>;
}
