import { useState } from 'react';
import { X } from 'lucide-react';
import type { Card } from '../types';

interface Props {
  card: Card;
  onClose: () => void;
  onSave: (name: string) => void;
}

export function RenameCardModal({ card, onClose, onSave }: Props) {
  const [name, setName] = useState(card.name);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim()) onSave(name.trim());
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="bg-slate-800 rounded-2xl w-full max-w-md border border-slate-700 shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <h2 className="text-lg font-semibold">שינוי שם כרטיס</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm text-slate-300 mb-1">שם הכרטיס</label>
            <input
              required autoFocus value={name} onChange={e => setName(e.target.value)}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-lg transition-colors"
            >
              שמור
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
