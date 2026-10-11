import { sendPasswordResetEmail } from 'firebase/auth';
import { doc, updateDoc } from 'firebase/firestore';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useAuth, useProfile } from '@/auth/AuthProvider';
import { Button, Card, CardHeader, Input, PageHeader } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { auth, db } from '@/lib/firebase';

export function LearnerProfile() {
  const me = useProfile();
  const { user, readOnly } = useAuth();
  const [form, setForm] = useState({
    firstName: me.firstName ?? '',
    surname: me.surname ?? '',
    mobile: me.mobile ?? '',
    dob: me.dob ?? '',
    homeSuburb: me.homeSuburb ?? '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <PageHeader title="Profile" subtitle="Keep your details up to date so your instructor can reach you." />
      <div className="grid grid-cols-1 gap-6 [&>*]:min-w-0 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader title="Personal details" />
          <form
            className="grid gap-4 p-5 sm:grid-cols-2"
            onSubmit={async e => {
              e.preventDefault();
              if (!form.firstName.trim()) return toast.error('First name is required.');
              setSaving(true);
              try {
                await updateDoc(doc(db, 'users', me.id), Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()])));
                toast.success('Profile saved');
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setSaving(false);
              }
            }}
          >
            <Input label="First name" value={form.firstName} onChange={set('firstName')} />
            <Input label="Surname" value={form.surname} onChange={set('surname')} />
            <Input label="Mobile" type="tel" value={form.mobile} onChange={set('mobile')} />
            <Input label="Date of birth" type="date" value={form.dob} onChange={set('dob')} />
            <Input label="Usual pick up address" value={form.homeSuburb} onChange={set('homeSuburb')} placeholder="Pre-fills when you book" wrapperClassName="sm:col-span-2" />
            <Input label="Email" value={user?.email ?? me.email ?? ''} disabled wrapperClassName="sm:col-span-2" hint="Contact support to change your sign-in email." />
            <div className="sm:col-span-2"><Button type="submit" loading={saving} disabled={readOnly}>Save changes</Button></div>
          </form>
        </Card>
        <Card className="h-fit p-5">
          <KeyRound className="size-6 text-ink-400" />
          <h3 className="mt-3 font-bold">Password</h3>
          <p className="mt-1 text-sm text-ink-500">We’ll email you a secure link to set a new password.</p>
          <Button
            variant="secondary"
            className="mt-4"
            disabled={readOnly || !user?.email}
            onClick={async () => {
              try {
                await sendPasswordResetEmail(auth, user!.email!);
                toast.success(`Reset link sent to ${user!.email}`);
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            Send reset link
          </Button>
        </Card>
      </div>
    </>
  );
}
