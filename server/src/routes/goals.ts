import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { z } from 'zod';

const router = Router();

const GoalSchema = z.object({
  card_id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().optional(),
  target_amount: z.number().positive(),
  period_type: z.enum(['monthly', 'quarterly', 'yearly', 'custom']),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
  reward_description: z.string().optional(),
  reward_value: z.number().optional(),
});

function getPeriodDates(periodType: string, start?: string, end?: string) {
  const now = new Date();
  if (periodType === 'custom' && start && end) {
    return { start, end };
  }
  if (periodType === 'monthly') {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { start: s.toISOString().split('T')[0], end: e.toISOString().split('T')[0] };
  }
  if (periodType === 'quarterly') {
    const q = Math.floor(now.getMonth() / 3);
    const s = new Date(now.getFullYear(), q * 3, 1);
    const e = new Date(now.getFullYear(), q * 3 + 3, 0);
    return { start: s.toISOString().split('T')[0], end: e.toISOString().split('T')[0] };
  }
  if (periodType === 'yearly') {
    return {
      start: `${now.getFullYear()}-01-01`,
      end: `${now.getFullYear()}-12-31`,
    };
  }
  return { start: undefined, end: undefined };
}

router.get('/', (req, res) => {
  const { card_id } = req.query;
  const where = card_id ? 'WHERE g.card_id = ?' : '';
  const args = card_id ? [card_id] : [];

  const goals = db.prepare(`
    SELECT g.*,
      c.name as card_name,
      c.color as card_color,
      c.provider as card_provider,
      c.last4 as card_last4
    FROM goals g
    JOIN cards c ON c.id = g.card_id
    ${where}
    ORDER BY g.created_at DESC
  `).all(...args);

  // For each goal, compute spent amount in current period
  const result = goals.map((goal: any) => {
    const { start, end } = getPeriodDates(goal.period_type, goal.period_start, goal.period_end);
    let spent = 0;
    if (start && end) {
      const row: any = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) as total
        FROM transactions
        WHERE card_id = ? AND date >= ? AND date <= ? AND type != 'installments'
      `).get(goal.card_id, start, end);
      spent = row.total;
    }

    const progress = goal.target_amount > 0 ? Math.min((spent / goal.target_amount) * 100, 100) : 0;
    const remaining = Math.max(goal.target_amount - spent, 0);
    const daysLeft = end ? Math.max(Math.ceil((new Date(end).getTime() - Date.now()) / 86400000), 0) : null;

    return { ...goal, spent, progress, remaining, current_period_start: start, current_period_end: end, days_left: daysLeft };
  });

  res.json(result);
});

router.post('/', (req, res) => {
  const parsed = GoalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const card = db.prepare('SELECT id FROM cards WHERE id = ?').get(parsed.data.card_id);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const id = randomUUID();
  const d = parsed.data;
  db.prepare(`
    INSERT INTO goals (id, card_id, name, description, target_amount, period_type,
      period_start, period_end, reward_description, reward_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, d.card_id, d.name, d.description ?? null, d.target_amount,
    d.period_type, d.period_start ?? null, d.period_end ?? null,
    d.reward_description ?? null, d.reward_value ?? null);

  res.status(201).json({ id });
});

router.put('/:id', (req, res) => {
  const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(req.params.id);
  if (!goal) return res.status(404).json({ error: 'Goal not found' });

  const parsed = GoalSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const d = parsed.data;
  db.prepare(`
    UPDATE goals SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      target_amount = COALESCE(?, target_amount),
      period_type = COALESCE(?, period_type),
      period_start = COALESCE(?, period_start),
      period_end = COALESCE(?, period_end),
      reward_description = COALESCE(?, reward_description),
      reward_value = COALESCE(?, reward_value),
      active = COALESCE(?, active)
    WHERE id = ?
  `).run(d.name ?? null, d.description ?? null, d.target_amount ?? null,
    d.period_type ?? null, d.period_start ?? null, d.period_end ?? null,
    d.reward_description ?? null, d.reward_value ?? null,
    'active' in d ? (d as any).active : null, req.params.id);

  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM goals WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;
