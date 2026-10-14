import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createHash } from 'crypto';
import { createApp, type AppOptions } from '../src/app.js';
import db from '../src/db.js';
import { resolveAuthConfig } from '../src/auth/config.js';
import { sessionLoader, requireAuth, requireAdmin } from '../src/auth/middleware.js';
import { cleanupExpiredSessions } from '../src/auth/sessions.js';
import { hashPassword } from '../src/password.js';

const ORIGIN = 'http://app.test';
const PW = 'correct horse battery';
const DAY = 86400_000;
let seq = 0;
const newEmail = () => `user${++seq}@example.com`;

function make(opts: AppOptions = {}) {
  const clock = { t: Date.UTC(2026, 0, 1) };
  const app = createApp({
    allowedOrigins: [ORIGIN],
    cookieSecure: false,
    loginIpMax: 1000, loginEmailMax: 1000, registerIpMax: 1000,
    now: () => clock.t,
    ...opts,
  });
  return { app, clock };
}

type App = ReturnType<typeof make>['app'];
const post = (app: App, path: string, body?: object, cookie?: string) => {
  const r = request(app).post(path).set('Origin', ORIGIN);
  if (cookie) r.set('Cookie', cookie);
  return body === undefined ? r : r.send(body);
};
const get = (app: App, path: string, cookie?: string) => {
  const r = request(app).get(path);
  return cookie ? r.set('Cookie', cookie) : r;
};
/** "name=value" of the session cookie set by a response. */
const cookieOf = (res: request.Response): string => {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => /^(__Host-)?sid=/.test(c));
  return raw ? raw.split(';')[0] : '';
};
const tokenOf = (cookie: string) => cookie.split('=')[1];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function register(app: App, email = newEmail(), password = PW) {
  const res = await post(app, '/api/auth/register', { email, password });
  return { res, email, cookie: cookieOf(res) };
}

describe('register / me / logout', () => {
  it('registers, auto-logs in with a hardened cookie, and /me works', async () => {
    const { app } = make();
    const { res, email, cookie } = await register(app, '  Mixed.Case@Example.COM ');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'mixed.case@example.com', isAdmin: false });
    expect(cookie).toMatch(/^sid=/);
    const header = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Secure/);
    expect(header).not.toMatch(/Domain/i);
    expect(email).toBe('  Mixed.Case@Example.COM ');

    const me = await get(app, '/api/auth/me', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ id: res.body.id, email: 'mixed.case@example.com', isAdmin: false });
    expect(me.headers['cache-control']).toBe('no-store');
  });

  it('uses __Host-sid + Secure in secure mode, and ignores the plain cookie name', async () => {
    const { app } = make({ cookieSecure: true });
    const { res, cookie } = await register(app);
    const header = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(header).toMatch(/^__Host-sid=/);
    expect(header).toMatch(/; Secure/);
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Domain/i);
    expect((await get(app, '/api/auth/me', cookie)).status).toBe(200);
    expect((await get(app, '/api/auth/me', 'sid=' + tokenOf(cookie))).status).toBe(401);
  });

  it('/me is 401 without a session', async () => {
    const { app } = make();
    expect((await get(app, '/api/auth/me')).status).toBe(401);
    expect((await get(app, '/api/auth/me', 'sid=garbage')).status).toBe(401);
  });

  it('logout revokes the session server-side and clears the cookie', async () => {
    const { app } = make();
    const { cookie } = await register(app);
    const out = await post(app, '/api/auth/logout', undefined, cookie);
    expect(out.status).toBe(200);
    expect((out.headers['set-cookie'] as unknown as string[])[0]).toMatch(/Max-Age=0/);
    expect((await get(app, '/api/auth/me', cookie)).status).toBe(401); // replaying the old cookie fails
  });

  it('stores only the SHA-256 of the token', async () => {
    const { app } = make();
    const { cookie } = await register(app);
    const token = tokenOf(cookie);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(db.prepare(`SELECT 1 FROM sessions WHERE token_hash = ?`).get(sha(token))).toBeTruthy();
    const rows = db.prepare(`SELECT * FROM sessions`).all() as any[];
    expect(rows.some((r) => Object.values(r).some((v) => v === token))).toBe(false);
  });
});

