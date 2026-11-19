// Admin → Settings → Commission Management: the commission structure (with effective dates), the
// introductory places, a report of every instructor's arrangement, and the change history.
import { CalendarClock, History, Percent, Sparkles, Users as UsersIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CATEGORY_LABEL, COUNTED, activeVersion, nextScheduled, pct, resolveCommission, validRate, type CommissionCategory } from '@shared/commission';
import { formatDocDate } from '@shared/documents';
import { fullName } from '@shared/domain';
import { Badge, Button, Card, CardHeader, EmptyState, Input, Modal, Select, Textarea, cx, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { sydneyToday, useCommissionChanges, useCommissionLedger, useCommissionProfiles, useCommissionVersions } from '@/lib/commission';
import { toDate } from '@/lib/data';
import { useAllUsers } from './Overview';

const TONE: Record<CommissionCategory, 'blue' | 'green' | 'yellow'> = { introductory: 'green', default: 'blue', custom: 'yellow' };
export const CategoryBadge = ({ c }: { c: CommissionCategory }) => <Badge tone={TONE[c]}>{CATEGORY_LABEL[c]}</Badge>;
const dayOf = (v: unknown) => { const d = toDate(v); return d ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(d) : null; };

export function CommissionManagement() {
  const versions = useCommissionVersions();
  const { data: profiles } = useCommissionProfiles();
  const { data: users } = useAllUsers();
  const { data: ledger } = useCommissionLedger('all');
  const changes = useCommissionChanges();
  const today = sydneyToday();
  const current = activeVersion(versions, today);
  const scheduled = versions.filter(v => v.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const instructors = users.filter(u => u.role === 'instructor');
  const byId = new Map(profiles.map(p => [p.id, p]));
  const allocated = profiles.filter(p => p.intro?.status === 'allocated' && instructors.some(u => u.id === p.id && !u.testAccount));

  const rows = useMemo(() => instructors.map(u => {
    const p = byId.get(u.id);
    const r = resolveCommission({ versions, custom: p?.custom, intro: p?.intro }, today);
    const mine = ledger.filter(l => l.instructorId === u.id && COUNTED.includes(l.status));
    const nextCustom = nextScheduled(p?.custom, today);
    return {
      u, p, r, nextCustom,
      onboarded: dayOf((u as any).verifiedAt) ?? dayOf((u as any).verificationSubmittedAt),
      earnings: mine.reduce((s, l) => s + l.earnings, 0),
      commission: mine.reduce((s, l) => s + l.commission, 0),
    };
  }).sort((a, b) => (a.onboarded ?? '9999').localeCompare(b.onboarded ?? '9999')), [instructors, profiles, versions, ledger, today]);
  const [filter, setFilter] = useState<'all' | CommissionCategory>('all');
  const shown = rows.filter(r => filter === 'all' || r.r.category === filter);

  const [form, setForm] = useState<{ defaultRate: string; introEnabled: boolean; introRate: string; introPlaces: string; effectiveFrom: string; reason: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState<{ id: string } | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const startEdit = () => setForm({ defaultRate: String(current.defaultRate), introEnabled: current.introEnabled, introRate: String(current.introRate), introPlaces: String(current.introPlaces), effectiveFrom: today, reason: '' });
  const formError = form && (!validRate(Number(form.defaultRate)) ? 'Default commission must be 0–99.99%'
    : !validRate(Number(form.introRate)) ? 'Introductory commission must be 0–99.99%'
    : !(Number.isInteger(Number(form.introPlaces)) && Number(form.introPlaces) >= 0) ? 'Places must be a whole number'
    : !form.effectiveFrom || form.effectiveFrom < today ? 'The effective date can’t be in the past'
    : form.reason.trim().length < 3 ? 'Give a reason' : null);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const r = await api.saveCommissionSettings({ defaultRate: Number(form.defaultRate), introEnabled: form.introEnabled, introRate: Number(form.introRate), introPlaces: Number(form.introPlaces), effectiveFrom: form.effectiveFrom, reason: form.reason.trim() });
      toast.success(`Saved. ${form.effectiveFrom === today ? 'In force now' : `Takes effect ${formatDocDate(form.effectiveFrom)}`}${r.allocation?.allocated.length ? ` · ${r.allocation.allocated.length} introductory place(s) given` : ''}`);
      setConfirm(false); setForm(null);
    } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-500">Commission is fixed when a lesson is confirmed, using the rates in force that day; lessons already booked keep their rate. Priority: an instructor’s custom rate, then the introductory rate (instructors holding a place), then the default rate.</p>
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Percent className="size-5" />Current commission structure</span>} subtitle={current.id === 'initial' ? 'Not set yet' : `In force since ${formatDocDate(current.effectiveFrom)}`}
            action={!form && <Button size="sm" onClick={startEdit}>Change structure</Button>} />
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-5 py-2">Instructor category</th><th className="px-5 py-2 text-right">Commission</th></tr></thead>
            <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
              <tr><td className="px-5 py-2">First {current.introPlaces} instructors (introductory) {current.introEnabled ? <Badge tone="green">Offer on</Badge> : <Badge>Offer off</Badge>}</td><td className="px-5 py-2 text-right font-semibold">{pct(current.introRate)}</td></tr>
              <tr><td className="px-5 py-2">All other instructors (default)</td><td className="px-5 py-2 text-right font-semibold">{pct(current.defaultRate)}</td></tr>
              <tr><td className="px-5 py-2">Individually negotiated (custom)</td><td className="px-5 py-2 text-right font-semibold">{rows.filter(r => r.r.category === 'custom').length} instructor(s) · own rate</td></tr>
            </tbody>
          </table></div>
          {current.id === 'initial' && <p className="px-5 pb-4 text-xs text-ink-500">No structure has been set yet: every instructor uses 15%, the rate the app has always shown.</p>}
        </Card>
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><Sparkles className="size-5" />Introductory places</span>} subtitle="Given in order of approval date. Test, disabled, deleted and duplicate accounts are not counted." />
          <div className="space-y-3 p-5">
            <p className="text-3xl font-extrabold">{allocated.length} <span className="text-base font-semibold text-ink-500">of {current.introPlaces} allocated · {Math.max(0, current.introPlaces - allocated.length)} remaining</span></p>
            <div className="h-2 overflow-hidden rounded-full bg-ink-100 dark:bg-ink-800"><div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, (allocated.length / Math.max(1, current.introPlaces)) * 100)}%` }} /></div>
            {!current.introEnabled && <p className="text-xs text-ink-500">The offer is off: no new places are given. Instructors who already hold a place keep it.</p>}
            <Button size="sm" variant="secondary" loading={busy} disabled={!current.introEnabled} onClick={async () => {
              setBusy(true);
              try { const r = await api.allocateIntroNow({}); toast.success(`${r.allocated.length} place(s) given · ${r.excluded.length} duplicate(s) excluded · ${r.remaining} remaining`); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
            }}>Allocate places to approved instructors now</Button>
          </div>
        </Card>
      </div>

      {form && (
        <Card>
          <CardHeader title="Change commission structure" subtitle="Applies to lessons confirmed on or after the effective date. These rates are your decision; nothing is assumed." />
          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
            <Input label="Default commission (%)" type="number" step="0.01" min={0} max={99.99} value={form.defaultRate} onChange={e => setForm({ ...form, defaultRate: e.target.value })} />
            <Input label="Introductory commission (%)" type="number" step="0.01" min={0} max={99.99} value={form.introRate} onChange={e => setForm({ ...form, introRate: e.target.value })} />
            <Input label="Introductory places" type="number" min={0} value={form.introPlaces} onChange={e => setForm({ ...form, introPlaces: e.target.value })} />
            <Select label="Introductory offer" value={form.introEnabled ? 'on' : 'off'} onChange={e => setForm({ ...form, introEnabled: e.target.value === 'on' })}><option value="on">On (give places)</option><option value="off">Off (no new places)</option></Select>
            <Input label="Effective from" type="date" min={today} value={form.effectiveFrom} onChange={e => setForm({ ...form, effectiveFrom: e.target.value })} />
            <Textarea label="Reason (recorded)" rows={1} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
          </div>
          <div className="flex items-center gap-2 px-5 pb-5">
            <Button disabled={!!formError} onClick={() => setConfirm(true)}>Review and save</Button>
            <Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            {formError && <span className="text-xs text-red-600">{formError}</span>}
          </div>
        </Card>
      )}

      {!!scheduled.length && (
        <Card>
          <CardHeader title={<span className="flex items-center gap-2"><CalendarClock className="size-5" />Scheduled changes</span>} />
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-5 py-2">Effective</th><th className="px-5 py-2">Default</th><th className="px-5 py-2">Introductory</th><th className="px-5 py-2">Places</th><th className="px-5 py-2">Reason</th><th /></tr></thead>
            <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
              {scheduled.map(v => <tr key={v.id}><td className="px-5 py-2 font-semibold">{formatDocDate(v.effectiveFrom)}</td><td className="px-5 py-2">{pct(v.defaultRate)}</td><td className="px-5 py-2">{pct(v.introRate)} {v.introEnabled ? '' : '(offer off)'}</td><td className="px-5 py-2">{v.introPlaces}</td><td className="px-5 py-2">{v.reason}</td>
                <td className="px-5 py-2 text-right"><Button size="sm" variant="ghost" onClick={() => { setCancelling({ id: v.id }); setCancelReason(''); }}>Cancel</Button></td></tr>)}
            </tbody>
          </table></div>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-ink-100 p-4 dark:border-ink-800">
          <h3 className="flex items-center gap-2 font-bold"><UsersIcon className="size-5" />Instructor commission report</h3>
          <span className="flex-1" />
          <Select value={filter} onChange={e => setFilter(e.target.value as never)} wrapperClassName="w-52"><option value="all">All arrangements</option><option value="introductory">Introductory</option><option value="default">Default</option><option value="custom">Custom</option></Select>
        </div>
        {!shown.length ? <EmptyState title="No instructors in this group" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-2">Instructor</th><th className="px-4 py-2">Approved</th><th className="px-4 py-2">Category</th><th className="px-4 py-2 text-right">Current rate</th><th className="px-4 py-2 text-right">Total earnings</th><th className="px-4 py-2 text-right">Total commission</th><th className="px-4 py-2">Custom rate</th><th className="px-4 py-2">Introductory offer</th></tr></thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {shown.map(({ u, p, r, nextCustom, onboarded, earnings, commission }) => (
                  <tr key={u.id}>
                    <td className="px-4 py-2 font-semibold"><Link className="underline" to={`/admin/users/${u.id}`}>{fullName(u)}</Link>{u.testAccount && <Badge tone="blue" className="ml-2">Test</Badge>}</td>
                    <td className="px-4 py-2">{onboarded ? formatDocDate(onboarded) : u.verificationStatus === 'verified' ? <span className="text-ink-500">Approved (date not recorded)</span> : <span className="text-ink-400">Not approved</span>}</td>
                    <td className="px-4 py-2"><CategoryBadge c={r.category} /></td>
                    <td className="px-4 py-2 text-right font-semibold">{pct(r.rate)}</td>
                    <td className="px-4 py-2 text-right">{formatMoney(earnings)}</td>
                    <td className="px-4 py-2 text-right">{formatMoney(commission)}</td>
                    <td className="px-4 py-2">{r.category === 'custom' ? `Yes (${pct(r.rate)})` : 'No'}{nextCustom && <span className="block text-xs text-ink-500">{nextCustom.rate === null ? 'Removed' : pct(nextCustom.rate)} from {formatDocDate(nextCustom.effectiveFrom)}</span>}</td>
                    <td className="px-4 py-2">{p?.intro?.status === 'allocated' ? <Badge tone="green">Place {p.intro.place}</Badge> : p?.intro?.status === 'excluded' ? <span title={p.intro.reason}><Badge tone="red">Excluded (duplicate)</Badge></span> : <span className="text-ink-400">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="px-4 py-3 text-xs text-ink-500">Totals include booked, completed and late-fee lessons at the rate each lesson was confirmed at; cancelled lessons are excluded.</p>
      </Card>

      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><History className="size-5" />Commission change history</span>} />
        {!changes.length ? <EmptyState title="No changes yet" /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase text-ink-400"><th className="px-4 py-2">Changed</th><th className="px-4 py-2">Administrator</th><th className="px-4 py-2">Applies to</th><th className="px-4 py-2">Previous</th><th className="px-4 py-2">New</th><th className="px-4 py-2">Effective</th><th className="px-4 py-2">Reason</th></tr></thead>
              <tbody className="divide-y divide-ink-100 dark:divide-ink-800">
                {changes.map(c => <ChangeRow key={c.id} c={c} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={confirm} onClose={() => setConfirm(false)} title="Save the new commission structure?"
        footer={<><Button variant="ghost" onClick={() => setConfirm(false)}>Back</Button><Button loading={busy} onClick={save}>Save</Button></>}>
        {form && <div className="space-y-2 text-sm">
          <p>From <strong>{formatDocDate(form.effectiveFrom)}</strong>{form.effectiveFrom === today ? ' (today)' : ''}, lessons confirmed on or after that date use:</p>
          <ul className="list-inside list-disc"><li>Default: <strong>{pct(Number(form.defaultRate))}</strong> (was {pct(current.defaultRate)})</li><li>Introductory: <strong>{pct(Number(form.introRate))}</strong> for the first {form.introPlaces} instructors, offer {form.introEnabled ? 'on' : 'off'}</li><li>Custom rates are not changed.</li></ul>
          <p className="text-ink-500">Lessons already booked keep the rate they were confirmed at. Instructors who already hold an introductory place keep it.</p>
        </div>}
      </Modal>
      <Modal open={!!cancelling} onClose={() => setCancelling(null)} title="Cancel this scheduled change?"
        footer={<Button variant="danger" loading={busy} disabled={cancelReason.trim().length < 3} onClick={async () => {
          setBusy(true);
          try { await api.cancelScheduledCommission({ id: cancelling!.id, reason: cancelReason.trim() }); toast.success('Scheduled change cancelled'); setCancelling(null); } catch (err) { toast.error(errorMessage(err)); } finally { setBusy(false); }
        }}>Cancel change</Button>}>
        <Textarea label="Reason (recorded)" value={cancelReason} onChange={e => setCancelReason(e.target.value)} />
      </Modal>
    </div>
  );
}

const fmt = (o: any) => !o ? '—' : o.rate !== undefined ? `${pct(o.rate)} ${o.category ? `(${CATEGORY_LABEL[o.category as CommissionCategory]})` : ''}`
  : o.defaultRate !== undefined ? `Default ${pct(o.defaultRate)} · Intro ${pct(o.introRate)} × ${o.introPlaces}${o.introEnabled ? '' : ' (off)'}`
  : o.status === 'allocated' ? `Introductory place ${o.place}` : o.status === 'excluded' ? 'Introductory: excluded' : '—';

export function ChangeRow({ c, hideWho }: { c: Record<string, any>; hideWho?: boolean }) {
  const label: Record<string, string> = { structure: 'All instructors', custom_set: 'Custom rate', custom_removed: 'Custom rate removed', intro_allocated: 'Introductory place', intro_excluded: 'Introductory (excluded)', scheduled_cancelled: 'Scheduled change cancelled' };
  return (
    <tr className={cx(c.kind === 'scheduled_cancelled' && 'text-ink-400')}>
      <td className="px-4 py-2">{c.at ? c.at.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td>
      <td className="px-4 py-2">{c.byName}</td>
      <td className="px-4 py-2">{!hideWho && c.instructorName ? <><strong>{c.instructorName}</strong> · </> : null}{label[c.kind] ?? c.kind}</td>
      <td className="px-4 py-2">{fmt(c.before)}</td>
      <td className="px-4 py-2">{fmt(c.after)}</td>
      <td className="px-4 py-2">{c.effectiveFrom ? formatDocDate(c.effectiveFrom) : '—'}</td>
      <td className="px-4 py-2">{c.reason ?? '—'}</td>
    </tr>
  );
}
