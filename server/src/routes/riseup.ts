import { Router, type Response } from 'express';
import { randomUUID } from 'crypto';
import db from '../db.js';
import { encryptPat, decryptAndUpgrade } from '../crypto.js';
import { z } from 'zod';
import {
  isValidPatFormat, testRiseupConnection, fetchRiseupCreditCardData, accountKey,
  toRiseupError, redactSecrets, RiseupError,
} from '../riseup.js';

// All handlers act on req.user.id (requireAuth is mounted in app.ts). The PAT never appears in a
// response beyond the masked preview, never in logs, and errors reaching the client are fixed
// Hebrew strings (see RiseupError); full detail goes to the server log with PAT patterns scrubbed.
const router = Router();

const DECRYPT_FAILED = 'פענוח הטוקן נכשל. בדוק את TOKEN_ENC_KEY.';
const SYNC_FAILED = 'הסנכרון נכשל. נסה שוב מאוחר יותר.';
const BUSY_USER = 'פעולת RiseUp כבר מתבצעת עבור המשתמש. נסה שוב בעוד רגע.';
const BUSY_SERVER = 'השרת עסוק כרגע בסנכרונים אחרים. נסה שוב בעוד כמה שניות.';

// Concurrency control. Each RiseUp call spawns an `npx` MCP subprocess, so (a) one user can run
// only one at a time (409) and (b) the server runs at most MAX_CONCURRENT_MCP at once (503).
// In-memory: correct for the single-process deployment (pm2 fork mode / one container).
const MAX_CONCURRENT_MCP = Math.max(1, Number(process.env.RISEUP_MAX_CONCURRENT) || 3);
const activeUsers = new Set<string>();

type Slot = { release: () => void } | { status: 409 | 503; error: string };

function acquireSlot(userId: string): Slot {
  if (activeUsers.has(userId)) return { status: 409, error: BUSY_USER };
  if (activeUsers.size >= MAX_CONCURRENT_MCP) return { status: 503, error: BUSY_SERVER };
  activeUsers.add(userId);
  return { release: () => { activeUsers.delete(userId); } };
}

function refuse(res: Response, slot: { status: 409 | 503; error: string }) {
  if (slot.status === 503) res.set('Retry-After', '10');
  return res.status(slot.status).json({ error: slot.error });
}

/** Test hook: number of in-flight RiseUp operations. */
export function activeRiseupOperations(): number { return activeUsers.size; }

/** Decrypts (and lazily re-encrypts with the current key). Throws on failure; callers must catch. */
function getPat(userId: string): string | undefined {
  return decryptAndUpgrade(db, userId);
}

function getLastSync(userId: string): number | null {
  const row = db.prepare(`SELECT last_sync FROM user_riseup WHERE user_id = ?`).get(userId) as { last_sync: number | null } | undefined;
  return row?.last_sync ?? null;
}

/** Masked preview: the fixed prefix and the last 4 characters only. */
function maskPat(pat: string): string {
  return `${pat.slice(0, 11)}...${pat.slice(-4)}`;
}

function logFailure(what: string, err: unknown, pat?: string) {
  const detail = err && (err as any).detail !== undefined ? (err as any).detail : (err as any)?.message ?? err;
  console.error(`${what}:`, redactSecrets(detail, ...(pat ? [pat] : [])));
}

router.get('/status', (req, res) => {
  const userId = req.user!.id;
  let pat: string | undefined;
  try {
    pat = getPat(userId);
  } catch (err: any) {
    logFailure('Token decryption failed', err);
    return res.status(500).json({ error: DECRYPT_FAILED });
  }
  res.json({
    connected: !!pat,
    tokenPreview: pat ? maskPat(pat) : null,
    lastSyncedAt: getLastSync(userId),
  });
});

const TokenSchema = z.object({ token: z.string().min(1).max(512) });

