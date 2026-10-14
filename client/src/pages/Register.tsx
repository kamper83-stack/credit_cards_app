import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { AuthCard, FormAlert, PasswordField, SubmitButton, TextField } from '../auth/AuthForm';
import { INVALID_INVITE_MESSAGE, parseInvite, serverMessage, statusOf, registerErrorMessage, validateEmail, validateNewPassword } from '../lib/errors';
import { safeRedirectPath } from '../lib/safeRedirect';

export function Register() {
  const { register } = useAuth();
  const submitting = useRef(false);
  const navigate = useNavigate();
  const location = useLocation();
  // The invite lives in component memory only (never storage). It is read once from ?invite= and the
  // query string is removed from the address bar/history right away so the secret does not linger.
  const [invite, setInvite] = useState(() => parseInvite(new URLSearchParams(location.search).get('invite') ?? ''));
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  useEffect(() => {
    if (new URLSearchParams(location.search).has('invite')) {
      navigate({ pathname: location.pathname, search: '', hash: '' }, { replace: true, state: location.state });
    }
  }, [location.search, location.pathname, location.state, navigate]);

  const onUseInvite = (e: FormEvent) => {
    e.preventDefault();
    const token = parseInvite(pasted);
    if (!token) { setPasteError('לא נמצאה הזמנה תקינה בטקסט שהוזן'); return; }
    setPasteError(null);
    setInvite(token);
    setPasted('');
  };

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string; confirm?: string }>({});

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (submitting.current || register.isPending) return;
    const next = {
      email: validateEmail(email) ?? undefined,
      password: validateNewPassword(password, email) ?? undefined,
      confirm: confirm !== password ? 'הסיסמאות אינן תואמות' : undefined,
    };
    setErrors(next);
    if (next.email || next.password || next.confirm) return;
    submitting.current = true;
    register.mutate({ email: email.trim(), password, invite }, {
      onSettled: () => { submitting.current = false; },
      onSuccess: () => navigate(safeRedirectPath((location.state as { from?: unknown } | null)?.from), { replace: true }),
    });
  };

  if (!invite) {
    return (
      <AuthCard title="יצירת חשבון">
        <p className="text-sm text-slate-300">ההרשמה אפשרית בהזמנה בלבד.</p>
        <p className="text-sm text-slate-400">יש לפתוח את קישור ההזמנה שקיבלתם ממנהל המערכת, או להדביק אותו (או את קוד ההזמנה) כאן:</p>
        <form onSubmit={onUseInvite} noValidate className="space-y-4">
          <TextField id="invite" label="קישור או קוד הזמנה" autoComplete="off" spellCheck={false}
            value={pasted} onChange={setPasted} error={pasteError} />
          <button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors">המשך</button>
        </form>
        <p className="text-sm text-slate-400 text-center">
          כבר יש לך חשבון?{' '}
          <Link to="/login" className="text-indigo-400 hover:underline">התחברות</Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="יצירת חשבון">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <TextField id="email" label="אימייל" type="email" autoComplete="username" inputMode="email"
          value={email} onChange={setEmail} error={errors.email} />
        <PasswordField id="password" label="סיסמה (10–128 תווים)" autoComplete="new-password"
          value={password} onChange={setPassword} error={errors.password} />
        <PasswordField id="confirm" label="אימות סיסמה" autoComplete="new-password"
          value={confirm} onChange={setConfirm} error={errors.confirm} />
        <FormAlert message={register.isError ? registerErrorMessage(register.error) : null} />
        {register.isError && statusOf(register.error) === 400 && serverMessage(register.error) === INVALID_INVITE_MESSAGE && (
          <button type="button" onClick={() => { setInvite(''); register.reset(); }} className="text-sm text-indigo-400 hover:underline">
            הזנת הזמנה אחרת
          </button>
        )}
        <SubmitButton pending={register.isPending} pendingLabel="יוצר חשבון...">הרשמה</SubmitButton>
      </form>
      <p className="text-sm text-slate-400 text-center">
        כבר יש לך חשבון?{' '}
        <Link to="/login" state={location.state} className="text-indigo-400 hover:underline">התחברות</Link>
      </p>
    </AuthCard>
  );
}
