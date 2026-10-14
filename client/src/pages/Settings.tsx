import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2, Unlink, RefreshCw, ShieldCheck, ExternalLink, KeyRound } from 'lucide-react';
import { riseupApi } from '../api';
import { useAuth } from '../auth/AuthContext';
import { FormAlert, PasswordField, SubmitButton } from '../auth/AuthForm';
import { authErrorMessage, looksLikeExpiredToken, riseupErrorMessage, validateNewPassword } from '../lib/errors';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';

export function Settings() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const { data: status, isLoading } = useQuery({ queryKey: ['riseup-status'], queryFn: riseupApi.status });

  const connect = useMutation({
    mutationFn: () => riseupApi.connect(token),
    onSuccess: () => {
      setToken('');
      setError(null);
      qc.invalidateQueries({ queryKey: ['riseup-status'] });
    },
    onError: (e: unknown) => setError(riseupErrorMessage(e, 'החיבור נכשל', 'connect')),
  });

  const disconnect = useMutation({
    mutationFn: riseupApi.disconnect,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['riseup-status'] }),
  });

  const sync = useMutation({
    mutationFn: () => riseupApi.sync(3),
    onSuccess: (r) => {
      setSyncResult(`נמצאו ${r.accountsFound ?? 0} כרטיסים, סונכרנו ${r.transactionsSynced ?? 0} עסקאות (${r.monthsSynced?.length ?? 0} חודשים אחרונים)`);
      setError(null);
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['goals'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['riseup-status'] });
    },
    onError: (e: unknown) => { setError(riseupErrorMessage(e, 'הסנכרון נכשל')); setSyncResult(null); },
  });

  return (
    <div className="space-y-6 max-w-xl">
      <h1 className="text-xl font-bold text-white">הגדרות</h1>

      <div className="bg-slate-800 rounded-2xl p-5 border border-slate-700 space-y-4">
        <div className="flex items-center gap-2">
          <Link2 size={18} className="text-indigo-400" />
          <h2 className="text-lg font-semibold text-white">חיבור ל-RiseUp</h2>
        </div>
        <p className="text-sm text-slate-400">
          נתוני ההוצאות בכרטיסי האשראי נשלפים דרך שרת ה-MCP הרשמי של RiseUp, לפי טוקן גישה אישי (PAT).
          צור טוקן בעמוד{' '}
          <a
            href="https://input.riseup.co.il/developer/tokens"
            target="_blank" rel="noreferrer"
            className="text-indigo-400 hover:underline inline-flex items-center gap-0.5"
          >
            Developer Tokens <ExternalLink size={11} />
          </a>{' '}
          ב-RiseUp. הטוקן ניתן לקריאה בלבד ופג תוקף אחרי 30 יום.
        </p>
        <p className="text-sm text-indigo-300 bg-indigo-900/20 border border-indigo-800 rounded-xl px-3 py-2">
          הטוקן שייך <strong>למשתמש המחובר בלבד</strong>
          {user ? <> (<span dir="ltr">{user.email}</span>)</> : null}
          {' '}— משתמשים אחרים באפליקציה לא רואים אותו ולא את הנתונים שלך.
        </p>

        {isLoading ? (
          <div className="text-sm text-slate-400">טוען...</div>
        ) : status?.connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 bg-green-900/30 border border-green-700 rounded-xl px-4 py-3">
              <ShieldCheck size={16} className="text-green-400" />
              <div className="text-sm text-green-300">
                מחובר · <span dir="ltr" className="font-mono">{status.tokenPreview}</span>
              </div>
            </div>
            {status.lastSyncedAt && (
              <p className="text-xs text-slate-500">
                סונכרן לאחרונה {formatDistanceToNow(new Date(status.lastSyncedAt * 1000), { addSuffix: true, locale: he })}
              </p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => sync.mutate()}
                disabled={sync.isPending}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
              >
                <RefreshCw size={14} className={sync.isPending ? 'animate-spin' : ''} />
                סנכרן עכשיו
              </button>
              <button
                onClick={() => { if (confirm('להתנתק מ-RiseUp?')) disconnect.mutate(); }}
                className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
              >
                <Unlink size={14} /> התנתק
              </button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={e => { e.preventDefault(); connect.mutate(); }}
            className="space-y-3"
          >
            <PasswordField
              id="riseup-token"
              label="טוקן גישה אישי (PAT)"
              autoComplete="off"
              value={token}
              onChange={setToken}
              placeholder="riseup_pat_..."
              required
              aria-required="true"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <button
              type="submit"
              disabled={connect.isPending}
              className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
            >
              <Link2 size={14} />
              {connect.isPending ? 'מתחבר...' : 'התחבר'}
            </button>
          </form>
        )}

        {error && (
          <div className="rounded-xl px-4 py-3 text-sm bg-red-900/50 text-red-400 border border-red-700">
            {error}
          </div>
        )}
        {error && looksLikeExpiredToken(error) && (
          <div className="rounded-xl px-4 py-3 text-sm bg-amber-900/30 text-amber-300 border border-amber-700">
            ייתכן שהטוקן פג תוקף (טוקן RiseUp תקף ל-30 יום בלבד). צרו טוקן חדש ב-Developer Tokens, התנתקו מ-RiseUp והתחברו מחדש עם הטוקן החדש.
          </div>
        )}
        {syncResult && (
          <div className="rounded-xl px-4 py-3 text-sm bg-green-900/30 text-green-300 border border-green-700">
            {syncResult}
          </div>
        )}
      </div>

      <PasswordSection />

      <div className="bg-slate-800/50 rounded-2xl p-5 border border-slate-700 text-sm text-slate-400 space-y-1">
        <p>הטוקן נשמר בשרת בלבד (מוצפן, ומשויך לחשבון שלך) ואינו נשלח לשום גורם מלבד RiseUp.</p>
        <p>סנכרון שולף את שלושת החודשים האחרונים ומזהה אוטומטית את כרטיסי האשראי המחוברים לחשבון ה-RiseUp שלך.</p>
      </div>
    </div>
  );
}

