import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { backupIfLegacy, restrictDbFilePermissions, preflight, MigrationError } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB_PATH overrides the default location (use ':memory:' or a temp file in tests).
export const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/rewards.db');

/** Create the (sync) schema and run ad-hoc backward-compatible migrations. Idempotent. */
export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      failed_attempts INTEGER DEFAULT 0,
      locked_until INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER DEFAULT (unixepoch()),
      last_seen INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS user_riseup (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      pat_ciphertext BLOB NOT NULL,
      iv BLOB NOT NULL,
      tag BLOB NOT NULL,
      key_version INTEGER NOT NULL DEFAULT 1,
      last_sync INTEGER
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      last4 TEXT,
      color TEXT DEFAULT '#6366f1',
      icon TEXT,
      credentials TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      riseup_account_id TEXT,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      target_amount REAL NOT NULL,
      period_type TEXT NOT NULL CHECK(period_type IN ('monthly', 'quarterly', 'yearly', 'custom')),
      period_start TEXT,
      period_end TEXT,
      reward_description TEXT,
      reward_value REAL,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      description TEXT,
      category TEXT,
      original_currency TEXT,
      original_amount REAL,
      type TEXT DEFAULT 'normal',
      raw TEXT,
      PRIMARY KEY (card_id, id),
      FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      synced_at INTEGER DEFAULT (unixepoch()),
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const columns = (table: string) =>
    new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));

  const cardCols = columns('cards');
  if (!cardCols.has('source')) db.exec(`ALTER TABLE cards ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
  if (!cardCols.has('riseup_account_id')) db.exec(`ALTER TABLE cards ADD COLUMN riseup_account_id TEXT`);
  if (!cardCols.has('user_id')) db.exec(`ALTER TABLE cards ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE`);
  if (!columns('sync_log').has('user_id')) {
    db.exec(`ALTER TABLE sync_log ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE`);
  }

  // RiseUp accounts are unique per user (two users may sync the same account hash).
  db.exec(`
    DROP INDEX IF EXISTS idx_cards_riseup_account;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_user_riseup_account
      ON cards(user_id, riseup_account_id) WHERE riseup_account_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_cards_user ON cards(user_id);
    CREATE INDEX IF NOT EXISTS idx_sync_log_user ON sync_log(user_id);
  `);

  // Legacy transactions had PRIMARY KEY(id) alone. SQLite cannot alter a PK, so rebuild the
  // table. Transaction ids come from RiseUp and are only unique per card/user.
  const pkCols = (db.prepare(`PRAGMA table_info(transactions)`).all() as Array<{ name: string; pk: number }>)
    .filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  if (pkCols.join(',') !== 'card_id,id') rebuildTransactions(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_transactions_card_date ON transactions(card_id, date);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
  `);
}


/**
 * SQLite's documented 12-step table rebuild: foreign keys OFF (the pragma is a no-op inside a
 * transaction), rebuild in one transaction, foreign_key_check before COMMIT, restore the pragma.
 * Legacy rows whose card no longer exists cannot satisfy the FK; they are copied to
 * `transactions_orphaned_<timestamp>` (for recovery) and left out of the new table.
 */
function rebuildTransactions(db: Database.Database): void {
  const fkWas = db.pragma('foreign_keys', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const orphans = (db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE card_id NOT IN (SELECT id FROM cards)`).get() as { n: number }).n;
      if (orphans > 0) {
        const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const table = `transactions_orphaned_${stamp}`;
        db.exec(`CREATE TABLE "${table}" AS SELECT * FROM transactions WHERE card_id NOT IN (SELECT id FROM cards)`);
        console.warn(`Migration: ${orphans} transaction(s) referenced a missing card; copied to table ${table} and dropped from transactions.`);
      }
      const orphanGoals = (db.prepare(`SELECT COUNT(*) AS n FROM goals WHERE card_id NOT IN (SELECT id FROM cards)`).get() as { n: number }).n;
      if (orphanGoals > 0) console.warn(`Migration: ${orphanGoals} goal(s) reference a missing card (left unchanged).`);

      db.exec(`
        DROP TABLE IF EXISTS transactions_new;
        CREATE TABLE transactions_new (
          id TEXT NOT NULL,
          card_id TEXT NOT NULL,
          amount REAL NOT NULL,
          date TEXT NOT NULL,
          description TEXT,
          category TEXT,
          original_currency TEXT,
          original_amount REAL,
          type TEXT DEFAULT 'normal',
          raw TEXT,
          PRIMARY KEY (card_id, id),
          FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
        );
        INSERT INTO transactions_new (id, card_id, amount, date, description, category, original_currency, original_amount, type, raw)
          SELECT id, card_id, amount, date, description, category, original_currency, original_amount, type, raw
          FROM transactions WHERE card_id IN (SELECT id FROM cards);
        DROP TABLE transactions;
        ALTER TABLE transactions_new RENAME TO transactions;
      `);
      const violations = db.pragma('foreign_key_check(transactions)') as unknown[];
      if (violations.length > 0) throw new Error(`transactions rebuild left ${violations.length} foreign key violation(s); rolled back.`);
    })();
  } finally {
    db.pragma(`foreign_keys = ${fkWas ? 'ON' : 'OFF'}`);
  }
}

export interface OpenOptions {
  /** When given, run the read-only pre-flight against this env before touching an existing file. */
  env?: Record<string, string | undefined>;
}

/**
 * Open a database at `file` (or ':memory:'). For an existing file with `opts.env`, a read-only
 * pre-flight runs first (key / admin env must support the migration); only then is a legacy DB backed
 * up (once) and the schema applied. A failed pre-flight leaves the file untouched.
 */
export function openDatabase(file: string, opts: OpenOptions = {}): Database.Database {
  const isMemory = file === ':memory:';
  if (!isMemory) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (opts.env) preflight(file, opts.env);
  }
  const db = new Database(file);
  try {
    if (!isMemory) {
      backupIfLegacy(db, file);
      db.pragma('journal_mode = WAL');
    }
    db.pragma('foreign_keys = ON');
    initSchema(db);
    if (!isMemory) restrictDbFilePermissions(file);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

function openAtStartup(): Database.Database {
  try {
    return openDatabase(DB_PATH, { env: process.env });
  } catch (err: any) {
    if (err instanceof MigrationError) {
      console.error(`Startup aborted: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

const db = openAtStartup();

export default db;
