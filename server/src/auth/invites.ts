import { randomBytes, randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { hashToken } from './sessions.js';

export const INVITE_ERROR = 'ההזמנה אינה תקפה';

export interface CreateInviteOptions {
  label?: string | null;
  expiresInDays?: number;
  maxUses?: number;
  createdBy: string;
  /** Seconds since epoch (injectable clock). */
  nowSec: number;
}

export interface CreatedInvite {
  id: string;
  /** Raw token: returned once to the creator, never stored (only its SHA-256 is). */
  token: string;
  /** Path the client appends to window.location.origin. */
  path: string;
  label: string | null;
  maxUses: number;
  expiresAt: number;
}

export function createInvite(db: Database.Database, o: CreateInviteOptions): CreatedInvite {
  const days = o.expiresInDays ?? 7;
  const maxUses = o.maxUses ?? 1;
  const label = o.label?.trim() ? o.label.trim().slice(0, 100) : null;
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  const expiresAt = o.nowSec + Math.round(days * 86400);
  db.prepare(`INSERT INTO invites (id, token_hash, label, max_uses, used_count, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`)
    .run(id, hashToken(token), label, maxUses, expiresAt, o.createdBy, o.nowSec);
  return { id, token, path: `/register?invite=${token}`, label, maxUses, expiresAt };
}

/**
 * Atomically consumes one use of the invite with this token. Returns the invite id, or null when it
 * is unknown, revoked, expired or exhausted (callers must not distinguish these). Must be called
 * inside the same db.transaction as the user insert so a failed registration does not burn a use.
 */
export function consumeInvite(db: Database.Database, token: string, nowSec: number): string | null {
  if (!token || token.length > 200) return null;
  const row = db.prepare(`SELECT id FROM invites WHERE token_hash = ?`).get(hashToken(token)) as { id: string } | undefined;
  if (!row) return null;
  const r = db.prepare(`
    UPDATE invites SET used_count = used_count + 1
    WHERE id = ? AND used_count < max_uses AND revoked_at IS NULL AND expires_at > ?
  `).run(row.id, nowSec);
  return r.changes === 1 ? row.id : null;
}

export type InviteStatus = 'active' | 'expired' | 'revoked' | 'exhausted';

export function inviteStatus(i: { used_count: number; max_uses: number; expires_at: number; revoked_at: number | null }, nowSec: number): InviteStatus {
  if (i.revoked_at) return 'revoked';
  if (i.used_count >= i.max_uses) return 'exhausted';
  if (i.expires_at <= nowSec) return 'expired';
  return 'active';
}
