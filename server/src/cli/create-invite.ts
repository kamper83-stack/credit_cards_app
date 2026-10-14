import 'dotenv/config';
import db from '../db.js';
import { createInvite } from '../auth/invites.js';

/**
 * Admin CLI: npm run create-invite --workspace=server -- [--days 7] [--uses 1] [--label text]
 * Needs at least one admin user. Prints the invite link path once; only its hash is stored.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function intArg(name: string, def: number, min: number, max: number): number {
  const raw = arg(name);
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`--${name} must be an integer between ${min} and ${max}.`);
    process.exit(2);
  }
  return n;
}

const days = intArg('days', 7, 1, 90);
const uses = intArg('uses', 1, 1, 100);
const label = arg('label');

const admin = db.prepare(`SELECT id FROM users WHERE is_admin = 1 AND disabled_at IS NULL ORDER BY created_at, rowid LIMIT 1`).get() as { id: string } | undefined;
if (!admin) {
  console.error('No enabled admin user exists; cannot create an invite.');
  process.exit(1);
}
const now = Math.floor(Date.now() / 1000);
const inv = db.transaction(() => {
  const created = createInvite(db, { label, expiresInDays: days, maxUses: uses, createdBy: admin.id, nowSec: now });
  db.prepare(`INSERT INTO admin_audit (actor_user_id, action, target, at) VALUES (?, 'invite.create_cli', ?, ?)`).run(admin.id, created.id, now);
  return created;
})();
console.log(`Invite created (valid ${days} day(s), ${uses} use(s)). Shown once; append to your site origin:`);
console.log(inv.path);
