import { collection, query, where } from 'firebase/firestore';
import { Copy, Gift, Mail, MessageCircle, Share2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { REFERRAL_REWARD_FRIEND, REFERRAL_REWARD_REFERRER } from '@shared/domain';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Button, Card, PageHeader, Skeleton, Stat, formatMoney } from '@/components/ui';
import { mapTransaction, useQuery } from '@/lib/data';
import { db } from '@/lib/firebase';

export function Refer() {
  const me = useProfile();
  const { uid } = useAuth();
  const { data: rewards } = useQuery(
    uid ? query(collection(db, 'users', uid, 'transactions'), where('type', '==', 'referral')) : null,
    mapTransaction,
    `referrals:${uid}`,
  );

  const code = me.referralCode;
  const link = code ? `${window.location.origin}/signup?ref=${code}` : '';
  const message = `I’m learning to drive with Safe Learners. Sign up with my code ${code} and get ${formatMoney(REFERRAL_REWARD_FRIEND)} lesson credit: ${link}`;
  const earned = rewards.filter(r => r.amount > 0 && r.note.startsWith('Referral reward')).reduce((s, r) => s + r.amount, 0);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Couldn’t copy — please copy it manually.');
    }
  };

  return (
    <>
      <PageHeader title="Invite friends" subtitle="Share Safe Learners and you both get lesson credit." />
      <Card className="relative overflow-hidden bg-ink-950 p-8 text-center text-white dark:bg-ink-900">
        <div className="absolute inset-x-0 top-0 h-1.5 bg-[repeating-linear-gradient(90deg,#ffc700_0_24px,transparent_24px_48px)]" />
        <Gift className="mx-auto size-10 text-brand-400" />
        <h2 className="mt-4 text-3xl font-extrabold">Give {formatMoney(REFERRAL_REWARD_FRIEND)}, get {formatMoney(REFERRAL_REWARD_REFERRER)}</h2>
        <p className="mx-auto mt-2 max-w-lg text-ink-300">
          When a friend signs up with your code and completes their first lesson, you get {formatMoney(REFERRAL_REWARD_REFERRER)} and they get {formatMoney(REFERRAL_REWARD_FRIEND)} in wallet credit.
        </p>

        <div className="mx-auto mt-8 max-w-md">
          {code ? (
            <>
              <button onClick={() => copy(code, 'Code')} className="group flex w-full items-center justify-between rounded-2xl border-2 border-dashed border-brand-500/60 bg-white/5 px-5 py-4 text-left">
                <span>
                  <span className="block text-xs font-semibold uppercase tracking-wider text-ink-400">Your code</span>
                  <span className="font-mono text-2xl font-extrabold tracking-widest text-brand-400">{code}</span>
                </span>
                <Copy className="size-5 text-ink-400 group-hover:text-white" />
              </button>
              <div className="mt-3 flex gap-2">
                <input readOnly value={link} className="min-w-0 flex-1 rounded-xl bg-white/10 px-3 text-sm text-ink-200" aria-label="Referral link" />
                <Button onClick={() => copy(link, 'Link')}>Copy link</Button>
              </div>
            </>
          ) : <Skeleton className="h-20 bg-white/10" />}
        </div>

        {code && (
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <a className="inline-flex items-center gap-2 rounded-xl bg-[#25D366] px-4 py-2 text-sm font-bold text-white" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer"><MessageCircle className="size-4" />WhatsApp</a>
            <a className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-sm font-bold" href={`mailto:?subject=${encodeURIComponent('Learn to drive with Safe Learners')}&body=${encodeURIComponent(message)}`}><Mail className="size-4" />Email</a>
            {'share' in navigator && (
              <button className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-sm font-bold" onClick={() => navigator.share({ title: 'Safe Learners', text: message, url: link }).catch(() => undefined)}><Share2 className="size-4" />More</button>
            )}
          </div>
        )}
      </Card>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <Stat label="Friends joined" value={me.referralCount ?? 0} icon={<Users className="size-4" />} sub="Signed up with your code" />
        <Stat label="Rewards earned" value={formatMoney(earned)} icon={<Gift className="size-4" />} sub="Paid into your wallet" />
      </div>
    </>
  );
}
