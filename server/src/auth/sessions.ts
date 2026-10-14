import { createHash, randomBytes } from 'crypto';
import type Database from 'better-sqlite3';
import type { AuthConfig } from './config.js';
import { IDLE_SECONDS } from './config.js';

export interface AuthUser {
  id: string;
  email: string;
  isAdmin: boolean;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The DB only ever holds this hash; the raw token exists only in the cookie. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

const seconds = (cfg: Pick<AuthConfig, 'now'>) => Math.floor(cfg.now() / 1000);

/** Creates a session and returns the raw token (32 random bytes, base64url). */
export function createSession(db: Database.Database, cfg: AuthConfig, userId: string, userAgent?: string): string {
  const token = randomBytes(32).toString('base64url');
  const t = seconds(cfg);
  db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(hashToken(token), userId, t, t, t + cfg.absoluteSeconds, userAgent ? userAgent.slice(0, 255) : null);
  return token;
}

/**
 * Returns the session's user if the token is valid (exists, inside the absolute lifetime and not idle
 * for too long). Expired rows are deleted. last_seen is refreshed at most once per `touchSeconds`.
 */
export function lookupSession(db: Database.Database, cfg: AuthConfig, token: string): AuthUser | null {
  if (!isWellFormedToken(token)) return null;
  const th = hashToken(token);
  const row = db.prepare(`
    SELECT s.last_seen, s.expires_at, u.id, u.email, u.is_admin, u.disabled_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?
  `).get(th) as { last_seen: number; expires_at: number; id: string; email: string; is_admin: number; disabled_at: number | null } | undefined;
  if (!row) return null;
  if (row.disabled_at) return null; // disabled accounts have no valid session (their rows are also deleted on disable)
  const t = seconds(cfg);
  if (t >= row.expires_at || t - row.last_seen >= cfg.idleSeconds) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(th);
    return null;
  }
  if (t - row.last_seen >= cfg.touchSeconds) {
    db.prepare(`UPDATE sessions SET last_seen = ? WHERE token_hash = ?`).run(t, th);
  }
  return { id: row.id, email: row.email, isAdmin: !!row.is_admin };
}

export function revokeSession(db: Database.Database, token: string): void {
  db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
}

export function revokeAllSessions(db: Database.Database, userId: string): void {
  db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
}

/** Session fixation defence: issue a brand-new token and kill the presented one (if any). */
export function rotateSession(db: Database.Database, cfg: AuthConfig, userId: string, oldToken?: string, userAgent?: string): string {
  return db.transaction(() => {
    if (oldToken) revokeSession(db, oldToken);
    return createSession(db, cfg, userId, userAgent);
  })();
}

export function cleanupExpiredSessions(db: Database.Database, nowMs: number = Date.now()): number {
  const t = Math.floor(nowMs / 1000);
  return db.prepare(`DELETE FROM sessions WHERE expires_at <= ? OR last_seen <= ?`).run(t, t - IDLE_SECONDS).changes;
}

/** Cleans up now and then hourly. The timer is unref'd so it never keeps the process alive. */
export function startSessionCleanup(db: Database.Database): NodeJS.Timeout {
  const run = () => {
    try {
      const n = cleanupExpiredSessions(db);
      if (n > 0) console.log(`Session cleanup: removed ${n} expired session(s).`);
    } catch (err: any) {
      console.error('Session cleanup failed:', err?.message);
    }
  };
  run();
  const timer = setInterval(run, 3600 * 1000);
  timer.unref();
  return timer;
}
