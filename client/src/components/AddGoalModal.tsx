import { useState } from 'react';
import { X } from 'lucide-react';
import type { Card } from '../types';

interface Props {
  cards: Card[];
  preselectedCardId?: string;
  onClose: () => void;
  onSave: (data: any) => void;
}

export function AddGoalModal({ cards, preselectedCardId, onClose, onSave }: Props) {
  const [cardId, setCardId] = useState(preselectedCardId || (cards[0]?.id ?? ''));
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState('');
  const [periodType, setPeriodType] = useState<'monthly' | 'quarterly' | 'yearly' | 'custom'>('monthly');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [rewardDesc, setRewardDesc] = useState('');
  const [rewardValue, setRewardValue] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      card_id: cardId,
      name,
      description: description || undefined,
      target_amount: parseFloat(target),
      period_type: periodType,
      period_start: periodType === 'custom' ? periodStart : undefined,
      period_end: periodType === 'custom' ? periodEnd : undefined,
      reward_description: rewardDesc || undefined,
      reward_value: rewardValue ? parseFloat(rewardValue) : undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="bg-slate-800 rounded-2xl w-full max-w-md border border-slate-700 shadow-2xl my-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <h2 className="text-lg font-semibold">הוסף יעד הטבה</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm text-slate-300 mb-1">כרטיס אשראי</label>
            <select
              required value={cardId} onChange={e => setCardId(e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:border-indigo-500 focus:outline-none"
            >
              {cards.map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` (****${c.last4})` : ''}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">שם היעד</label>
            <input
              required value={name} onChange={e => setName(e.target.value)}
              placeholder='למשל: "הוצא 3000₪ וקבל 150₪ קאשבק"'
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">תיאור (אופציונלי)</label>
            <input
              value={description} onChange={e => setDescription(e.target.value)}
              placeholder="פרטים נוספים על ההטבה"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">סכום יעד (₪)</label>
            <input
              required type="number" min="1" step="any"
              value={target} onChange={e => setTarget(e.target.value)}
              placeholder="3000"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">תקופה</label>
            <div className="grid grid-cols-4 gap-1">
              {(['monthly', 'quarterly', 'yearly', 'custom'] as const).map(p => (
                <button
                  key={p} type="button"
                  onClick={() => setPeriodType(p)}
                  className={`py-2 text-xs rounded-lg font-medium transition-colors ${periodType === p ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
                >
                  {{ monthly: 'חודשי', quarterly: 'רבעוני', yearly: 'שנתי', custom: 'מותאם' }[p]}
                </button>
              ))}
            </div>
          </div>

          {periodType === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">מתאריך</label>
                <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} required
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:border-indigo-500 focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">עד תאריך</label>
                <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} required
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:border-indigo-500 focus:outline-none" />
              </div>
            </div>
          )}

          <div className="bg-slate-900 rounded-xl p-4 border border-slate-700 space-y-3">
            <p className="text-sm font-medium text-slate-300">פרטי ההטבה (אופציונלי)</p>
            <div>
              <label className="block text-xs text-slate-400 mb-1">תיאור ההטבה</label>
              <input
                value={rewardDesc} onChange={e => setRewardDesc(e.target.value)}
                placeholder='למשל: "150₪ קאשבק" / "נקודות כפולות"'
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">שווי ההטבה (₪)</label>
              <input
                type="number" min="0" step="any"
                value={rewardValue} onChange={e => setRewardValue(e.target.value)}
                placeholder="150"
                className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button type="submit"
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg transition-colors">
              הוסף יעד
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
