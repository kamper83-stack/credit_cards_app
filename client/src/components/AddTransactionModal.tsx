import { useState } from 'react';
import { X } from 'lucide-react';
import type { Card } from '../types';

interface Props {
  cards: Card[];
  preselectedCardId?: string;
  onClose: () => void;
  onSave: (data: any) => void;
}

export function AddTransactionModal({ cards, preselectedCardId, onClose, onSave }: Props) {
  const today = new Date().toISOString().split('T')[0];
  const [cardId, setCardId] = useState(preselectedCardId || (cards[0]?.id ?? ''));
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({ card_id: cardId, amount: parseFloat(amount), date, description, category: category || undefined });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="bg-slate-800 rounded-2xl w-full max-w-md border border-slate-700 shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <h2 className="text-lg font-semibold">הוסף עסקה ידנית</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm text-slate-300 mb-1">כרטיס</label>
            <select required value={cardId} onChange={e => setCardId(e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:border-indigo-500 focus:outline-none">
              {cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">סכום (₪)</label>
            <input required type="number" min="0.01" step="0.01"
              value={amount} onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">תאריך</label>
            <input required type="date" value={date} onChange={e => setDate(e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:border-indigo-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">תיאור</label>
            <input required value={description} onChange={e => setDescription(e.target.value)}
              placeholder="שם בית העסק / תיאור"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm text-slate-300 mb-1">קטגוריה (אופציונלי)</label>
            <input value={category} onChange={e => setCategory(e.target.value)}
              placeholder="מסעדות, קניות, דלק..."
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="submit"
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg transition-colors">
              הוסף עסקה
            </button>
            <button type="button" onClick={onClose}
              className="flex-1 bg-slate-700 hover:bg-slate-600 text-white font-medium py-2 rounded-lg transition-colors">
              ביטול
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
