import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { openDatabase } from '../src/db.js';
import { runStartupMigrations, MigrationError } from '../src/migrate.js';
import { encryptPat, decryptPat, decryptAndUpgrade, upgradeAllRows } from '../src/crypto.js';
import { hashPassword, verifyPassword } from '../src/password.js';

const KEY = randomBytes(32).toString('base64');
const PAT = 'riseup_pat_' + 'A'.repeat(30);
const ENV = { TOKEN_ENC_KEY: KEY, ADMIN_EMAIL: 'Admin@Example.com', ADMIN_PASSWORD: 'correct horse battery' };

let dir: string;
let dbFile: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapp-')); dbFile = path.join(dir, 'rewards.db'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Create a DB with the pre-multi-user schema and some rows. */
function makeLegacyDb(withPat = true, opts: { orphans?: boolean; stalePatCopy?: boolean } = {}) {
  const d = new Database(dbFile);
  d.exec(`
    CREATE TABLE cards (id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, last4 TEXT,
      color TEXT DEFAULT '#6366f1', icon TEXT, credentials TEXT, source TEXT NOT NULL DEFAULT 'manual',
      riseup_account_id TEXT, created_at INTEGER DEFAULT (unixepoch()));
    CREATE UNIQUE INDEX idx_cards_riseup_account ON cards(riseup_account_id) WHERE riseup_account_id IS NOT NULL;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE goals (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
      target_amount REAL NOT NULL, period_type TEXT NOT NULL, period_start TEXT, period_end TEXT,
      reward_description TEXT, reward_value REAL, active INTEGER DEFAULT 1, created_at INTEGER DEFAULT (unixepoch()),
      FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE);
    CREATE TABLE transactions (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL,
      description TEXT, category TEXT, original_currency TEXT, original_amount REAL, type TEXT DEFAULT 'normal', raw TEXT,
      FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE);
    CREATE TABLE sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, status TEXT NOT NULL,
      message TEXT, synced_at INTEGER DEFAULT (unixepoch()));
    INSERT INTO cards (id, name, provider, source, riseup_account_id) VALUES ('c1','One','riseup','riseup','acc1'), ('c2','Two','visa','manual',NULL);
    INSERT INTO transactions (id, card_id, amount, date, description) VALUES ('t1','c1',10,'2026-01-01','a'), ('t2','c1',20,'2026-01-02','b'), ('t3','c2',5,'2026-01-03','c');
    INSERT INTO goals (id, card_id, name, target_amount, period_type) VALUES ('g1','c1','G',100,'monthly');
    INSERT INTO sync_log (card_id, status, message) VALUES ('riseup','success','ok');
  `);
  if (withPat) d.prepare(`INSERT INTO settings VALUES ('riseup_pat', ?), ('riseup_last_sync', '1700000000')`).run(PAT);
  if (opts.stalePatCopy) { // leaves the PAT in a free page of the file
    d.prepare(`INSERT INTO settings VALUES ('old_copy', ?)`).run(PAT + 'x'.repeat(3000));
    d.prepare(`DELETE FROM settings WHERE key = 'old_copy'`).run();
  }
  if (opts.orphans) {
    d.pragma('foreign_keys = OFF');
    d.exec(`INSERT INTO transactions (id, card_id, amount, date) VALUES ('t9','ghost',1,'2026-01-09');
      INSERT INTO goals (id, card_id, name, target_amount, period_type) VALUES ('g9','ghost','Orphan',1,'monthly');`);
  }
  d.close();
}

const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const backupsOf = () => fs.readdirSync(dir).filter(f => f.includes('.bak-'));
const rowOf = (e: ReturnType<typeof encryptPat>) => ({ pat_ciphertext: e.ciphertext, iv: e.iv, tag: e.tag, key_version: e.keyVersion });

const pkOf = (d: Database.Database) =>
  (d.prepare(`PRAGMA table_info(transactions)`).all() as any[]).filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);

