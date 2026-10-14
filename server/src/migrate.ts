import type Database from 'better-sqlite3';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { hashPassword } from './password.js';
import { encryptPat, decryptPat, assertEncryptionKey } from './crypto.js';

type Env = Record<string, string | undefined>;

function tableColumns(db: Database.Database, table: string): string[] | null {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(table);
  if (!exists) return null;
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
}

/**
 * Pre-schema check: does this DB predate multi-user support?
 * (cards without user_id, or a plaintext RiseUp PAT in settings.)
 */
export function isLegacyDb(db: Database.Database): boolean {
  const cards = tableColumns(db, 'cards');
  if (cards && !cards.includes('user_id')) return true;
  if (tableColumns(db, 'settings')) {
    const pat = db.prepare(`SELECT 1 FROM settings WHERE key = 'riseup_pat'`).get();
    if (pat) return true;
  }
  return false;
}

function chmod600(file: string): void {
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

/** Best-effort chmod 600 on the DB file and its WAL/SHM sidecars. */
export function restrictDbFilePermissions(file: string): void {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    if (fs.existsSync(f)) chmod600(f);
  }
}

/** If the DB is legacy, write a consistent copy to `<file>.bak-<timestamp>` (mode 0600). */
export function backupIfLegacy(db: Database.Database, file: string): string | null {
  if (file === ':memory:' || !isLegacyDb(db)) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let target = `${file}.bak-${stamp}`;
  for (let i = 1; fs.existsSync(target); i++) target = `${file}.bak-${stamp}-${i}`;
  db.prepare('VACUUM INTO ?').run(target);
  chmod600(target);
  console.log(`Legacy database detected; backup written to ${target}`);
  return target;
}

export class MigrationError extends Error {}

/**
 * Async startup migrations (password hashing is async). Idempotent; call and await before listen().
 * - creates the admin user from ADMIN_EMAIL/ADMIN_PASSWORD when needed
 * - assigns legacy cards/sync_log rows to the admin
 * - moves the plaintext settings.riseup_pat into user_riseup (AES-256-GCM) and deletes it
 */
export async function runStartupMigrations(db: Database.Database, env: Env = process.env): Promise<void> {
  const userCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
  const patRow = db.prepare(`SELECT value FROM settings WHERE key = 'riseup_pat'`).get() as { value: string } | undefined;
  const lastSyncRow = db.prepare(`SELECT value FROM settings WHERE key = 'riseup_last_sync'`).get() as { value: string } | undefined;
  const orphanCards = (db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE user_id IS NULL`).get() as { n: number }).n;
  const orphanLogs = (db.prepare(`SELECT COUNT(*) AS n FROM sync_log WHERE user_id IS NULL`).get() as { n: number }).n;
  const legacyData = !!patRow || orphanCards > 0 || orphanLogs > 0;
  const adminEmail = env.ADMIN_EMAIL?.trim();
  const adminPassword = env.ADMIN_PASSWORD;
  const hasAdminEnv = !!adminEmail || !!adminPassword;

  if (userCount() === 0 && !legacyData && !hasAdminEnv) return; // fresh install, nothing to do

  // Validate everything up front so we refuse to start before touching any data.
  if (patRow) {
    try {
      assertEncryptionKey(env);
    } catch (e: any) {
      throw new MigrationError(
        `A plaintext RiseUp token exists in the database and must be encrypted, but ${e.message} ` +
        `The plaintext token has NOT been modified.`);
    }
  }

  let newAdmin: { id: string; email: string; hash: string } | null = null;
  if (userCount() === 0) {
    if (!adminEmail || !adminPassword) {
      throw new MigrationError(
        legacyData
          ? 'Legacy data found but no users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD to create the admin account that will own it.'
          : 'ADMIN_EMAIL and ADMIN_PASSWORD must both be set to create the admin account.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) throw new MigrationError('ADMIN_EMAIL is not a valid email address.');
    if (adminPassword.length < 12) throw new MigrationError('ADMIN_PASSWORD must be at least 12 characters.');
    newAdmin = { id: randomUUID(), email: adminEmail, hash: await hashPassword(adminPassword) };
  }

  const migrate = db.transaction(() => {
    let adminId: string;
    if (newAdmin) {
      db.prepare(`INSERT INTO users (id, email, password_hash, is_admin) VALUES (?, ?, ?, 1)`)
        .run(newAdmin.id, newAdmin.email, newAdmin.hash);
      adminId = newAdmin.id;
    } else {
      const row = db.prepare(`SELECT id FROM users ORDER BY is_admin DESC, created_at, rowid LIMIT 1`).get() as { id: string };
      adminId = row.id;
    }

    db.prepare(`UPDATE cards SET user_id = ? WHERE user_id IS NULL`).run(adminId);
    db.prepare(`UPDATE sync_log SET user_id = ? WHERE user_id IS NULL`).run(adminId);

    if (patRow) {
      const enc = encryptPat(patRow.value, adminId, env);
      const lastSync = lastSyncRow && Number.isFinite(Number(lastSyncRow.value)) ? Number(lastSyncRow.value) : null;
      db.prepare(`
        INSERT INTO user_riseup (user_id, pat_ciphertext, iv, tag, key_version, last_sync)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET pat_ciphertext = excluded.pat_ciphertext, iv = excluded.iv,
          tag = excluded.tag, key_version = excluded.key_version, last_sync = excluded.last_sync
      `).run(adminId, enc.ciphertext, enc.iv, enc.tag, enc.keyVersion, lastSync);

      // Round-trip check from what was actually stored, before deleting the plaintext.
      const stored = db.prepare(`SELECT pat_ciphertext, iv, tag, key_version FROM user_riseup WHERE user_id = ?`).get(adminId) as any;
      if (decryptPat(stored, adminId, env) !== patRow.value) {
        throw new MigrationError('Encrypted token failed round-trip verification; aborting migration.');
      }
      db.prepare(`DELETE FROM settings WHERE key = 'riseup_pat'`).run();
    }
    db.prepare(`DELETE FROM settings WHERE key = 'riseup_last_sync'`).run();
  });
  // Zero freed pages so the deleted plaintext PAT does not linger in the DB file, then
  // flush the WAL (the .bak-* backup deliberately still holds the old plaintext).
  db.pragma('secure_delete = ON');
  migrate();
  db.pragma('wal_checkpoint(TRUNCATE)');
}
