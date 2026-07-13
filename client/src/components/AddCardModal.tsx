import { useState } from 'react';
import { X } from 'lucide-react';

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#06b6d4'];

interface Props {
  onClose: () => void;
  onSave: (data: any) => void;
}

export function AddCardModal({ onClose, onSave }: Props) {
  const [name, setName] = useState('');
  const [last4, setLast4] = useState('');
  const [color, setColor] = useState(COLORS[0]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({ name, last4: last4 || undefined, color });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="bg-slate-800 rounded-2xl w-full max-w-md border border-slate-700 shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <h2 className="text-lg font-semibold">הוסף כרטיס ידני</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-xs text-slate-400 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2">
            כרטיסים המחוברים ל-RiseUp נוצרים אוטומטית בסנכרון. הוסף כאן כרטיס רק אם ברצונך לעקוב אחריו ידנית.
          </p>
          <div>
            <label className="block text-sm text-slate-300 mb-1">שם הכרטיס</label>
            <input
              required value={name} onChange={e => setName(e.target.value)}
              placeholder='למשל: "ויזה הפועלים Premium"'
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">4 ספרות אחרונות (אופציונלי)</label>
            <input
              value={last4} onChange={e => setLast4(e.target.value.slice(0, 4))}
              maxLength={4} placeholder="1234"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-2">צבע</label>
            <div className="flex gap-2 flex-wrap">
              {COLORS.map(c => (
                <button
                  key={c} type="button"
                  onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full border-2 transition-all ${color === c ? 'border-white scale-110' : 'border-transparent'}`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg transition-colors"
            >
              הוסף כרטיס
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
