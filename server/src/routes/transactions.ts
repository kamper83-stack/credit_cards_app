import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { z } from 'zod';

const router = Router();

// Transactions have no owner column: ownership is always derived from the card
// (cards.user_id = req.user.id). Another user's card/transaction is indistinguishable from a
// missing one (404). The `raw` column (full RiseUp payload) is never returned to clients.

const TxSchema = z.object({
  card_id: z.string().uuid(),
  amount: z.number().positive(),
  date: z.string(),
  description: z.string().min(1),
  category: z.string().optional(),
  type: z.string().optional(),
});

router.get('/', (req, res) => {
  const userId = req.user!.id;
  const { from, to } = req.query as Record<string, string>;
  const cardId = req.query.card_id;
  if (cardId !== undefined && typeof cardId !== 'string') return res.status(400).json({ error: 'Invalid card_id' });
  if (cardId) {
    const owned = db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?').get(cardId, userId);
    if (!owned) return res.status(404).json({ error: 'Card not found' });
  }
  // Clamp limit to a sane range — NaN/negative/garbage input must not
  // reach SQLite (LIMIT NaN throws and 500s the endpoint).
  const rawLimit = Number((req.query.limit as string) ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1000) : 50;

  let where = 'WHERE c.user_id = ?';
  const args: any[] = [userId];

  if (cardId) { where += ' AND t.card_id = ?'; args.push(cardId); }
  if (typeof from === 'string' && from) { where += ' AND t.date >= ?'; args.push(from); }
  if (typeof to === 'string' && to) { where += ' AND t.date <= ?'; args.push(to); }

  const rows = db.prepare(`
    SELECT t.id, t.card_id, t.amount, t.date, t.description, t.category, t.original_currency,
      t.original_amount, t.type, c.name as card_name, c.color as card_color
    FROM transactions t JOIN cards c ON c.id = t.card_id
    ${where}
    ORDER BY t.date DESC
    LIMIT ?
  `).all(...args, limit);

  res.json(rows);
});

router.post('/', (req, res) => {
  const parsed = TxSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const card = db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?').get(parsed.data.card_id, req.user!.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const id = randomUUID();
  const d = parsed.data;
  db.prepare(`
    INSERT INTO transactions (id, card_id, amount, date, description, category, type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, d.card_id, d.amount, d.date, d.description, d.category ?? null, d.type ?? 'normal');

  res.status(201).json({ id });
});

// The primary key is (card_id, id), so an id alone can match rows on several of the caller's
// cards (RiseUp ids are only unique per card). Optional ?card_id= disambiguates; without it an
// ambiguous id is refused (400) rather than deleting several rows. Rows on other users' cards
// are never matched. Synced (RiseUp) rows may be deleted too (same as before); the next sync
// re-creates them.
router.delete('/:id', (req, res) => {
  const userId = req.user!.id;
  const cardId = req.query.card_id;
  if (cardId !== undefined && typeof cardId !== 'string') return res.status(400).json({ error: 'Invalid card_id' });

  const matches = db.prepare(`
    SELECT t.card_id FROM transactions t JOIN cards c ON c.id = t.card_id
    WHERE t.id = ? AND c.user_id = ?${cardId ? ' AND t.card_id = ?' : ''}
  `).all(...(cardId ? [req.params.id, userId, cardId] : [req.params.id, userId])) as Array<{ card_id: string }>;

  if (matches.length === 0) return res.status(404).json({ error: 'Transaction not found' });
  if (matches.length > 1) return res.status(400).json({ error: 'Ambiguous transaction id; pass card_id' });

  db.prepare(`DELETE FROM transactions WHERE id = ? AND card_id = ? AND card_id IN (SELECT id FROM cards WHERE user_id = ?)`)
    .run(req.params.id, matches[0].card_id, userId);
  res.json({ success: true });
});

export default router;
