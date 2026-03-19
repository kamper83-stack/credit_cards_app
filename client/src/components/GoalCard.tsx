import { Trash2, Trophy, Calendar, CreditCard, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { ProgressRing } from './ProgressRing';
import type { Goal } from '../types';
import { format, differenceInDays, parseISO } from 'date-fns';
import { he } from 'date-fns/locale';

const PERIOD_LABELS: Record<string, string> = {
  monthly: 'חודשי',
  quarterly: 'רבעוני',
  yearly: 'שנתי',
  custom: 'מותאם אישית',
};

function fmt(n: number) {
  return n.toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
}

interface Props {
  goal: Goal;
  onDelete: () => void;
}

function getPaceInfo(goal: Goal) {
  if (!goal.current_period_start || !goal.current_period_end) return null;
  const start = parseISO(goal.current_period_start);
  const end = parseISO(goal.current_period_end);
  const totalDays = differenceInDays(end, start) || 1;
  const elapsed = totalDays - (goal.days_left ?? 0);
  const pacePct = Math.min((elapsed / totalDays) * 100, 100);
  return { pacePct, elapsedDays: elapsed, totalDays };
}

export function GoalCard({ goal, onDelete }: Props) {
  const pct = Math.round(goal.progress);
  const done = pct >= 100;
  const paceInfo = !done ? getPaceInfo(goal) : null;
  const pacePct = paceInfo?.pacePct ?? 0;
  const isAhead = goal.progress >= pacePct;
  const isBehind = !done && goal.progress < pacePct - 5; // 5% tolerance

  return (
    <div className="bg-slate-800 rounded-2xl p-5 border border-slate-700 hover:border-slate-500 transition-all">
      {/* Card badge */}
      <div className="flex items-center gap-2 mb-4">
        <div className="w-3 h-3 rounded-full" style={{ background: goal.card_color }} />
        <span className="text-xs text-slate-400 flex items-center gap-1">
          <CreditCard size={12} />
          {goal.card_name}
          {goal.card_last4 && <span className="opacity-60">****{goal.card_last4}</span>}
        </span>
        <span className="mr-auto text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">
          {PERIOD_LABELS[goal.period_type]}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <ProgressRing progress={goal.progress} color={goal.card_color} size={90} stroke={8}>
          <span className={`text-sm font-bold ${done ? 'text-green-400' : 'text-white'}`}>
            {done ? '✓' : `${pct}%`}
          </span>
        </ProgressRing>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-white truncate">{goal.name}</h3>
          {goal.description && (
            <p className="text-xs text-slate-400 mt-0.5 truncate">{goal.description}</p>
          )}

          <div className="mt-3 space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-slate-400">הוצאתי</span>
              <span className="font-medium text-white">{fmt(goal.spent)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-400">יעד</span>
              <span className="font-medium text-white">{fmt(goal.target_amount)}</span>
            </div>
            {!done && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">נשאר</span>
                <span className="font-semibold text-amber-400">{fmt(goal.remaining)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Progress bar with pace indicator */}
      <div className="mt-4 space-y-1">
        <div className="relative bg-slate-700 rounded-full h-3 overflow-visible">
          {/* Fill */}
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.min(goal.progress, 100)}%`,
              background: done ? '#22c55e' : isBehind ? '#f59e0b' : goal.card_color,
            }}
          />
          {/* Pace marker */}
          {paceInfo && pacePct > 0 && pacePct < 100 && (
            <div
              className="absolute top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-white/70"
              style={{ left: `${pacePct}%` }}
              title={`קצב נדרש: ${Math.round(pacePct)}%`}
            />
          )}
        </div>
        {/* Pace status */}
        {paceInfo && !done && (
          <div className={`flex items-center gap-1 text-xs ${isBehind ? 'text-amber-400' : 'text-emerald-400'}`}>
            {isBehind
              ? <><TrendingDown size={11} /> מאחור בקצב ({Math.round(pacePct - goal.progress)}% פיגור)</>
              : isAhead
              ? <><TrendingUp size={11} /> לפני הקצב</>
              : <><Minus size={11} /> בקצב טוב</>}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {goal.reward_description && (
            <div className="flex items-center gap-1 text-xs text-amber-400">
              <Trophy size={12} />
              <span className="truncate max-w-[140px]">{goal.reward_description}</span>
              {goal.reward_value && <span className="font-bold">{fmt(goal.reward_value)}</span>}
            </div>
          )}
          {goal.days_left !== undefined && goal.days_left !== null && !done && (
            <div className="flex items-center gap-1 text-xs text-slate-400">
              <Calendar size={12} />
              <span>{goal.days_left} ימים נותרו</span>
            </div>
          )}
          {done && (
            <span className="text-xs text-green-400 font-semibold flex items-center gap-1">
              <Trophy size={12} /> הושג!
            </span>
          )}
        </div>
        <button
          onClick={onDelete}
          className="text-slate-600 hover:text-red-400 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
