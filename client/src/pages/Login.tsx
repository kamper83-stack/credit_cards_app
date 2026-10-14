import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { AuthCard, FormAlert, PasswordField, SubmitButton, TextField } from '../auth/AuthForm';
import { authErrorMessage, validateEmail } from '../lib/errors';
import { safeRedirectPath } from '../lib/safeRedirect';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (login.isPending) return;
    const next = { email: validateEmail(email) ?? undefined, password: password ? undefined : 'יש להזין סיסמה' };
    setErrors(next);
    if (next.email || next.password) return;
    login.mutate({ email: email.trim(), password }, {
      onSuccess: () => navigate(safeRedirectPath((location.state as { from?: unknown } | null)?.from), { replace: true }),
    });
  };

  return (
    <AuthCard title="התחברות">
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