describe('legacy migration', () => {
  it('migrates a legacy DB, encrypts the PAT and keeps all rows', async () => {
    makeLegacyDb();
    const db = openDatabase(dbFile);
    await runStartupMigrations(db, ENV);

    const admin = db.prepare(`SELECT * FROM users`).get() as any;
    expect(admin.email).toBe('Admin@Example.com');
    expect(admin.is_admin).toBe(1);
    expect(await verifyPassword(admin.password_hash, ENV.ADMIN_PASSWORD)).toBe(true);

    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE user_id = ?`).get(admin.id)).toEqual({ n: 2 });
    expect(db.prepare(`SELECT COUNT(*) n FROM sync_log WHERE user_id = ?`).get(admin.id)).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) n FROM transactions`).get()).toEqual({ n: 3 });
    expect(db.prepare(`SELECT COUNT(*) n FROM goals`).get()).toEqual({ n: 1 });
    expect(pkOf(db)).toEqual(['card_id', 'id']);
    expect(db.prepare(`PRAGMA foreign_keys`).get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare(`PRAGMA journal_mode`).get()).toEqual({ journal_mode: 'wal' });

    const row = db.prepare(`SELECT * FROM user_riseup WHERE user_id = ?`).get(admin.id) as any;
    expect(row.last_sync).toBe(1700000000);
    expect(decryptPat(row, admin.id, ENV)).toBe(PAT);
    expect(row.pat_ciphertext.includes(Buffer.from(PAT))).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) n FROM settings`).get()).toEqual({ n: 0 });
    for (const f of [dbFile, `${dbFile}-wal`]) {
      if (fs.existsSync(f)) expect(fs.readFileSync(f).includes(Buffer.from(PAT))).toBe(false);
    }

    const backups = fs.readdirSync(dir).filter(f => f.startsWith('rewards.db.bak-'));
    expect(backups).toHaveLength(1);
    expect(fs.statSync(path.join(dir, backups[0])).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dbFile).mode & 0o777).toBe(0o600);
    const bak = new Database(path.join(dir, backups[0]), { readonly: true });
    expect((bak.prepare(`SELECT value FROM settings WHERE key='riseup_pat'`).get() as any).value).toBe(PAT);
    bak.close();
    db.close();
  });

  it('is a no-op on the second run', async () => {
    makeLegacyDb();
    let db = openDatabase(dbFile);
    await runStartupMigrations(db, ENV);
    const before = db.prepare(`SELECT * FROM user_riseup`).get() as any;
    const userBefore = db.prepare(`SELECT * FROM users`).get() as any;
    db.close();

    db = openDatabase(dbFile);
    await runStartupMigrations(db, ENV);
    expect(db.prepare(`SELECT * FROM user_riseup`).get()).toEqual(before);
    expect(db.prepare(`SELECT * FROM users`).get()).toEqual(userBefore);
    expect(db.prepare(`SELECT COUNT(*) n FROM transactions`).get()).toEqual({ n: 3 });
    expect(fs.readdirSync(dir).filter(f => f.includes('.bak-'))).toHaveLength(1);
    db.close();
  });

  it('refuses when a PAT exists but no key is configured, leaving the plaintext intact', async () => {
    makeLegacyDb();
    const db = openDatabase(dbFile);
    await expect(runStartupMigrations(db, { ADMIN_EMAIL: ENV.ADMIN_EMAIL, ADMIN_PASSWORD: ENV.ADMIN_PASSWORD }))
      .rejects.toThrow(/TOKEN_ENC_KEY/);
    expect((db.prepare(`SELECT value FROM settings WHERE key='riseup_pat'`).get() as any).value).toBe(PAT);
    expect(db.prepare(`SELECT COUNT(*) n FROM users`).get()).toEqual({ n: 0 });
    db.close();
  });

  it('refuses when legacy data exists without ADMIN_EMAIL/ADMIN_PASSWORD', async () => {
    makeLegacyDb(false);
    const db = openDatabase(dbFile);
    await expect(runStartupMigrations(db, { TOKEN_ENC_KEY: KEY })).rejects.toThrow(/ADMIN_EMAIL/);
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE user_id IS NULL`).get()).toEqual({ n: 2 });
    db.close();
  });

  it('does nothing on a fresh DB without ADMIN_* and makes no backup', async () => {
    const db = openDatabase(dbFile);
    await runStartupMigrations(db, {});
    expect(db.prepare(`SELECT COUNT(*) n FROM users`).get()).toEqual({ n: 0 });
    expect(fs.readdirSync(dir).filter(f => f.includes('.bak-'))).toHaveLength(0);
    db.close();
  });
});

