import type Database from 'better-sqlite3';
import { createInvite, type CreatedInvite } from '../auth/invites.js';

/** Thrown for expected operator errors (exit code 1). */
export class CliError extends Error {}

interface UserRow { id: string; email: string; is_admin: number; disabled_at: number | null }

/**
 * Who is recorded as the actor in admin_audit for a CLI action: the enabled admin named by `--as <email>`,
 * else the oldest enabled admin. `fallbackId` (promote-admin on an install with no admin) is the user being promoted.
 */
export function resolveActor(db: Database.Database, asEmail?: string, fallbackId?: string): string {
  if (asEmail) {
    const u = db.prepare(`SELECT id FROM users WHERE email = ? AND is_admin = 1 AND disabled_at IS NULL`).get(asEmail.trim().toLowerCase()) as { id: string } | undefined;
    if (!u) throw new CliError('--as must be the email of an enabled admin user.');
    return u.id;
  }
  const a = db.prepare(`SELECT id FROM users WHERE is_admin = 1 AND disabled_at IS NULL ORDER BY created_at, rowid LIMIT 1`).get() as { id: string } | undefined;
  if (a) return a.id;
  if (fallbackId) return fallbackId;
  throw new CliError('No enabled admin user exists; cannot create an invite. Promote one with the promote-admin CLI (deploy/DEPLOY.md 5.4.1).');
}

export function cliCreateInvite(
  db: Database.Database,
  o: { days: number; uses: number; label?: string; as?: string; nowSec: number },
): CreatedInvite {
  const actor = resolveActor(db, o.as);
  return db.transaction(() => {
    const created = createInvite(db, { label: o.label, expiresInDays: o.days, maxUses: o.uses, createdBy: actor, nowSec: o.nowSec });
    db.prepare(`INSERT INTO admin_audit (actor_user_id, action, target, at) VALUES (?, 'invite.create_cli', ?, ?)`).run(actor, created.id, o.nowSec);
    return created;
  })();
}

export function cliPromoteAdmin(
  db: Database.Database,
  o: { email: string; as?: string; nowSec: number },
): { alreadyAdmin: boolean; email: string } {
  const email = o.email.trim().toLowerCase();
  const user = db.prepare(`SELECT id, email, is_admin, disabled_at FROM users WHERE email = ?`).get(email) as UserRow | undefined;
  if (!user) throw new CliError('No user with that email.');
  if (user.disabled_at) throw new CliError('That user is disabled; enable the account first (see deploy/DEPLOY.md 5.4.1). Nothing was changed.');
  if (user.is_admin) return { alreadyAdmin: true, email };
  db.transaction(() => {
    const actor = resolveActor(db, o.as, user.id);
    db.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`).run(user.id);
    db.prepare(`INSERT INTO admin_audit (actor_user_id, action, target, at) VALUES (?, 'user.promote_cli', ?, ?)`).run(actor, user.id, o.nowSec);
  })();
  return { alreadyAdmin: false, email };
}
