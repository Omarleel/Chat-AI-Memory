import {useEffect, useRef} from 'react';
import {AlertTriangle, CheckCircle2, Info, Loader2, X} from 'lucide-react';

export function PageHeader({title, description, actions}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({title, description, actions, children, className = '', bodyClassName = 'p-5'}) {
  return (
    <section className={`card min-w-0 ${className}`}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

const TONES = {
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  blue: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  red: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300'
};
export function Badge({tone = 'slate', children, className = ''}) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`}>{children}</span>;
}

export function Field({label, hint, error, children, className = ''}) {
  return (
    <label className={`block ${className}`}>
      {label && <span className="label">{label}</span>}
      {children}
      {error ? <span className="mt-1 block text-xs text-rose-600">{error}</span>
        : hint && <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">{hint}</span>}
    </label>
  );
}

export function Toggle({checked, onChange, label, hint, disabled}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-700'}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition ${checked ? 'left-4' : 'left-0.5'}`} />
      </button>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-slate-500 dark:text-slate-400">{hint}</span>}
      </span>
    </label>
  );
}

export const Spinner = ({className = 'h-4 w-4'}) => <Loader2 className={`animate-spin ${className}`} aria-hidden="true" />;

export function Loading({label = 'Cargando…'}) {
  return <div className="flex items-center gap-2 py-6 text-sm text-slate-500"><Spinner /> {label}</div>;
}

const NOTICE = {
  error: {icon: AlertTriangle, cls: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200'},
  warning: {icon: AlertTriangle, cls: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'},
  info: {icon: Info, cls: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200'},
  success: {icon: CheckCircle2, cls: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'}
};
export function Notice({kind = 'info', title, children, className = ''}) {
  const {icon: Icon, cls} = NOTICE[kind];
  return (
    <div className={`flex gap-3 rounded-lg border px-4 py-3 text-sm ${cls} ${className}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{title && <p className="font-medium">{title}</p>}<div className="break-words">{children}</div></div>
    </div>
  );
}
export const ErrorNotice = ({error, className}) => error ? <Notice kind="error" className={className}>{error.message ?? String(error)}</Notice> : null;

export function EmptyState({icon: Icon, title, children}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {Icon && <Icon className="mb-3 h-8 w-8 text-slate-300 dark:text-slate-600" aria-hidden="true" />}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-slate-500 dark:text-slate-400">{children}</div>}
    </div>
  );
}

export function ProgressBar({value, tone = 'brand'}) {
  const pct = Math.round(Math.min(1, Math.max(0, value ?? 0)) * 100);
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full transition-all ${tone === 'red' ? 'bg-rose-500' : 'bg-brand-500'}`} style={{width: `${pct}%`}} />
    </div>
  );
}

export function Stat({label, value, hint, tone}) {
  return (
    <div className="min-w-0">
      <p className="label">{label}</p>
      <p className={`truncate text-sm font-semibold ${tone === 'red' ? 'text-rose-600' : ''}`} title={typeof value === 'string' ? value : undefined}>{value}</p>
      {hint && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

export function Modal({open, title, children, onClose, footer}) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" onMouseDown={e => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="card w-full max-w-lg outline-none">
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button className="btn-ghost p-1" onClick={onClose} aria-label="Cerrar"><X className="h-4 w-4" /></button>
        </header>
        <div className="px-5 py-4 text-sm">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">{footer}</footer>}
      </div>
    </div>
  );
}
