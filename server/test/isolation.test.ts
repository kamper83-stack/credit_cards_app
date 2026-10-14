import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { randomBytes } from 'crypto';

vi.mock('../src/riseup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/riseup.js')>();
  return { ...actual, fetchRiseupCreditCardData: vi.fn(), testRiseupConnection: vi.fn() };
});

import { createApp, isPublicApiRoute } from '../src/app.js';
import { newInvite } from './helpers.js';
import db from '../src/db.js';
import { encryptPat } from '../src/crypto.js';
import { activeRiseupOperations } from '../src/routes/riseup.js';
import { fetchRiseupCreditCardData, testRiseupConnection, RiseupError, type SyncResult } from '../src/riseup.js';

process.env.TOKEN_ENC_KEY = randomBytes(32).toString('base64');
// Limits are read per call. Generous defaults keep the shared users A/B usable; the dedicated
// tests below lower them for fresh users.
process.env.RISEUP_USER_RATE_LIMIT_MAX = '1000';
process.env.RISEUP_TOKEN_COOLDOWN_MS = '1';

const ORIGIN = 'http://app.test';
const PW = 'correct horse battery';
const app = createApp({
  allowedOrigins: [ORIGIN], cookieSecure: false, rateLimitMax: 1_000_000,
  loginIpMax: 1000, loginEmailMax: 1000, loginEmailGlobalMax: 1000, registerIpMax: 1000,
});
const fetchMock = vi.mocked(fetchRiseupCreditCardData);
const testMock = vi.mocked(testRiseupConnection);

const PAT_A = 'riseup_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAa1b2';
const PAT_B = 'riseup_pat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBc3d4';

// Every response body ever returned to a given user, to scan for leaks.
const seen: Record<string, string[]> = {};

class Client {
  constructor(public id: string, public email: string, private cookie: string) { seen[id] = []; }
  async call(method: 'get' | 'post' | 'put' | 'delete', url: string, body?: object) {
    const r = request(app)[method](url).set('Origin', ORIGIN).set('Cookie', this.cookie);
    const res = await (body === undefined ? r : r.send(body));
    seen[this.id].push(res.text);
    return res;
  }
  get = (u: string) => this.call('get', u);
  post = (u: string, b: object = {}) => this.call('post', u, b);
  put = (u: string, b: object = {}) => this.call('put', u, b);
  del = (u: string) => this.call('delete', u);
}