describe('pre-flight (B1)', () => {
  it('3 failing starts without env: no backup, DB file byte-identical, still legacy', () => {
    makeLegacyDb();
    const before = sha(dbFile);
    const entries = fs.readdirSync(dir).sort();
    for (const env of [{}, { ADMIN_EMAIL: ENV.ADMIN_EMAIL, ADMIN_PASSWORD: ENV.ADMIN_PASSWORD }, { TOKEN_ENC_KEY: KEY }]) {
      expect(() => openDatabase(dbFile, { env })).toThrow(MigrationError);
    }
    expect(backupsOf()).toHaveLength(0);
    expect(fs.readdirSync(dir).sort()).toEqual(entries); // no -wal/-shm/backup appeared
    expect(sha(dbFile)).toBe(before);
    const d = new Database(dbFile, { readonly: true });
    expect(pkOf(d)).toEqual(['id']);
    expect(d.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'idx_cards_riseup_account'`).get()).toBeTruthy();
    expect(d.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'users'`).get()).toBeUndefined();
    d.close();
  });

  it('creates the backup only once even if a start succeeds past pre-flight repeatedly; mode 0600', () => {
    makeLegacyDb();
    openDatabase(dbFile, { env: ENV }).close();
    openDatabase(dbFile, { env: ENV }).close(); // PAT still plaintext => still "legacy"
    expect(backupsOf()).toHaveLength(1);
    expect(fs.statSync(path.join(dir, backupsOf()[0])).mode & 0o777).toBe(0o600);
  });

  it('backup is created 0600 even under a permissive umask', () => {
    makeLegacyDb();
    const old = process.umask(0o000);
    try { openDatabase(dbFile, { env: ENV }).close(); } finally { process.umask(old); }
    expect(fs.statSync(path.join(dir, backupsOf()[0])).mode & 0o777).toBe(0o600);
  });

  it('an already-migrated DB needs the key at pre-flight', async () => {
    makeLegacyDb();
    let db = openDatabase(dbFile, { env: ENV });
    await runStartupMigrations(db, ENV);
    db.close();
    const before = sha(dbFile);
    expect(() => openDatabase(dbFile, { env: {} })).toThrow(/TOKEN_ENC_KEY/);
    expect(() => openDatabase(dbFile, { env: { TOKEN_ENC_KEY: randomBytes(32).toString('base64') } })).toThrow(/Cannot decrypt/);
    expect(sha(dbFile)).toBe(before);
    db = openDatabase(dbFile, { env: ENV });
    db.close();
  });
});

