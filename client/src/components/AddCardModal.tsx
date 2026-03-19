import { useState } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cardsApi } from '../api';
import type { Provider } from '../types';

const COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#8b5cf6', '#06b6d4'];

interface Props {
  onClose: () => void;
  onSave: (data: any) => void;
}

export function AddCardModal({ onClose, onSave }: Props) {
  const { data: providers = [] } = useQuery({ queryKey: ['providers'], queryFn: cardsApi.providers });
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('');
  const [last4, setLast4] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [showPwd, setShowPwd] = useState(false);

  const selectedProvider: Provider | undefined = providers.find((p: Provider) => p.id === provider);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({ name, provider, last4: last4 || undefined, color, credentials: selectedProvider?.fields.length ? creds : undefined });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div className="bg-slate-800 rounded-2xl w-full max-w-md border border-slate-700 shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <h2 className="text-lg font-semibold">הוסף כרטיס אשראי</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm text-slate-300 mb-1">שם הכרטיס</label>
            <input
              required value={name} onChange={e => setName(e.target.value)}
              placeholder='למשל: "ויזה הפועלים Premium"'
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-300 mb-1">ספק / בנק</label>
            <select
              required value={provider} onChange={e => { setProvider(e.target.value); setCreds({}); }}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="">בחר ספק...</option>
              {providers.map((p: Provider) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
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

          {selectedProvider && selectedProvider.fields.length > 0 && (
            <div className="bg-slate-900 rounded-xl p-4 border border-slate-600 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-300">פרטי התחברות לסנכרון אוטומטי</p>
                <button type="button" onClick={() => setShowPwd(v => !v)} className="text-slate-400">
                  {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="text-xs text-amber-400">הפרטים נשמרים מקומית בלבד על המחשב שלך</p>
              {selectedProvider.fields.map(f => (
                <div key={f.key}>
                  <label className="block text-xs text-slate-400 mb-1">{f.label}</label>
                  <input
                    type={f.type === 'password' && !showPwd ? 'password' : 'text'}
                    value={creds[f.key] || ''}
                    onChange={e => setCreds(prev => ({ ...prev, [f.key]: e.target.value }))}
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:border-indigo-500 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          )}

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