async function registerUser(email: string): Promise<Client> {
  const res = await request(app).post('/api/auth/register').set('Origin', ORIGIN).send({ email, password: PW, invite: newInvite() });
  expect(res.status).toBe(201);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  return new Client(res.body.id, email, cookie);
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function syncData(overrides: { amount?: number } = {}): SyncResult {
  const t = {
    transactionId: 'SHARED-TX-1', transactionDate: `${today()}T10:00:00Z`, cashflowDate: today(),
    businessName: 'Shop', isIncome: false, amount: overrides.amount ?? 50, accountNickname: 'Visa',
    sourceType: 'creditCard', source: 'isracard', accountNumberHash: 'SHARED-HASH', categoryLabel: 'food', isInstallment: false,
  };
  return { accounts: [{ sourceId: 'SHARED-HASH', nickname: 'Visa' }], transactions: [t], monthsSynced: ['2026-10'] };
}

let A: Client, B: Client;
let cardA: string, cardB: string, goalA: string, goalB: string, txA: string, txB: string;

/** Everything that belongs to a user, for before/after comparison. */
const snapshot = (userId: string) => JSON.stringify({
  cards: db.prepare(`SELECT * FROM cards WHERE user_id = ? ORDER BY id`).all(userId),
  goals: db.prepare(`SELECT g.* FROM goals g JOIN cards c ON c.id = g.card_id WHERE c.user_id = ? ORDER BY g.id`).all(userId),
  txs: db.prepare(`SELECT t.* FROM transactions t JOIN cards c ON c.id = t.card_id WHERE c.user_id = ? ORDER BY t.card_id, t.id`).all(userId),
  riseup: db.prepare(`SELECT * FROM user_riseup WHERE user_id = ?`).all(userId),
});

beforeAll(async () => {
  A = await registerUser('a@example.com');
  B = await registerUser('b@example.com');
  cardA = (await A.post('/api/cards', { name: 'A card' })).body.id;
  cardB = (await B.post('/api/cards', { name: 'B card' })).body.id;
  const goal = { name: 'g', target_amount: 1000, period_type: 'monthly' };
  goalA = (await A.post('/api/goals', { ...goal, card_id: cardA })).body.id;
  goalB = (await B.post('/api/goals', { ...goal, card_id: cardB })).body.id;
  txA = (await A.post('/api/transactions', { card_id: cardA, amount: 100, date: today(), description: 'a' })).body.id;
  txB = (await B.post('/api/transactions', { card_id: cardB, amount: 900, date: today(), description: 'b' })).body.id;
  for (const id of [cardA, cardB, goalA, goalB, txA, txB]) expect(id).toBeTruthy();
});

afterEach(() => { fetchMock.mockReset(); testMock.mockReset(); });

describe('unauthenticated access', () => {
  const routes: Array<['get' | 'post' | 'put' | 'delete', string]> = [
    ['get', '/api/cards'], ['post', '/api/cards'], ['put', '/api/cards/x'], ['delete', '/api/cards/x'],
    ['get', '/api/goals'], ['post', '/api/goals'], ['put', '/api/goals/x'], ['delete', '/api/goals/x'],
    ['get', '/api/transactions'], ['post', '/api/transactions'], ['delete', '/api/transactions/x'],
    ['get', '/api/riseup/status'], ['put', '/api/riseup/token'], ['delete', '/api/riseup/token'], ['post', '/api/riseup/sync'],
  ];
  it.each(routes)('%s %s -> 401', async (method, url) => {
    const res = await request(app)[method](url).set('Origin', ORIGIN).send({});
    expect(res.status).toBe(401);
    expect(Object.keys(res.body)).toEqual(['error']);
  });

  it('an invalid session cookie is also 401', async () => {
    const res = await request(app).get('/api/cards').set('Cookie', 'sid=not-a-real-session');
    expect(res.status).toBe(401);
  });

  it('/api/health stays public', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
});

describe('cross-user object access is 404 and changes nothing', () => {
  it("A cannot read/update/delete B's card, goal or transaction", async () => {
    const before = snapshot(B.id);
    const attempts = [
      A.put(`/api/cards/${cardB}`, { name: 'hacked' }),
      A.del(`/api/cards/${cardB}`),
      A.put(`/api/goals/${goalB}`, { name: 'hacked', target_amount: 1 }),
      A.put(`/api/goals/${goalB}`, { active: 0 }),
      A.del(`/api/goals/${goalB}`),
      A.del(`/api/transactions/${txB}`),
      A.del(`/api/transactions/${txB}?card_id=${cardB}`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expect(res.body.error).toBeTypeOf('string');
    }
    expect(snapshot(B.id)).toBe(before);
  });

  it('404 bodies for foreign and nonexistent objects are identical (no existence oracle)', async () => {
    const missing = '11111111-1111-4111-8111-111111111111';
    const pairs = [
      [A.put(`/api/cards/${cardB}`, { name: 'x' }), A.put(`/api/cards/${missing}`, { name: 'x' })],
      [A.del(`/api/goals/${goalB}`), A.del(`/api/goals/${missing}`)],
      [A.del(`/api/transactions/${txB}`), A.del(`/api/transactions/${missing}`)],
    ];
    for (const [foreign, none] of pairs) {
      const [f, n] = await Promise.all([foreign, none]);
      expect(f.status).toBe(404);
      expect(f.body).toEqual(n.body);
    }
  });

  it("A cannot create a goal or transaction on B's card", async () => {
    const before = snapshot(B.id);
    const g = await A.post('/api/goals', { card_id: cardB, name: 'x', target_amount: 5, period_type: 'monthly' });
    const t = await A.post('/api/transactions', { card_id: cardB, amount: 5, date: today(), description: 'x' });
    expect(g.status).toBe(404);
    expect(t.status).toBe(404);
    expect(snapshot(B.id)).toBe(before);
  });

  it("A cannot filter list endpoints by B's card_id", async () => {
    expect((await A.get(`/api/goals?card_id=${cardB}`)).status).toBe(404);
    expect((await A.get(`/api/transactions?card_id=${cardB}`)).status).toBe(404);
    expect((await A.get(`/api/transactions?card_id[]=${cardB}`)).status).toBe(400);
  });

  it('list endpoints return only own rows', async () => {
    const cards = (await A.get('/api/cards')).body;
    const goals = (await A.get('/api/goals')).body;
    const txs = (await A.get('/api/transactions?limit=1000')).body;
    expect(cards.map((c: any) => c.id)).toEqual([cardA]);
    expect(goals.map((g: any) => g.id)).toEqual([goalA]);
    expect(txs.map((t: any) => t.id)).toEqual([txA]);
    expect((await B.get('/api/cards')).body.map((c: any) => c.id)).toEqual([cardB]);
  });

  it("A's own objects still work (sanity: scoping did not break the owner)", async () => {
    expect((await A.put(`/api/cards/${cardA}`, { name: 'A renamed' })).status).toBe(200);
    expect((await A.put(`/api/goals/${goalA}`, { name: 'renamed' })).status).toBe(200);
    expect((await A.get('/api/cards')).body[0].name).toBe('A renamed');
  });

  it('a goal PUT cannot move the goal to another user\'s card', async () => {
    const before = snapshot(B.id);
    await A.put(`/api/goals/${goalA}`, { card_id: cardB, name: 'moved' });
    expect(snapshot(B.id)).toBe(before);
    expect((db.prepare(`SELECT card_id FROM goals WHERE id = ?`).get(goalA) as any).card_id).toBe(cardA);
  });
});

describe('transaction delete semantics', () => {
  it('own transaction can be deleted; second delete is 404', async () => {
    const t = (await A.post('/api/transactions', { card_id: cardA, amount: 1, date: today(), description: 'tmp' })).body.id;
    expect((await A.del(`/api/transactions/${t}`)).status).toBe(200);
    expect((await A.del(`/api/transactions/${t}`)).status).toBe(404);
  });

  it('same id on two of the same user\'s cards requires card_id', async () => {
    const c2 = (await A.post('/api/cards', { name: 'A2' })).body.id;
    for (const c of [cardA, c2]) {
      db.prepare(`INSERT INTO transactions (id, card_id, amount, date, description) VALUES ('DUP', ?, 1, ?, 'd')`).run(c, today());
    }
    expect((await A.del('/api/transactions/DUP')).status).toBe(400);
    expect((db.prepare(`SELECT COUNT(*) n FROM transactions WHERE id = 'DUP'`).get() as any).n).toBe(2);
    expect((await A.del(`/api/transactions/DUP?card_id=${c2}`)).status).toBe(200);
    expect((db.prepare(`SELECT card_id FROM transactions WHERE id = 'DUP'`).all() as any[]).map(r => r.card_id)).toEqual([cardA]);
    // same id on B's card is never touched by A's delete
    db.prepare(`INSERT INTO transactions (id, card_id, amount, date, description) VALUES ('DUP', ?, 1, ?, 'd')`).run(cardB, today());
    expect((await A.del('/api/transactions/DUP')).status).toBe(200); // unambiguous for A
    expect((db.prepare(`SELECT card_id FROM transactions WHERE id = 'DUP'`).all() as any[]).map(r => r.card_id)).toEqual([cardB]);
    db.prepare(`DELETE FROM transactions WHERE id = 'DUP'`).run();
  });
});

describe('goal progress', () => {
  it("ignores other users' transactions with identical dates and amounts", async () => {
    const c = (await A.post('/api/cards', { name: 'twin A' })).body.id;
    const d = (await B.post('/api/cards', { name: 'twin B' })).body.id;
    await A.post('/api/transactions', { card_id: c, amount: 100, date: today(), description: 'same' });
    await B.post('/api/transactions', { card_id: d, amount: 100, date: today(), description: 'same' });
    const ga = (await A.post('/api/goals', { card_id: c, name: 't', target_amount: 1000, period_type: 'monthly' })).body.id;
    const goals = (await A.get('/api/goals')).body;
    expect(goals.find((g: any) => g.id === ga).spent).toBe(100);
    // the original goalA (card with 100) also unaffected by B's 900
    expect(goals.find((g: any) => g.id === goalA).spent).toBe(100);
    const gb = (await B.get('/api/goals')).body;
    expect(gb.find((g: any) => g.id === goalB).spent).toBe(900);
  });

  it('the SQL sum is itself owner-scoped (goal pointing at a foreign card gets spent=0)', async () => {
    // Simulate corrupted data: a goal row of A's whose card_id is B's card is not visible to A at all.
    db.prepare(`INSERT INTO goals (id, card_id, name, target_amount, period_type) VALUES ('rogue', ?, 'r', 10, 'monthly')`).run(cardB);
    const a = (await A.get('/api/goals')).body;
    expect(a.find((g: any) => g.id === 'rogue')).toBeUndefined();
    db.prepare(`DELETE FROM goals WHERE id = 'rogue'`).run();
  });
});

describe('RiseUp per user', () => {
  it('PUT /token stores an encrypted blob, different per user even for the same token', async () => {
    testMock.mockResolvedValue(undefined);
    expect((await A.put('/api/riseup/token', { token: PAT_A })).status).toBe(200);
    expect((await B.put('/api/riseup/token', { token: PAT_A })).status).toBe(200); // same plaintext
    const ra = db.prepare(`SELECT * FROM user_riseup WHERE user_id = ?`).get(A.id) as any;
    const rb = db.prepare(`SELECT * FROM user_riseup WHERE user_id = ?`).get(B.id) as any;
    for (const r of [ra, rb]) {
      expect(Buffer.from(r.pat_ciphertext).toString('utf8')).not.toContain(PAT_A);
      expect(Buffer.from(r.pat_ciphertext).includes(Buffer.from(PAT_A))).toBe(false);
    }
    expect(Buffer.compare(ra.pat_ciphertext, rb.pat_ciphertext)).not.toBe(0);
    expect(Buffer.compare(ra.iv, rb.iv)).not.toBe(0);
    // B now stores its own token
    expect((await B.put('/api/riseup/token', { token: PAT_B })).status).toBe(200);
  });

  it('status is per user and returns only a masked preview', async () => {
    const a = (await A.get('/api/riseup/status')).body;
    const b = (await B.get('/api/riseup/status')).body;
    expect(a).toEqual({ connected: true, tokenPreview: 'riseup_pat_...a1b2', lastSyncedAt: null });
    expect(b).toEqual({ connected: true, tokenPreview: 'riseup_pat_...c3d4', lastSyncedAt: null });
    const C = await registerUser('c@example.com');
    expect((await C.get('/api/riseup/status')).body).toEqual({ connected: false, tokenPreview: null, lastSyncedAt: null });
  });

  it('rejects a malformed token and never echoes it', async () => {
    const res = await A.put('/api/riseup/token', { token: 'not-a-pat-secret-xyz' });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('secret-xyz');
  });

  it('same RiseUp transactionId synced by both users yields two independent rows', async () => {
    fetchMock.mockResolvedValue(syncData({ amount: 50 }));
    expect((await A.post('/api/riseup/sync', { force: true })).status).toBe(200);
    expect((await B.post('/api/riseup/sync', { force: true })).status).toBe(200);
    const rows = db.prepare(`SELECT t.card_id, t.amount, c.user_id FROM transactions t JOIN cards c ON c.id = t.card_id WHERE t.id = 'SHARED-TX-1'`).all() as any[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.user_id))).toEqual(new Set([A.id, B.id]));
    expect(new Set(rows.map(r => r.card_id)).size).toBe(2);

    // A's later sync changes only A's row
    fetchMock.mockResolvedValue(syncData({ amount: 77 }));
    expect((await A.post('/api/riseup/sync', { force: true })).status).toBe(200);
    const amountOf = (uid: string) => (db.prepare(`SELECT t.amount FROM transactions t JOIN cards c ON c.id = t.card_id WHERE t.id = 'SHARED-TX-1' AND c.user_id = ?`).get(uid) as any).amount;
    expect(amountOf(A.id)).toBe(77);
    expect(amountOf(B.id)).toBe(50);
    expect((db.prepare(`SELECT COUNT(*) n FROM cards WHERE riseup_account_id = 'SHARED-HASH'`).get() as any).n).toBe(2);
  });

  it('last_synced, lastSyncedAt and sync_log are per user', async () => {
    const C = await registerUser('d@example.com');
    const cards = (await C.get('/api/cards')).body;
    expect(cards).toEqual([]);
    expect((await C.get('/api/riseup/status')).body.lastSyncedAt).toBeNull();

    // give B a newer, distinguishable log entry; A's cards must not pick it up
    db.prepare(`INSERT INTO sync_log (card_id, status, message, user_id, synced_at) VALUES ('riseup', 'success', 'x', ?, 4102444800)`).run(B.id);
    const aSynced = (await A.get('/api/cards')).body.map((c: any) => c.last_synced).filter(Boolean);
    const bSynced = (await B.get('/api/cards')).body.map((c: any) => c.last_synced).filter(Boolean);
    expect(aSynced.length).toBeGreaterThan(0);
    expect(aSynced.every((v: number) => v < 4102444800)).toBe(true);
    expect(bSynced.every((v: number) => v === 4102444800)).toBe(true);
    expect((await A.get('/api/riseup/status')).body.lastSyncedAt).not.toBeNull();
    for (const r of db.prepare(`SELECT user_id FROM sync_log`).all() as any[]) expect(r.user_id).toBeTruthy();
  });

  it('the 24h throttle is per user', async () => {
    const D = await registerUser('e@example.com');
    testMock.mockResolvedValue(undefined);
    await D.put('/api/riseup/token', { token: 'riseup_pat_' + 'D'.repeat(30) });
    fetchMock.mockResolvedValue(syncData());
    const a = await A.post('/api/riseup/sync', {}); // A synced moments ago
    expect(a.body).toMatchObject({ skipped: true, reason: 'already_synced' });
    expect(fetchMock).not.toHaveBeenCalled();
    const d = await D.post('/api/riseup/sync', {}); // D never synced
    expect(d.body.success).toBe(true);
    expect(d.body.skipped).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // the sync used D's token, not anyone else's
    expect(fetchMock.mock.calls[0][0]).toBe('riseup_pat_' + 'D'.repeat(30));
  });

  it('sync without a token is 400', async () => {
    const E = await registerUser('f@example.com');
    expect((await E.post('/api/riseup/sync', { force: true })).status).toBe(400);
  });

  it('DELETE /token removes only the caller\'s token and keeps synced data', async () => {
    const F = await registerUser('g@example.com');
    testMock.mockResolvedValue(undefined);
    await F.put('/api/riseup/token', { token: 'riseup_pat_' + 'F'.repeat(30) });
    fetchMock.mockResolvedValue({ ...syncData(), accounts: [{ sourceId: 'F-HASH', nickname: 'F' }], transactions: [{ ...syncData().transactions[0], accountNumberHash: 'F-HASH' }] });
    await F.post('/api/riseup/sync', { force: true });
    const before = (await F.get('/api/cards')).body.length;
    expect((await F.del('/api/riseup/token')).status).toBe(200);
    expect((await F.get('/api/riseup/status')).body.connected).toBe(false);
    expect((await F.get('/api/cards')).body.length).toBe(before);
    expect((await A.get('/api/riseup/status')).body.connected).toBe(true);
    expect((await B.get('/api/riseup/status')).body.connected).toBe(true);
  });

  it('a second concurrent sync for the same user is 409', async () => {
    let release!: (v: SyncResult) => void;
    fetchMock.mockImplementation(() => new Promise<SyncResult>(r => { release = r; }));
    const first = A.post('/api/riseup/sync', { force: true });
    await vi.waitFor(() => expect(activeRiseupOperations()).toBe(1));
    const second = await A.post('/api/riseup/sync', { force: true });
    expect(second.status).toBe(409);
    const tokenPut = await A.put('/api/riseup/token', { token: PAT_A });
    expect(tokenPut.status).toBe(409);
    release(syncData());
    expect((await first).status).toBe(200);
    expect(activeRiseupOperations()).toBe(0);
    // lock released: another sync works
    fetchMock.mockResolvedValue(syncData());
    expect((await A.post('/api/riseup/sync', { force: true })).status).toBe(200);
  });

  it('a global cap limits simultaneous MCP subprocesses (503 + Retry-After)', async () => {
    const users: Client[] = [];
    for (let i = 0; i < 4; i++) {
      const u = await registerUser(`cap${i}@example.com`);
      const enc = encryptPat('riseup_pat_' + String(i).repeat(30), u.id);
      db.prepare(`INSERT INTO user_riseup (user_id, pat_ciphertext, iv, tag, key_version) VALUES (?, ?, ?, ?, ?)`).run(u.id, enc.ciphertext, enc.iv, enc.tag, enc.keyVersion);
      users.push(u);
    }
    const releases: Array<(v: SyncResult) => void> = [];
    fetchMock.mockImplementation(() => new Promise<SyncResult>(r => { releases.push(r); }));
    const running = users.slice(0, 3).map(u => u.post('/api/riseup/sync', { force: true }));
    await vi.waitFor(() => expect(activeRiseupOperations()).toBe(3));
    const rejected = await users[3].post('/api/riseup/sync', { force: true });
    expect(rejected.status).toBe(503);
    expect(rejected.headers['retry-after']).toBeDefined();
    expect(rejected.body.error).toMatch(/[א-ת]/);
    releases.forEach(r => r({ accounts: [], transactions: [], monthsSynced: [] }));
    for (const r of await Promise.all(running)) expect(r.status).toBe(200);
    expect(activeRiseupOperations()).toBe(0);
  });
});

async function userWithToken(email: string): Promise<Client> {
  const u = await registerUser(email);
  const enc = encryptPat('riseup_pat_' + 'q'.repeat(30), u.id);
  db.prepare(`INSERT INTO user_riseup (user_id, pat_ciphertext, iv, tag, key_version) VALUES (?, ?, ?, ?, ?)`).run(u.id, enc.ciphertext, enc.iv, enc.tag, enc.keyVersion);
  return u;
}

describe('RiseUp abuse limits', () => {
  const withEnv = async (env: Record<string, string>, fn: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
    Object.assign(process.env, env);
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };

  it('a user cannot start more than the rate limit; other users are unaffected; slot is released each time', async () => {
    await withEnv({ RISEUP_USER_RATE_LIMIT_MAX: '2', RISEUP_USER_RATE_LIMIT_WINDOW_MS: '60000' }, async () => {
      const hog = await userWithToken('hog@example.com');
      const other = await userWithToken('other@example.com');
      fetchMock.mockResolvedValue(syncData());
      expect((await hog.post('/api/riseup/sync', { force: true })).status).toBe(200);
      expect((await hog.post('/api/riseup/sync', { force: true })).status).toBe(200);
      expect(activeRiseupOperations()).toBe(0);
      const limited = await hog.post('/api/riseup/sync', { force: true });
      expect(limited.status).toBe(429);
      expect(limited.body.error).toMatch(/[א-ת]/);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // token tests count against the same budget
      testMock.mockResolvedValue(undefined);
      expect((await hog.put('/api/riseup/token', { token: PAT_A })).status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(testMock).not.toHaveBeenCalled();
      expect(activeRiseupOperations()).toBe(0);
      // another user still gets a slot
      expect((await other.post('/api/riseup/sync', { force: true })).status).toBe(200);
    });
  });

  it('failed operations also count and release the slot', async () => {
    await withEnv({ RISEUP_USER_RATE_LIMIT_MAX: '2', RISEUP_USER_RATE_LIMIT_WINDOW_MS: '60000' }, async () => {
      const u = await userWithToken('failing@example.com');
      fetchMock.mockRejectedValue(new RiseupError('network', 'x'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await u.post('/api/riseup/sync', { force: true })).status).toBe(500);
      expect(activeRiseupOperations()).toBe(0);
      expect((await u.post('/api/riseup/sync', { force: true })).status).toBe(500);
      expect((await u.post('/api/riseup/sync', { force: true })).status).toBe(429);
      spy.mockRestore();
      expect(activeRiseupOperations()).toBe(0);
    });
  });

  it('one user holding a slot cannot take another (409) and leaves the rest for other users', async () => {
    const hog = await userWithToken('hog2@example.com');
    const other = await userWithToken('other2@example.com');
    let release!: (v: SyncResult) => void;
    fetchMock.mockImplementationOnce(() => new Promise<SyncResult>(r => { release = r; }));
    const first = hog.post('/api/riseup/sync', { force: true });
    await vi.waitFor(() => expect(activeRiseupOperations()).toBe(1));
    expect((await hog.post('/api/riseup/sync', { force: true })).status).toBe(409);
    expect((await hog.put('/api/riseup/token', { token: PAT_A })).status).toBe(409);
    expect(activeRiseupOperations()).toBe(1);
    fetchMock.mockResolvedValue(syncData());
    expect((await other.post('/api/riseup/sync', { force: true })).status).toBe(200);
    release(syncData());
    expect((await first).status).toBe(200);
    expect(activeRiseupOperations()).toBe(0);
  });

  it('a failed token test starts a per-user cooldown (429) that clears on success or expiry', async () => {
    await withEnv({ RISEUP_TOKEN_COOLDOWN_MS: '60000' }, async () => {
      const u = await registerUser('cool@example.com');
      const other = await registerUser('cool2@example.com');
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      testMock.mockRejectedValueOnce(new RiseupError('auth', 'bad'));
      expect((await u.put('/api/riseup/token', { token: PAT_A })).status).toBe(400);
      spy.mockRestore();
      expect(activeRiseupOperations()).toBe(0);
      testMock.mockResolvedValue(undefined);
      const again = await u.put('/api/riseup/token', { token: PAT_A });
      expect(again.status).toBe(429);
      expect(again.body.error).toMatch(/[א-ת]/);
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
      expect(testMock).toHaveBeenCalledTimes(1);
      // other users are not affected
      expect((await other.put('/api/riseup/token', { token: PAT_B })).status).toBe(200);
      // a short cooldown expires
      await withEnv({ RISEUP_TOKEN_COOLDOWN_MS: '1' }, async () => {
        const v = await registerUser('cool3@example.com');
        const spy2 = vi.spyOn(console, 'error').mockImplementation(() => {});
        testMock.mockRejectedValueOnce(new RiseupError('auth', 'bad'));
        expect((await v.put('/api/riseup/token', { token: PAT_A })).status).toBe(400);
        spy2.mockRestore();
        await new Promise(r => setTimeout(r, 10));
        expect((await v.put('/api/riseup/token', { token: PAT_A })).status).toBe(200);
      });
    });
  });
});

describe('goal active toggle and transaction input validation', () => {
  it('PUT {active:0} / {active:false} deactivates, {active:1} reactivates, other fields untouched', async () => {
    const get = async () => (await A.get('/api/goals')).body.find((g: any) => g.id === goalA);
    expect((await get()).active).toBe(1);
    const originalName = (await get()).name;
    expect((await A.put(`/api/goals/${goalA}`, { active: 0 })).status).toBe(200);
    expect((await get()).active).toBe(0);
    expect((await get()).name).toBe(originalName);
    expect((await A.put(`/api/goals/${goalA}`, { active: 1 })).status).toBe(200);
    expect((await get()).active).toBe(1);
    expect((await A.put(`/api/goals/${goalA}`, { active: false })).status).toBe(200);
    expect((await get()).active).toBe(0);
    expect((await A.put(`/api/goals/${goalA}`, { name: 'renamed' })).status).toBe(200);
    expect((await get()).active).toBe(0); // omitted -> unchanged
    expect((await A.put(`/api/goals/${goalA}`, { active: true })).status).toBe(200);
    expect((await get()).active).toBe(1);
    expect((await A.put(`/api/goals/${goalA}`, { active: 'yes' })).status).toBe(400);
    expect((await A.put(`/api/goals/${goalA}`, { active: 2 })).status).toBe(400);
  });

  it('POST /transactions requires YYYY-MM-DD dates and a known type', async () => {
    const base = { card_id: cardA, amount: 5, description: 'v' };
    for (const date of ['2026-1-5', '15/10/2026', '2026-02-30', 'tomorrow', '2026-10-14T10:00:00Z', '']) {
      expect((await A.post('/api/transactions', { ...base, date })).status).toBe(400);
    }
    expect((await A.post('/api/transactions', { ...base, date: today(), type: 'weird' })).status).toBe(400);
    const ok = await A.post('/api/transactions', { ...base, date: today(), type: 'installments' });
    expect(ok.status).toBe(201);
    expect((await A.post('/api/transactions', { ...base, date: today(), type: 'normal' })).status).toBe(201);
    expect((await A.post('/api/transactions', { ...base, date: today() })).status).toBe(201);
  });
});

describe('sync failure responses are sanitized', () => {
  const nasty = `spawn /home/deploy/.npm/_npx/bin/npx ENOENT token=${PAT_A} env TOKEN_ENC_KEY=abc\n    at ChildProcess._handle.onexit (node:internal/child_process:285:19)\n    at /srv/app/server/src/riseup.ts:12:3`;

  it.each([
    ['plain Error with token, path and stack', () => new Error(nasty)],
    ['RiseupError (category: auth)', () => new RiseupError('auth', nasty)],
    ['RiseupError (category: network)', () => new RiseupError('network', nasty)],
    ['non-Error rejection', () => nasty],
  ])('sync: %s', async (_name, make) => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    fetchMock.mockImplementation(() => Promise.reject(make()));
    const res = await A.post('/api/riseup/sync', { force: true });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(Object.keys(res.body)).toEqual(['error']);
    for (const bad of [PAT_A, 'riseup_pat_', '/home', '/srv', 'node:internal', 'ENOENT', 'TOKEN_ENC_KEY', 'ChildProcess', ' at ']) {
      expect(res.text).not.toContain(bad);
    }
    // the log carries no token either
    expect(logs.join('\n')).not.toContain(PAT_A);
    // and neither does the persisted sync_log
    const last = db.prepare(`SELECT message FROM sync_log WHERE user_id = ? AND status = 'error' ORDER BY id DESC LIMIT 1`).get(A.id) as any;
    expect(last.message).not.toContain(PAT_A);
    expect(last.message).not.toMatch(/\/home|ENOENT|node:internal/);
  });

  it('PUT /token connection failure is sanitized too', async () => {
    testMock.mockRejectedValue(new Error(nasty));
    const res = await A.put('/api/riseup/token', { token: PAT_A });
    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/riseup_pat_A|\/home|ENOENT|TOKEN_ENC_KEY/);
  });
});

