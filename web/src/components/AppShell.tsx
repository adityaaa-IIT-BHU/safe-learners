import { doc, updateDoc, writeBatch } from 'firebase/firestore';
import {
  BadgeCheck,
  Bell,
  CalendarDays,
  CarFront,
  ChartColumn,
  CircleDollarSign,
  Eye,
  Gift,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  MapPinned,
  Menu,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Sun,
  Users,
  Wallet,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { fullName, type Role } from '@shared/domain';
import { useAuth } from '@/auth/AuthProvider';
import { useNotifications } from '@/lib/data';
import { db } from '@/lib/firebase';
import { useTheme } from '@/lib/theme';
import { timeAgo } from '@/lib/format';
import { Avatar, cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

const NAV: Record<Role, NavItem[]> = {
  learner: [
    { to: '/learner', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/learner/instructors', label: 'Find instructors', icon: Search },
    { to: '/learner/wallet', label: 'Wallet', icon: Wallet },
    { to: '/learner/refer', label: 'Invite friends', icon: Gift },
    { to: '/learner/support', label: 'Help & support', icon: LifeBuoy },
    { to: '/learner/profile', label: 'Profile', icon: Settings },
  ],
  instructor: [
    { to: '/instructor', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/instructor/calendar', label: 'Calendar', icon: CalendarDays },
    { to: '/instructor/learners', label: 'Learners', icon: Users },
    { to: '/instructor/availability', label: 'Availability', icon: MapPinned },
    { to: '/instructor/calendar-settings', label: 'Calendar settings', icon: SlidersHorizontal },
    { to: '/instructor/pricing', label: 'Pricing', icon: CircleDollarSign },
    { to: '/instructor/reports', label: 'Reports', icon: ChartColumn },
    { to: '/instructor/reviews', label: 'Reviews', icon: Star },
    { to: '/instructor/profile', label: 'Profile & vehicle', icon: CarFront },
    { to: '/instructor/verification', label: 'Verification', icon: BadgeCheck },
    { to: '/instructor/settings', label: 'Settings', icon: Settings },
    { to: '/instructor/support', label: 'Help & support', icon: LifeBuoy },
  ],
  admin: [
    { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
    { to: '/admin/verifications', label: 'Verifications', icon: ShieldCheck },
    { to: '/admin/users', label: 'Users', icon: Users },
    { to: '/admin/bookings', label: 'Bookings', icon: CalendarDays },
    { to: '/admin/reviews', label: 'Reviews', icon: Star },
    { to: '/admin/tools', label: 'Tools', icon: Wrench },
  ],
};

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <Link to="/" className={cx('flex items-center gap-2.5', className)}>
      <span className="lplate size-9 text-sm tracking-tight ring-2 ring-ink-950 dark:ring-brand-500">SL</span>
      {!compact && (
        <span className="leading-none">
          <span className="block text-base font-extrabold tracking-tight">Safe Learners</span>
          <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-500">Driving school network</span>
        </span>
      )}
    </Link>
  );
}

export function AppShell({ role }: { role: Role }) {
  const { profile, readOnly, viewAs, isAdmin } = useAuth();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const items = NAV[role];
  const sidebar = (
    <nav className="flex h-full flex-col gap-1 p-4">
      <Logo className="mb-6 px-2" />
      {items.map(item => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => cx(
            'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition',
            isActive
              ? 'bg-ink-950 text-white shadow-sm dark:bg-brand-500 dark:text-ink-950'
              : 'text-ink-600 hover:bg-ink-100 hover:text-ink-950 dark:text-ink-400 dark:hover:bg-ink-800 dark:hover:text-white',
          )}
        >
          {({ isActive }) => (
            <>
              <item.icon className={cx('size-[18px]', isActive ? 'text-brand-400 dark:text-ink-950' : '')} />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
      {isAdmin && role !== 'admin' && (
        <NavLink to="/admin" className="mt-2 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-600 hover:bg-ink-100 dark:text-ink-400 dark:hover:bg-ink-800">
          <ShieldCheck className="size-[18px]" /> Admin
        </NavLink>
      )}
      {role === 'instructor' && profile?.verificationStatus !== 'verified' && (
        <Link to="/instructor/verification" className="mt-auto rounded-2xl bg-brand-100 p-4 text-sm dark:bg-brand-500/10">
          <p className="font-bold text-brand-900 dark:text-brand-300">Get verified</p>
          <p className="mt-1 text-brand-800/80 dark:text-brand-300/80">Learners can book you once your documents are approved.</p>
        </Link>
      )}
    </nav>
  );

  return (
    <div className="min-h-dvh">
      {readOnly && (
        <div className="sticky top-0 z-40 flex items-center justify-center gap-3 bg-ink-950 px-4 py-2 text-sm text-white">
          <Eye className="size-4 text-brand-400" />
          Viewing <strong>{fullName(profile)}</strong>’s account (read only)
          <button
            onClick={() => { viewAs(null); navigate('/admin/users'); }}
            className="rounded-lg bg-brand-500 px-2.5 py-1 text-xs font-bold text-ink-950"
          >
            Exit
          </button>
        </div>
      )}

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-ink-200/70 bg-white lg:block dark:border-ink-800 dark:bg-ink-900">
        {sidebar}
      </aside>

      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-ink-950/50 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 animate-slide-up overflow-y-auto bg-white shadow-lift dark:bg-ink-900">
            <button onClick={() => setDrawerOpen(false)} className="absolute right-3 top-4 rounded-lg p-2 text-ink-500" aria-label="Close menu"><X className="size-5" /></button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-ink-200/70 bg-white/80 px-4 backdrop-blur-lg sm:px-6 dark:border-ink-800 dark:bg-ink-950/80">
          <button onClick={() => setDrawerOpen(true)} className="rounded-lg p-2 text-ink-600 hover:bg-ink-100 lg:hidden dark:text-ink-300 dark:hover:bg-ink-800" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <Logo compact className="lg:hidden" />
          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
            <NotificationBell userId={role === 'admin' ? 'admin' : profile?.id} />
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button onClick={toggle} className="rounded-xl p-2.5 text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800" aria-label="Toggle dark mode">
      {theme === 'dark' ? <Sun className="size-5" /> : <Moon className="size-5" />}
    </button>
  );
}

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onOutside]);
  return ref;
}

function NotificationBell({ userId }: { userId?: string }) {
  const { readOnly } = useAuth();
  const [open, setOpen] = useState(false);
  const { data: items } = useNotifications(userId);
  const navigate = useNavigate();
  const ref = useClickOutside(() => setOpen(false));
  const unread = items.filter(n => !n.read).length;

  const markAllRead = async () => {
    if (readOnly) return;
    const batch = writeBatch(db);
    items.filter(n => !n.read).forEach(n => batch.update(doc(db, 'notifications', n.id), { read: true }));
    await batch.commit();
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)} className="relative rounded-xl p-2.5 text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800" aria-label={`Notifications (${unread} unread)`}>
        <Bell className="size-5" />
        {unread > 0 && (
          <span className="absolute right-1.5 top-1.5 flex min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-[18px] text-white ring-2 ring-white dark:ring-ink-950">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-50 w-[min(24rem,calc(100vw-2rem))] animate-slide-up overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-lift dark:border-ink-800 dark:bg-ink-900">
          <div className="flex items-center justify-between border-b border-ink-100 px-4 py-3 dark:border-ink-800">
            <p className="font-bold">Notifications</p>
            {unread > 0 && !readOnly && <button onClick={markAllRead} className="text-xs font-semibold text-ink-500 hover:text-ink-900 dark:hover:text-white">Mark all read</button>}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-ink-500">You’re all caught up.</p>
            ) : items.map(n => (
              <button
                key={n.id}
                onClick={async () => {
                  setOpen(false);
                  if (!n.read && !readOnly) await updateDoc(doc(db, 'notifications', n.id), { read: true });
                  if (n.link) navigate(n.link);
                }}
                className={cx('flex w-full gap-3 border-b border-ink-100 px-4 py-3 text-left transition last:border-0 hover:bg-ink-50 dark:border-ink-800 dark:hover:bg-ink-800/60', !n.read && 'bg-brand-50/60 dark:bg-brand-500/5')}
              >
                <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-brand-500')} />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{n.title}</span>
                  <span className="mt-0.5 line-clamp-2 block text-xs text-ink-500">{n.body}</span>
                  {n.createdAt && <span className="mt-1 block text-[11px] text-ink-400">{timeAgo(n.createdAt)}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { profile, user, signOut, readOnly } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const navigate = useNavigate();
  const name = fullName(profile) || user?.email || '';
  const settingsPath = profile?.role === 'instructor' ? '/instructor/settings' : profile?.role === 'learner' ? '/learner/profile' : '/admin';

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-2 rounded-xl p-1 pr-2 hover:bg-ink-100 dark:hover:bg-ink-800">
        <Avatar name={name} src={profile?.photoUrl} size={34} />
        <span className="hidden max-w-[10rem] truncate text-sm font-semibold sm:block">{profile?.firstName}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-50 w-60 animate-slide-up overflow-hidden rounded-2xl border border-ink-200 bg-white p-1.5 shadow-lift dark:border-ink-800 dark:bg-ink-900">
          <div className="px-3 py-2">
            <p className="truncate text-sm font-bold">{name}</p>
            <p className="truncate text-xs text-ink-500">{user?.email}</p>
          </div>
          <MenuItem onClick={() => { setOpen(false); navigate(settingsPath); }} icon={<Settings className="size-4" />}>Account settings</MenuItem>
          {!readOnly && (
            <MenuItem onClick={async () => { await signOut(); navigate('/'); }} icon={<LogOut className="size-4" />}>Sign out</MenuItem>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, icon, children }: { onClick: () => void; icon: ReactNode; children: ReactNode }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800">
      {icon}
      {children}
    </button>
  );
}

/** Buttons that change data are disabled while an admin views someone else's account. */
export function useWriteGuard() {
  const { readOnly } = useAuth();
  return readOnly;
}

