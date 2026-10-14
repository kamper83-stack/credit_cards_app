import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { createApp } from '../src/app.js';
import { newInvite } from './helpers.js';
import db from '../src/db.js';
import { encryptPat } from '../src/crypto.js';

const ORIGIN = 'http://localhost:5173';
const app = createApp({ allowedOrigins: [ORIGIN], cookieSecure: false, loginIpMax: 1000, loginEmailMax: 1000, loginEmailGlobalMax: 1000, registerIpMax: 1000 });
let ownerId = '';
let cookie = '';
const authed = (m: 'get' | 'post' | 'put' | 'delete', url: string) =>
  request(app)[m](url).set('Host', 'localhost:5173').set('Origin', ORIGIN).set('Cookie', cookie);
const PAT = 'riseup_pat_' + 'A'.repeat(30);

describe('API', () => {
  it('GET /api/health', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('sends a CSP without upgrade-insecure-requests', async () => {
    const res = await request(app).get('/api/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('data routes require a session (401) and nothing is written', async () => {
    const res = await request(app).post('/api/cards').set('Host', 'localhost:5173').set('Origin', ORIGIN).send({ name: 'x' });
    expect(res.status).toBe(401);
    expect((db.prepare(`SELECT COUNT(*) n FROM cards`).get() as any).n).toBe(0);
    const reg = await request(app).post('/api/auth/register').set('Origin', ORIGIN).send({ email: 'owner@example.com', password: 'correct horse battery', invite: newInvite() });
    expect(reg.status).toBe(201);
    ownerId = reg.body.id;
    cookie = (reg.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  });

  it('creates and lists a card (DB-backed), owned by the authenticated user', async () => {
    const created = await authed('post', '/api/cards').send({ name: 'Test card', last4: '1234' });
    expect(created.status).toBe(201);

    const list = await authed('get', '/api/cards');
    expect(list.status).toBe(200);
    expect(list.body.some((c: any) => c.id === created.body.id && c.credentials === undefined)).toBe(true);
    expect((db.prepare(`SELECT user_id FROM cards WHERE id = ?`).get(created.body.id) as any).user_id).toBe(ownerId);
  });

  it('GET /api/riseup/status returns a JSON error (no stack) when the token cannot be decrypted', async () => {
    const goodKey = randomBytes(32).toString('base64');
    const enc = encryptPat(PAT, ownerId, { TOKEN_ENC_KEY: goodKey });
    db.prepare(`INSERT INTO user_riseup (user_id, pat_ciphertext, iv, tag, key_version) VALUES (?, ?, ?, ?, ?)`)
      .run(ownerId, enc.ciphertext, enc.iv, enc.tag, enc.keyVersion);
    const saved = process.env.TOKEN_ENC_KEY;
    try {
      process.env.TOKEN_ENC_KEY = goodKey;
      const ok = await authed('get', '/api/riseup/status');
      expect(ok.status).toBe(200);
      expect(ok.body.connected).toBe(true);

      process.env.TOKEN_ENC_KEY = randomBytes(32).toString('base64');
      const bad = await authed('get', '/api/riseup/status');
      expect(bad.status).toBe(500);
      expect(bad.headers['content-type']).toMatch(/json/);
      expect(Object.keys(bad.body)).toEqual(['error']);
      expect(bad.text).not.toMatch(/Failed to decrypt|at .*\.(ts|js)|Error:/);
    } finally {
      if (saved === undefined) delete process.env.TOKEN_ENC_KEY; else process.env.TOKEN_ENC_KEY = saved;
      db.prepare(`DELETE FROM user_riseup`).run();
    }
  });

  it('rejects invalid card body', async () => {
    const res = await authed('post', '/api/cards').send({});
    expect(res.status).toBe(400);
  });

  it('PUT unknown card id returns 404', async () => {
    const res = await authed('put', '/api/cards/does-not-exist').send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('rate limiting', () => {
  it('returns 429 after RATE_LIMIT_MAX requests', async () => {
    const limited = createApp({ rateLimitMax: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await request(limited).get('/api/cards')).status).toBe(401); // counted even when unauthenticated
    }
    expect((await request(limited).get('/api/cards')).status).toBe(429);
  });

  it('is not bypassed by spoofed X-Forwarded-For from an untrusted peer', async () => {
    // supertest connects over loopback, which the default ('loopback') trusts like nginx.
    // 'uniquelocal' makes the loopback test peer untrusted, i.e. a direct non-proxy client.
    const limited = createApp({ rateLimitMax: 3, trustProxy: 'uniquelocal' });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(limited).get('/api/cards').set('X-Forwarded-For', `10.0.0.${i + 1}`);
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429).length).toBe(3);
  });

  it('exempts /api/health', async () => {
    const limited = createApp({ rateLimitMax: 2 });
    for (let i = 0; i < 6; i++) {
      expect((await request(limited).get('/api/health')).status).toBe(200);
    }
  });
});
