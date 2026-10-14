import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db.js';
import { parseCliArgs, intFlag, UsageError } from '../src/cli/args.js';
import { cliCreateInvite, cliPromoteAdmin, CliError } from '../src/cli/actions.js';

function mem() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}
function addUser(db: Database.Database, email: string, o: { admin?: boolean; disabled?: boolean; at?: number } = {}) {
  const id = `id-${email}`;
  db.prepare(`INSERT INTO users (id, email, password_hash, is_admin, created_at, disabled_at) VALUES (?, ?, 'x', ?, ?, ?)`)
    .run(id, email, o.admin ? 1 : 0, o.at ?? 100, o.disabled ? 5 : null);
  return id;
}
const audit = (db: Database.Database) => db.prepare(`SELECT actor_user_id, action, target FROM admin_audit ORDER BY id`).all();

describe('strict CLI argument parsing', () => {
  const spec = { days: 'int', uses: 'int', label: 'string', as: 'string' } as const;
  it('accepts valid forms', () => {
    expect(parseCliArgs(['--days', '3', '--label=hi there', '--as', 'a@b.co'], spec).flags).toEqual({ days: '3', label: 'hi there', as: 'a@b.co' });
    expect(parseCliArgs(['x@y.zz'], {}, 1).positionals).toEqual(['x@y.zz']);
  });
  it('rejects unknown flags, missing values, repeats, bad ints and stray args', () => {
    expect(() => parseCliArgs(['--use', '5'], spec)).toThrow(/Unknown option --use/);
    expect(() => parseCliArgs(['--label', '--days', '3'], spec)).toThrow(/--label needs a value/);
    expect(() => parseCliArgs(['--days'], spec)).toThrow(/needs a value/);
    expect(() => parseCliArgs(['--days='], spec)).toThrow(/needs a value/);
    expect(() => parseCliArgs(['--days', '1', '--days', '2'], spec)).toThrow(/more than once/);
    expect(() => parseCliArgs(['--days', 'x'], spec)).toThrow(/integer/);
    expect(() => parseCliArgs(['stray'], spec)).toThrow(UsageError);
    expect(() => parseCliArgs(['a', 'b'], {}, 1)).toThrow(/Unexpected argument: b/);
    expect(() => parseCliArgs(['--__proto__', '1'], spec)).toThrow(/Unknown option/);
    expect(() => intFlag({ days: '91' }, 'days', 7, 1, 90)).toThrow(/between 1 and 90/);
    expect(intFlag({}, 'days', 7, 1, 90)).toBe(7);
  });
});

describe('promote-admin', () => {
  it('promotes an enabled user and writes an audit row (actor = oldest admin)', () => {
    const db = mem();
    const a1 = addUser(db, 'a1@example.com', { admin: true, at: 10 });
    addUser(db, 'a2@example.com', { admin: true, at: 20 });
    const u = addUser(db, 'user@example.com');
    expect(cliPromoteAdmin(db, { email: ' User@Example.com ', nowSec: 1000 })).toEqual({ alreadyAdmin: false, email: 'user@example.com' });
    expect(db.prepare(`SELECT is_admin FROM users WHERE id = ?`).get(u)).toEqual({ is_admin: 1 });
    expect(audit(db)).toEqual([{ actor_user_id: a1, action: 'user.promote_cli', target: u }]);
  });
  it('--as picks the audit actor; it must be an enabled admin', () => {
    const db = mem();
    addUser(db, 'a1@example.com', { admin: true, at: 10 });
    const a2 = addUser(db, 'a2@example.com', { admin: true, at: 20 });
    addUser(db, 'user@example.com');
    addUser(db, 'plain@example.com');
    expect(() => cliPromoteAdmin(db, { email: 'user@example.com', as: 'plain@example.com', nowSec: 1 })).toThrow(CliError);
    expect(audit(db)).toEqual([]);
    cliPromoteAdmin(db, { email: 'user@example.com', as: 'a2@example.com', nowSec: 1 });
    expect(audit(db)[0]).toMatchObject({ actor_user_id: a2 });
  });
  it('recovers an install with users but no admin (actor = the promoted user)', () => {
    const db = mem();
    const u = addUser(db, 'user@example.com');
    cliPromoteAdmin(db, { email: 'user@example.com', nowSec: 1 });
    expect(db.prepare(`SELECT is_admin FROM users WHERE id = ?`).get(u)).toEqual({ is_admin: 1 });
    expect(audit(db)).toEqual([{ actor_user_id: u, action: 'user.promote_cli', target: u }]);
  });
  it('refuses unknown and disabled users without changing anything; already-admin is a no-op', () => {
    const db = mem();
    const admin = addUser(db, 'a@example.com', { admin: true });
    const dis = addUser(db, 'dis@example.com', { disabled: true });
    expect(() => cliPromoteAdmin(db, { email: 'nobody@example.com', nowSec: 1 })).toThrow(/No user/);
    expect(() => cliPromoteAdmin(db, { email: 'dis@example.com', nowSec: 1 })).toThrow(/disabled/);
    expect(db.prepare(`SELECT is_admin FROM users WHERE id = ?`).get(dis)).toEqual({ is_admin: 0 });
    expect(cliPromoteAdmin(db, { email: 'a@example.com', nowSec: 1 }).alreadyAdmin).toBe(true);
    expect(audit(db)).toEqual([]);
    expect(admin).toBeTruthy();
  });
});

