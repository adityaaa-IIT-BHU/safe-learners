import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { Logo, ThemeToggle } from '@/components/AppShell';
import { ButtonLink } from '@/components/ui';

export const SUPPORT_EMAIL = 'info@safelearners.com.au';

export function PublicLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-ink-200/60 bg-white/80 backdrop-blur-lg dark:border-ink-800 dark:bg-ink-950/80">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-1 text-sm font-semibold text-ink-600 md:flex dark:text-ink-300">
            <Link to="/instructors" className="rounded-lg px-3 py-2 hover:bg-ink-100 dark:hover:bg-ink-800">Find an instructor</Link>
            <Link to="/instructor/signup" className="rounded-lg px-3 py-2 hover:bg-ink-100 dark:hover:bg-ink-800">Teach with us</Link>
            <Link to="/support" className="rounded-lg px-3 py-2 hover:bg-ink-100 dark:hover:bg-ink-800">Help</Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            {user ? (
              <ButtonLink to="/app" variant="dark" size="sm">My dashboard</ButtonLink>
            ) : (
              <>
                <ButtonLink to="/login" variant="ghost" size="sm" className="hidden sm:inline-flex">Sign in</ButtonLink>
                <ButtonLink to="/signup" size="sm">Get started</ButtonLink>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-ink-200/60 bg-white dark:border-ink-800 dark:bg-ink-950">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div>
          <Logo />
          <p className="mt-4 text-sm text-ink-500">Book trusted, verified driving instructors near you and manage every lesson in one place.</p>
        </div>
        <FooterCol title="Learners" links={[['Find an instructor', '/instructors'], ['Create an account', '/signup'], ['Help centre', '/support']]} />
        <FooterCol title="Instructors" links={[['Teach with Safe Learners', '/instructor/signup'], ['Instructor sign in', '/login']]} />
        <div>
          <p className="text-sm font-bold">Contact</p>
          <a href={`mailto:${SUPPORT_EMAIL}`} className="mt-3 block text-sm text-ink-500 hover:text-ink-900 dark:hover:text-white">{SUPPORT_EMAIL}</a>
          <p className="mt-2 text-sm text-ink-500">Safe Learners Australia · ABN 74 679 772 840</p>
        </div>
      </div>
      <div className="border-t border-ink-200/60 py-5 text-center text-xs text-ink-400 dark:border-ink-800">
        © {new Date().getFullYear()} Safe Learners Australia
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <p className="text-sm font-bold">{title}</p>
      <ul className="mt-3 space-y-2">
        {links.map(([label, to]) => (
          <li key={to}><Link to={to} className="text-sm text-ink-500 hover:text-ink-900 dark:hover:text-white">{label}</Link></li>
        ))}
      </ul>
    </div>
  );
}
