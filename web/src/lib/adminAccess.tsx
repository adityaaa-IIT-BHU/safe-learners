// Which client Admin Panel sections need which permissions (any one of the listed is enough to open
// the section; actions inside are checked again by the server).
import { ShieldOff } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import type { Action, ModuleKey } from '@shared/access';
import { useAuth } from '@/auth/AuthProvider';
import { Card, EmptyState } from '@/components/ui';

export const ADMIN_SECTIONS: { path: string; needs: [ModuleKey, Action][] }[] = [
  { path: '/admin', needs: [['reports', 'view']] },
  { path: '/admin/verifications', needs: [['documents', 'view'], ['instructors', 'view']] },
  { path: '/admin/users', needs: [['learners', 'view'], ['instructors', 'view']] },
  { path: '/admin/bookings', needs: [['bookings', 'view']] },
  { path: '/admin/reviews', needs: [['reviews', 'view']] },
  { path: '/admin/finance', needs: [['finance', 'view'], ['invoices', 'view'], ['wallet', 'view']] },
  { path: '/admin/xero', needs: [['xero', 'view']] },
  { path: '/admin/tools', needs: [['tools', 'view']] },
  { path: '/admin/settings', needs: [['ocr', 'view'], ['commission', 'view']] },
];

export function useSectionAccess() {
  const { can } = useAuth();
  const allowed = (path: string) => {
    const s = ADMIN_SECTIONS.find(x => x.path === path);
    return !s || s.needs.some(([m, a]) => can(m, a));
  };
  return { allowed, first: ADMIN_SECTIONS.find(s => s.needs.some(([m, a]) => can(m, a)))?.path ?? null };
}

/** Shows a section only to admins with access to it (the server enforces the same rules). */
export function SectionGuard({ path, children }: { path: string; children: ReactNode }) {
  const { allowed, first } = useSectionAccess();
  if (allowed(path)) return <>{children}</>;
  if (path === '/admin' && first) return <Navigate to={first} replace />;
  return <NoAccess />;
}

export function NoAccess() {
  return <Card><EmptyState icon={<ShieldOff className="size-6" />} title="You don’t have access to this section" body="Your administrator access is managed by Cybria. Ask them if you need it." /></Card>;
}
