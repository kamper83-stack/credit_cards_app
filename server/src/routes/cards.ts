import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { z } from 'zod';

const router = Router();

const CardSchema = z.object({
  name: z.string().min(1),
  last4: z.string().max(4).optional(),
  color: z.string().optional(),
});

// Every query in this router is scoped by cards.user_id = req.user.id. A card that belongs to
// someone else is indistinguishable from a missing one: always 404, never 403.
const NOT_FOUND = { error: 'Card not found' };

router.get('/', (req, res) => {
  const userId = req.user!.id;
  // Explicit column list: `credentials` (and user_id) are never selected.
  const cards = db.prepare(`
    SELECT c.id, c.name, c.provider, c.last4, c.color, c.icon, c.source, c.riseup_account_id, c.created_at,
      (SELECT COUNT(*) FROM goals g WHERE g.card_id = c.id AND g.active = 1) as goals_count,
      (SELECT COUNT(*) FROM transactions t WHERE t.card_id = c.id) as tx_count,
      (SELECT synced_at FROM sync_log WHERE user_id = @userId AND card_id = 'riseup' AND status = 'success'
        ORDER BY synced_at DESC, id DESC LIMIT 1) as last_synced
    FROM cards c WHERE c.user_id = @userId ORDER BY c.created_at DESC
  `).all({ userId });

  res.json(cards.map((c: any) => ({ ...c, credentials: undefined })));
});

router.post('/', (req, res) => {
  const parsed = CardSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = req.user!.id;

  const id = randomUUID();
  const { name, last4, color } = parsed.data;

  db.prepare(`
    INSERT INTO cards (id, name, provider, last4, color, source, user_id)
    VALUES (?, ?, 'manual', ?, ?, 'manual', ?)
  `).run(id, name, last4 ?? null, color ?? '#6366f1', userId);

  res.status(201).json({ id, name, last4, color });
});

router.put('/:id', (req, res) => {
  const userId = req.user!.id;
  const card = db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!card) return res.status(404).json(NOT_FOUND);

  const parsed = CardSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, last4, color } = parsed.data;
  db.prepare(`
    UPDATE cards SET
      name = COALESCE(?, name),
      last4 = COALESCE(?, last4),
      color = COALESCE(?, color)
    WHERE id = ? AND user_id = ?
  `).run(name ?? null, last4 ?? null, color ?? null, req.params.id, userId);

  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM cards WHERE id = ? AND user_id = ?').run(req.params.id, req.user!.id);
  if (result.changes === 0) return res.status(404).json(NOT_FOUND);
  res.json({ success: true });
});

export default router;
