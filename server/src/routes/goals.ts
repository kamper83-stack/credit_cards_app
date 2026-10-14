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
  active: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
});

function getPeriodDates(periodType: string, start?: string, end?: string) {
  const now = new Date();
  // Format a Date using LOCAL calendar fields (YYYY-MM-DD).
  // Do NOT use toISOString() here — it converts to UTC, which shifts the
  // date back one day in positive-offset timezones (e.g. Asia/Jerusalem)
  // and makes transactions on the 1st of the month fall outside the window.
  const localDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  if (periodType === 'custom' && start && end) {
    return { start, end };
  }
  if (periodType === 'monthly') {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { start: localDate(s), end: localDate(e) };
  }
  if (periodType === 'quarterly') {
    const q = Math.floor(now.getMonth() / 3);
    const s = new Date(now.getFullYear(), q * 3, 1);
    const e = new Date(now.getFullYear(), q * 3 + 3, 0);
    return { start: localDate(s), end: localDate(e) };
  }
  if (periodType === 'yearly') {
    return {
      start: `${now.getFullYear()}-01-01`,
      end: `${now.getFullYear()}-12-31`,
    };
  }
  return { start: undefined, end: undefined };
}

// Goals have no owner column of their own: ownership is always derived from the card
// (cards.user_id). A goal on someone else's card is indistinguishable from a missing one (404).
const GOAL_NOT_FOUND = { error: 'Goal not found' };
const CARD_NOT_FOUND = { error: 'Card not found' };
const OWNED_CARDS = 'SELECT id FROM cards WHERE user_id = ?';

router.get('/', (req, res) => {
  const userId = req.user!.id;
  const cardId = req.query.card_id;
  if (cardId !== undefined && typeof cardId !== 'string') return res.status(400).json({ error: 'Invalid card_id' });
  if (cardId) {
    const owned = db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?').get(cardId, userId);
    if (!owned) return res.status(404).json(CARD_NOT_FOUND);
  }

  const goals = db.prepare(`
    SELECT g.id, g.card_id, g.name, g.description, g.target_amount, g.period_type, g.period_start,
      g.period_end, g.reward_description, g.reward_value, g.active, g.created_at,
      c.name as card_name,
      c.color as card_color,
      c.provider as card_provider,
      c.last4 as card_last4
    FROM goals g
    JOIN cards c ON c.id = g.card_id
    WHERE c.user_id = ?${cardId ? ' AND g.card_id = ?' : ''}
    ORDER BY g.created_at DESC
  `).all(...(cardId ? [userId, cardId] : [userId]));

  // For each goal, compute spent amount in current period (only this user's own transactions)
  const sumStmt = db.prepare(`
    SELECT COALESCE(SUM(t.amount), 0) as total
    FROM transactions t JOIN cards c ON c.id = t.card_id
    WHERE t.card_id = ? AND c.user_id = ? AND t.date >= ? AND t.date <= ?
  `);
  const result = goals.map((goal: any) => {
    const { start, end } = getPeriodDates(goal.period_type, goal.period_start, goal.period_end);
    let spent = 0;
    if (start && end) {
      const row: any = sumStmt.get(goal.card_id, userId, start, end);
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

  const card = db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?').get(parsed.data.card_id, req.user!.id);
  if (!card) return res.status(404).json(CARD_NOT_FOUND);

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
  const userId = req.user!.id;
  const goal = db.prepare(`SELECT g.id FROM goals g JOIN cards c ON c.id = g.card_id WHERE g.id = ? AND c.user_id = ?`).get(req.params.id, userId);
  if (!goal) return res.status(404).json(GOAL_NOT_FOUND);

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
    WHERE id = ? AND card_id IN (${OWNED_CARDS})
  `).run(d.name ?? null, d.description ?? null, d.target_amount ?? null,
    d.period_type ?? null, d.period_start ?? null, d.period_end ?? null,
    d.reward_description ?? null, d.reward_value ?? null,
    d.active === undefined ? null : (d.active ? 1 : 0), req.params.id, userId);

  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const result = db.prepare(`DELETE FROM goals WHERE id = ? AND card_id IN (${OWNED_CARDS})`).run(req.params.id, req.user!.id);
  if (result.changes === 0) return res.status(404).json(GOAL_NOT_FOUND);
  res.json({ success: true });
});

export default router;