describe('no cross-user or sensitive data in any response', () => {
  it("A's token never appears in anything B received (and vice versa)", () => {
    const allB = seen[B.id].join('\n');
    const allA = seen[A.id].join('\n');
    expect(allB).not.toContain(PAT_A);
    expect(allB).not.toContain('AAAAAAAAAAAAAAAAAAAA');
    expect(allA).not.toContain(PAT_B);
    expect(allA).not.toContain('BBBBBBBBBBBBBBBBBBBB');
    expect(allB).not.toContain(A.email);
    expect(allB).not.toContain(A.id);
    expect(allA).not.toContain(B.id);
  });

  it('no response contains credentials / pat / password_hash / ciphertext / raw fields', () => {
    const FORBIDDEN = new Set(['credentials', 'pat', 'token', 'password_hash', 'pat_ciphertext', 'iv', 'tag', 'raw', 'user_id', 'token_hash']);
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          expect(FORBIDDEN.has(k), `${path}.${k}`).toBe(false);
          walk(x, `${path}.${k}`);
        }
      }
    };
    for (const id of Object.keys(seen)) {
      for (const text of seen[id]) {
        let body: unknown;
        try { body = JSON.parse(text); } catch { continue; }
        walk(body, '$');
        expect(text).not.toMatch(/\$argon2/);
      }
    }
  });

  it('even if a credentials value is stored on a card it is never returned', async () => {
    db.prepare(`UPDATE cards SET credentials = 'super-secret-creds' WHERE id = ?`).run(cardA);
    const res = await A.get('/api/cards');
    expect(res.text).not.toContain('super-secret-creds');
    expect(res.text).not.toContain('credentials');
    db.prepare(`UPDATE cards SET credentials = NULL WHERE id = ?`).run(cardA);
  });

  it('transactions never expose the raw RiseUp payload', async () => {
    fetchMock.mockResolvedValue(syncData());
    await B.post('/api/riseup/sync', { force: true });
    const res = await B.get('/api/transactions?limit=1000');
    expect(res.body.length).toBeGreaterThan(1);
    expect(res.text).not.toContain('accountNumberHash');
    for (const t of res.body) expect(t).not.toHaveProperty('raw');
  });
});

