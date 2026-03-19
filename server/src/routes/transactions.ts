import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { z } from 'zod';

const router = Router();

const TxSchema = z.object({
  card_id: z.string().uuid(),
  amount: z.number().positive(),
  date: z.string(),
  description: z.string().min(1),
  category: z.string().optional(),
  type: z.string().optional(),
});

router.get('/', (req, res) => {
  const { card_id, from, to, limit = '50' } = req.query as Record<string, string>;

  let where = 'WHERE 1=1';
  const args: any[] = [];

  if (card_id) { where += ' AND card_id = ?'; args.push(card_id); }
  if (from) { where += ' AND date >= ?'; args.push(from); }
  if (to) { where += ' AND date <= ?'; args.push(to); }

  const rows = db.prepare(`
    SELECT t.*, c.name as card_name, c.color as card_color
    FROM transactions t JOIN cards c ON c.id = t.card_id
    ${where}
    ORDER BY t.date DESC
    LIMIT ?
  `).all(...args, parseInt(limit, 10));

  res.json(rows);
});

router.post('/', (req, res) => {
  const parsed = TxSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const card = db.prepare('SELECT id FROM cards WHERE id = ?').get(parsed.data.card_id);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const id = randomUUID();
  const d = parsed.data;
  db.prepare(`
    INSERT INTO transactions (id, card_id, amount, date, description, category, type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, d.card_id, d.amount, d.date, d.description, d.category ?? null, d.type ?? 'normal');

  res.status(201).json({ id });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;
