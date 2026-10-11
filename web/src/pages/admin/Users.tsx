import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { ArrowLeft, Eye, Search, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { fullName, pricingOf, type Role } from '@shared/domain';
import { useAuth } from '@/auth/AuthProvider';
import { BookingRow } from '@/components/booking';
import { Avatar, Badge, Button, ButtonLink, Card, CardHeader, EmptyState, Input, Modal, PageHeader, PageLoader, Select, Stat, formatMoney } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { useBookings, useDoc, usePrivateProfile, useUser } from '@/lib/data';
import { db } from '@/lib/firebase';
import { homePath } from '@/lib/routes';
import { useAllUsers } from './Overview';

export function AdminUsers() {
  const { data: users } = useAllUsers();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<'all' | Role>('all');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users
      .filter(u => u.status !== 'claimed')
      .filter(u => role === 'all' || u.role === role)
      .filter(u => !q || [fullName(u), u.email, u.inviteEmail, u.mobile].some(v => v?.toLowerCase().includes(q)))
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  }, [users, search, role]);

  return (
    <>
      <PageHeader title="Users" subtitle={`${filtered.length} shown`} />
      <Card className="mb-4 grid gap-3 p-3 sm:grid-cols-[1fr_200px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, email or phone" className="input pl-10" aria-label="Search users" />
        </div>
        <Select value={role} onChange={e => setRole(e.target.value as 'all' | Role)} aria-label="Role">
          <option value="all">All roles</option>
          <option value="learner">Learners</option>
          <option value="instructor">Instructors</option>
          <option value="admin">Admins</option>
        </Select>
      </Card>
      <Card className="divide-y divide-ink-100 dark:divide-ink-800">
        {filtered.length === 0 && <EmptyState title="No users match" />}
        {filtered.map(u => (
          <Link key={u.id} to={`/admin/users/${u.id}`} className="flex flex-wrap items-center gap-4 px-5 py-3 hover:bg-ink-50 dark:hover:bg-ink-800/50">
            <Avatar name={fullName(u)} src={u.photoUrl} size={40} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{fullName(u)}</p>
              <p className="truncate text-sm text-ink-500">{u.email ?? u.inviteEmail ?? '—'}{u.mobile ? ` · ${u.mobile}` : ''}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={u.role === 'instructor' ? 'yellow' : u.role === 'admin' ? 'blue' : 'slate'}>{u.role}</Badge>
              {u.status === 'invited' && <Badge tone="amber">Invited</Badge>}
              {u.role === 'instructor' && <Badge tone={u.verificationStatus === 'verified' ? 'green' : 'amber'}>{(u.verificationStatus ?? 'not_submitted').replace('_', ' ')}</Badge>}
              {u.accountStatus === 'disabled' && <Badge tone="red">Disabled</Badge>}
            </div>
          </Link>
        ))}
      </Card>
    </>
  );
}

