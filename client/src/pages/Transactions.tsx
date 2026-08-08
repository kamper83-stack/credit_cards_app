import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X, CalendarDays } from 'lucide-react';
import { cardsApi, transactionsApi } from '../api';
import { AddTransactionModal } from '../components/AddTransactionModal';
import type { Transaction } from '../types';
import { format } from 'date-fns';
import { he } from 'date-fns/locale';

function fmt(n: number) {
  return n.toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2 });
}

/** Build [firstDay, lastDay] of a YYYY-MM month in LOCAL time (no UTC shift). */
function monthRange(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) {
    const now = new Date();
    return [`${now.getFullYear()}-01-01`, `${now.getFullYear()}-12-31`];
  }
  const first = new Date(y, m - 1, 1);
  const last = new Date(y, m, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return [iso(first), iso(last)];
}

/** Last N months as YYYY-MM strings, oldest first (local time). */
function recentMonths(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export function Transactions() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const filterCard = searchParams.get('card_id') || '';
  const monthParam = searchParams.get('month') || '';

  const setFilterCard = (cardId: string) => {
    if (cardId) setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('card_id', cardId);
      return next;
    });
    else setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('card_id');
      return next;
    });
  };

  const setMonth = (month: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (month) next.set('month', month);
      else next.delete('month');
      return next;
    });
  };

  // Default to current month filter (local timezone, avoids UTC off-by-one)
  const today = new Date();
  const defaultMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const month = monthParam || defaultMonth;
  const [from, to] = monthRange(month);

  const { data: cards = [] } = useQuery({ queryKey: ['cards'], queryFn: cardsApi.list });
  const filteredCardName = cards.find((c: any) => c.id === filterCard)?.name;
  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['transactions', filterCard, month],
    queryFn: () => transactionsApi.list({ card_id: filterCard || undefined, from, to, limit: 500 }),
  });

  const totalAmount = transactions.reduce((s: number, t: Transaction) => s + t.amount, 0);

  const addTx = useMutation({
    mutationFn: transactionsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['goals'] });
      setShowAdd(false);
    },
    onError: () => setError('הוספת העסקה נכשלה'),
  });

  const deleteTx = useMutation({
    mutationFn: transactionsApi.delete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
    onError: () => setError('מחיקת העסקה נכשלה'),
  });

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-xl px-4 py-3 text-sm bg-red-900/50 text-red-400 border border-red-700">
          {error}
        </div>
      )}

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
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={filterCard} onChange={e => setFilterCard(e.target.value)}
            className="bg-slate-800 border border-slate-600 rounded-xl px-3 py-2 text-white text-sm focus:border-indigo-500 focus:outline-none"
          >
            <option value="">כל הכרטיסים</option>
            {cards.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select
            value={month} onChange={e => setMonth(e.target.value)}
            className="bg-slate-800 border border-slate-600 rounded-xl px-3 py-2 text-white text-sm focus:border-indigo-500 focus:outline-none"
          >
            {recentMonths(12).map(m => (
              <option key={m} value={m}>
                {format(new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1), 'MMMM yyyy', { locale: he })}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
          >
            <Plus size={16} /> הוסף ידנית
          </button>
        </div>
      </div>

      {/* Month summary */}
      {!isLoading && transactions.length > 0 && (
        <div className="flex items-center gap-2 text-sm bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3">
          <CalendarDays size={15} className="text-slate-400" />
          <span className="text-slate-400">סה"כ בחודש:</span>
          <span className="font-bold text-white">{fmt(totalAmount)}</span>
          <span className="text-slate-500">· {transactions.length} עסקאות</span>
        </div>
      )}

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
