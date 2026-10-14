import { Router, type Response } from 'express';
import { randomUUID } from 'crypto';
import db, { getLegacyOwnerId } from '../db.js';
import { encryptPat, decryptPat } from '../crypto.js';
import { z } from 'zod';
import { isValidPatFormat, testRiseupConnection, fetchRiseupCreditCardData, accountKey } from '../riseup.js';

const router = Router();

// TODO(phase3/4): replace getLegacyOwnerId() with the authenticated user (req.user.id).
function requireOwner(res: Response): string | null {
  const id = getLegacyOwnerId();
  if (!id) res.status(409).json({ error: 'לא הוגדר משתמש מנהל. הגדר ADMIN_EMAIL ו-ADMIN_PASSWORD והפעל מחדש.' });
  return id;
}

function getPat(userId: string): string | undefined {
  const row = db.prepare(`SELECT pat_ciphertext, iv, tag, key_version FROM user_riseup WHERE user_id = ?`).get(userId) as any;
  return row ? decryptPat(row, userId) : undefined;
}

function getLastSync(userId: string): number | null {
  const row = db.prepare(`SELECT last_sync FROM user_riseup WHERE user_id = ?`).get(userId) as { last_sync: number | null } | undefined;
  return row?.last_sync ?? null;
}

function maskPat(pat: string): string {
  return `${pat.slice(0, 11)}...${pat.slice(-4)}`;
}

router.get('/status', (_req, res) => {
  const userId = getLegacyOwnerId();
  const pat = userId ? getPat(userId) : undefined;
  res.json({
    connected: !!pat,
    tokenPreview: pat ? maskPat(pat) : null,
    lastSyncedAt: userId ? getLastSync(userId) : null,
  });
});

const TokenSchema = z.object({ token: z.string().min(1) });

router.put('/token', async (req, res) => {
  const userId = requireOwner(res);
  if (!userId) return;
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

  let enc;
  try {
    enc = encryptPat(token, userId);
  } catch (err: any) {
    console.error('Token encryption unavailable:', err.message);
    return res.status(500).json({ error: 'הצפנת הטוקן אינה מוגדרת בשרת (TOKEN_ENC_KEY)' });
  }
  db.prepare(`
    INSERT INTO user_riseup (user_id, pat_ciphertext, iv, tag, key_version) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET pat_ciphertext = excluded.pat_ciphertext, iv = excluded.iv,
      tag = excluded.tag, key_version = excluded.key_version, last_sync = NULL
  `).run(userId, enc.ciphertext, enc.iv, enc.tag, enc.keyVersion);
  res.json({ success: true });
});

router.delete('/token', (_req, res) => {
  const userId = requireOwner(res);
  if (!userId) return;
  db.prepare(`DELETE FROM user_riseup WHERE user_id = ?`).run(userId);
  res.json({ success: true });
});

// Minimum interval between automatic (non-forced) syncs, in seconds (24h).
const AUTO_SYNC_INTERVAL_SEC = 24 * 60 * 60;

router.post('/sync', async (req, res) => {
  const userId = requireOwner(res);
  if (!userId) return;
  let pat: string | undefined;
  try {
    pat = getPat(userId);
  } catch (err: any) {
    console.error('Token decryption failed:', err.message);
    return res.status(500).json({ error: 'פענוח הטוקן נכשל. בדוק את TOKEN_ENC_KEY.' });
  }
  if (!pat) return res.status(400).json({ error: 'לא מחובר ל-RiseUp. הזן טוקן גישה בהגדרות.' });

  const months = Math.min(Math.max(Number(req.body?.months) || 3, 1), 24);
  const force = req.body?.force === true;

  // Daily throttle for automatic on-load syncs. A manual button press always passes force=true.
  if (!force) {
    const last = getLastSync(userId);
    if (last !== null) {
      const now = Math.floor(Date.now() / 1000);
      if (Number.isFinite(last) && now - last < AUTO_SYNC_INTERVAL_SEC) {
        return res.json({ success: true, skipped: true, reason: 'already_synced', lastSyncedAt: last });
      }
    }
  }

  try {
    const { accounts, transactions, monthsSynced } = await fetchRiseupCreditCardData(pat, months);

    const cardIdBySource = new Map<string, string>();
    const upsertCard = db.prepare(`
      INSERT INTO cards (id, name, provider, color, source, riseup_account_id, user_id)
      VALUES (?, ?, 'riseup', '#6366f1', 'riseup', ?, ?)
      ON CONFLICT(user_id, riseup_account_id) WHERE riseup_account_id IS NOT NULL DO UPDATE SET name = excluded.name
    `);
    const getCardBySource = db.prepare(`SELECT id FROM cards WHERE riseup_account_id = ? AND user_id = ?`);

    const syncCards = db.transaction((accs: typeof accounts) => {
      for (const acc of accs) {
        upsertCard.run(randomUUID(), acc.nickname, acc.sourceId, userId);
        const row = getCardBySource.get(acc.sourceId, userId) as { id: string };
        cardIdBySource.set(acc.sourceId, row.id);
      }
    });
    syncCards(accounts);

    const insertTx = db.prepare(`
      INSERT INTO transactions (id, card_id, amount, date, description, category, type, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(card_id, id) DO UPDATE SET
        amount = excluded.amount, date = excluded.date, description = excluded.description,
        category = excluded.category, type = excluded.type, raw = excluded.raw
    `);

    const syncTransactions = db.transaction((txns: typeof transactions) => {
      for (const t of txns) {
        const cardId = cardIdBySource.get(accountKey(t));
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

    db.prepare(`UPDATE user_riseup SET last_sync = ? WHERE user_id = ?`).run(Math.floor(Date.now() / 1000), userId);

    db.prepare(`INSERT INTO sync_log (card_id, status, message, user_id) VALUES ('riseup', 'success', ?, ?)`)
      .run(`סונכרנו ${transactions.length} עסקאות מ-${accounts.length} כרטיסים (${monthsSynced.join(', ')})`, userId);

    res.json({
      success: true,
      accountsFound: accounts.length,
      transactionsSynced: transactions.length,
      monthsSynced,
    });
  } catch (err: any) {
    db.prepare(`INSERT INTO sync_log (card_id, status, message, user_id) VALUES ('riseup', 'error', ?, ?)`).run(err.message, userId);
    res.status(500).json({ error: err.message || 'הסנכרון נכשל' });
  }
});

export default router;
