import { useState, type ReactNode, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff, Trophy } from 'lucide-react';

export const inputClass =
  'w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none text-sm';

export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex items-center justify-center gap-2">
          <Trophy size={22} className="text-amber-400" aria-hidden="true" />
          <span className="font-bold text-white">מעקב הטבות כרטיסי אשראי</span>
        </div>
        <div className="bg-slate-800 rounded-2xl p-6 border border-slate-700 space-y-4">
          <h1 className="text-lg font-semibold text-white">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
}

export function TextField({ id, label, value, onChange, error, ...rest }: FieldProps) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm text-slate-300">{label}</label>
      <input
        id={id}
        dir="ltr"
        value={value}
        onChange={e => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={inputClass}
        {...rest}
      />
      {error && <p id={`${id}-error`} className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

export function PasswordField({ id, label, value, onChange, error, autoComplete, ...rest }: FieldProps & { autoComplete: 'current-password' | 'new-password' | 'off' }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm text-slate-300">{label}</label>
      <div className="relative">
        <input
          id={id}
          dir="ltr"
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={e => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={`${inputClass} pr-10`}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setShown(s => !s)}
          aria-label={shown ? 'הסתר סיסמה' : 'הצג סיסמה'}
          aria-pressed={shown}
          className="absolute inset-y-0 right-0 px-3 text-slate-400 hover:text-white"
        >
          {shown ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
        </button>
      </div>
      {error && <p id={`${id}-error`} className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

/** Live region (implicit via role): always rendered so screen readers announce the message when it appears. */
export function FormAlert({ message, tone = 'error' }: { message?: string | null; tone?: 'error' | 'success' }) {
  const cls = tone === 'error'
    ? 'bg-red-900/50 text-red-400 border-red-700'
    : 'bg-green-900/30 text-green-300 border-green-700';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'}>
      {message && <div className={`rounded-xl px-4 py-3 text-sm border ${cls}`}>{message}</div>}
    </div>
  );
}

export function SubmitButton({ pending, children, pendingLabel }: { pending: boolean; children: ReactNode; pendingLabel: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
