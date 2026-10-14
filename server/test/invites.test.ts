import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { createApp, type AppOptions } from '../src/app.js';
import db from '../src/db.js';
import { hashPassword } from '../src/password.js';
import { hashToken } from '../src/auth/sessions.js';
import { newInvite } from './helpers.js';

const ORIGIN = 'http://app.test';
const PW = 'correct horse battery';
const GENERIC = 'ההזמנה אינה תקפה';
const NOW0 = Date.UTC(2026, 5, 1);
let seq = 0;
const email = () => `inv${++seq}@example.com`;

function make(opts: AppOptions = {}) {
  const clock = { t: NOW0 };
  const app = createApp({
    allowedOrigins: [ORIGIN], cookieSecure: false,
    loginIpMax: 1000, loginEmailMax: 1000, loginEmailGlobalMax: 1000, registerIpMax: 1000, inviteFailMax: 1000,
    now: () => clock.t, ...opts,
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
const cookieOf = (res: request.Response) =>
  (([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => /^sid=/.test(c)) ?? '').split(';')[0];
const reg = (app: App, invite: unknown, e = email()) => post(app, '/api/auth/register', { email: e, password: PW, invite });
const nowSec = () => Math.floor(NOW0 / 1000);
const inviteRow = (token: string) => db.prepare(`SELECT * FROM invites WHERE token_hash = ?`).get(hashToken(token)) as any;

async function makeAdmin(app: App, e = email()) {
  const id = randomUUID();
  db.prepare(`INSERT INTO users (id, email, password_hash, is_admin, created_at) VALUES (?, ?, ?, 1, ?)`).run(id, e, await hashPassword(PW), nowSec());
  const res = await post(app, '/api/auth/login', { email: e, password: PW });
  expect(res.status).toBe(200);
  return { id, email: e, cookie: cookieOf(res) };
}
async function makeUser(app: App) {
  const e = email();
  const res = await reg(app, newInvite({ nowSec: nowSec() }), e);
  expect(res.status).toBe(201);
  return { id: res.body.id as string, email: e, cookie: cookieOf(res) };
}

describe('invite-gated registration', () => {
  it('rejects missing, unknown, expired, revoked and exhausted invites with an identical response', async () => {
    const { app, clock } = make();
    const admin = await makeAdmin(app);
    const expired = newInvite({ nowSec: nowSec(), expiresInDays: 1 });
    const revoked = newInvite({ nowSec: nowSec() });
    const exhausted = newInvite({ nowSec: nowSec() });
    const revokedId = inviteRow(revoked).id;
    expect((await post(app, `/api/admin/invites/${revokedId}/revoke`, {}, admin.cookie)).status).toBe(200);
    expect((await reg(app, exhausted)).status).toBe(201);
    clock.t = NOW0 + 2 * 86400_000; // `expired` is now past its 1 day, but revoked/exhausted were created at NOW0 w/ 90d

    const cases: unknown[] = [undefined, '', 'nope', 'x'.repeat(500), 42, null, expired, revoked, exhausted];
    const bodies = new Set<string>();
    for (const inv of cases) {
      const res = await reg(app, inv);
      expect(res.status).toBe(400);
      bodies.add(JSON.stringify(res.body));
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: GENERIC })]);
  });

  it('a successful registration consumes exactly one use and records the invite', async () => {
    const { app } = make();
    const token = newInvite({ nowSec: nowSec(), maxUses: 3, label: 'friends' });
    expect(inviteRow(token).used_count).toBe(0);
    const res = await reg(app, token);
    expect(res.status).toBe(201);
    expect(inviteRow(token).used_count).toBe(1);
    const u = db.prepare(`SELECT invite_id, disabled_at FROM users WHERE id = ?`).get(res.body.id) as any;
    expect(u).toEqual({ invite_id: inviteRow(token).id, disabled_at: null });
  });

  it('max_uses=3 admits exactly 3 of 10 concurrent attempts', async () => {
    const { app } = make();
    const token = newInvite({ nowSec: nowSec(), maxUses: 3 });
    const results = await Promise.all(Array.from({ length: 10 }, () => reg(app, token)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 400 && r.body.error === GENERIC)).toHaveLength(7);
    expect(inviteRow(token).used_count).toBe(3);
  });

  it('a failed registration (duplicate email) does not burn a use', async () => {
    const { app } = make();
    const first = await makeUser(app);
    const token = newInvite({ nowSec: nowSec(), maxUses: 1 });
    const dup = await reg(app, token, first.email.toUpperCase());
    expect(dup.status).toBe(409);
    expect(inviteRow(token).used_count).toBe(0);
    expect((await reg(app, token)).status).toBe(201); // still usable
    expect(inviteRow(token).used_count).toBe(1);
  });

  it('a password-policy failure does not burn a use either', async () => {
    const { app } = make();
    const token = newInvite({ nowSec: nowSec() });
    const res = await post(app, '/api/auth/register', { email: email(), password: 'short', invite: token });
    expect(res.status).toBe(400);
    expect(inviteRow(token).used_count).toBe(0);
  });

  it('expiry follows the injected clock', async () => {
    const { app, clock } = make();
    const token = newInvite({ nowSec: nowSec(), expiresInDays: 2, maxUses: 5 });
    clock.t = NOW0 + 2 * 86400_000 - 1000;
    expect((await reg(app, token)).status).toBe(201);
    clock.t = NOW0 + 2 * 86400_000;
    const res = await reg(app, token);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: GENERIC });
  });

  it('rate limits invalid-invite attempts per IP, but not valid registrations', async () => {
    const { app } = make({ inviteFailMax: 3 });
    for (let i = 0; i < 3; i++) expect((await reg(app, 'bad')).status).toBe(400);
    expect((await reg(app, 'bad')).status).toBe(429);
    // valid registrations from another limiter bucket are unaffected only if under quota: separate app instance
    const { app: app2 } = make({ inviteFailMax: 3 });
    for (let i = 0; i < 6; i++) expect((await reg(app2, newInvite({ nowSec: nowSec() }))).status).toBe(201);
  });

  it('stores only the SHA-256 of the token and never logs it', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) => vi.spyOn(console, m));
    try {
      const { app } = make();
      const admin = await makeAdmin(app);
      const created = await post(app, '/api/admin/invites', { label: 'x' }, admin.cookie);
      expect(created.status).toBe(201);
      const token = created.body.token as string;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created.body.path).toBe(`/register#invite=${token}`); // fragment: never sent to the server/proxy logs
      await reg(app, token);
      await reg(app, 'wrong-' + token);
      const dump = JSON.stringify(db.prepare(`SELECT * FROM invites`).all()) + JSON.stringify(db.prepare(`SELECT * FROM users`).all())
        + JSON.stringify(db.prepare(`SELECT * FROM admin_audit`).all());
      expect(dump).not.toContain(token);
      expect(inviteRow(token).token_hash).toBe(hashToken(token));
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      expect(logged).not.toContain(token);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

