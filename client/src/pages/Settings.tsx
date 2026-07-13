import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2, Unlink, RefreshCw, ShieldCheck, ExternalLink } from 'lucide-react';
import { riseupApi } from '../api';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';

export function Settings() {
  const qc = useQueryClient();
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
    onError: (e: any) => setError(e.response?.data?.error || 'החיבור נכשל'),
  });

  const disconnect = useMutation({
    mutationFn: riseupApi.disconnect,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['riseup-status'] }),
  });

  const sync = useMutation({
    mutationFn: () => riseupApi.sync(3),
    onSuccess: (r) => {
      setSyncResult(`נמצאו ${r.accountsFound} כרטיסים, סונכרנו ${r.transactionsSynced} עסקאות (${r.monthsSynced.length} חודשים אחרונים)`);
      setError(null);
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['goals'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['riseup-status'] });
    },
    onError: (e: any) => { setError(e.response?.data?.error || 'הסנכרון נכשל'); setSyncResult(null); },
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
            <input
              required
              dir="ltr"
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="riseup_pat_..."
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none font-mono text-sm"
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
        {syncResult && (
          <div className="rounded-xl px-4 py-3 text-sm bg-green-900/30 text-green-300 border border-green-700">
            {syncResult}
          </div>
        )}
      </div>

      <div className="bg-slate-800/50 rounded-2xl p-5 border border-slate-700 text-sm text-slate-400 space-y-1">
        <p>הטוקן נשמר מקומית בלבד ב-SQLite ואינו עוזב את המחשב שלך.</p>
        <p>סנכרון שולף את שלושת החודשים האחרונים ומזהה אוטומטית את כרטיסי האשראי המחוברים לחשבון ה-RiseUp שלך.</p>
      </div>
    </div>
  );
}