describe('password policy and duplicates', () => {
  it('rejects short, long, common and email-equal passwords', async () => {
    const { app } = make();
    const email = newEmail();
    const bad = ['short1', 'x'.repeat(129), 'Password123', '1234567890', email.toUpperCase()];
    for (const password of bad) {
      const res = await post(app, '/api/auth/register', { email, password });
      expect(res.status, password.slice(0, 12)).toBe(400);
    }
    expect((await post(app, '/api/auth/register', { email, password: 'x'.repeat(128) })).status).toBe(201);
  });

  it('rejects malformed emails', async () => {
    const { app } = make();
    for (const e of ['nope', 'a@b', 'a b@c.com', `${'a'.repeat(250)}@x.com`, 5, null]) {
      expect((await post(app, '/api/auth/register', { email: e, password: PW })).status).toBe(400);
    }
  });

  it('returns 409 for a duplicate email (case-insensitive) without logging in', async () => {
    const { app } = make();
    const { email } = await register(app);
    const dup = await post(app, '/api/auth/register', { email: email.toUpperCase(), password: PW });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('כתובת האימייל כבר רשומה');
    expect(dup.headers['set-cookie']).toBeUndefined();
  });
});

describe('login', () => {
  it('gives an identical generic 401 for wrong password and unknown email', async () => {
    const { app } = make();
    const { email } = await register(app);
    const wrong = await post(app, '/api/auth/login', { email, password: 'not-the-password' });
    const unknown = await post(app, '/api/auth/login', { email: newEmail(), password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual({ error: 'אימייל או סיסמה שגויים' });
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.headers['retry-after']).toBeUndefined();
  });

  it('logs in case-insensitively and rotates the session (old token dies)', async () => {
    const { app } = make();
    const { email, cookie: first } = await register(app);
    const res = await post(app, '/api/auth/login', { email: email.toUpperCase(), password: PW }, first);
    expect(res.status).toBe(200);
    const second = cookieOf(res);
    expect(second).not.toBe(first);
    expect((await get(app, '/api/auth/me', first)).status).toBe(401);
    expect((await get(app, '/api/auth/me', second)).status).toBe(200);
  });

  it('locks after 5 failures with exponential backoff and resets on success', async () => {
    const { app, clock } = make();
    const { email } = await register(app);
    const row = () => db.prepare(`SELECT failed_attempts f, locked_until l FROM users WHERE email = ?`).get(email) as any;
    const bad = () => post(app, '/api/auth/login', { email, password: 'wrong-password-1' });
    const good = () => post(app, '/api/auth/login', { email, password: PW });
    const now = () => Math.floor(clock.t / 1000);

    for (let i = 0; i < 4; i++) { await bad(); expect(row().l).toBeNull(); }
    await bad(); // 5th
    expect(row().f).toBe(5);
    expect(row().l - now()).toBe(60);

    const locked = await good(); // correct password is refused while locked, with the generic answer
    expect(locked.status).toBe(401);
    expect(locked.body).toEqual({ error: 'אימייל או סיסמה שגויים' });
    expect(row().f).toBe(5); // not counted while locked

    clock.t += 61_000;
    await bad(); // 6th -> 2 minutes
    expect(row().f).toBe(6);
    expect(row().l - now()).toBe(120);
    clock.t += 61_000;
    expect((await good()).status).toBe(401); // still locked
    clock.t += 61_000;
    for (let i = 0; i < 3; i++) { await bad(); clock.t += 16 * 60_000; } // 7,8,9 -> 4m, 8m, 15m (cap)
    expect(row().f).toBe(9);
    await bad(); expect(row().l - now()).toBe(15 * 60); // 10th: 32m capped to 15m
    clock.t += 15 * 60_000 + 1000;
    expect((await good()).status).toBe(200);
    expect(row()).toEqual({ f: 0, l: null });
  });

  it('per-email limiter returns 429 across IPs, and other emails are unaffected', async () => {
    const { app } = make({ loginEmailMax: 3 });
    const email = newEmail();
    const attempt = (e: string, ip: string) =>
      post(app, '/api/auth/login', { email: e, password: 'nope-nope-nope' }).set('X-Forwarded-For', ip);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await attempt(email.toUpperCase(), `10.0.0.${i}`)).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    expect((await attempt(newEmail(), '10.0.0.1')).status).toBe(401);
  });

  it('per-IP login and register limiters return 429', async () => {
    const { app } = make({ loginIpMax: 2, registerIpMax: 2 });
    const s = [];
    for (let i = 0; i < 3; i++) s.push((await post(app, '/api/auth/login', { email: newEmail(), password: 'x' })).status);
    expect(s).toEqual([401, 401, 429]);
    const r = [];
    for (let i = 0; i < 3; i++) r.push((await post(app, '/api/auth/register', { email: newEmail(), password: PW })).status);
    expect(r).toEqual([201, 201, 429]);
  });
});

