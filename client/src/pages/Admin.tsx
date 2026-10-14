import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Copy, Link2, Plus, ShieldCheck, Users, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { adminApi } from '../api';
import { useAuth } from '../auth/AuthContext';
import { FormAlert, inputClass } from '../auth/AuthForm';
import { adminErrorMessage } from '../lib/errors';
import type { AdminInvite, AdminUser, CreatedInvite, InviteStatus } from '../types';

const rel = (sec: number | null | undefined) =>
  sec ? formatDistanceToNow(new Date(sec * 1000), { locale: he, addSuffix: true }) : '—';

const STATUS: Record<InviteStatus, { label: string; cls: string }> = {
  active: { label: 'פעילה', cls: 'bg-green-900/40 text-green-300 border-green-700' },
  expired: { label: 'פגה', cls: 'bg-slate-700 text-slate-300 border-slate-600' },
  revoked: { label: 'בוטלה', cls: 'bg-red-900/40 text-red-300 border-red-700' },
  exhausted: { label: 'מוצתה', cls: 'bg-amber-900/40 text-amber-300 border-amber-700' },
};

function Badge({ cls, children }: { cls: string; children: string }) {
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs border ${cls}`}>{children}</span>;
}

const card = 'bg-slate-800 rounded-2xl p-5 border border-slate-700 space-y-4';
const th = 'text-start font-medium px-3 py-2 whitespace-nowrap';
const td = 'px-3 py-2 align-middle';
const dangerBtn = 'px-2.5 py-1 rounded-lg text-xs border border-red-700 text-red-300 hover:bg-red-900/40 disabled:opacity-40 disabled:cursor-not-allowed';
const neutralBtn = 'px-2.5 py-1 rounded-lg text-xs border border-slate-600 text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed';

export function Admin() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-white flex items-center gap-2">
        <ShieldCheck size={20} className="text-indigo-400" aria-hidden="true" /> ניהול
      </h1>
      <InvitesSection />
      <UsersSection />
    </div>
  );
}

function InvitesSection() {
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('7');
  const [uses, setUses] = useState('1');
  const [formError, setFormError] = useState<string | null>(null);
  // The raw token exists only here, in memory, until dismissed or this section unmounts.
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);

  const { data: invites, isLoading, error: listError } = useQuery({ queryKey: ['admin', 'invites'], queryFn: adminApi.invites });

  const create = useMutation({
    mutationFn: adminApi.createInvite,
    onSuccess: (inv) => {
      setCreated(inv);
      setCopied(null);
      setLabel('');
      qc.invalidateQueries({ queryKey: ['admin', 'invites'] });
    },
  });
  const revoke = useMutation({
    mutationFn: adminApi.revokeInvite,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'invites'] }),
  });

  const inRange = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && +v >= min && +v <= max;

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!inRange(days, 1, 90)) { setFormError('תוקף ההזמנה: מספר שלם בין 1 ל-90 ימים'); return; }
    if (!inRange(uses, 1, 100)) { setFormError('מספר השימושים: מספר שלם בין 1 ל-100'); return; }
    setFormError(null);
    const l = label.trim();
    create.mutate({ ...(l ? { label: l } : {}), expiresInDays: +days, maxUses: +uses });
  };

  const link = created ? `${window.location.origin}${created.path}` : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied('ok');
    } catch {
      linkRef.current?.select();
      setCopied('fail');
    }
  };

  const dismiss = () => { setCreated(null); setCopied(null); };

  return (
    <section className={card} aria-labelledby="invites-h">
      <div className="flex items-center gap-2">
        <Link2 size={18} className="text-indigo-400" aria-hidden="true" />
        <h2 id="invites-h" className="text-lg font-semibold text-white">הזמנות</h2>
      </div>

      <form onSubmit={onCreate} noValidate className="grid grid-cols-1 sm:grid-cols-[1fr_10rem_10rem_auto] gap-3 items-end">
        <div className="space-y-1">
          <label htmlFor="inv-label" className="block text-sm text-slate-300">תווית (אופציונלי)</label>
          <input id="inv-label" className={inputClass} maxLength={100} value={label} onChange={e => setLabel(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label htmlFor="inv-days" className="block text-sm text-slate-300">תוקף בימים (1–90)</label>
          <input id="inv-days" dir="ltr" inputMode="numeric" className={inputClass} value={days} onChange={e => setDays(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label htmlFor="inv-uses" className="block text-sm text-slate-300">מספר שימושים (1–100)</label>
          <input id="inv-uses" dir="ltr" inputMode="numeric" className={inputClass} value={uses} onChange={e => setUses(e.target.value)} />
        </div>
        <button type="submit" disabled={create.isPending}
          className="flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium">
          <Plus size={15} aria-hidden="true" /> {create.isPending ? 'יוצר...' : 'יצירת הזמנה'}
        </button>
      </form>
      <FormAlert message={formError ?? (create.isError ? adminErrorMessage(create.error, 'יצירת ההזמנה נכשלה') : null)} />

      {created && (
        <div role="region" aria-label="קישור הזמנה חדש" className="rounded-xl border border-indigo-500 bg-indigo-950/40 p-4 space-y-3">
          <div className="flex items-start gap-2 text-amber-300 text-sm">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>הקישור מוצג פעם אחת בלבד ולא ניתן לשחזר אותו. העתיקו אותו עכשיו ושלחו למוזמן/ת בערוץ מאובטח.</span>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input ref={linkRef} readOnly dir="ltr" aria-label="קישור הזמנה" value={link}
              onFocus={e => e.currentTarget.select()} className={`${inputClass} font-mono`} />
            <button type="button" onClick={copy}
              className="flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-medium shrink-0">
              {copied === 'ok' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />} {copied === 'ok' ? 'הועתק' : 'העתקת קישור'}
            </button>
          </div>
          {copied === 'fail' && <p className="text-xs text-amber-300">ההעתקה האוטומטית נכשלה, הקישור סומן - העתיקו ידנית (Ctrl+C).</p>}
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>תקף {rel(created.expiresAt)}, עד {created.maxUses} שימושים</span>
            <button type="button" onClick={dismiss} className={`${neutralBtn} flex items-center gap-1`}>
              <X size={12} aria-hidden="true" /> סגירה והסתרה
            </button>
          </div>
        </div>
      )}

      <FormAlert message={revoke.isError ? adminErrorMessage(revoke.error, 'ביטול ההזמנה נכשל') : null} />
      {listError ? <FormAlert message={adminErrorMessage(listError, 'טעינת ההזמנות נכשלה')} /> : isLoading ? (
        <p className="text-sm text-slate-400">טוען...</p>
      ) : !invites?.length ? (
        <p className="text-sm text-slate-400">עדיין לא נוצרו הזמנות.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-slate-200">
            <thead className="text-slate-400 border-b border-slate-700">
              <tr><th className={th}>תווית</th><th className={th}>סטטוס</th><th className={th}>שימושים</th><th className={th}>תוקף</th><th className={th}><span className="sr-only">פעולות</span></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {invites.map((i: AdminInvite) => (
                <tr key={i.id}>
                  <td className={td}>{i.label || <span className="text-slate-500">ללא תווית</span>}</td>
                  <td className={td}><Badge cls={STATUS[i.status].cls}>{STATUS[i.status].label}</Badge></td>
                  <td className={td} dir="ltr">{i.usedCount}/{i.maxUses}</td>
                  <td className={td}>{i.status === 'revoked' ? 'בוטלה ' + rel(i.revokedAt) : (i.status === 'expired' ? 'פגה ' : 'תפוג ') + rel(i.expiresAt)}</td>
                  <td className={td}>
                    {i.status === 'active' && (
                      <button type="button" className={dangerBtn} disabled={revoke.isPending}
                        aria-label={`ביטול הזמנה ${i.label ?? ''}`.trim()}
                        onClick={() => { if (window.confirm('לבטל את ההזמנה? הקישור יפסיק לעבוד.')) revoke.mutate(i.id); }}>
                        ביטול
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UsersSection() {
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const { data: users, isLoading, error: listError } = useQuery({ queryKey: ['admin', 'users'], queryFn: adminApi.users });
  const toggle = useMutation({
    mutationFn: (v: { id: string; disabled: boolean }) => adminApi.setUserDisabled(v.id, v.disabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
    // A failed attempt (409 self / last admin) may mean the list is stale; refresh it too.
    onError: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  const enabledAdmins = (users ?? []).filter(u => u.isAdmin && !u.disabled).length;

  const onToggle = (u: AdminUser) => {
    const msg = u.disabled
      ? `להפעיל מחדש את ${u.email}?`
      : `להשבית את ${u.email}? כל ההתחברויות שלו/ה יתבטלו מיד והוא/היא לא יוכלו להתחבר. הנתונים נשמרים ואפשר להפעיל מחדש בכל עת.`;
    if (window.confirm(msg)) toggle.mutate({ id: u.id, disabled: !u.disabled });
  };

  return (
    <section className={card} aria-labelledby="users-h">
      <div className="flex items-center gap-2">
        <Users size={18} className="text-indigo-400" aria-hidden="true" />
        <h2 id="users-h" className="text-lg font-semibold text-white">משתמשים</h2>
      </div>
      <FormAlert message={toggle.isError ? adminErrorMessage(toggle.error, 'הפעולה נכשלה') : null} />
      {listError ? <FormAlert message={adminErrorMessage(listError, 'טעינת המשתמשים נכשלה')} /> : isLoading ? (
        <p className="text-sm text-slate-400">טוען...</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-slate-200">
            <thead className="text-slate-400 border-b border-slate-700">
              <tr>
                <th className={th}>אימייל</th><th className={th}>תפקיד</th><th className={th}>סטטוס</th><th className={th}>כרטיסים</th>
                <th className={th}>נוצר</th><th className={th}>נראה לאחרונה</th><th className={th}>הזמנה</th><th className={th}><span className="sr-only">פעולות</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {(users ?? []).map(u => {
                const isSelf = u.id === me?.id;
                const lastAdmin = u.isAdmin && !u.disabled && enabledAdmins <= 1;
                const blocked = !u.disabled && (isSelf || lastAdmin);
                return (
                  <tr key={u.id}>
                    <td className={td} dir="ltr">{u.email}{isSelf && <span className="text-slate-500"> (אתם)</span>}</td>
                    <td className={td}><Badge cls={u.isAdmin ? 'bg-indigo-900/40 text-indigo-300 border-indigo-700' : 'bg-slate-700 text-slate-300 border-slate-600'}>{u.isAdmin ? 'מנהל' : 'משתמש'}</Badge></td>
                    <td className={td}><Badge cls={u.disabled ? 'bg-red-900/40 text-red-300 border-red-700' : STATUS.active.cls}>{u.disabled ? 'מושבת' : 'פעיל'}</Badge></td>
                    <td className={td}>{u.cardCount}</td>
                    <td className={td}>{rel(u.createdAt)}</td>
                    <td className={td}>{rel(u.lastSeen)}</td>
                    <td className={td}>{u.inviteLabel || '—'}</td>
                    <td className={td}>
                      <button type="button" disabled={blocked || toggle.isPending}
                        title={blocked ? (isSelf ? 'לא ניתן להשבית את עצמכם' : 'לא ניתן להשבית את המנהל האחרון') : undefined}
                        className={u.disabled ? neutralBtn : dangerBtn}
                        aria-label={`${u.disabled ? 'הפעלת' : 'השבתת'} ${u.email}`}
                        onClick={() => onToggle(u)}>
                        {u.disabled ? 'הפעלה' : 'השבתה'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
