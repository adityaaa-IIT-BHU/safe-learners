import { zodResolver } from '@hookform/resolvers/zod';
import { createUserWithEmailAndPassword, sendPasswordResetEmail, signInWithEmailAndPassword, updateProfile } from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { CarFront, GraduationCap } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import type { Role } from '@shared/domain';
import { DEFAULT_TIMEZONE } from '@shared/time';
import { homePath } from '@/lib/routes';
import { useAuth } from '@/auth/AuthProvider';
import { Logo } from '@/components/AppShell';
import { Button, Input, Select } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { auth, db } from '@/lib/firebase';

function AuthFrame({ title, subtitle, children, aside }: { title: string; subtitle: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <Logo />
        <div className="mx-auto my-auto w-full max-w-md animate-slide-up py-10">
          <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
          <div className="mt-2 text-ink-500">{subtitle}</div>
          <div className="mt-8">{children}</div>
        </div>
      </div>
      <div className="relative hidden overflow-hidden bg-ink-950 lg:block">
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="lplate size-72 text-[8.5rem] tracking-tighter ring-[12px] ring-white">SL</span>
        </div>
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950 to-transparent p-12 text-white">
          {aside ?? (
            <>
              <p className="text-2xl font-bold">Book your first lesson in under a minute.</p>
              <p className="mt-2 text-ink-400">Real availability. Verified instructors. No phone tag.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Sign in ----------

const loginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
});

export function Login() {
  const { user, profile, isAdmin, loading } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const form = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });
  const next = params.get('next');

  if (!loading && user && (profile || isAdmin)) {
    return <Navigate to={next || (profile ? homePath(profile.role) : '/admin')} replace />;
  }

  const onSubmit = form.handleSubmit(async values => {
    try {
      await signInWithEmailAndPassword(auth, values.email.trim(), values.password);
      navigate(next || '/app', { replace: true });
    } catch (err) {
      form.setError('root', { message: errorMessage(err) });
    }
  });

  return (
    <AuthFrame title="Welcome back" subtitle={<>New to Safe Learners? <Link to="/signup" className="font-semibold text-ink-900 underline dark:text-white">Create an account</Link></>}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Input label="Email" type="email" autoComplete="email" {...form.register('email')} error={form.formState.errors.email?.message} />
        <Input label="Password" type="password" autoComplete="current-password" {...form.register('password')} error={form.formState.errors.password?.message} />
        {form.formState.errors.root && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{form.formState.errors.root.message}</p>}
        <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting}>Sign in</Button>
        <p className="text-center text-sm"><Link to="/reset-password" className="font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white">Forgot your password?</Link></p>
      </form>
    </AuthFrame>
  );
}

// ---------- Sign up ----------

const signupSchema = z.object({
  firstName: z.string().trim().min(1, 'Required'),
  surname: z.string().trim().min(1, 'Required'),
  email: z.string().trim().email('Enter a valid email'),
  mobile: z.string().trim().regex(/^(\+?61|0)4\d{2}\s?\d{3}\s?\d{3}$/, 'Enter an Australian mobile, e.g. 0412 345 678'),
  password: z.string().min(8, 'At least 8 characters'),
  dob: z.string().optional(),
  transmission: z.enum(['Auto', 'Manual', 'Auto & Manual']).optional(),
  referralCode: z.string().trim().optional(),
  terms: z.literal(true, { message: 'Please accept the terms to continue' }),
});