describe('admin API', () => {
  const adminRoutes: Array<[string, string]> = [
    ['get', '/api/admin/invites'], ['post', '/api/admin/invites'], ['post', '/api/admin/invites/x/revoke'],
    ['get', '/api/admin/users'], ['post', '/api/admin/users/x/disable'], ['post', '/api/admin/users/x/enable'],
  ];
  const call = (app: App, m: string, url: string, cookie?: string) =>
    m === 'get' ? get(app, url, cookie) : post(app, url, {}, cookie);

  it('anonymous gets 401, non-admin 403, on every admin route', async () => {
    const { app } = make();
    const user = await makeUser(app);
    for (const [m, url] of adminRoutes) {
      const anon = await call(app, m, url);
      expect(anon.status, `${m} ${url}`).toBe(401);
      const non = await call(app, m, url, user.cookie);
      expect(non.status, `${m} ${url}`).toBe(403);
      expect(non.headers['content-type']).toMatch(/json/);
    }
  });

  it('creates, lists (never the token), validates and revokes invites with audit rows', async () => {
    const { app, clock } = make();
    const admin = await makeAdmin(app);
    for (const bad of [{ expiresInDays: 0 }, { expiresInDays: 91 }, { maxUses: 0 }, { maxUses: 101 }, { maxUses: 1.5 }, { foo: 1 }]) {
      expect((await post(app, '/api/admin/invites', bad, admin.cookie)).status).toBe(400);
    }
    const def = await post(app, '/api/admin/invites', {}, admin.cookie);
    expect(def.status).toBe(201);
    expect(def.body).toMatchObject({ maxUses: 1, expiresAt: nowSec() + 7 * 86400, label: null });
    const full = await post(app, '/api/admin/invites', { label: 'family', expiresInDays: 30, maxUses: 100 }, admin.cookie);
    expect(full.body).toMatchObject({ maxUses: 100, expiresAt: nowSec() + 30 * 86400, label: 'family' });

    await reg(app, def.body.token);
    const list = await get(app, '/api/admin/invites', admin.cookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(def.body.token);
    expect(JSON.stringify(list.body)).not.toMatch(/token/i);
    const byId = Object.fromEntries(list.body.map((i: any) => [i.id, i]));
    expect(byId[def.body.id]).toMatchObject({ status: 'exhausted', usedCount: 1, maxUses: 1 });
    expect(byId[full.body.id]).toMatchObject({ status: 'active', label: 'family', usedCount: 0 });

    clock.t = NOW0 + 31 * 86400_000;
    const relog = await post(app, '/api/auth/login', { email: admin.email, password: PW }); // idle timeout passed
    const later = await get(app, '/api/admin/invites', cookieOf(relog));
    expect(later.body.find((i: any) => i.id === full.body.id).status).toBe('expired');
    clock.t = NOW0;

    // revoke: immediate, idempotent, 404 for unknown
    const r1 = await post(app, `/api/admin/invites/${full.body.id}/revoke`, {}, admin.cookie);
    const r2 = await post(app, `/api/admin/invites/${full.body.id}/revoke`, {}, admin.cookie);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect((await reg(app, full.body.token)).status).toBe(400);
    expect((await post(app, '/api/admin/invites/nope/revoke', {}, admin.cookie)).status).toBe(404);
    const status = (await get(app, '/api/admin/invites', admin.cookie)).body.find((i: any) => i.id === full.body.id).status;
    expect(status).toBe('revoked');

    const audit = db.prepare(`SELECT actor_user_id, action, target FROM admin_audit WHERE actor_user_id = ? ORDER BY id`).all(admin.id) as any[];
    expect(audit.filter((a) => a.action === 'invite.create')).toHaveLength(2);
    expect(audit.filter((a) => a.action === 'invite.revoke')).toEqual([{ actor_user_id: admin.id, action: 'invite.revoke', target: full.body.id }]); // idempotent: one row
    expect(JSON.stringify(audit)).not.toContain(full.body.token);
  });

  it('an invite revoked mid-way stops further registrations but keeps earlier users', async () => {
    const { app } = make();
    const admin = await makeAdmin(app);
    const inv = (await post(app, '/api/admin/invites', { maxUses: 5 }, admin.cookie)).body;
    const u1 = await reg(app, inv.token);
    expect(u1.status).toBe(201);
    await post(app, `/api/admin/invites/${inv.id}/revoke`, {}, admin.cookie);
    expect((await reg(app, inv.token)).status).toBe(400);
    expect((await get(app, '/api/auth/me', cookieOf(u1))).status).toBe(200);
  });

  it('lists users without secrets or financial data', async () => {
    const { app } = make();
    const admin = await makeAdmin(app);
    const inv = (await post(app, '/api/admin/invites', { label: 'pals' }, admin.cookie)).body;
    const u = await reg(app, inv.token);
    const list = await get(app, '/api/admin/users', admin.cookie);
    expect(list.status).toBe(200);
    const row = list.body.find((x: any) => x.id === u.body.id);
    expect(row).toMatchObject({ isAdmin: false, disabled: false, inviteLabel: 'pals', cardCount: 0 });
    expect(Object.keys(row).sort()).toEqual(['cardCount', 'createdAt', 'disabled', 'email', 'id', 'inviteLabel', 'isAdmin', 'lastSeen']);
    expect(JSON.stringify(list.body)).not.toMatch(/password|hash|token/i);
  });

  it('disable kills sessions immediately, blocks login with the generic 401, enable restores it', async () => {
    const { app } = make();
    const admin = await makeAdmin(app);
    const user = await makeUser(app);
    expect((await get(app, '/api/auth/me', user.cookie)).status).toBe(200);

    const wrong = await post(app, '/api/auth/login', { email: user.email, password: 'definitely wrong pw' });
    expect((await post(app, `/api/admin/users/${user.id}/disable`, {}, admin.cookie)).status).toBe(200);
    expect((await post(app, `/api/admin/users/${user.id}/disable`, {}, admin.cookie)).status).toBe(200); // idempotent
    expect(db.prepare(`SELECT COUNT(*) n FROM sessions WHERE user_id = ?`).get(user.id)).toEqual({ n: 0 });
    expect((await get(app, '/api/auth/me', user.cookie)).status).toBe(401);
    expect((await get(app, '/api/cards', user.cookie)).status).toBe(401);
    expect((await post(app, '/api/auth/change-password', { currentPassword: PW, newPassword: 'another long password' }, user.cookie)).status).toBe(401);

    const login = await post(app, '/api/auth/login', { email: user.email, password: PW });
    expect(login.status).toBe(401);
    expect(login.body).toEqual(wrong.body);
    expect(login.headers['set-cookie']).toBeUndefined();
    // disabled logins do not touch the lockout counter (1 = the earlier genuine wrong password)
    expect(db.prepare(`SELECT failed_attempts f FROM users WHERE id = ?`).get(user.id)).toEqual({ f: 1 });

    db.prepare(`UPDATE users SET failed_attempts = 4, locked_until = ? WHERE id = ?`).run(nowSec() + 600, user.id);
    expect((await post(app, `/api/admin/users/${user.id}/enable`, {}, admin.cookie)).status).toBe(200);
    expect(db.prepare(`SELECT failed_attempts f, locked_until l, disabled_at d FROM users WHERE id = ?`).get(user.id)).toEqual({ f: 0, l: null, d: null });
    expect((await post(app, '/api/auth/login', { email: user.email, password: PW })).status).toBe(200);

    const actions = (db.prepare(`SELECT action, target FROM admin_audit WHERE actor_user_id = ? AND action LIKE 'user.%' ORDER BY id`).all(admin.id) as any[]);
    expect(actions).toEqual([{ action: 'user.disable', target: user.id }, { action: 'user.enable', target: user.id }]);
  });

  it('cannot disable yourself or the last enabled admin; unknown id is 404', async () => {
    const { app } = make();
    // other tests in this file leave admins behind; neutralise them so this test controls the admin set
    db.prepare(`UPDATE users SET is_admin = 0 WHERE is_admin = 1`).run();
    const a1 = await makeAdmin(app);
    expect((await post(app, `/api/admin/users/${a1.id}/disable`, {}, a1.cookie)).status).toBe(409);
    expect(db.prepare(`SELECT disabled_at FROM users WHERE id = ?`).get(a1.id)).toEqual({ disabled_at: null });

    const a2 = await makeAdmin(app);
    // a2 disables a1 (allowed: a2 remains), then a1 is the disabled one; a2 cannot disable itself
    expect((await post(app, `/api/admin/users/${a1.id}/disable`, {}, a2.cookie)).status).toBe(200);
    expect((await post(app, `/api/admin/users/${a2.id}/disable`, {}, a2.cookie)).status).toBe(409);
    // a third admin could not disable a2 if a2 were the only other enabled admin besides the actor... actor counts as enabled
    const a3 = await makeAdmin(app);
    expect((await post(app, `/api/admin/users/${a2.id}/disable`, {}, a3.cookie)).status).toBe(200);
    expect((await post(app, '/api/admin/users/no-such-id/disable', {}, a3.cookie)).status).toBe(404);
    expect((await post(app, '/api/admin/users/no-such-id/enable', {}, a3.cookie)).status).toBe(404);
  });

  it('GET /auth/me exposes only id, email, isAdmin', async () => {
    const { app } = make();
    const u = await makeUser(app);
    expect(Object.keys((await get(app, '/api/auth/me', u.cookie)).body).sort()).toEqual(['email', 'id', 'isAdmin']);
  });
});
