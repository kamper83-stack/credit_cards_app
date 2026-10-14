import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { hashPassword } from './password.js';
import { passwordShapeError } from './auth/passwordPolicy.js';
import { encryptPat, decryptPat, parseKey, currentKeyVersion, upgradeAllRows, type PatRow } from './crypto.js';

type Env = Record<string, string | undefined>;

export class MigrationError extends Error {}

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

/** Existing `<file>.bak-*` backups next to the DB. */
export function listBackups(file: string): string[] {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-`;
  try {
    return fs.readdirSync(dir).filter(f => f.startsWith(prefix)).map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * If the DB is legacy, write a consistent copy to `<file>.bak-<timestamp>` (mode 0600). Done at most
 * once: if any `.bak-*` already exists (e.g. from an earlier failed start) no new copy is made, so a
 * restart loop cannot litter the disk with copies of the plaintext token.
 */
export function backupIfLegacy(db: Database.Database, file: string): string | null {
  if (file === ':memory:' || !isLegacyDb(db)) return null;
  const existing = listBackups(file);
  if (existing.length > 0) {
    console.log(`Legacy database detected; backup already exists (${existing[0]}), not creating another`);
    return null;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const target = `${file}.bak-${stamp}`;
  // VACUUM INTO accepts an existing *empty* file. Create it with mode 0600 first ('wx' + mode, so
  // it is never more permissive than 0600 regardless of umask) so the plaintext copy is never
  // readable by other users, not even briefly.
  fs.closeSync(fs.openSync(target, 'wx', 0o600));
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } catch (e) {
    fs.rmSync(target, { force: true });
    throw e;
  }
  chmod600(target);
  console.log(`Legacy database detected; backup written to ${target}`);
  return target;
}

// ---------------------------------------------------------------------------------------------
// State inspection + requirement checks. Shared by the read-only pre-flight (before any write) and
// by runStartupMigrations, so a failing start can never half-apply anything.
// ---------------------------------------------------------------------------------------------

interface DbState {
  hasPlaintextPat: boolean;
  hasOwnerlessData: boolean; // cards / sync_log rows that need an owner (legacy data)
  userCount: number;
  riseupRows: number;
}

const countRows = (db: Database.Database, table: string, where = '1=1'): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

function ownerlessCount(db: Database.Database, table: string): number {
  const cols = tableColumns(db, table);
  if (!cols) return 0;
  return countRows(db, table, cols.includes('user_id') ? 'user_id IS NULL' : '1=1');
}

function inspectState(db: Database.Database): DbState {
  const hasPlaintextPat = !!tableColumns(db, 'settings') &&
    !!db.prepare(`SELECT 1 FROM settings WHERE key = 'riseup_pat'`).get();
  return {
    hasPlaintextPat,
    hasOwnerlessData: ownerlessCount(db, 'cards') > 0 || ownerlessCount(db, 'sync_log') > 0,
    userCount: tableColumns(db, 'users') ? countRows(db, 'users') : 0,
    riseupRows: tableColumns(db, 'user_riseup') ? countRows(db, 'user_riseup') : 0,
  };
}

/** ADMIN_PASSWORD, or the contents of ADMIN_PASSWORD_FILE (trailing newline stripped). */
export function resolveAdminPassword(env: Env): string | undefined {
  const file = env.ADMIN_PASSWORD_FILE?.trim();
  if (file) {
    if (env.ADMIN_PASSWORD) throw new MigrationError('Set only one of ADMIN_PASSWORD and ADMIN_PASSWORD_FILE.');
    try {
      return fs.readFileSync(file, 'utf8').replace(/[\r\n]+$/, '');
    } catch {
      throw new MigrationError(`ADMIN_PASSWORD_FILE (${file}) could not be read.`);
    }
  }
  return env.ADMIN_PASSWORD;
}

const hasAdminEnv = (env: Env) => !!env.ADMIN_EMAIL?.trim() || !!env.ADMIN_PASSWORD || !!env.ADMIN_PASSWORD_FILE?.trim();

/** Validate the admin env vars; returns the credentials. */
function requireAdminEnv(env: Env, legacyData: boolean): { email: string; password: string } {
  const email = env.ADMIN_EMAIL?.trim();
  const password = resolveAdminPassword(env);
  if (!email || !password) {
    throw new MigrationError(
      legacyData
        ? 'Legacy data found but no users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD (or ADMIN_PASSWORD_FILE) to create the admin account that will own it.'
        : 'ADMIN_EMAIL and ADMIN_PASSWORD (or ADMIN_PASSWORD_FILE) must both be set to create the admin account.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new MigrationError('ADMIN_EMAIL is not a valid email address.');
  if ([...password.normalize('NFC')].length < 12) throw new MigrationError('ADMIN_PASSWORD must be at least 12 characters.');
  if (passwordShapeError(password)) throw new MigrationError('ADMIN_PASSWORD must not contain NUL characters or consist only of whitespace.');
  return { email, password };
}

/** Every stored token must decrypt with the configured keys; fail with the cause otherwise. */
function verifyRows(db: Database.Database, env: Env): void {
  const rows = db.prepare(`SELECT user_id, pat_ciphertext, iv, tag, key_version FROM user_riseup`)
    .all() as Array<PatRow & { user_id: string }>;
  for (const r of rows) {
    try {
      decryptPat(r, r.user_id, env);
    } catch (e: any) {
      throw new MigrationError(
        `Cannot decrypt the stored RiseUp token of user ${r.user_id} (key_version ${r.key_version}): ${e.message} ` +
        `Check TOKEN_ENC_KEY, TOKEN_ENC_KEY_VERSION and TOKEN_ENC_KEY_PREV. No data was modified.`);
    }
  }
}

/** Throws MigrationError if the env cannot support what the DB state requires. Never writes. */
function checkRequirements(db: Database.Database, state: DbState, env: Env): void {
  const legacyData = state.hasPlaintextPat || state.hasOwnerlessData;
  if (state.hasPlaintextPat || state.riseupRows > 0) {
    try {
      parseKey(env.TOKEN_ENC_KEY, 'TOKEN_ENC_KEY');
      currentKeyVersion(env);
    } catch (e: any) {
      throw new MigrationError(
        `The database holds a RiseUp token that must be (en|de)crypted, but ${e.message} ` +
        `No data was modified.`);
    }
  }
  if (state.userCount === 0 && (legacyData || hasAdminEnv(env))) requireAdminEnv(env, legacyData);
  if (state.riseupRows > 0) verifyRows(db, env);
}

/**
 * Read-only pre-flight on an existing DB file, run BEFORE any backup, journal-mode change or schema
 * change. Throws MigrationError (leaving the file byte-for-byte untouched) when the environment
 * cannot support the migration: bad/missing TOKEN_ENC_KEY, undecryptable tokens, missing ADMIN_*.
 */
export function preflight(file: string, env: Env): void {
  if (file === ':memory:' || !fs.existsSync(file)) return;
  const ro = new Database(file, { readonly: true, fileMustExist: true });
  try {
    checkRequirements(ro, inspectState(ro), env);
  } finally {
    ro.close();
  }
}

/**
 * Async startup migrations (password hashing is async). Idempotent; call and await before listen().
 * - creates the admin user from ADMIN_EMAIL/ADMIN_PASSWORD when needed
 * - assigns legacy cards/sync_log rows to the admin
 * - moves the plaintext settings.riseup_pat into user_riseup (AES-256-GCM) and deletes it
 * - verifies every stored token decrypts, and re-encrypts rows still on an older key version
 */
export async function runStartupMigrations(db: Database.Database, env: Env = process.env): Promise<void> {
  const state = inspectState(db);
  const legacyData = state.hasPlaintextPat || state.hasOwnerlessData;
  if (state.userCount === 0 && !legacyData && !hasAdminEnv(env)) return; // fresh install, nothing to do

  // Validate everything up front so we refuse to start before touching any data.
  checkRequirements(db, state, env);

  const patRow = state.hasPlaintextPat
    ? db.prepare(`SELECT value FROM settings WHERE key = 'riseup_pat'`).get() as { value: string }
    : undefined;
  const lastSyncRow = tableColumns(db, 'settings')
    ? db.prepare(`SELECT value FROM settings WHERE key = 'riseup_last_sync'`).get() as { value: string } | undefined
    : undefined;

  let newAdmin: { id: string; email: string; hash: string } | null = null;
  if (state.userCount === 0) {
    const { email, password } = requireAdminEnv(env, legacyData);
    newAdmin = { id: randomUUID(), email, hash: await hashPassword(password) };
  }

  if (newAdmin || legacyData) {
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
      if (tableColumns(db, 'settings')) db.prepare(`DELETE FROM settings WHERE key = 'riseup_last_sync'`).run();
    });
    db.pragma('secure_delete = ON');
    migrate(); // single transaction: a throw anywhere rolls everything back

    if (patRow) {
      // Rewrite the whole file so earlier plaintext copies of the PAT in free pages are purged,
      // then flush/truncate the WAL.
      db.exec('VACUUM');
      if (db.name !== ':memory:') db.pragma('wal_checkpoint(TRUNCATE)');
      const backups = db.name === ':memory:' ? [] : listBackups(db.name);
      console.warn(
        'WARNING: the RiseUp token was encrypted and the plaintext removed from the database, but the ' +
        `pre-migration backup ${backups.length ? backups.join(', ') : '(<db>.bak-*)'} still contains the PLAINTEXT token. ` +
        'Verify the app works, then delete the backup (and any copies of it).');
    }
  }

  const upgraded = upgradeAllRows(db, env);
  if (upgraded > 0) console.log(`${upgraded} rows re-encrypted with key version ${currentKeyVersion(env)}`);
}
