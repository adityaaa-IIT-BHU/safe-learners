// Admin → Users → instructor: Commission Settings (current rate and type, custom rate with an
// effective date and reason, scheduled changes, and this instructor's change history).
import { Percent } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { CATEGORY_LABEL, COUNTED, pct, resolveCommission, upcomingChange, validRate } from '@shared/commission';
import { formatDocDate } from '@shared/documents';
import { Button, Card, CardHeader, Input, Modal, Textarea, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { sydneyToday, useCommissionChanges, useCommissionLedger, useCommissionProfile, useCommissionVersions } from '@/lib/commission';
import { CategoryBadge, ChangeRow } from './CommissionManagement';

export function InstructorCommissionCard({ uid, name }: { uid: string; name: string }) {
  const versions = useCommissionVersions();
  const { data: profile } = useCommissionProfile(uid);
  const { data: ledger } = useCommissionLedger(uid);
  const changes = useCommissionChanges(uid);
  const today = sydneyToday();
  const input = { versions, custom: profile?.custom, intro: profile?.intro };
  const now = resolveCommission(input, today);
  const next = upcomingChange(input, today);
  const customNow = now.category === 'custom';
  const scheduledCustom = (profile?.custom ?? []).filter(c => c.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const counted = ledger.filter(l => COUNTED.includes(l.status));
  const [mode, setMode] = useState<'set' | 'remove' | null>(null);
  const [rate, setRate] = useState('');
  const [from, setFrom] = useState(today);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = mode === 'set' && !validRate(Number(rate)) ? 'Enter a percentage from 0 to 99.99' : !from || from < today ? 'The date can’t be in the past' : reason.trim().length < 3 ? 'Give a reason' : null;
  const after = mode ? resolveCommission({ ...input, custom: [...(profile?.custom ?? []), { id: 'preview', rate: mode === 'remove' ? null : Number(rate), effectiveFrom: from, createdMs: Date.now() }] }, from) : null;

  const save = async () => {
    setBusy(true);
    try {
      await api.setInstructorCommission({ uid, rate: mode === 'remove' ? null : Number(rate), effectiveFrom: from, reason: reason.trim() });
      toast.success(mode === 'remove' ? 'Custom rate removed' : 'Custom rate saved');
      setConfirm(false); setMode(null); setRate(''); setReason(''); setFrom(today);
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  return (
    <Card className="mt-6">
      <CardHeader title={<span className="flex items-center gap-2"><Percent className="size-5" />Commission Settings</span>}
        subtitle="Priority: custom rate, then introductory, then default. Changes apply to lessons confirmed from the effective date." />
      <div className="grid gap-4 p-5 sm:grid-cols-3">
        <div><p className="text-xs font-semibold uppercase text-ink-400">Current commission</p><p className="text-3xl font-extrabold">{pct(now.rate)}</p><CategoryBadge c={now.category} /></div>
        <div className="text-sm">
          <p className="text-xs font-semibold uppercase text-ink-400">Introductory offer</p>
          <p>{profile?.intro?.status === 'allocated' ? `Holds place ${profile.intro.place} (approved ${formatDocDate(profile.intro.basisDate ?? null)})` : profile?.intro?.status === 'excluded' ? `Excluded: ${profile.intro.reason}` : 'No place'}</p>
          {next && <p className="mt-2 text-xs text-ink-500">From {formatDocDate(next.effectiveFrom)}: {pct(next.rate)} ({CATEGORY_LABEL[next.category]})</p>}
        </div>
        <div className="text-sm">
          <p className="text-xs font-semibold uppercase text-ink-400">Lessons so far</p>
          <p>{counted.length} lesson(s) · earnings {formatMoney(counted.reduce((s, l) => s + l.earnings, 0))} · commission {formatMoney(counted.reduce((s, l) => s + l.commission, 0))}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 px-5 pb-4">
        <Button size="sm" onClick={() => { setMode('set'); setRate(customNow ? String(now.rate) : ''); }}>{customNow ? 'Change custom rate' : 'Set custom rate'}</Button>
        {(customNow || scheduledCustom.some(c => c.rate !== null)) && <Button size="sm" variant="secondary" onClick={() => setMode('remove')}>Remove custom rate</Button>}
      </div>
      {mode && (
        <div className="mx-5 mb-5 grid gap-3 rounded-xl border border-ink-200 p-4 sm:grid-cols-3 dark:border-ink-700">
          {mode === 'set' && <Input label="Custom commission (%)" type="number" step="0.01" min={0} max={99.99} value={rate} onChange={e => setRate(e.target.value)} />}
          <Input label="Effective from" type="date" min={today} value={from} onChange={e => setFrom(e.target.value)} />
          <Textarea label="Reason (recorded)" rows={1} value={reason} onChange={e => setReason(e.target.value)} />
          <div className="flex items-center gap-2 sm:col-span-3">
            <Button size="sm" disabled={!!error} onClick={() => setConfirm(true)}>Review and save</Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
            {error && <span className="text-xs text-red-600">{error}</span>}
          </div>
        </div>
      )}
      {!!scheduledCustom.length && (
        <div className="px-5 pb-4 text-sm">
          <p className="mb-1 text-xs font-semibold uppercase text-ink-400">Scheduled</p>
          {scheduledCustom.map(c => <p key={c.id}>{c.rate === null ? 'Custom rate removed' : `Custom ${pct(c.rate)}`} from {formatDocDate(c.effectiveFrom)} — {c.reason}</p>)}
        </div>
      )}
      {!!changes.length && (
        <div className="overflow-x-auto border-t border-ink-100 dark:border-ink-800">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-2">Changed</th><th className="px-4 py-2">Administrator</th><th className="px-4 py-2">Change</th><th className="px-4 py-2">Previous</th><th className="px-4 py-2">New</th><th className="px-4 py-2">Effective</th><th className="px-4 py-2">Reason</th></tr></thead>
            <tbody className="divide-y divide-ink-100 dark:divide-ink-800">{changes.map(c => <ChangeRow key={c.id} c={c} hideWho />)}</tbody>
          </table>
        </div>
      )}
      <Modal open={confirm} onClose={() => setConfirm(false)} title={`${mode === 'remove' ? 'Remove' : 'Save'} ${name}’s custom commission?`}
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Back</Button><Button loading={busy} onClick={save}>Confirm</Button></>}>
        <p className="text-sm">From <strong>{formatDocDate(from)}</strong>{from === today ? ' (today)' : ''}, lessons confirmed with {name} use <strong>{after ? pct(after.rate) : ''}</strong> ({after ? CATEGORY_LABEL[after.category] : ''}).</p>
        <p className="mt-2 text-sm text-ink-500">Lessons already booked keep the rate they were confirmed at.</p>
      </Modal>
    </Card>
  );
}