describe('session lifetime', () => {
  it('expires after 7 idle days, but activity slides the window (until the 30-day cap)', async () => {
    const { app, clock } = make();
    const { cookie: idle } = await register(app);
    clock.t += 7 * DAY + 1000;
    expect((await get(app, '/api/auth/me', idle)).status).toBe(401);

    const { cookie } = await register(app);
    for (let i = 0; i < 4; i++) { // 4 x 6 days = 24 days of use
      clock.t += 6 * DAY;
      expect((await get(app, '/api/auth/me', cookie)).status).toBe(200);
    }
    clock.t += 6 * DAY; // 30 days since creation, session was active 6 days ago
    expect((await get(app, '/api/auth/me', cookie)).status).toBe(401);
    expect(db.prepare(`SELECT 1 FROM sessions WHERE token_hash = ?`).get(sha(tokenOf(cookie)))).toBeUndefined();
  });

  it('writes last_seen at most once per hour', async () => {
    const { app, clock } = make();
    const { cookie } = await register(app);
    const seen = () => (db.prepare(`SELECT last_seen s FROM sessions WHERE token_hash = ?`).get(sha(tokenOf(cookie))) as any).s;
    const t0 = seen();
    clock.t += 30 * 60_000;
    await get(app, '/api/auth/me', cookie);
    expect(seen()).toBe(t0);
    clock.t += 31 * 60_000;
    await get(app, '/api/auth/me', cookie);
    expect(seen()).toBe(t0 + 61 * 60);
  });

  it('cleanup removes expired sessions only', async () => {
    const { app, clock } = make();
    const { cookie: keep } = await register(app);
    const { cookie: old } = await register(app);
    db.prepare(`UPDATE sessions SET expires_at = ? WHERE token_hash = ?`).run(Math.floor(clock.t / 1000) - 1, sha(tokenOf(old)));
    expect(cleanupExpiredSessions(db, clock.t)).toBeGreaterThanOrEqual(1);
    expect(db.prepare(`SELECT 1 FROM sessions WHERE token_hash = ?`).get(sha(tokenOf(old)))).toBeUndefined();
    expect((await get(app, '/api/auth/me', keep)).status).toBe(200);
  });
});

describe('change-password', () => {
  it('revokes all other sessions (and the old cookie), issues a fresh one, switches the password', async () => {
    const { app } = make();
    const { email, cookie: a } = await register(app);
    const b = cookieOf(await post(app, '/api/auth/login', { email, password: PW }));
    expect((await get(app, '/api/auth/me', a)).status).toBe(200); // login does not touch other sessions

    const wrong = await post(app, '/api/auth/change-password', { currentPassword: 'wrong-wrong-1', newPassword: 'a brand new passphrase' }, a);
    expect(wrong.status).toBe(403);
    const weak = await post(app, '/api/auth/change-password', { currentPassword: PW, newPassword: 'short' }, a);
    expect(weak.status).toBe(400);

    const ok = await post(app, '/api/auth/change-password', { currentPassword: PW, newPassword: 'a brand new passphrase' }, a);
    expect(ok.status).toBe(200);
    const fresh = cookieOf(ok);
    expect(fresh).not.toBe('');
    expect((await get(app, '/api/auth/me', b)).status).toBe(401);
    expect((await get(app, '/api/auth/me', a)).status).toBe(401);
    expect((await get(app, '/api/auth/me', fresh)).status).toBe(200);
    expect((await post(app, '/api/auth/login', { email, password: PW })).status).toBe(401);
    expect((await post(app, '/api/auth/login', { email, password: 'a brand new passphrase' })).status).toBe(200);
  });

  it('requires a session', async () => {
    const { app } = make();
    expect((await post(app, '/api/auth/change-password', { currentPassword: PW, newPassword: 'whatever it is now' })).status).toBe(401);
  });
});