// ---------------------------------------------------------------------------
// Route protection is default-deny (one guard before every /api router). The tests below discover
// every layer under /api structurally and then probe each one black-box as an anonymous caller.
// ---------------------------------------------------------------------------

function layerMountPath(layer: any): string {
  if (layer.regexp?.fast_slash) return '';
  return layer.regexp.source
    .replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\//g, '/');
}

interface Probe { method: string; path: string; kind: string }

/** Walks an Express stack recursively. Unknown layer shapes are reported, never silently skipped. */
function discoverApiLayers(stack: any[], base: string, probes: Probe[], unknown: string[]) {
  for (const layer of stack) {
    if (layer.route) {
      const p = layer.route.path === '/' ? '' : String(layer.route.path);
      if (typeof layer.route.path !== 'string') {
        // The SPA fallback (only present with a client build) explicitly excludes /api; anything else is unknown.
        if (!String(layer.route.path?.source).includes('(?!api')) unknown.push(`route with non-string path ${layer.route.path}`);
        continue;
      }
      for (const m of Object.keys(layer.route.methods)) probes.push({ method: m, path: base + p, kind: 'route' });
      continue;
    }
    const mount = base + layerMountPath(layer);
    if (layer.name === 'router' && Array.isArray(layer.handle?.stack)) {
      discoverApiLayers(layer.handle.stack, mount, probes, unknown);
    } else if (layer.name === 'mounted_app') {
      // Express hides a sub-app's stack in a closure, so it cannot be walked: flag it and probe its root.
      unknown.push(`sub-app at ${mount} (stack not introspectable)`);
      probes.push(...['get', 'post'].map(method => ({ method, path: mount || '/', kind: 'sub-app root' })));
    } else if (typeof layer.handle === 'function' && !layer.handle.stack && !layer.handle._router) {
      // plain middleware: only interesting when mounted under /api (global middleware has no mount path)
      if (mount.startsWith('/api')) {
        for (const method of ['get', 'post', 'delete']) probes.push({ method, path: mount, kind: `middleware ${layer.name}` });
      }
    } else {
      unknown.push(`unrecognised layer ${layer.name} at ${mount}`);
    }
  }
}