describe('orphan rows during transactions rebuild (S1)', () => {
  it('rebuilds with FK on, preserves orphans in a side table, warns', async () => {
    makeLegacyDb(true, { orphans: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = openDatabase(dbFile);
    expect(pkOf(db)).toEqual(['card_id', 'id']);
    expect(db.prepare(`SELECT COUNT(*) n FROM transactions`).get()).toEqual({ n: 3 });
    const side = (db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'transactions_orphaned_%'`).all() as any[]);
    expect(side).toHaveLength(1);
    expect(db.prepare(`SELECT id FROM "${side[0].name}"`).all()).toEqual([{ id: 't9' }]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/1 transaction/);
    expect(warn.mock.calls.flat().join('\n')).toMatch(/1 goal/);
    expect(db.prepare(`SELECT COUNT(*) n FROM goals`).get()).toEqual({ n: 2 });
    await runStartupMigrations(db, ENV);
    db.close();
    warn.mockRestore();
  });
});

describe('startup safety nets', () => {
  it('crash mid-migration commits nothing and a rerun succeeds', async () => {
    makeLegacyDb();
    const db = openDatabase(dbFile);
    db.exec(`CREATE TRIGGER boom BEFORE DELETE ON settings WHEN OLD.key = 'riseup_pat' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    await expect(runStartupMigrations(db, ENV)).rejects.toThrow(/boom/);
    expect(db.prepare(`SELECT COUNT(*) n FROM users`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) n FROM user_riseup`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) n FROM cards WHERE user_id IS NULL`).get()).toEqual({ n: 2 });
    expect((db.prepare(`SELECT value FROM settings WHERE key='riseup_pat'`).get() as any).value).toBe(PAT);
    db.exec(`DROP TRIGGER boom`);
    await runStartupMigrations(db, ENV);
    expect(db.prepare(`SELECT COUNT(*) n FROM users`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) n FROM user_riseup`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) n FROM settings WHERE key='riseup_pat'`).get()).toEqual({ n: 0 });
    db.close();
  });

  it('purges the old plaintext PAT from the raw DB file (free pages) and warns about the backup', async () => {
    makeLegacyDb(true, { stalePatCopy: true });
    expect(fs.readFileSync(dbFile).includes(Buffer.from(PAT))).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = openDatabase(dbFile);
    await runStartupMigrations(db, ENV);
    db.close();
    for (const f of [dbFile, `${dbFile}-wal`]) {
      if (fs.existsSync(f)) expect(fs.readFileSync(f).includes(Buffer.from(PAT))).toBe(false);
    }
    const msg = warn.mock.calls.flat().join('\n');
    expect(msg).toMatch(/PLAINTEXT/);
    expect(msg).toMatch(/delete the backup/);
    warn.mockRestore(); log.mockRestore();
  });

  it('refuses to start (migrated DB) without the key, or with an unknown key_version', async () => {
    makeLegacyDb();
    const db = openDatabase(dbFile);
    await runStartupMigrations(db, ENV);
    await expect(runStartupMigrations(db, { })).rejects.toThrow(/TOKEN_ENC_KEY/);
    await expect(runStartupMigrations(db, { TOKEN_ENC_KEY: KEY, TOKEN_ENC_KEY_VERSION: '5' })).rejects.toThrow(/key_version 1.*TOKEN_ENC_KEY_PREV/s);
    await expect(runStartupMigrations(db, { TOKEN_ENC_KEY: randomBytes(32).toString('base64') })).rejects.toThrow(/Cannot decrypt the stored RiseUp token/);
    db.close();
  });

  it('ADMIN_PASSWORD_FILE works, is trimmed of the trailing newline, and conflicts with ADMIN_PASSWORD', async () => {
    makeLegacyDb(false);
    const pwFile = path.join(dir, 'pw');
    fs.writeFileSync(pwFile, 'file based password\n');
    const db = openDatabase(dbFile);
    const env = { TOKEN_ENC_KEY: KEY, ADMIN_EMAIL: 'a@example.com', ADMIN_PASSWORD_FILE: pwFile };
    await expect(runStartupMigrations(db, { ...env, ADMIN_PASSWORD: 'something else long' })).rejects.toThrow(/only one/);
    await expect(runStartupMigrations(db, { ...env, ADMIN_PASSWORD_FILE: path.join(dir, 'missing') })).rejects.toThrow(/could not be read/);
    await runStartupMigrations(db, env);
    const admin = db.prepare(`SELECT password_hash FROM users`).get() as any;
    expect(await verifyPassword(admin.password_hash, 'file based password')).toBe(true);
    db.close();
  });
});

describe('transactions keyed by (card_id, id)', () => {
  it('lets cards of different users share a transaction id; upsert does not overwrite the other row', async () => {
    const db = openDatabase(dbFile);
    const mkUser = (id: string) => db.prepare(`INSERT INTO users (id,email,password_hash) VALUES (?,?,'x')`).run(id, `${id}@x.com`);
    mkUser('u1'); mkUser('u2');
    const mkCard = (id: string, u: string) => db.prepare(`INSERT INTO cards (id,name,provider,user_id,riseup_account_id) VALUES (?, 'n','riseup',?, 'same-hash')`).run(id, u);
    mkCard('cA', 'u1'); mkCard('cB', 'u2'); // same riseup_account_id allowed across users
    expect(() => mkCard('cC', 'u1')).toThrow(/UNIQUE/);
    const upsert = db.prepare(`INSERT INTO transactions (id, card_id, amount, date) VALUES ('tx', ?, ?, '2026-01-01')
      ON CONFLICT(card_id, id) DO UPDATE SET amount = excluded.amount`);
    upsert.run('cA', 1); upsert.run('cB', 2); upsert.run('cA', 99);
    expect(db.prepare(`SELECT card_id, amount FROM transactions ORDER BY card_id`).all())
      .toEqual([{ card_id: 'cA', amount: 99 }, { card_id: 'cB', amount: 2 }]);
    db.prepare(`DELETE FROM users WHERE id='u1'`).run(); // cascades
    expect(db.prepare(`SELECT COUNT(*) n FROM transactions`).get()).toEqual({ n: 1 });
    db.close();
  });
});

describe('crypto', () => {
  const env = { TOKEN_ENC_KEY: KEY };
  const toRow = (e: ReturnType<typeof encryptPat>) => ({ pat_ciphertext: e.ciphertext, iv: e.iv, tag: e.tag, key_version: e.keyVersion });

  it('round-trips, with a random 12-byte IV', () => {
    const a = encryptPat(PAT, 'u1', env), b = encryptPat(PAT, 'u1', env);
    expect(a.iv).toHaveLength(12);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(decryptPat(toRow(a), 'u1', env)).toBe(PAT);
  });
  it('accepts a hex key', () => {
    const hex = { TOKEN_ENC_KEY: randomBytes(32).toString('hex') };
    expect(decryptPat(toRow(encryptPat('x', 'u', hex)), 'u', hex)).toBe('x');
  });
  it('fails with a different userId (AAD)', () => {
    expect(() => decryptPat(toRow(encryptPat(PAT, 'u1', env)), 'u2', env)).toThrow();
  });
  it('fails with a tampered tag or ciphertext', () => {
    const e = encryptPat(PAT, 'u1', env);
    const tag = Buffer.from(e.tag); tag[0] ^= 1;
    expect(() => decryptPat({ ...toRow(e), tag }, 'u1', env)).toThrow();
    const ct = Buffer.from(e.ciphertext); ct[0] ^= 1;
    expect(() => decryptPat({ ...toRow(e), pat_ciphertext: ct }, 'u1', env)).toThrow();
  });
  it('rejects bad key lengths/formats and a missing key', () => {
    expect(() => encryptPat('x', 'u', { TOKEN_ENC_KEY: randomBytes(16).toString('base64') })).toThrow(/32 bytes/);
    expect(() => encryptPat('x', 'u', { TOKEN_ENC_KEY: 'short' })).toThrow(/32 bytes/);
    expect(() => encryptPat('x', 'u', {})).toThrow(/TOKEN_ENC_KEY/);
  });
  it('supports rotation via TOKEN_ENC_KEY_PREV', () => {
    const oldKey = randomBytes(32).toString('base64');
    const old = encryptPat(PAT, 'u1', { TOKEN_ENC_KEY: oldKey });
    expect(old.keyVersion).toBe(1);
    const rotated = { TOKEN_ENC_KEY: KEY, TOKEN_ENC_KEY_VERSION: '2', TOKEN_ENC_KEY_PREV: oldKey };
    expect(decryptPat(toRow(old), 'u1', rotated)).toBe(PAT);
    const fresh = encryptPat(PAT, 'u1', rotated);
    expect(fresh.keyVersion).toBe(2);
    expect(decryptPat(toRow(fresh), 'u1', rotated)).toBe(PAT);
    expect(() => decryptPat(toRow(old), 'u1', { ...rotated, TOKEN_ENC_KEY_PREV: undefined })).toThrow(/TOKEN_ENC_KEY_PREV/);
  });
});

describe('crypto hardening and rotation', () => {
  it('rejects truncated / wrong-length tag and iv with a generic error', () => {
    const env = { TOKEN_ENC_KEY: KEY };
    const e = encryptPat(PAT, 'u1', env);
    for (const bad of [{ tag: e.tag.subarray(0, 8) }, { tag: e.tag.subarray(0, 4) }, { iv: e.iv.subarray(0, 8) }, { iv: Buffer.concat([e.iv, Buffer.alloc(4)]) }]) {
      expect(() => decryptPat({ ...rowOf(e), ...bad }, 'u1', env)).toThrow(/^Failed to decrypt token \(wrong key, wrong user, or tampered data\)$/);
    }
  });

  function setup() {
    const db = openDatabase(':memory:');
    db.prepare(`INSERT INTO users (id,email,password_hash) VALUES ('u1','u1@x.com','x')`).run();
    return db;
  }
  const store = (db: Database.Database, e: ReturnType<typeof encryptPat>) =>
    db.prepare(`INSERT OR REPLACE INTO user_riseup (user_id, pat_ciphertext, iv, tag, key_version, last_sync) VALUES ('u1', ?, ?, ?, ?, 42)`)
      .run(e.ciphertext, e.iv, e.tag, e.keyVersion);
  const version = (db: Database.Database) => (db.prepare(`SELECT key_version v, last_sync s FROM user_riseup`).get() as any);

  it('lazily re-encrypts on decrypt, then survives two rotations in a row', () => {
    const k1 = randomBytes(32).toString('base64'), k2 = randomBytes(32).toString('base64'), k3 = randomBytes(32).toString('base64');
    const db = setup();
    store(db, encryptPat(PAT, 'u1', { TOKEN_ENC_KEY: k1 }));

    const env2 = { TOKEN_ENC_KEY: k2, TOKEN_ENC_KEY_VERSION: '2', TOKEN_ENC_KEY_PREV: k1 };
    expect(decryptAndUpgrade(db, 'u1', env2)).toBe(PAT);
    expect(version(db)).toEqual({ v: 2, s: 42 });

    // second rotation: only k2 (now PREV) is needed, k1 is gone
    const env3 = { TOKEN_ENC_KEY: k3, TOKEN_ENC_KEY_VERSION: '3', TOKEN_ENC_KEY_PREV: k2 };
    expect(decryptAndUpgrade(db, 'u1', env3)).toBe(PAT);
    expect(version(db).v).toBe(3);
    expect(decryptAndUpgrade(db, 'u1', { TOKEN_ENC_KEY: k3, TOKEN_ENC_KEY_VERSION: '3' })).toBe(PAT); // PREV no longer needed
    db.close();
  });

  it('startup pass upgrades all rows and logs the count; a skipped rotation is reported', async () => {
    const k1 = randomBytes(32).toString('base64'), k2 = randomBytes(32).toString('base64'), k3 = randomBytes(32).toString('base64');
    const db = setup();
    store(db, encryptPat(PAT, 'u1', { TOKEN_ENC_KEY: k1 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const env2 = { TOKEN_ENC_KEY: k2, TOKEN_ENC_KEY_VERSION: '2', TOKEN_ENC_KEY_PREV: k1 };
    await runStartupMigrations(db, env2);
    expect(log.mock.calls.flat().join('\n')).toMatch(/1 rows re-encrypted/);
    expect(upgradeAllRows(db, env2)).toBe(0);
    expect(version(db).v).toBe(2);
    // jumping to v4 without passing through v3 cannot read a v2 row
    await expect(runStartupMigrations(db, { TOKEN_ENC_KEY: k3, TOKEN_ENC_KEY_VERSION: '4', TOKEN_ENC_KEY_PREV: k2 }))
      .rejects.toThrow(/key_version 2/);
    log.mockRestore();
    db.close();
  });
});

describe('password', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('s3cret-pass-phrase');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(h, 's3cret-pass-phrase')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});
