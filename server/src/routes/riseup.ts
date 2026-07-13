import { Router } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { z } from 'zod';
import { isValidPatFormat, testRiseupConnection, fetchRiseupCreditCardData } from '../riseup.js';

const router = Router();

function getPat(): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'riseup_pat'`).get() as { value: string } | undefined;
  return row?.value;
}

function maskPat(pat: string): string {
  return `${pat.slice(0, 11)}...${pat.slice(-4)}`;
}

router.get('/status', (_req, res) => {
  const pat = getPat();
  const lastSync = db.prepare(`SELECT value FROM settings WHERE key = 'riseup_last_sync'`).get() as { value: string } | undefined;
  res.json({
    connected: !!pat,
    tokenPreview: pat ? maskPat(pat) : null,
    lastSyncedAt: lastSync ? Number(lastSync.value) : null,
  });
});

const TokenSchema = z.object({ token: z.string().min(1) });

router.put('/token', async (req, res) => {
  const parsed = TokenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'נדרש טוקן' });

  const token = parsed.data.token.trim();
  if (!isValidPatFormat(token)) {
    return res.status(400).json({ error: 'פורמט הטוקן אינו תקין. הוא אמור להתחיל ב-riseup_pat_' });
  }

  try {
    await testRiseupConnection(token);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'לא ניתן להתחבר עם הטוקן שסופק' });
  }

  db.prepare(`INSERT INTO settings (key, value) VALUES ('riseup_pat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(token);
  res.json({ success: true });
});

router.delete('/token', (_req, res) => {
  db.prepare(`DELETE FROM settings WHERE key IN ('riseup_pat', 'riseup_last_sync')`).run();
  res.json({ success: true });
});

router.post('/sync', async (req, res) => {
  const pat = getPat();
  if (!pat) return res.status(400).json({ error: 'לא מחובר ל-RiseUp. הזן טוקן גישה בהגדרות.' });

  const months = Math.min(Math.max(Number(req.body?.months) || 3, 1), 24);

  try {
    const { accounts, transactions, monthsSynced } = await fetchRiseupCreditCardData(pat, months);

    const cardIdBySource = new Map<string, string>();
    const upsertCard = db.prepare(`
      INSERT INTO cards (id, name, provider, color, source, riseup_account_id)
      VALUES (?, ?, 'riseup', '#6366f1', 'riseup', ?)
      ON CONFLICT(riseup_account_id) DO UPDATE SET name = excluded.name
    `);
    const getCardBySource = db.prepare(`SELECT id FROM cards WHERE riseup_account_id = ?`);

    const syncCards = db.transaction((accs: typeof accounts) => {
      for (const acc of accs) {
        upsertCard.run(randomUUID(), acc.nickname, acc.sourceId);
        const row = getCardBySource.get(acc.sourceId) as { id: string };
        cardIdBySource.set(acc.sourceId, row.id);
      }
    });
    syncCards(accounts);

    const insertTx = db.prepare(`
      INSERT INTO transactions (id, card_id, amount, date, description, category, type, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        amount = excluded.amount, date = excluded.date, description = excluded.description,
        category = excluded.category, type = excluded.type, raw = excluded.raw
    `);

    const syncTransactions = db.transaction((txns: typeof transactions) => {
      for (const t of txns) {
        const cardId = cardIdBySource.get(t.source);
        if (!cardId) continue;
        insertTx.run(
          t.transactionId,
          cardId,
          t.amount,
          t.transactionDate.slice(0, 10),
          t.businessName,
          t.categoryLabel ?? null,
          t.isInstallment ? 'installments' : 'normal',
          JSON.stringify(t)
        );
      }
    });
    syncTransactions(transactions);

    db.prepare(`INSERT INTO settings (key, value) VALUES ('riseup_last_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(Math.floor(Date.now() / 1000)));

    db.prepare(`INSERT INTO sync_log (card_id, status, message) VALUES ('riseup', 'success', ?)`)
      .run(`סונכרנו ${transactions.length} עסקאות מ-${accounts.length} כרטיסים (${monthsSynced.join(', ')})`);

    res.json({
      success: true,
      accountsFound: accounts.length,
      transactionsSynced: transactions.length,
      monthsSynced,
    });
  } catch (err: any) {
    db.prepare(`INSERT INTO sync_log (card_id, status, message) VALUES ('riseup', 'error', ?)`).run(err.message);
    res.status(500).json({ error: err.message || 'הסנכרון נכשל' });
  }
});

export default router;
