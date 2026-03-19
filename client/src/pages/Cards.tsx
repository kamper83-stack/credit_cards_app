import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CreditCard } from 'lucide-react';
import { cardsApi } from '../api';
import { CardTile } from '../components/CardTile';
import { AddCardModal } from '../components/AddCardModal';

export function Cards() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<{ id: string; msg: string; ok: boolean } | null>(null);

  const { data: cards = [], isLoading } = useQuery({ queryKey: ['cards'], queryFn: cardsApi.list });

  const addCard = useMutation({
    mutationFn: cardsApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cards'] }); setShowAdd(false); },
  });

  const deleteCard = useMutation({
    mutationFn: cardsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cards'] }),
  });

  async function handleSync(id: string) {
    setSyncing(id);
    setSyncMsg(null);
    try {
      const { count } = await cardsApi.sync(id);
      setSyncMsg({ id, msg: `סונכרנו ${count} עסקאות`, ok: true });
      qc.invalidateQueries({ queryKey: ['cards'] });
      qc.invalidateQueries({ queryKey: ['goals'] });
    } catch (e: any) {
      setSyncMsg({ id, msg: e.response?.data?.error || 'שגיאה בסנכרון', ok: false });
    } finally {
      setSyncing(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white">כרטיסי אשראי</h1>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
        >
          <Plus size={16} /> הוסף כרטיס
        </button>
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
          <p className="text-sm mt-1">הוסף כרטיס אשראי כדי להתחיל</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((c: any) => (
            <CardTile
              key={c.id}
              card={c}
              syncing={syncing === c.id}
              onSync={() => handleSync(c.id)}
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
