import { CreditCard, RefreshCw, Trash2, Settings } from 'lucide-react';
import type { Card } from '../types';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';

interface Props {
  card: Card;
  onSync: () => void;
  onDelete: () => void;
  onEdit: () => void;
  syncing?: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  max: 'מקס', cal: 'ויזה כאל', isracard: 'ישראכרט',
  amex: 'אמריקן אקספרס', hapoalim: 'הפועלים', leumi: 'לאומי',
  mizrahi: 'מזרחי', discount: 'דיסקונט', behatsdaa: 'בהצדעה',
  beyahad: 'ביחד', manual: 'ידני',
};

export function CardTile({ card, onSync, onDelete, onEdit, syncing }: Props) {
  return (
    <div
      className="relative rounded-2xl p-5 overflow-hidden border border-slate-700 hover:border-slate-500 transition-all cursor-pointer group"
      style={{ background: `linear-gradient(135deg, ${card.color}22, ${card.color}08)` }}
    >
      {/* Glow */}
      <div
        className="absolute inset-0 opacity-20 pointer-events-none"
        style={{ background: `radial-gradient(circle at top right, ${card.color}, transparent 70%)` }}
      />

      <div className="flex items-start justify-between relative">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${card.color}33` }}>
            <CreditCard size={20} style={{ color: card.color }} />
          </div>
          <div>
            <h3 className="font-semibold text-white">{card.name}</h3>
            <p className="text-xs text-slate-400">
              {PROVIDER_LABELS[card.provider] || card.provider}
              {card.last4 && <span className="mr-1 opacity-70">****{card.last4}</span>}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {card.provider !== 'manual' && (
            <button
              onClick={e => { e.stopPropagation(); onSync(); }}
              disabled={syncing}
              className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-all"
              title="סנכרן נתונים"
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); onEdit(); }}
            className="p-1.5 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-all"
          >
            <Settings size={14} />
          </button>
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            className="p-1.5 rounded-lg hover:bg-red-900/50 text-slate-400 hover:text-red-400 transition-all"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="flex gap-4 mt-4 relative">
        <div>
          <div className="text-2xl font-bold" style={{ color: card.color }}>{card.goals_count}</div>
          <div className="text-xs text-slate-400">יעדים פעילים</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-white">{card.tx_count}</div>
          <div className="text-xs text-slate-400">עסקאות</div>
        </div>
      </div>

      {card.last_synced && (
        <p className="text-xs text-slate-500 mt-2 relative">
          סונכרן {formatDistanceToNow(new Date(card.last_synced * 1000), { addSuffix: true, locale: he })}
        </p>
      )}
    </div>
  );
}
