import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CreditCard, Trophy, AlertCircle, TrendingUp } from 'lucide-react';
import { cardsApi, goalsApi } from '../api';
import { CardTile } from '../components/CardTile';
import { AddCardModal } from '../components/AddCardModal';
import type { Goal } from '../types';

function fmt(n: number) {
  return n.toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
}

interface GoalAlert {
  goalName: string;
  cardName: string;
  progress: number;
  remaining: number;
  rewardDescription?: string;
  rewardValue?: number;
  type: 'completed' | 'milestone' | 'behind';
}

const MILESTONES = [50, 75, 90, 100];

function buildGoalAlerts(goals: Goal[]): GoalAlert[] {
  const alerts: GoalAlert[] = [];
  for (const g of goals) {
    if (!g.active) continue;
    const pct = g.progress;
    if (pct >= 100) {
      alerts.push({ goalName: g.name, cardName: g.card_name, progress: pct, remaining: 0, rewardDescription: g.reward_description, rewardValue: g.reward_value, type: 'completed' });
    } else {
      const crossed = MILESTONES.filter(m => m < 100 && pct >= m).pop();
      if (crossed) {
        alerts.push({ goalName: g.name, cardName: g.card_name, progress: pct, remaining: g.remaining, rewardDescription: g.reward_description, rewardValue: g.reward_value, type: 'milestone' });
      }
      // behind pace
      if (g.days_left !== undefined && g.days_left !== null && g.days_left <= 7 && pct < 70) {
        alerts.push({ goalName: g.name, cardName: g.card_name, progress: pct, remaining: g.remaining, rewardDescription: g.reward_description, type: 'behind' });
      }
    }
  }
  return alerts;
}

export function Cards() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<{ id: string; msg: string; ok: boolean } | null>(null);
  const [goalAlerts, setGoalAlerts] = useState<GoalAlert[]>([]);

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
    setGoalAlerts([]);
    try {
      const { count } = await cardsApi.sync(id);
      setSyncMsg({ id, msg: `סונכרנו ${count} עסקאות`, ok: true });
      await qc.invalidateQueries({ queryKey: ['cards'] });
      await qc.invalidateQueries({ queryKey: ['goals'] });
      // Fetch updated goals for this card and build alerts
      const updatedGoals = await goalsApi.list(id);
      const alerts = buildGoalAlerts(updatedGoals);
      if (alerts.length > 0) setGoalAlerts(alerts);
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

      {goalAlerts.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">עדכוני יעדים לאחר סנכרון</div>
          {goalAlerts.map((alert, i) => (
            <div
              key={i}
              className={`rounded-xl px-4 py-3 text-sm border flex items-start gap-3 ${
                alert.type === 'completed'
                  ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700'
                  : alert.type === 'behind'
                  ? 'bg-red-900/40 text-red-300 border-red-700'
                  : 'bg-amber-900/40 text-amber-300 border-amber-700'
              }`}
            >
              <span className="mt-0.5 shrink-0">
                {alert.type === 'completed' ? <Trophy size={15} /> : alert.type === 'behind' ? <AlertCircle size={15} /> : <TrendingUp size={15} />}
              </span>
              <div>
                <span className="font-semibold">{alert.cardName}</span>
                {' — '}
                <span>{alert.goalName}</span>
                {': '}
                {alert.type === 'completed' && (
                  <>יעד הושג! {alert.rewardDescription && <span className="font-bold">{alert.rewardDescription}{alert.rewardValue ? ` (${fmt(alert.rewardValue)})` : ''}</span>}</>
                )}
                {alert.type === 'milestone' && (
                  <>הגעת ל-<span className="font-bold">{Math.round(alert.progress)}%</span> — נותרו <span className="font-bold">{fmt(alert.remaining)}</span> לסיום</>
                )}
                {alert.type === 'behind' && (
                  <>רק <span className="font-bold">{Math.round(alert.progress)}%</span> מהיעד ונותרו מעט ימים — נדרשים עוד <span className="font-bold">{fmt(alert.remaining)}</span></>
                )}
              </div>
            </div>
          ))}
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