describe('create-invite action', () => {
  it('audits as --as or the oldest admin, and fails without an enabled admin', () => {
    const db = mem();
    expect(() => cliCreateInvite(db, { days: 7, uses: 1, nowSec: 1 })).toThrow(/promote-admin/);
    const a1 = addUser(db, 'a1@example.com', { admin: true, at: 10 });
    const a2 = addUser(db, 'a2@example.com', { admin: true, at: 20 });
    const inv = cliCreateInvite(db, { days: 7, uses: 1, nowSec: 1 });
    expect(inv.path).toMatch(/^\/register#invite=[A-Za-z0-9_-]{43}$/);
    cliCreateInvite(db, { days: 7, uses: 1, as: 'a2@example.com', nowSec: 1 });
    expect(audit(db).map((r) => r.actor_user_id)).toEqual([a1, a2]);
    expect(db.prepare(`SELECT created_by FROM invites ORDER BY rowid`).all()).toEqual([{ created_by: a1 }, { created_by: a2 }]);
  });
});

describe('CLI processes (strict args, exit codes)', () => {
  const root = path.join(__dirname, '..');
  const tsx = path.join(root, 'node_modules/.bin/tsx');
  const hasTsx = fs.existsSync(tsx) || fs.existsSync(path.join(root, '../node_modules/.bin/tsx'));
  const tsxBin = fs.existsSync(tsx) ? tsx : path.join(root, '../node_modules/.bin/tsx');
  const run = (script: string, args: string[], dbFile: string) =>
    spawnSync(tsxBin, [path.join(root, 'src/cli', script), ...args], { env: { ...process.env, DB_PATH: dbFile, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 60_000 });

  it.skipIf(!hasTsx)('exits 2 with usage for bad flags, 0/1 otherwise', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-cli-'));
    try {
      const f = path.join(dir, 'cli.db');
      const seed = new Database(f);
      initSchema(seed);
      addUser(seed, 'a@example.com', { admin: true });
      addUser(seed, 'u@example.com');
      seed.close();
      for (const args of [['--label', '--days', '3'], ['--use', '5'], ['--days'], ['stray']]) {
        const r = run('create-invite.ts', args, f);
        expect(r.status, args.join(' ')).toBe(2);
        expect(r.stderr).toMatch(/Usage: create-invite/);
      }
      expect(run('promote-admin.ts', [], f).status).toBe(2);
      expect(run('promote-admin.ts', ['u@example.com', '--bogus'], f).status).toBe(2);
      expect(run('reset-password.ts', ['--x'], f).status).toBe(2);
      expect(run('promote-admin.ts', ['nobody@example.com'], f).status).toBe(1);
      const ok = run('promote-admin.ts', ['u@example.com'], f);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toMatch(/now an admin/);
      const inv = run('create-invite.ts', ['--days', '2', '--label', 'x', '--as', 'u@example.com'], f);
      expect(inv.status).toBe(0);
      expect(inv.stdout).toMatch(/\/register#invite=/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
