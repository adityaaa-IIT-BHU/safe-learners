import { clsx } from 'clsx';
import { Loader2, X } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { initials } from '@shared/domain';

export { clsx as cx };

// ---------- Buttons ----------

type Variant = 'primary' | 'dark' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-brand-500 text-ink-950 hover:bg-brand-400 shadow-sm shadow-brand-700/20',
  dark: 'bg-ink-950 text-white hover:bg-ink-800 dark:bg-white dark:text-ink-950 dark:hover:bg-ink-100',
  secondary: 'bg-white text-ink-800 border border-ink-200 hover:bg-ink-50 dark:bg-ink-900 dark:text-ink-100 dark:border-ink-700 dark:hover:bg-ink-800',
  ghost: 'text-ink-700 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800',
  danger: 'bg-red-600 text-white hover:bg-red-500',
  success: 'bg-emerald-600 text-white hover:bg-emerald-500',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-base gap-2 rounded-xl',
};

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra?: string) {
  return clsx(
    'inline-flex items-center justify-center font-semibold whitespace-nowrap transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    sizes[size],
    extra,
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function ButtonLink({ variant = 'primary', size = 'md', className, ...rest }: LinkProps & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...rest} />;
}

// ---------- Surfaces ----------

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('card', className)} {...rest}>{children}</div>;
}

export function CardHeader({ title, subtitle, action, className }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex items-start justify-between gap-4 border-b border-ink-100 px-5 py-4 dark:border-ink-800', className)}>
      <div className="min-w-0">
        <h3 className="font-bold text-ink-900 dark:text-white">{title}</h3>
        {subtitle && <p className="mt-0.5 text-sm text-ink-500 dark:text-ink-400">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-6 animate-slide-up">
      {back && <div className="mb-3">{back}</div>}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink-950 sm:text-3xl dark:text-white">{title}</h1>
          {subtitle && <p className="mt-1 text-ink-500 dark:text-ink-400">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

// ---------- Badges ----------

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'yellow';

const tones: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300',
  red: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300',
  slate: 'bg-ink-100 text-ink-600 ring-ink-500/20 dark:bg-ink-800 dark:text-ink-300',
  yellow: 'bg-brand-100 text-brand-900 ring-brand-600/30 dark:bg-brand-500/15 dark:text-brand-300',
};

export function Badge({ tone = 'slate', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset', tones[tone], className)}>
      {children}
    </span>
  );
}

// ---------- Avatar ----------

export function Avatar({ name, src, size = 40, className }: { name?: string; src?: string; size?: number; className?: string }) {
  const style = { width: size, height: size, fontSize: Math.max(11, size * 0.38) };
  if (src) return <img src={src} alt={name || ''} style={style} className={clsx('shrink-0 rounded-full object-cover object-top ring-2 ring-white dark:ring-ink-900', className)} />;
  return (
    <span style={style} className={clsx('inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-300 to-brand-500 font-bold text-ink-950 ring-2 ring-white dark:ring-ink-900', className)}>
      {initials(name)}
    </span>
  );
}

// ---------- Form fields ----------

interface FieldShellProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: (id: string) => ReactNode;
}

export function Field({ label, hint, error, className, children }: FieldShellProps) {
  const id = useId();
  return (
    <div className={className}>
      {label && <label htmlFor={id} className="label">{label}</label>}
      {children(id)}
      {error ? <p className="mt-1.5 text-xs font-medium text-red-600">{error}</p> : hint ? <p className="mt-1.5 text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; hint?: ReactNode; error?: string; wrapperClassName?: string };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, wrapperClassName, className, ...rest }, ref) {
  return (
    <Field label={label} hint={hint} error={error} className={wrapperClassName}>
      {id => <input id={id} ref={ref} className={clsx('input', error && 'border-red-400', className)} {...rest} />}
    </Field>
  );
});

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: ReactNode; hint?: ReactNode; error?: string; wrapperClassName?: string };

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, hint, error, wrapperClassName, className, ...rest }, ref) {
  return (
    <Field label={label} hint={hint} error={error} className={wrapperClassName}>
      {id => <textarea id={id} ref={ref} rows={4} className={clsx('input resize-y', className)} {...rest} />}
    </Field>
  );
});

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { label?: ReactNode; hint?: ReactNode; error?: string; wrapperClassName?: string };

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, hint, error, wrapperClassName, className, children, ...rest }, ref) {
  return (
    <Field label={label} hint={hint} error={error} className={wrapperClassName}>
      {id => (
        <select id={id} ref={ref} className={clsx('input appearance-none bg-[url("data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2020%2020%22%20fill%3D%22%238590a3%22%3E%3Cpath%20d%3D%22M5.3%207.3a1%201%200%20011.4%200L10%2010.6l3.3-3.3a1%201%200%20111.4%201.4l-4%204a1%201%200%2001-1.4%200l-4-4a1%201%200%20010-1.4z%22/%3E%3C/svg%3E")] bg-[length:1.25rem] bg-[right_0.75rem_center] bg-no-repeat pr-10', className)} {...rest}>
          {children}
        </select>
      )}
    </Field>
  );
});