export function Signup({ role }: { role: Extract<Role, 'learner' | 'instructor'> }) {
  const { user, profile, onboard } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const form = useForm<z.infer<typeof signupSchema>>({
    resolver: zodResolver(signupSchema),
    defaultValues: { email: params.get('email') ?? '', referralCode: params.get('ref') ?? '', transmission: 'Auto' },
  });

  useEffect(() => {
    if (user && profile && !creating) navigate(homePath(profile.role), { replace: true });
  }, [user, profile, creating, navigate]);

  const onSubmit = form.handleSubmit(async values => {
    setCreating(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, values.email, values.password);
      await updateProfile(cred.user, { displayName: `${values.firstName} ${values.surname}` });
      // Public profile: instructors' contact details stay private (their profile is public).
      await setDoc(doc(db, 'users', cred.user.uid), {
        role,
        firstName: values.firstName,
        surname: values.surname,
        timezone: DEFAULT_TIMEZONE,
        createdAt: serverTimestamp(),
        ...(role === 'learner' ? { email: values.email.toLowerCase(), mobile: values.mobile } : {}),
        ...(role === 'instructor' ? { verificationStatus: 'not_submitted', transmission: values.transmission ?? 'Auto' } : {}),
      });
      await setDoc(doc(db, 'users', cred.user.uid, 'private', 'profile'), {
        email: values.email.toLowerCase(),
        mobile: values.mobile,
        ...(values.dob ? { dob: values.dob } : {}),
      }, { merge: true });
      await onboard(role === 'learner' ? values.referralCode || undefined : undefined);
      toast.success(role === 'instructor' ? 'Account created. Next, set up your profile.' : 'Welcome to Safe Learners!');
      // `creating` stays true so the redirect effect above doesn't override this navigation.
      navigate(role === 'instructor' ? '/instructor/verification' : '/learner', { replace: true });
    } catch (err) {
      form.setError('root', { message: errorMessage(err) });
      setCreating(false);
    }
  });

  const e = form.formState.errors;
  const isInstructor = role === 'instructor';
  return (
    <AuthFrame
      title={isInstructor ? 'Teach with Safe Learners' : 'Start learning to drive'}
      subtitle={<>Already have an account? <Link to="/login" className="font-semibold text-ink-900 underline dark:text-white">Sign in</Link></>}
      aside={isInstructor ? (
        <>
          <p className="text-2xl font-bold">Your hours. Your prices. Your suburbs.</p>
          <p className="mt-2 text-ink-400">We handle bookings, reminders and rescheduling so you can focus on teaching.</p>
        </>
      ) : undefined}
    >
      <div className="mb-6 grid grid-cols-2 gap-2 rounded-2xl bg-ink-100 p-1 dark:bg-ink-900">
        <Link to={`/signup${window.location.search}`} className={`flex items-center justify-center gap-2 rounded-xl py-2 text-sm font-bold ${!isInstructor ? 'bg-white shadow-sm dark:bg-ink-800' : 'text-ink-500'}`}><GraduationCap className="size-4" />Learner</Link>
        <Link to="/instructor/signup" className={`flex items-center justify-center gap-2 rounded-xl py-2 text-sm font-bold ${isInstructor ? 'bg-white shadow-sm dark:bg-ink-800' : 'text-ink-500'}`}><CarFront className="size-4" />Instructor</Link>
      </div>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <Input label="First name" autoComplete="given-name" {...form.register('firstName')} error={e.firstName?.message} />
          <Input label="Surname" autoComplete="family-name" {...form.register('surname')} error={e.surname?.message} />
        </div>
        <Input label="Email" type="email" autoComplete="email" {...form.register('email')} error={e.email?.message} />
        <Input label="Mobile" type="tel" autoComplete="tel" placeholder="0412 345 678" {...form.register('mobile')} error={e.mobile?.message} />
        {isInstructor ? (
          <Select label="You teach in" {...form.register('transmission')}>
            <option value="Auto">Automatic</option>
            <option value="Manual">Manual</option>
            <option value="Auto & Manual">Automatic & manual</option>
          </Select>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Input label="Date of birth" type="date" {...form.register('dob')} />
            <Input label="Referral code" placeholder="Optional" {...form.register('referralCode')} />
          </div>
        )}
        <Input label="Password" type="password" autoComplete="new-password" {...form.register('password')} error={e.password?.message} />
        <label className="flex items-start gap-3 text-sm text-ink-600 dark:text-ink-300">
          <input type="checkbox" className="mt-0.5 size-4 accent-brand-500" {...form.register('terms')} />
          <span>I agree to the Safe Learners terms of use and privacy policy.</span>
        </label>
        {e.terms && <p className="text-xs font-medium text-red-600">{e.terms.message}</p>}
        {e.root && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{e.root.message}</p>}
        <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting}>Create account</Button>
      </form>
    </AuthFrame>
  );
}

// ---------- Reset password ----------

export function ResetPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <AuthFrame title="Reset your password" subtitle="We’ll email you a link to choose a new password.">
      {sent ? (
        <div className="space-y-4">
          <p className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
            If an account exists for <strong>{email}</strong>, a reset link is on its way.
          </p>
          <Link to="/login" className="font-semibold underline">Back to sign in</Link>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={async e => {
            e.preventDefault();
            setBusy(true);
            try {
              await sendPasswordResetEmail(auth, email.trim());
            } catch {
              // Same message either way, so we don't reveal which emails have accounts.
            }
            setBusy(false);
            setSent(true);
          }}
        >
          <Input label="Email" type="email" required value={email} onChange={e => setEmail(e.target.value)} />
          <Button type="submit" size="lg" className="w-full" loading={busy}>Send reset link</Button>
        </form>
      )}
    </AuthFrame>
  );
}