function PasswordSection() {
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ next?: string; confirm?: string; current?: string }>({});
  const [done, setDone] = useState(false);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (changePassword.isPending) return;
    setDone(false);
    const v = {
      current: current ? undefined : 'יש להזין את הסיסמה הנוכחית',
      next: validateNewPassword(next) ?? undefined,
      confirm: confirm !== next ? 'הסיסמאות אינן תואמות' : undefined,
    };
    setErrors(v);
    if (v.current || v.next || v.confirm) return;
    changePassword.mutate({ currentPassword: current, newPassword: next }, {
      onSuccess: () => { setDone(true); setCurrent(''); setNext(''); setConfirm(''); },
    });
  };

  return (
    <div id="password" className="bg-slate-800 rounded-2xl p-5 border border-slate-700 space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound size={18} className="text-indigo-400" aria-hidden="true" />
        <h2 className="text-lg font-semibold text-white">החלפת סיסמה</h2>
      </div>
      <form onSubmit={onSubmit} noValidate className="space-y-3">
        <PasswordField id="cp-current" label="סיסמה נוכחית" autoComplete="current-password"
          value={current} onChange={setCurrent} error={errors.current} />
        <PasswordField id="cp-new" label="סיסמה חדשה (10–128 תווים)" autoComplete="new-password"
          value={next} onChange={setNext} error={errors.next} />
        <PasswordField id="cp-confirm" label="אימות סיסמה חדשה" autoComplete="new-password"
          value={confirm} onChange={setConfirm} error={errors.confirm} />
        <FormAlert message={changePassword.isError ? authErrorMessage(changePassword.error) : null} />
        <FormAlert tone="success" message={done ? 'הסיסמה הוחלפה. כל החיבורים האחרים שלך (מכשירים ודפדפנים אחרים) נותקו; החיבור הנוכחי נשאר פעיל.' : null} />
        <SubmitButton pending={changePassword.isPending} pendingLabel="מחליף...">החלף סיסמה</SubmitButton>
      </form>
    </div>
  );
}
