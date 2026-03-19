import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { scrapeCard, PROVIDERS } from '../scraper.js';
import { z } from 'zod';

const router = Router();

const CardSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  last4: z.string().max(4).optional(),
  color: z.string().optional(),
  credentials: z.record(z.string()).optional(),
});

router.get('/providers', (_req, res) => {
  res.json(PROVIDERS.map(({ id, name, fields }) => ({ id, name, fields })));
});

router.get('/', (_req, res) => {
  const cards = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM goals g WHERE g.card_id = c.id AND g.active = 1) as goals_count,
      (SELECT COUNT(*) FROM transactions t WHERE t.card_id = c.id) as tx_count,
      (SELECT synced_at FROM sync_log WHERE card_id = c.id ORDER BY synced_at DESC LIMIT 1) as last_synced
    FROM cards c ORDER BY c.created_at DESC
  `).all();

  // Don't send credentials to client
  res.json(cards.map((c: any) => ({ ...c, credentials: undefined })));
});

router.post('/', (req, res) => {
  const parsed = CardSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = randomUUID();
  const { name, provider, last4, color, credentials } = parsed.data;

  db.prepare(`
    INSERT INTO cards (id, name, provider, last4, color, credentials)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, provider, last4 ?? null, color ?? '#6366f1', credentials ? JSON.stringify(credentials) : null);

  res.status(201).json({ id, name, provider, last4, color });
});

router.put('/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const parsed = CardSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { name, provider, last4, color, credentials } = parsed.data;
  db.prepare(`
    UPDATE cards SET
      name = COALESCE(?, name),
      provider = COALESCE(?, provider),
      last4 = COALESCE(?, last4),
      color = COALESCE(?, color),
      credentials = COALESCE(?, credentials)
    WHERE id = ?
  `).run(name ?? null, provider ?? null, last4 ?? null, color ?? null,
    credentials ? JSON.stringify(credentials) : null, req.params.id);

  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/:id/sync', async (req, res) => {
  const card: any = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  if (card.provider === 'manual') {
    return res.status(400).json({ error: 'Manual cards cannot be synced automatically' });
  }

  if (!card.credentials) {
    return res.status(400).json({ error: 'No credentials stored for this card' });
  }

  try {
    const credentials = JSON.parse(card.credentials);
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 3);

    const transactions = await scrapeCard(card.provider, credentials, startDate);

    const insert = db.prepare(`
      INSERT OR REPLACE INTO transactions (id, card_id, amount, date, description, original_currency, original_amount, type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((txns: any[]) => {
      for (const t of txns) {
        insert.run(t.id, card.id, t.amount, t.date, t.description,
          t.originalCurrency ?? null, t.originalAmount ?? null, t.type);
      }
    });

    insertMany(transactions);

    db.prepare(`
      INSERT INTO sync_log (card_id, status, message)
      VALUES (?, 'success', ?)
    `).run(card.id, `Synced ${transactions.length} transactions`);

    res.json({ success: true, count: transactions.length });
  } catch (err: any) {
    db.prepare(`
      INSERT INTO sync_log (card_id, status, message) VALUES (?, 'error', ?)
    `).run(card.id, err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
