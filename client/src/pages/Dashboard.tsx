import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, TrendingUp, Trophy, AlertCircle } from 'lucide-react';
import { cardsApi, goalsApi } from '../api';
import { GoalCard } from '../components/GoalCard';
import { AddGoalModal } from '../components/AddGoalModal';
import type { Goal } from '../types';

function fmt(n: number) {
  return n.toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
}

export function Dashboard() {
  const qc = useQueryClient();
  const [showAddGoal, setShowAddGoal] = useState(false);

  const { data: cards = [] } = useQuery({ queryKey: ['cards'], queryFn: cardsApi.list });
  const { data: goals = [], isLoading } = useQuery({ queryKey: ['goals'], queryFn: () => goalsApi.list() });

  const deleteGoal = useMutation({
    mutationFn: goalsApi.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['goals'] }),
  });

  const addGoal = useMutation({
    mutationFn: goalsApi.create,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['goals'] }); setShowAddGoal(false); },
  });

  const activeGoals = goals.filter((g: Goal) => g.active);
  const completed = activeGoals.filter((g: Goal) => g.progress >= 100);
  const urgent = activeGoals.filter((g: Goal) => g.progress < 100 && (g.days_left ?? 999) <= 7);
  const total_spent = activeGoals.reduce((s: number, g: Goal) => s + g.spent, 0);
  const total_target = activeGoals.reduce((s: number, g: Goal) => s + g.target_amount, 0);
  const total_rewards = completed.reduce((s: number, g: Goal) => s + (g.reward_value || 0), 0);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700">
          <div className="text-slate-400 text-sm mb-1">סה"כ הוצאות (יעדים פעילים)</div>
          <div className="text-2xl font-bold text-white">{fmt(total_spent)}</div>
          <div className="text-xs text-slate-500 mt-1">מתוך {fmt(total_target)}</div>
        </div>
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700">
          <div className="text-slate-400 text-sm mb-1 flex items-center gap-1"><Trophy size={14} /> יעדים שהושגו</div>
          <div className="text-2xl font-bold text-green-400">{completed.length}</div>
          <div className="text-xs text-slate-500 mt-1">מתוך {activeGoals.length} יעדים</div>
        </div>
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700">
          <div className="text-slate-400 text-sm mb-1 flex items-center gap-1"><TrendingUp size={14} /> הטבות שנצברו</div>
          <div className="text-2xl font-bold text-amber-400">{fmt(total_rewards)}</div>
          <div className="text-xs text-slate-500 mt-1">השנה</div>
        </div>
        <div className="bg-slate-800 rounded-2xl p-4 border border-slate-700">
          <div className="text-slate-400 text-sm mb-1 flex items-center gap-1"><AlertCircle size={14} /> דורשים תשומת לב</div>
          <div className="text-2xl font-bold text-red-400">{urgent.length}</div>
          <div className="text-xs text-slate-500 mt-1">פחות מ-7 ימים</div>
        </div>
      </div>

      {/* Urgent goals */}
      {urgent.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-red-400 uppercase tracking-wider mb-3 flex items-center gap-2">
            <AlertCircle size={14} /> דחוף - פחות מ-7 ימים
          </h2>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {urgent.map((g: Goal) => (
              <GoalCard key={g.id} goal={g} onDelete={() => deleteGoal.mutate(g.id)} />
            ))}
          </div>
        </div>
      )}

      {/* All active goals */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">כל היעדים הפעילים</h2>
        <button
          onClick={() => setShowAddGoal(true)}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors"
        >
          <Plus size={16} /> יעד חדש
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-slate-400">טוען...</div>
      ) : activeGoals.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <Trophy size={48} className="mx-auto mb-4 opacity-30" />
          <p className="text-lg">אין יעדים עדיין</p>
          <p className="text-sm mt-1">הוסף כרטיסי אשראי ויעדים כדי להתחיל לעקוב</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {activeGoals.map((g: Goal) => (
            <GoalCard key={g.id} goal={g} onDelete={() => deleteGoal.mutate(g.id)} />
          ))}
        </div>
      )}

      {showAddGoal && cards.length > 0 && (
        <AddGoalModal
          cards={cards}
          onClose={() => setShowAddGoal(false)}
          onSave={data => addGoal.mutate(data)}
        />
      )}

      {showAddGoal && cards.length === 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.7)' }}>
          <div className="bg-slate-800 rounded-2xl p-8 text-center border border-slate-700 max-w-sm">
            <p className="text-white mb-4">הוסף קודם כרטיס אשראי לפני שיוצרים יעד</p>
            <button onClick={() => setShowAddGoal(false)} className="bg-indigo-600 hover:bg-indigo-700 px-6 py-2 rounded-xl text-white">
              אוקי
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