const concretePath = (p: string) => p.replace(/:[A-Za-z_]+/g, 'x');

async function probeAnonymously(target: any) {
  const probes: Probe[] = [];
  const unknown: string[] = [];
  discoverApiLayers(target._router.stack, '', probes, unknown);
  const apiProbes = probes.filter(p => p.path.startsWith('/api'));
  const failures: string[] = [];
  for (const pr of apiProbes) {
    const url = concretePath(pr.path);
    if (isPublicApiRoute(pr.method, url.slice('/api'.length) || '/')) continue;
    const res = await (request(target) as any)[pr.method](url).set('Origin', ORIGIN).send({});
    if (res.status !== 401) failures.push(`${pr.method.toUpperCase()} ${url} (${pr.kind}) -> ${res.status}`);
  }
  return { probes: apiProbes, unknown, failures };
}

describe('default-deny route protection', () => {
  it('the real app: every discovered /api route/middleware answers anonymous callers with 401 (except the allowlist)', async () => {
    const { probes, unknown, failures } = await probeAnonymously(app);
    const labels = probes.map(p => `${p.method.toUpperCase()} ${p.path}`);
    // Guard against a vacuous pass if Express internals change.
    expect(labels).toEqual(expect.arrayContaining([
      'GET /api/cards', 'POST /api/cards', 'PUT /api/cards/:id', 'DELETE /api/cards/:id',
      'GET /api/goals', 'DELETE /api/goals/:id', 'GET /api/transactions', 'DELETE /api/transactions/:id',
      'GET /api/riseup/status', 'PUT /api/riseup/token', 'DELETE /api/riseup/token', 'POST /api/riseup/sync',
      'POST /api/auth/login', 'GET /api/auth/me', 'POST /api/auth/change-password', 'GET /api/health',
    ]));
    expect(unknown).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('only the exact allowlist is public', () => {
    for (const [m, p] of [['POST', '/auth/register'], ['POST', '/auth/login'], ['POST', '/auth/logout'], ['GET', '/health'], ['GET', '/health/'], ['get', '/HEALTH']]) {
      expect(isPublicApiRoute(m, p)).toBe(true);
    }
    for (const [m, p] of [['GET', '/healthdump'], ['GET', '/health/x'], ['GET', '/health/../cards'], ['POST', '/health'], ['GET', '/auth/me'],
      ['POST', '/auth/change-password'], ['GET', '/auth/login'], ['POST', '/auth/login/x'], ['GET', '//health'], ['GET', '/cards']]) {
      expect(isPublicApiRoute(m, p)).toBe(false);
    }
  });

  describe('the guard blocks every bypass shape a developer could add later', () => {
    const SECRET = { secret: 'leaked' };
    const bypassApp = createApp({
      allowedOrigins: [ORIGIN], cookieSecure: false, rateLimitMax: 1_000_000,
      loginIpMax: 1000, loginEmailMax: 1000, loginEmailGlobalMax: 1000, registerIpMax: 1000,
      extraApiRoutes: (a) => {
        a.use('/api/dump', (_req, res) => res.json(SECRET));                       // plain middleware
        const sub = express();                                                      // mounted sub-app
        sub.get('/', (_req, res) => res.json(SECRET));
        sub.get('/deep', (_req, res) => res.json(SECRET));
        a.use('/api/subapp', sub);
        const outer = express.Router(); const inner = express.Router();              // nested router
        inner.get('/leak', (_req, res) => res.json(SECRET));
        outer.use('/inner', inner);
        a.use('/api/nested', outer);
        a.get('/api/healthdump', (_req, res) => res.json(SECRET));                  // prefix of an allowlisted path
      },
    });
    const shapes = ['/api/dump', '/api/dump/anything', '/api/subapp', '/api/subapp/deep', '/api/nested/inner/leak', '/api/healthdump',
      '/api/health/../dump', '/API/dump', '/api/dump/', '/api//dump'];

    it.each(shapes)('anonymous GET %s is never served', async (url) => {
      const res = await request(bypassApp).get(url).set('Origin', ORIGIN);
      expect([401, 404]).toContain(res.status);
      expect(res.text).not.toContain('leaked');
    });

    it.each(['/api/dump', '/api/subapp', '/api/subapp/deep', '/api/nested/inner/leak', '/api/healthdump'])('anonymous GET %s is exactly 401', async (url) => {
      expect((await request(bypassApp).get(url).set('Origin', ORIGIN)).status).toBe(401);
    });

    it('the shapes really exist: signed-in users reach them (so the 401s above come from the guard)', async () => {
      const email = 'bypass@example.com';
      const reg = await request(bypassApp).post('/api/auth/register').set('Origin', ORIGIN).send({ email, password: PW, invite: newInvite() });
      const cookie = (reg.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
      for (const url of ['/api/dump', '/api/subapp', '/api/subapp/deep', '/api/nested/inner/leak', '/api/healthdump']) {
        const res = await request(bypassApp).get(url).set('Origin', ORIGIN).set('Cookie', cookie);
        expect(res.status).toBe(200);
        expect(res.body).toEqual(SECRET);
      }
    });

    it('structural + black-box discovery finds and probes every bypass shape', async () => {
      const { probes, unknown, failures } = await probeAnonymously(bypassApp);
      const paths = probes.map(p => p.path);
      for (const p of ['/api/dump', '/api/subapp', '/api/nested/inner/leak', '/api/healthdump']) expect(paths).toContain(p);
      // nested routers are walked; a sub-app cannot be, so it is flagged for a human to look at
      expect(unknown).toEqual(['sub-app at /api/subapp (stack not introspectable)']);
      expect(failures).toEqual([]);
    });

    it('flags layer shapes it cannot analyse', () => {
      const weird = [{ name: 'weird', regexp: { source: '^\\/api\\/x\\/?(?=\\/|$)' }, handle: { stack: [] } }];
      const probes: Probe[] = []; const unknown: string[] = [];
      discoverApiLayers(weird, '', probes, unknown);
      expect(unknown).toEqual(['unrecognised layer weird at /api/x']);
    });
  });
});

describe('unknown /api paths', () => {
  it('anonymous -> 401, authenticated -> JSON 404 (also for //, trailing slash and case variants)', async () => {
    for (const url of ['/api/nope', '/api//cards', '/api/cards/../nope', '/api/auth/nope']) {
      expect((await request(app).get(url).set('Origin', ORIGIN)).status).toBe(401);
      const res = await A.get(url);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toEqual({ error: 'Not found' });
    }
  });
});
