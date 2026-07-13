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

router.get('/', (_req, res) => {
  const cards = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM goals g WHERE g.card_id = c.id AND g.active = 1) as goals_count,
      (SELECT COUNT(*) FROM transactions t WHERE t.card_id = c.id) as tx_count,
      (SELECT synced_at FROM sync_log WHERE card_id = 'riseup' ORDER BY synced_at DESC LIMIT 1) as last_synced
    FROM cards c ORDER BY c.created_at DESC
  `).all();

  res.json(cards.map((c: any) => ({ ...c, credentials: undefined })));
});

router.post('/', (req, res) => {
  const parsed = CardSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = randomUUID();
  const { name, last4, color } = parsed.data;

  db.prepare(`
    INSERT INTO cards (id, name, provider, last4, color, source)
    VALUES (?, ?, 'manual', ?, ?, 'manual')
  `).run(id, name, last4 ?? null, color ?? '#6366f1');

  res.status(201).json({ id, name, last4, color });
});

router.put('/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const parsed = CardSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, last4, color } = parsed.data;
  db.prepare(`
    UPDATE cards SET
      name = COALESCE(?, name),
      last4 = COALESCE(?, last4),
      color = COALESCE(?, color)
    WHERE id = ?
  `).run(name ?? null, last4 ?? null, color ?? null, req.params.id);

  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

export default router;
