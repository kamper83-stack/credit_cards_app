import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { cardsApi, transactionsApi } from '../api';
import { AddTransactionModal } from '../components/AddTransactionModal';
import type { Transaction } from '../types';
import { format } from 'date-fns';
import { he } from 'date-fns/locale';

function fmt(n: number) {
  return n.toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2 });
}

export function Transactions() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const filterCard = searchParams.get('card_id') || '';

  const setFilterCard = (cardId: string) => {
    if (cardId) setSearchParams({ card_id: cardId });
    else setSearchParams({});
  };

  const { data: cards = [] } = useQuery({ queryKey: ['cards'], queryFn: cardsApi.list });
  const filteredCardName = cards.find((c: any) => c.id === filterCard)?.name;
  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['transactions', filterCard],
    queryFn: () => transactionsApi.list({ card_id: filterCard || undefined, limit: 200 }),
  });

  const addTx = useMutation({
    mutationFn: transactionsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['goals'] });
      setShowAdd(false);
    },
  });

  const deleteTx = useMutation({
    mutationFn: transactionsApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-white">עסקאות</h1>
          {filterCard && filteredCardName && (
            <span className="flex items-center gap-1.5 bg-indigo-900/50 border border-indigo-700 text-indigo-300 text-xs px-2.5 py-1 rounded-full">
              {filteredCardName}
              <button onClick={() => setFilterCard('')} className="hover:text-white transition-colors">
                <X size={12} />
              </button>
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <select
            value={filterCard} onChange={e => setFilterCard(e.target.value)}
            className="bg-slate-800 border border-slate-600 rounded-xl px-3 py-2 text-white text-sm focus:border-indigo-500 focus:outline-none"
          >
            <option value="">כל הכרטיסים</option>
            {cards.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            <Plus size={16} /> הוסף ידנית
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-slate-400">טוען...</div>
      ) : transactions.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <p>אין עסקאות עדיין</p>
          <p className="text-sm mt-1">סנכרן כרטיס אשראי או הוסף עסקה ידנית</p>
        </div>
      ) : (
        <div className="bg-slate-800 rounded-2xl border border-slate-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700">
                  <th className="text-right px-4 py-3 text-xs text-slate-400 font-medium">תאריך</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-400 font-medium">תיאור</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-400 font-medium">כרטיס</th>
                  <th className="text-right px-4 py-3 text-xs text-slate-400 font-medium">קטגוריה</th>
                  <th className="text-left px-4 py-3 text-xs text-slate-400 font-medium">סכום</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t: Transaction) => (
                  <tr key={t.id} className="border-b border-slate-700/50 hover:bg-slate-700/30 transition-colors">
                    <td className="px-4 py-3 text-sm text-slate-300 whitespace-nowrap">
                      {format(new Date(t.date), 'dd/MM/yyyy')}
                    </td>
                    <td className="px-4 py-3 text-sm text-white max-w-[200px] truncate">{t.description}</td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 text-xs text-slate-300">
                        <span className="w-2 h-2 rounded-full" style={{ background: t.card_color }} />
                        {t.card_name}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">{t.category || '-'}</td>
                    <td className="px-4 py-3 text-sm font-medium text-white text-left whitespace-nowrap">
                      {fmt(t.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => deleteTx.mutate(t.id)}
                        className="text-slate-600 hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showAdd && (
        <AddTransactionModal
          cards={cards}
          onClose={() => setShowAdd(false)}
          onSave={data => addTx.mutate(data)}
        />
      )}
    </div>
  );
}
