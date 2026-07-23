import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CreditCard, RefreshCw, Link2 } from 'lucide-react';
import { cardsApi, riseupApi } from '../api';
import { CardTile } from '../components/CardTile';
import { AddCardModal } from '../components/AddCardModal';

export function Cards() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showAdd, setShowAdd] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ msg: string; ok: boolean } | null>(null);

  const { data: cards = [], isLoading } = useQuery({ queryKey: ['cards'], queryFn: cardsApi.list });
  const { data: riseupStatus } = useQuery({ queryKey: ['riseup-status'], queryFn: riseupApi.status });

  const addCard = useMutation({
    mutationFn: cardsApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cards'] }); setShowAdd(false); },
  });

  const deleteCard = useMutation({
    mutationFn: cardsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cards'] }),
  });

  const sync = useMutation({
    mutationFn: () => riseupApi.sync(3),
    onSuccess: (r) => {
      setSyncMsg({ msg: `נמצאו ${r.accountsFound} כרטיסים, סונכרנו ${r.transactionsSynced} עסקאות`, ok: true });
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['goals'] });
      qc.invalidateQueries({ queryKey: ['transactions'] });
    },
    onError: (e: any) => setSyncMsg({ msg: e.response?.data?.error || 'שגיאה בסנכרון', ok: false }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-bold text-white">כרטיסי אשראי</h1>
        <div className="flex items-center gap-3">
          {riseupStatus?.connected ? (
            <button
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
              className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
            >
              <RefreshCw size={16} className={sync.isPending ? 'animate-spin' : ''} /> סנכרן מ-RiseUp
            </button>
          ) : (
            <Link
              to="/settings"
              className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
            >
              <Link2 size={16} /> התחבר ל-RiseUp
            </Link>
          )}
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            <Plus size={16} /> הוסף כרטיס ידני
          </button>
        </div>
      </div>

      {syncMsg && (
        <div className={`rounded-xl px-4 py-3 text-sm ${syncMsg.ok ? 'bg-green-900/50 text-green-400 border border-green-700' : 'bg-red-900/50 text-red-400 border border-red-700'}`}>
          {syncMsg.msg}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-12 text-slate-400">טוען...</div>
      ) : cards.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <CreditCard size={48} className="mx-auto mb-4 opacity-30" />
          <p className="text-lg">אין כרטיסים עדיין</p>
          <p className="text-sm mt-1">התחבר ל-RiseUp כדי לסנכרן כרטיסים אוטומטית, או הוסף כרטיס ידני</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((c: any) => (
            <CardTile
              key={c.id}
              card={c}
              onClick={() => navigate(`/transactions?card_id=${c.id}`)}
              onDelete={() => { if (confirm(`למחוק את ${c.name}?`)) deleteCard.mutate(c.id); }}
              onEdit={() => { /* TODO: edit modal */ }}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <AddCardModal
          onClose={() => setShowAdd(false)}
          onSave={data => addCard.mutate(data)}
        />
      )}
    </div>
  );
}
