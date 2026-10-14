import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { AuthCard, FormAlert, PasswordField, SubmitButton, TextField } from '../auth/AuthForm';
import { authErrorMessage, validateEmail, validateNewPassword } from '../lib/errors';
import { safeRedirectPath } from '../lib/safeRedirect';

export function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; confirm?: string }>({});

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (register.isPending) return;
    const next = {
      email: validateEmail(email) ?? undefined,
      password: validateNewPassword(password, email) ?? undefined,
      confirm: confirm !== password ? 'הסיסמאות אינן תואמות' : undefined,
    };
    setErrors(next);
    if (next.email || next.password || next.confirm) return;
    register.mutate({ email: email.trim(), password }, {
      onSuccess: () => navigate(safeRedirectPath((location.state as { from?: unknown } | null)?.from), { replace: true }),
    });
  };

  return (
    <AuthCard title="יצירת חשבון">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField id="email" label="אימייל" type="email" autoComplete="username" inputMode="email"
          value={email} onChange={setEmail} error={errors.email} />
        <PasswordField id="password" label="סיסמה (10–128 תווים)" autoComplete="new-password"
          value={password} onChange={setPassword} error={errors.password} />
        <PasswordField id="confirm" label="אימות סיסמה" autoComplete="new-password"
          value={confirm} onChange={setConfirm} error={errors.confirm} />
        <FormAlert message={register.isError ? authErrorMessage(register.error) : null} />
        <SubmitButton pending={register.isPending} pendingLabel="יוצר חשבון...">הרשמה</SubmitButton>
      </form>
      <p className="text-sm text-slate-400 text-center">
        כבר יש לך חשבון?{' '}
        <Link to="/login" state={location.state} className="text-indigo-400 hover:underline">התחברות</Link>
      </p>
    </AuthCard>
  );
}
