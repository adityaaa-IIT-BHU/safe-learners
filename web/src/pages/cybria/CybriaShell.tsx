// Cybria Super Admin Control Centre: dedicated sign-in, guard and shell. Only Cybria Super Admins can
// open it; everyone else (client admins included) sees "page not found", and every action is checked
// again on the server.
import { signInWithEmailAndPassword } from 'firebase/auth';
import {
  ArrowLeftRight, BadgeCheck, CalendarDays, ChevronsLeft, ChevronsRight, CircleDollarSign, Gauge, KeyRound, Landmark, LogOut, Percent,
  ScanText, ShieldCheck, UserCog, Users, type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { Button, Input, PageLoader, cx } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { auth } from '@/lib/firebase';
import { NotFound } from '@/pages/public/NotFound';

export const CYBRIA_NAV: { group: string; items: { to: string; label: string; icon: LucideIcon; end?: boolean }[] }[] = [
  { group: 'Overview', items: [{ to: '/cybria', label: 'Dashboard', icon: Gauge, end: true }] },
  { group: 'Access', items: [
    { to: '/cybria/admins', label: 'Client Admin Management', icon: UserCog },
    { to: '/cybria/roles', label: 'Roles & Permissions', icon: KeyRound },
  ] },
  { group: 'Operations', items: [
    { to: '/cybria/users', label: 'User Management', icon: Users },
    { to: '/cybria/bookings', label: 'Booking Management', icon: CalendarDays },
    { to: '/cybria/documents', label: 'Document Verification', icon: BadgeCheck },
    { to: '/cybria/ocr', label: 'OCR & Automation', icon: ScanText },
  ] },
  { group: 'Money', items: [
    { to: '/cybria/finance', label: 'Finance & Payments', icon: Landmark },
    { to: '/cybria/commission', label: 'Commission Management', icon: Percent },
    { to: '/cybria/xero', label: 'Xero & Accounting', icon: ArrowLeftRight },
  ] },
];

/** Opens the Control Centre only for Cybria Super Admins. */
export function RequireSuper({ children }: { children: ReactNode }) {
  const { user, isSuper, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to={`/cybria/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!isSuper) return <NotFound />;
  return <>{children}</>;
}

export function CybriaShell() {
  const { user, signOut } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  return (
    <div className="flex min-h-dvh bg-ink-50 dark:bg-ink-950">
      <aside className={cx('sticky top-0 hidden h-dvh shrink-0 flex-col bg-[#1d1433] text-white transition-all md:flex', collapsed ? 'w-16' : 'w-64')}>
        <div className="flex items-center gap-2 px-4 py-5">
          <ShieldCheck className="size-7 shrink-0 text-amber-300" />
          {!collapsed && <div className="leading-tight"><p className="text-sm font-extrabold tracking-wide">CYBRIA</p><p className="text-[10px] uppercase tracking-[0.18em] text-white/60">Super Admin · SafeLearners</p></div>}
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto px-2 pb-4">
          {CYBRIA_NAV.map(g => (
            <div key={g.group}>
              {!collapsed && <p className="px-3 pb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-white/40">{g.group}</p>}
              {g.items.map(i => (
                <NavLink key={i.to} to={i.to} end={i.end} title={i.label}
                  className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition', isActive ? 'bg-amber-300 text-[#1d1433]' : 'text-white/75 hover:bg-white/10 hover:text-white')}>
                  <i.icon className="size-4 shrink-0" />{!collapsed && i.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="space-y-1 border-t border-white/10 p-2">
          <button onClick={() => navigate('/admin')} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-white/75 hover:bg-white/10"><CircleDollarSign className="size-4" />{!collapsed && 'Client Admin Panel'}</button>
          <button onClick={() => setCollapsed(c => !c)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-white/75 hover:bg-white/10">{collapsed ? <ChevronsRight className="size-4" /> : <><ChevronsLeft className="size-4" />Collapse</>}</button>
          <button onClick={async () => { await signOut(); navigate('/cybria/login'); }} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-white/75 hover:bg-white/10"><LogOut className="size-4" />{!collapsed && 'Sign out'}</button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-ink-200 bg-white/90 px-4 py-3 backdrop-blur md:px-8 dark:border-ink-800 dark:bg-ink-900/90">
          <ShieldCheck className="size-5 text-[#6f42c1] md:hidden" />
          <p className="text-sm font-bold">Cybria Super Admin Control Centre</p>
          <span className="flex-1" />
          <select className="rounded-lg border border-ink-200 bg-transparent px-2 py-1 text-sm md:hidden dark:border-ink-700" value="" onChange={e => e.target.value && navigate(e.target.value)}>
            <option value="">Go to…</option>
            {CYBRIA_NAV.flatMap(g => g.items).map(i => <option key={i.to} value={i.to}>{i.label}</option>)}
          </select>
          <span className="hidden text-xs text-ink-500 sm:inline">{user?.email}</span>
        </header>
        <main className="mx-auto max-w-7xl p-4 md:p-8"><Outlet /></main>
      </div>
    </div>
  );
}

export function CybriaLogin() {
  const { user, isSuper, loading, signOut } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const next = new URLSearchParams(useLocation().search).get('next') ?? '/cybria';
  if (!loading && user && isSuper) return <Navigate to={next.startsWith('/cybria') ? next : '/cybria'} replace />;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#1d1433] p-4">
      <form className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-6 shadow-2xl dark:bg-ink-900" onSubmit={async e => {
        e.preventDefault();
        setBusy(true); setError(null);
        try {
          const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
          const t = await cred.user.getIdTokenResult(true);
          if (t.claims.sa !== true) { await signOut(); setError('This sign-in is for Cybria Super Admins only.'); return; }
          navigate(next.startsWith('/cybria') ? next : '/cybria', { replace: true });
        } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
      }}>
        <div className="flex items-center gap-3"><ShieldCheck className="size-9 text-[#6f42c1]" /><div><p className="font-extrabold">Cybria Super Admin</p><p className="text-xs text-ink-500">SafeLearners Control Centre</p></div></div>
        {user && !isSuper && !loading && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">You’re signed in with an account that isn’t a Cybria Super Admin. <button type="button" className="underline" onClick={() => signOut()}>Sign out</button></p>}
        <Input label="Email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
        <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <Button type="submit" className="w-full" loading={busy}>Sign in</Button>
        <p className="text-center text-xs text-ink-500">Authorised Cybria staff only. Access is recorded.</p>
      </form>
    </div>
  );
}
