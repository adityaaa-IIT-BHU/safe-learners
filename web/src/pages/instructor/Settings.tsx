import { sendPasswordResetEmail } from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { KeyRound, Landmark, Lock, Receipt, Repeat } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Button, Card, CardHeader, Input, PageHeader, Segmented, Select } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useDoc } from '@/lib/data';
import { auth, db } from '@/lib/firebase';
import { SUPPORT_EMAIL } from '../public/Layout';

interface Billing { businessName: string; abn: string; address: string; suburb: string; postcode: string; state: string; gstRegistered: boolean }
interface Bank { accountName: string; bsb: string; accountNumber: string }
type Frequency = 'weekly' | 'fortnightly' | 'four_weekly';
interface Banking { billing?: Billing; payoutFrequency?: Frequency; bank?: Bank }

const EMPTY_BILLING: Billing = { businessName: '', abn: '', address: '', suburb: '', postcode: '', state: 'NSW', gstRegistered: false };
const EMPTY_BANK: Bank = { accountName: '', bsb: '', accountNumber: '' };

export function InstructorSettings() {
  const me = useProfile();
  const { user, readOnly } = useAuth();
  const ref = doc(db, 'users', me.id, 'private', 'banking');
  const { data: banking, loading } = useDoc(ref, (_, d) => d as Banking);
  // Details saved by earlier versions of the site, used to pre-fill the first save.
  const { data: legacyPrivate } = useDoc(doc(db, 'users', me.id, 'private', 'profile'), (_, d) => (d.bankingDetails ?? null) as Partial<Bank & { abn: string }> | null);
  const legacyMain = (me as unknown as { bankingDetails?: Partial<Bank> }).bankingDetails;

  const [billing, setBilling] = useState<Billing>(EMPTY_BILLING);
  const [frequency, setFrequency] = useState<Frequency>('fortnightly');
  const [bank, setBank] = useState<Bank>(EMPTY_BANK);
  const [saving, setSaving] = useState<'billing' | 'frequency' | 'bank' | null>(null);

  useEffect(() => {
    if (loading) return;
    setBilling({ ...EMPTY_BILLING, businessName: `${me.firstName} ${me.surname ?? ''}`.trim(), abn: legacyPrivate?.abn ?? '', ...banking?.billing });
    setFrequency(banking?.payoutFrequency ?? 'fortnightly');
    if (!banking?.bank) setBank({ ...EMPTY_BANK, ...(legacyPrivate ?? legacyMain ?? {}) } as Bank);
  }, [loading, banking, legacyPrivate]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (what: 'billing' | 'frequency' | 'bank', data: Partial<Banking>) => {
    setSaving(what);
    try {
      await setDoc(ref, { ...data, updatedAt: serverTimestamp() }, { merge: true });
      toast.success(what === 'bank' ? 'Bank account saved. For security it can now only be changed by Safe Learners support.' : 'Saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const setB = (k: keyof Billing) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setBilling(b => ({ ...b, [k]: e.target.value }));
  const setK = (k: keyof Bank) => (e: React.ChangeEvent<HTMLInputElement>) => setBank(b => ({ ...b, [k]: e.target.value }));
  const locked = !!banking?.bank;

  return (
    <>
      <PageHeader title="Settings" subtitle="Billing, payouts and account security." />
      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title={<span className="flex items-center gap-2"><Receipt className="size-4" />Billing info</span>} subtitle="Shown on your invoices and payout statements." />
            <form className="grid gap-4 p-5 sm:grid-cols-2" onSubmit={e => {
              e.preventDefault();
              const abn = billing.abn.replace(/\D/g, '');
              if (abn && abn.length !== 11) return toast.error('ABN must be 11 digits.');
              if (billing.postcode && !/^\d{4}$/.test(billing.postcode)) return toast.error('Postcode must be 4 digits.');
              void save('billing', { billing: { ...billing, abn } });
            }}>
              <Input label="Business name" value={billing.businessName} onChange={setB('businessName')} />
              <Input label="ABN" inputMode="numeric" value={billing.abn} onChange={setB('abn')} />
              <Input label="Billing address" value={billing.address} onChange={setB('address')} wrapperClassName="sm:col-span-2" />
              <Input label="Suburb" value={billing.suburb} onChange={setB('suburb')} />
              <div className="grid grid-cols-2 gap-3">
                <Input label="Postcode" inputMode="numeric" maxLength={4} value={billing.postcode} onChange={setB('postcode')} />
                <Select label="State" value={billing.state} onChange={setB('state')}>{['NSW', 'ACT', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT'].map(s => <option key={s}>{s}</option>)}</Select>
              </div>
              <div className="sm:col-span-2">
                <p className="label">Registered for GST?</p>
                <Segmented value={billing.gstRegistered ? 'yes' : 'no'} onChange={v => setBilling(b => ({ ...b, gstRegistered: v === 'yes' }))} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} className="max-w-xs [&_button]:text-center" />
              </div>
              <div className="sm:col-span-2"><Button type="submit" loading={saving === 'billing'} disabled={readOnly}>Save billing info</Button></div>
            </form>
          </Card>

          <Card>
            <CardHeader title={<span className="flex items-center gap-2"><Repeat className="size-4" />Payout frequency</span>} subtitle="How often your earnings are paid out. You can change this any time." />
            <div className="flex flex-wrap items-center gap-4 p-5">
              <Segmented value={frequency} onChange={setFrequency} className="w-full max-w-md [&_button]:text-center"
                options={[{ value: 'weekly', label: 'Weekly' }, { value: 'fortnightly', label: 'Fortnightly' }, { value: 'four_weekly', label: 'Every 4 weeks' }]} />
              <Button loading={saving === 'frequency'} disabled={readOnly || frequency === banking?.payoutFrequency} onClick={() => save('frequency', { payoutFrequency: frequency })}>Save</Button>
            </div>
          </Card>

          <Card>
            <CardHeader title={<span className="flex items-center gap-2"><Landmark className="size-4" />Bank account</span>} subtitle="Where your payouts are sent." />
            {locked ? (
              <div className="space-y-3 p-5">
                <dl className="grid gap-3 rounded-xl bg-ink-50 p-4 text-sm sm:grid-cols-3 dark:bg-ink-800/60">
                  <div><dt className="text-xs font-semibold uppercase text-ink-400">Account name</dt><dd className="font-semibold">{banking!.bank!.accountName}</dd></div>
                  <div><dt className="text-xs font-semibold uppercase text-ink-400">BSB</dt><dd className="font-semibold">{banking!.bank!.bsb}</dd></div>
                  <div><dt className="text-xs font-semibold uppercase text-ink-400">Account number</dt><dd className="font-semibold">****{banking!.bank!.accountNumber.slice(-4)}</dd></div>
                </dl>
                <p className="flex items-start gap-2 text-xs text-ink-500"><Lock className="mt-0.5 size-3.5 shrink-0" />For security, bank details can’t be edited after they’re submitted. To change them, email <a className="font-semibold underline" href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Update my payout bank account')}`}>{SUPPORT_EMAIL}</a>.</p>
              </div>
            ) : (
              <form className="grid gap-4 p-5 sm:grid-cols-2" onSubmit={e => {
                e.preventDefault();
                const bsb = bank.bsb.replace(/\D/g, '');
                const acc = bank.accountNumber.replace(/\D/g, '');
                if (!bank.accountName.trim()) return toast.error('Account name is required.');
                if (bsb.length !== 6) return toast.error('BSB must be 6 digits.');
                if (acc.length < 5 || acc.length > 10) return toast.error('Account number must be 5–10 digits.');
                if (!confirm('Please double-check your bank details. Once saved, only Safe Learners support can change them.')) return;
                void save('bank', { bank: { accountName: bank.accountName.trim(), bsb: `${bsb.slice(0, 3)}-${bsb.slice(3)}`, accountNumber: acc } });
              }}>
                <Input label="Account name" value={bank.accountName} onChange={setK('accountName')} wrapperClassName="sm:col-span-2" />
                <Input label="BSB" inputMode="numeric" placeholder="062-000" value={bank.bsb} onChange={setK('bsb')} />
                <Input label="Account number" inputMode="numeric" value={bank.accountNumber} onChange={setK('accountNumber')} />
                <p className="flex items-start gap-2 text-xs text-ink-500 sm:col-span-2"><Lock className="mt-0.5 size-3.5 shrink-0" />Bank details are locked once submitted, for your security.</p>
                <div className="sm:col-span-2"><Button type="submit" loading={saving === 'bank'} disabled={readOnly}>Submit bank details</Button></div>
              </form>
            )}
          </Card>
        </div>

        <Card className="h-fit p-5">
          <KeyRound className="size-6 text-ink-400" />
          <h3 className="mt-3 font-bold">Password</h3>
          <p className="mt-1 text-sm text-ink-500">Signed in as {user?.email}. We’ll email you a secure link to set a new password.</p>
          <Button variant="secondary" className="mt-4" disabled={readOnly || !user?.email} onClick={async () => {
            try {
              await sendPasswordResetEmail(auth, user!.email!);
              toast.success(`Reset link sent to ${user!.email}`);
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}>Send reset link</Button>
        </Card>
      </div>
    </>
  );
}