describe('requireAuth / requireAdmin', () => {
  it('401 anonymous, 403 non-admin, 200 admin', async () => {
    const { app, clock } = make();
    const cfg = resolveAuthConfig({ cookieSecure: false, now: () => clock.t });
    const mini = express();
    mini.use(sessionLoader(db, cfg));
    mini.get('/auth', requireAuth, (req, res) => res.json({ id: req.user!.id }));
    mini.get('/admin', requireAdmin, (_req, res) => res.json({ ok: true }));

    const { res, cookie } = await register(app);
    expect((await request(mini).get('/auth')).status).toBe(401);
    expect((await request(mini).get('/admin')).status).toBe(401);
    expect((await request(mini).get('/auth').set('Cookie', cookie)).body.id).toBe(res.body.id);
    expect((await request(mini).get('/admin').set('Cookie', cookie)).status).toBe(403);
    db.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`).run(res.body.id);
    expect((await request(mini).get('/admin').set('Cookie', cookie)).status).toBe(200);
  });
});

describe('CSRF', () => {
  const { app } = make({ allowedOrigins: [] });
  const logout = () => request(app).post('/api/auth/logout').set('Host', 'app.test');

  it('allows same-origin Origin / Referer / Sec-Fetch-Site', async () => {
    expect((await logout().set('Origin', 'http://app.test')).status).toBe(200);
    expect((await logout().set('Referer', 'http://app.test/settings')).status).toBe(200);
    expect((await logout().set('Sec-Fetch-Site', 'same-origin')).status).toBe(200);
    expect((await logout().set('Sec-Fetch-Site', 'none')).status).toBe(200);
  });

  it('rejects cross-origin and unverifiable state-changing requests', async () => {
    expect((await logout().set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await logout().set('Origin', 'http://app.test.evil.example')).status).toBe(403);
    expect((await logout().set('Origin', 'http://app.test:8080')).status).toBe(403);
    expect((await logout().set('Origin', 'null')).status).toBe(403);
    expect((await logout().set('Origin', 'https://evil.example').set('Referer', 'http://app.test/')).status).toBe(403); // Origin wins
    expect((await logout().set('Referer', 'https://evil.example/x')).status).toBe(403);
    expect((await logout().set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await logout().set('Sec-Fetch-Site', 'same-site')).status).toBe(403);
    expect((await logout()).status).toBe(403); // no provenance headers at all
    const login = await request(app).post('/api/auth/login').set('Host', 'app.test').set('Origin', 'https://evil.example')
      .send({ email: 'a@b.com', password: 'x' });
    expect(login.status).toBe(403);
  });

  it('accepts configured ALLOWED_ORIGINS', async () => {
    const { app: a2 } = make({ allowedOrigins: ['https://front.example'] });
    expect((await request(a2).post('/api/auth/logout').set('Origin', 'https://front.example')).status).toBe(200);
    expect((await request(a2).post('/api/auth/logout').set('Origin', 'https://other.example')).status).toBe(403);
  });

  it('requires application/json for bodies, never blocks GET', async () => {
    const res = await logout().set('Origin', 'http://app.test').set('Content-Type', 'text/plain').send('email=a');
    expect(res.status).toBe(415);
    const form = await logout().set('Origin', 'http://app.test').type('form').send({ a: 1 });
    expect(form.status).toBe(415);
    expect((await request(app).get('/api/auth/me').set('Origin', 'https://evil.example')).status).toBe(401);
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
});

describe('password hashing sanity', () => {
  it('stores an argon2id hash', async () => {
    const { app } = make();
    const { res } = await register(app);
    const row = db.prepare(`SELECT password_hash h FROM users WHERE id = ?`).get(res.body.id) as any;
    expect(row.h).toMatch(/^\$argon2id\$/);
    expect(await hashPassword('x'.repeat(12))).toMatch(/^\$argon2id\$/);
  });
});
