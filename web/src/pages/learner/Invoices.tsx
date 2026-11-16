import { FileText } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { InvoiceDetail, InvoiceStatusBadge, auDate } from '@/components/finance';
import { Card, EmptyState, Modal, PageHeader, Select, Skeleton, formatMoney } from '@/components/ui';
import { useMyInvoices } from '@/lib/finance';

export function LearnerInvoices() {
  const { uid } = useAuth();
  const me = useProfile();
  const { data: invoices, loading } = useMyInvoices(uid);
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<'all' | 'outstanding' | 'paid'>('all');
  const open = invoices.find(i => i.id === params.get('invoice')) ?? null;
  const list = invoices.filter(i => filter === 'all' || (filter === 'outstanding' ? i.amountDue > 0.005 && !i.voided : i.amountDue <= 0.005));
  const outstanding = invoices.filter(i => !i.voided).reduce((t, i) => t + i.amountDue, 0);

  return (
    <>
      <PageHeader title="Invoices" subtitle="An invoice for every lesson, showing what was paid from your wallet and anything still owing." />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm">Outstanding: <strong className={outstanding > 0.005 ? 'text-amber-700 dark:text-amber-400' : ''}>{formatMoney(outstanding)}</strong></p>
        <Select label="Show" value={filter} onChange={e => setFilter(e.target.value as typeof filter)} wrapperClassName="w-44">
          <option value="all">All invoices</option>
          <option value="outstanding">Outstanding</option>
          <option value="paid">Paid or settled</option>
        </Select>
      </div>
      <Card>
        {loading ? <div className="space-y-2 p-5">{[0, 1, 2].map(i => <Skeleton key={i} className="h-12" />)}</div> : list.length === 0 ? (
          <EmptyState icon={<FileText className="size-6" />} title="No invoices yet" body="An invoice is created automatically when a lesson is confirmed." />
        ) : (
          <ul className="divide-y divide-ink-100 dark:divide-ink-800">
            {list.map(i => (
              <li key={i.id}>
                <button onClick={() => setParams({ invoice: i.id })} className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left hover:bg-ink-50 dark:hover:bg-ink-800/50">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{i.number}</p>
                    <p className="truncate text-xs text-ink-500">{i.description} · issued {auDate(i.issueDate)}</p>
                  </div>
                  <InvoiceStatusBadge invoice={i} />
                  <div className="w-24 text-right">
                    <p className="font-bold">{formatMoney(i.total)}</p>
                    {i.amountDue > 0.005 && !i.voided && <p className="text-xs text-amber-700 dark:text-amber-400">{formatMoney(i.amountDue)} due</p>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Modal open={!!open} onClose={() => setParams({})} title="Invoice" size="lg">
        {open && <InvoiceDetail invoice={open} walletBalance={me.walletBalance ?? 0} />}
      </Modal>
    </>
  );
}
