import { ButtonLink } from '@/components/ui';
import { PublicLayout } from './Layout';

export function NotFound() {
  return (
    <PublicLayout>
      <div className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
        <span className="lplate size-24 text-6xl ring-4 ring-ink-950 dark:ring-brand-500">?</span>
        <h1 className="mt-8 text-3xl font-extrabold">Wrong turn</h1>
        <p className="mt-2 text-ink-500">We couldn’t find that page. It may have moved, or the link might be old.</p>
        <ButtonLink to="/" className="mt-8">Back to home</ButtonLink>
      </div>
    </PublicLayout>
  );
}