export function AdminUserDetail() {
  const { id = '' } = useParams();
  const { viewAs } = useAuth();
  const navigate = useNavigate();
  const { data: user, loading } = useUser(id);
  const { data: priv } = usePrivateProfile(id);
  const { data: asLearner } = useBookings('learnerId', user?.role === 'learner' ? id : null);
  const { data: asInstructor } = useBookings('instructorId', user?.role === 'instructor' ? id : null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  if (loading) return <PageLoader />;
  if (!user) return <Card><EmptyState title="User not found" action={<ButtonLink to="/admin/users">All users</ButtonLink>} /></Card>;
  const bookings = user.role === 'learner' ? asLearner : asInstructor;
  const disabled = user.accountStatus === 'disabled';

  return (
    <>
      <PageHeader
        back={<Link to="/admin/users" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white"><ArrowLeft className="size-4" />Users</Link>}
        title={<span className="flex items-center gap-3"><Avatar name={fullName(user)} src={user.photoUrl} size={48} />{fullName(user)}</span>}
        subtitle={`${user.role} · ${priv?.email ?? user.email ?? user.inviteEmail ?? 'no email'}${(priv?.mobile ?? user.mobile) ? ` · ${priv?.mobile ?? user.mobile}` : ''}${priv?.dob ? ` · born ${priv.dob}` : ''}`}
        actions={<>
          {user.role !== 'admin' && user.status !== 'invited' && (
            <Button variant="secondary" icon={<Eye className="size-4" />} onClick={() => { viewAs(user.id); navigate(homePath(user.role)); }}>View as {user.firstName}</Button>
          )}
          {user.role === 'learner' && <Button variant="secondary" icon={<Wallet className="size-4" />} onClick={() => setWalletOpen(true)}>Adjust wallet</Button>}
          {user.role !== 'admin' && (
            <Button variant={disabled ? 'success' : 'danger'} loading={busy} onClick={async () => {
              if (!disabled && !confirm(`Disable ${user.firstName}'s account? They won't be able to sign in.`)) return;
              setBusy(true);
              try {
                await api.setAccountStatus({ uid: user.id, status: disabled ? 'active' : 'disabled' });
                toast.success(disabled ? 'Account enabled' : 'Account disabled');
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}>{disabled ? 'Enable account' : 'Disable account'}</Button>
          )}
        </>}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        {user.role === 'learner' ? <>
          <Stat label="Wallet" value={formatMoney(user.walletBalance ?? 0)} />
          <Stat label="Referral code" value={user.referralCode ?? '—'} sub={`${user.referralCount ?? 0} friends joined`} />
          <Stat label="Bookings" value={bookings.length} />
        </> : user.role === 'instructor' ? <>
          <Stat label="Hourly price" value={formatMoney(pricingOf(user).lesson)} sub={user.pendingPriceChange ? `→ ${formatMoney(user.pendingPriceChange.newPrice)} scheduled` : undefined} />
          <Stat label="Rating" value={user.ratingCount ? user.ratingAvg?.toFixed(1) : '—'} sub={`${user.ratingCount ?? 0} reviews`} />
          <Stat label="Bookings" value={bookings.filter(b => b.kind === 'lesson').length} />
        </> : null}
      </div>
      {user.role === 'instructor' && <AdminBankCard uid={user.id} />}
      <Card className="mt-6">
        <CardHeader title="Bookings" />
        <div className="space-y-3 p-5">
          {bookings.length === 0 ? <p className="text-sm text-ink-500">No bookings.</p> : bookings.slice().reverse().slice(0, 40).map(b => (
            <BookingRow key={b.id} booking={b} to={`#`} person={{ name: user.role === 'learner' ? b.instructorName : b.learnerName }} />
          ))}
        </div>
      </Card>
      <Modal open={walletOpen} onClose={() => setWalletOpen(false)} title={`Adjust ${user.firstName}’s wallet`}
        footer={<Button loading={busy} disabled={!Number(amount)} onClick={async () => {
          setBusy(true);
          try {
            const res = await api.adjustWallet({ uid: user.id, amount: Number(amount), note: note.trim() || undefined });
            toast.success(`New balance ${formatMoney(res.balance)}`);
            setWalletOpen(false);
            setAmount('');
            setNote('');
          } catch (err) {
            toast.error(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}>Apply</Button>}>
        <div className="grid gap-4">
          <Input label="Amount (AUD)" type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} hint="Use a negative number to deduct." />
          <Input label="Note shown to the learner" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. 10 hour package paid by bank transfer" />
        </div>
      </Modal>
    </>
  );
}

/** Instructors can't change a submitted bank account themselves; admins update it on request. */
function AdminBankCard({ uid }: { uid: string }) {
  const ref = doc(db, 'users', uid, 'private', 'banking');
  const { data } = useDoc(ref, (_, d) => d as { bank?: { accountName: string; bsb: string; accountNumber: string }; payoutFrequency?: string; billing?: { businessName?: string; abn?: string; gstRegistered?: boolean } });
  const [editing, setEditing] = useState(false);
  const [bank, setBank] = useState({ accountName: '', bsb: '', accountNumber: '' });
  const [busy, setBusy] = useState(false);
  return (
    <Card className="mt-6">
      <CardHeader title="Payout details" subtitle={data?.payoutFrequency ? `Paid ${data.payoutFrequency.replace('_', ' ')}` : 'Not set up yet'}
        action={!editing ? <Button size="sm" variant="secondary" onClick={() => { setBank(data?.bank ?? { accountName: '', bsb: '', accountNumber: '' }); setEditing(true); }}>Update bank account</Button> : undefined} />
      <div className="p-5 text-sm">
        {!editing ? (
          data?.bank
            ? <p>{data.bank.accountName} · BSB {data.bank.bsb} · Account {data.bank.accountNumber}{data.billing?.abn ? ` · ABN ${data.billing.abn}` : ''}{data.billing?.gstRegistered ? ' · GST registered' : ''}</p>
            : <p className="text-ink-500">No bank account submitted.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Input label="Account name" value={bank.accountName} onChange={e => setBank(b => ({ ...b, accountName: e.target.value }))} />
            <Input label="BSB" value={bank.bsb} onChange={e => setBank(b => ({ ...b, bsb: e.target.value }))} />
            <Input label="Account number" value={bank.accountNumber} onChange={e => setBank(b => ({ ...b, accountNumber: e.target.value }))} />
            <div className="flex gap-2 sm:col-span-3">
              <Button size="sm" loading={busy} onClick={async () => {
                const bsb = bank.bsb.replace(/\D/g, '');
                if (bsb.length !== 6) return toast.error('BSB must be 6 digits.');
                setBusy(true);
                try {
                  await setDoc(ref, { bank: { accountName: bank.accountName.trim(), bsb: `${bsb.slice(0, 3)}-${bsb.slice(3)}`, accountNumber: bank.accountNumber.replace(/\D/g, '') }, bankChangedByAdminAt: serverTimestamp() }, { merge: true });
                  toast.success('Bank account updated');
                  setEditing(false);
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setBusy(false);
                }
              }}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