router.put('/token', async (req, res) => {
  const userId = req.user!.id;
  const parsed = TokenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'נדרש טוקן' });

  const token = parsed.data.token.trim();
  if (!isValidPatFormat(token)) {
    return res.status(400).json({ error: 'פורמט הטוקן אינו תקין. הוא אמור להתחיל ב-riseup_pat_' });
  }

  const slot = acquireSlot(userId);
  if (!('release' in slot)) return refuse(res, slot);
  try {
    await testRiseupConnection(token);
  } catch (err) {
    const e = toRiseupError(err, token);
    logFailure('RiseUp token test failed', e, token);
    return res.status(400).json({ error: e.message });
  } finally {
    slot.release();
  }

  let enc;
  try {
    enc = encryptPat(token, userId);
  } catch (err: any) {
    logFailure('Token encryption unavailable', err, token);
    return res.status(500).json({ error: 'הצפנת הטוקן אינה מוגדרת בשרת (TOKEN_ENC_KEY)' });
  }
  db.prepare(`
    INSERT INTO user_riseup (user_id, pat_ciphertext, iv, tag, key_version) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET pat_ciphertext = excluded.pat_ciphertext, iv = excluded.iv,
      tag = excluded.tag, key_version = excluded.key_version, last_sync = NULL
  `).run(userId, enc.ciphertext, enc.iv, enc.tag, enc.keyVersion);
  res.json({ success: true });
});

// Removes only the stored token. Cards, transactions, goals and sync_log already synced are
// deliberately kept (they are the user's data); the user can delete cards individually.
router.delete('/token', (req, res) => {
  db.prepare(`DELETE FROM user_riseup WHERE user_id = ?`).run(req.user!.id);
  res.json({ success: true });
});

// Minimum interval between automatic (non-forced) syncs, in seconds (24h).
const AUTO_SYNC_INTERVAL_SEC = 24 * 60 * 60;

router.post('/sync', async (req, res) => {
  const userId = req.user!.id;
  let pat: string | undefined;
  try {
    pat = getPat(userId);
  } catch (err: any) {
    logFailure('Token decryption failed', err);
    return res.status(500).json({ error: DECRYPT_FAILED });
  }
  if (!pat) return res.status(400).json({ error: 'לא מחובר ל-RiseUp. הזן טוקן גישה בהגדרות.' });

  const months = Math.min(Math.max(Number(req.body?.months) || 3, 1), 24);
  const force = req.body?.force === true;

  // Daily throttle (per user) for automatic on-load syncs. A manual button press always passes force=true.
  if (!force) {
    const last = getLastSync(userId);
    if (last !== null) {
      const now = Math.floor(Date.now() / 1000);
      if (Number.isFinite(last) && now - last < AUTO_SYNC_INTERVAL_SEC) {
        return res.json({ success: true, skipped: true, reason: 'already_synced', lastSyncedAt: last });
      }
    }
  }

  const slot = acquireSlot(userId);
  if (!('release' in slot)) return refuse(res, slot);

  try {
    const { accounts, transactions, monthsSynced } = await fetchRiseupCreditCardData(pat, months);

    // Built fresh per sync and per user: maps RiseUp account key -> THIS user's card id. Cards are
    // looked up with user_id = ?, so a transaction can only ever land on the caller's own cards
    // and the (card_id, id) conflict target cannot touch another user's rows.
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
  } catch (err) {
    // Full detail (PAT scrubbed) to the server log only; the client and sync_log get a fixed message.
    const known = toRiseupError(err, pat);
    const safe = err instanceof RiseupError ? err.message : SYNC_FAILED;
    logFailure('RiseUp sync failed', known, pat);
    try {
      db.prepare(`INSERT INTO sync_log (card_id, status, message, user_id) VALUES ('riseup', 'error', ?, ?)`).run(safe, userId);
    } catch (logErr) {
      logFailure('sync_log write failed', logErr, pat);
    }
    res.status(500).json({ error: safe });
  } finally {
    slot.release();
  }
});

export default router;
