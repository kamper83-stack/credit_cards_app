import db from '../src/db.js';
import { createInvite } from '../src/auth/invites.js';

/** Ensures an (enabled) admin row exists for invite.created_by and returns its id. */
export function ensureInviteAdmin(): string {
  const email = 'invite-helper-admin@example.com';
  const row = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: string } | undefined;
  if (row) return row.id;
  const id = 'invite-helper-admin';
  db.prepare(`INSERT INTO users (id, email, password_hash, is_admin, created_at) VALUES (?, ?, 'x', 1, 1)`).run(id, email);
  return id;
}

/** A fresh invite token (default: 1 use, long expiry from the real clock) for registering test users. */
export function newInvite(opts: { maxUses?: number; expiresInDays?: number; nowSec?: number; label?: string } = {}): string {
  return createInvite(db, {
    createdBy: ensureInviteAdmin(),
    maxUses: opts.maxUses ?? 1,
    expiresInDays: opts.expiresInDays ?? 90,
    label: opts.label,
    nowSec: opts.nowSec ?? Math.floor(Date.now() / 1000),
  }).token;
}