/** Segmented single-choice control. */
export function Segmented<T extends string>({ value, onChange, options, className }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; sub?: ReactNode }[];
  className?: string;
}) {
  return (
    <div className={clsx('grid gap-2', className)} style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 4)}, minmax(0, 1fr))` }} role="radiogroup">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-xl border px-3 py-2.5 text-left text-sm transition',
            value === o.value
              ? 'border-ink-950 bg-ink-950 text-white dark:border-brand-500 dark:bg-brand-500 dark:text-ink-950'
              : 'border-ink-200 bg-white hover:border-ink-400 dark:border-ink-700 dark:bg-ink-900',
          )}
        >
          <div className="font-semibold">{o.label}</div>
          {o.sub && <div className={clsx('text-xs', value === o.value ? 'opacity-80' : 'text-ink-500')}>{o.sub}</div>}
        </button>
      ))}
    </div>
  );
}

// ---------- Tabs ----------

export function Tabs<T extends string>({ value, onChange, tabs }: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode; count?: number }[];
}) {
  return (
    <div className="scroll-thin -mx-1 flex gap-1 overflow-x-auto border-b border-ink-200 px-1 dark:border-ink-800" role="tablist">
      {tabs.map(t => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={clsx(
            'relative flex items-center gap-2 whitespace-nowrap px-3 py-2.5 text-sm font-semibold transition',
            value === t.value ? 'text-ink-950 dark:text-white' : 'text-ink-500 hover:text-ink-800 dark:hover:text-ink-200',
          )}
        >
          {t.label}
          {!!t.count && (
            <span className={clsx('rounded-full px-1.5 text-[11px] font-bold', value === t.value ? 'bg-brand-500 text-ink-950' : 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300')}>
              {t.count}
            </span>
          )}
          {value === t.value && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand-500" />}
        </button>
      ))}
    </div>
  );
}

// ---------- Modal ----------

export function Modal({ open, onClose, title, children, footer, size = 'md' }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={e => e.target === ref.current && onClose()}
      className={clsx(
        'm-auto w-[calc(100%-2rem)] rounded-2xl bg-white p-0 text-ink-900 shadow-lift backdrop:bg-ink-950/50 backdrop:backdrop-blur-sm dark:bg-ink-900 dark:text-ink-100',
        'open:animate-slide-up',
        { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' }[size],
      )}
    >
      {open && (
        <>
          <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4 dark:border-ink-800">
            <h2 className="text-lg font-bold">{title}</h2>
            <button onClick={onClose} className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800" aria-label="Close">
              <X className="size-5" />
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-ink-100 px-5 py-3 dark:border-ink-800">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

// ---------- Feedback states ----------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-5 animate-spin text-ink-400', className)} />;
}

export function PageLoader() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Spinner className="size-8" />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('animate-pulse rounded-xl bg-ink-200/70 dark:bg-ink-800', className)} />;
}

export function EmptyState({ icon, title, body, action, className }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {icon && <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-brand-100 text-brand-800 dark:bg-brand-500/15 dark:text-brand-300">{icon}</div>}
      <h3 className="font-bold text-ink-900 dark:text-white">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-sm text-ink-500">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, icon }: { label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between text-sm font-medium text-ink-500">
        {label}
        {icon && <span className="text-ink-400">{icon}</span>}
      </div>
      <div className="mt-2 text-2xl font-extrabold tracking-tight text-ink-950 dark:text-white">{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-500">{sub}</div>}
    </Card>
  );
}

export function Stars({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <span className="inline-flex" aria-label={`${value.toFixed(1)} out of 5`}>
      {[1, 2, 3, 4, 5].map(i => (
        <svg key={i} width={size} height={size} viewBox="0 0 20 20" className={i <= Math.round(value) ? 'text-brand-500' : 'text-ink-200 dark:text-ink-700'} fill="currentColor">
          <path d="M10 1.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L10 14.9l-5.2 2.7 1-5.8L1.5 7.7l5.9-.9z" />
        </svg>
      ))}
    </span>
  );
}

export function Money({ value, className }: { value: number | undefined; className?: string }) {
  return <span className={className}>{formatMoney(value)}</span>;
}

export function formatMoney(value: number | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: value % 1 ? 2 : 0 }).format(value);
}
