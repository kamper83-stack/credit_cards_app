import { Router } from 'express';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { AuthConfig } from '../auth/config.js';
import { requireAdmin } from '../auth/middleware.js';
import { createInvite, inviteStatus } from '../auth/invites.js';
import { revokeAllSessions } from '../auth/sessions.js';

const CreateInviteSchema = z.object({
  label: z.string().trim().max(100).optional().nullable(),
  expiresInDays: z.number().int().min(1).max(90).default(7),
  maxUses: z.number().int().min(1).max(100).default(1),
}).strict();

const IdParam = z.string().min(1).max(64);

export function createAdminRouter(db: Database.Database, cfg: AuthConfig): Router {
  const router = Router();
  const nowSec = () => Math.floor(cfg.now() / 1000);
  router.use(requireAdmin);

  const audit = (actor: string, action: string, target: string) =>
    db.prepare(`INSERT INTO admin_audit (actor_user_id, action, target, at) VALUES (?, ?, ?, ?)`).run(actor, action, target, nowSec());

  router.get('/invites', (_req, res) => {
    const t = nowSec();
    const rows = db.prepare(`
      SELECT id, label, max_uses, used_count, expires_at, revoked_at, created_at FROM invites ORDER BY created_at DESC, rowid DESC
    `).all() as Array<{ id: string; label: string | null; max_uses: number; used_count: number; expires_at: number; revoked_at: number | null; created_at: number }>;
    res.json(rows.map((r) => ({
      id: r.id, label: r.label, maxUses: r.max_uses, usedCount: r.used_count,
      expiresAt: r.expires_at, revokedAt: r.revoked_at, createdAt: r.created_at, status: inviteStatus(r, t),
    })));
  });

  router.post('/invites', (req, res) => {
    const parsed = CreateInviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'פרטים לא תקינים' });
    const inv = db.transaction(() => {
      const created = createInvite(db, { ...parsed.data, createdBy: req.user!.id, nowSec: nowSec() });
      audit(req.user!.id, 'invite.create', created.id);
      return created;
    })();
    // The only response that ever contains the token.
    res.status(201).json({
      id: inv.id, token: inv.token, path: inv.path, label: inv.label, maxUses: inv.maxUses, expiresAt: inv.expiresAt,
    });
  });

  router.post('/invites/:id/revoke', (req, res) => {
    const id = IdParam.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ error: 'Not found' });
    const row = db.prepare(`SELECT revoked_at FROM invites WHERE id = ?`).get(id.data) as { revoked_at: number | null } | undefined;
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!row.revoked_at) {
      db.transaction(() => {
        db.prepare(`UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(nowSec(), id.data);
        audit(req.user!.id, 'invite.revoke', id.data);
      })();
    }
    res.json({ ok: true });
  });

  router.get('/users', (_req, res) => {
    const rows = db.prepare(`
      SELECT u.id, u.email, u.is_admin, u.disabled_at, u.created_at, i.label AS invite_label,
             (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
             (SELECT COUNT(*) FROM cards c WHERE c.user_id = u.id) AS card_count
      FROM users u LEFT JOIN invites i ON i.id = u.invite_id
      ORDER BY u.created_at, u.rowid
    `).all() as Array<{ id: string; email: string; is_admin: number; disabled_at: number | null; created_at: number | null; invite_label: string | null; last_seen: number | null; card_count: number }>;
    res.json(rows.map((u) => ({
      id: u.id, email: u.email, isAdmin: !!u.is_admin, disabled: !!u.disabled_at,
      createdAt: u.created_at, lastSeen: u.last_seen, inviteLabel: u.invite_label, cardCount: u.card_count,
    })));
  });

  router.post('/users/:id/disable', (req, res) => {
    const id = IdParam.safeParse(req.params.id);
    const user = id.success
      ? db.prepare(`SELECT id, is_admin, disabled_at FROM users WHERE id = ?`).get(id.data) as { id: string; is_admin: number; disabled_at: number | null } | undefined
      : undefined;
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.id === req.user!.id) return res.status(409).json({ error: 'לא ניתן להשבית את המשתמש שלך' });
    if (!user.disabled_at) {
      const done = db.transaction(() => {
        if (user.is_admin) {
          const others = (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled_at IS NULL AND id != ?`).get(user.id) as { n: number }).n;
          if (others === 0) return false;
        }
        db.prepare(`UPDATE users SET disabled_at = ? WHERE id = ?`).run(nowSec(), user.id);
        revokeAllSessions(db, user.id);
        audit(req.user!.id, 'user.disable', user.id);
        return true;
      })();
      if (!done) return res.status(409).json({ error: 'לא ניתן להשבית את המנהל האחרון' });
    }
    res.json({ ok: true });
  });

  router.post('/users/:id/enable', (req, res) => {
    const id = IdParam.safeParse(req.params.id);
    const user = id.success
      ? db.prepare(`SELECT id, disabled_at FROM users WHERE id = ?`).get(id.data) as { id: string; disabled_at: number | null } | undefined
      : undefined;
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.disabled_at) {
      db.transaction(() => {
        db.prepare(`UPDATE users SET disabled_at = NULL, failed_attempts = 0, locked_until = NULL WHERE id = ?`).run(user.id);
        audit(req.user!.id, 'user.enable', user.id);
      })();
    }
    res.json({ ok: true });
  });

  return router;
}
