import { useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { AuthCard, FormAlert, PasswordField, SubmitButton, TextField } from '../auth/AuthForm';
import { authErrorMessage, validateEmail } from '../lib/errors';
import { safeRedirectPath } from '../lib/safeRedirect';

export function Login() {
  const { login, logout, logoutFailed } = useAuth();
  const submitting = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (submitting.current || login.isPending) return;
    const next = { email: validateEmail(email) ?? undefined, password: password ? undefined : 'יש להזין סיסמה' };
    setErrors(next);
    if (next.email || next.password) return;
    submitting.current = true;
    login.mutate({ email: email.trim(), password }, {
      onSettled: () => { submitting.current = false; },
      onSuccess: () => navigate(safeRedirectPath((location.state as { from?: unknown } | null)?.from), { replace: true }),
    });
  };

  return (
    <AuthCard title="התחברות">
      {logoutFailed && (
        <div role="alert" className="rounded-xl px-4 py-3 text-sm border bg-amber-900/30 text-amber-300 border-amber-700 space-y-2">
          <p>ההתנתקות מול השרת נכשלה — ייתכן שהחיבור עדיין פעיל. נסו להתנתק שוב</p>
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-sm font-medium"
          >
            {logout.isPending ? 'מתנתק...' : 'נסו להתנתק שוב'}
          </button>
        </div>
      )}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField id="email" label="אימייל" type="email" autoComplete="username" inputMode="email"
          value={email} onChange={setEmail} error={errors.email} />
        <PasswordField id="password" label="סיסמה" autoComplete="current-password"
          value={password} onChange={setPassword} error={errors.password} />
        <FormAlert message={login.isError ? authErrorMessage(login.error) : null} />
        <SubmitButton pending={login.isPending} pendingLabel="מתחבר...">התחבר</SubmitButton>
      </form>
      <p className="text-sm text-slate-400 text-center">
        אין לך חשבון?{' '}
        <Link to="/register" state={location.state} className="text-indigo-400 hover:underline">הרשמה</Link>
      </p>
    </AuthCard>
  );
}
