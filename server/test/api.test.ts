import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { createApp } from '../src/app.js';
import db from '../src/db.js';
import { encryptPat } from '../src/crypto.js';

const app = createApp();
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

  it('POST /api/cards returns 409 when no owner user exists', async () => {
    expect((await request(app).post('/api/cards').set('Sec-Fetch-Site', 'same-origin').send({ name: 'x' })).status).toBe(409);
    expect((db.prepare(`SELECT COUNT(*) n FROM cards`).get() as any).n).toBe(0);
  });

  it('creates and lists a card (DB-backed), owned by the legacy owner', async () => {
    db.prepare(`INSERT INTO users (id, email, password_hash, is_admin) VALUES ('owner', 'o@x.com', 'x', 1)`).run();
    const created = await request(app).post('/api/cards').set('Sec-Fetch-Site', 'same-origin').send({ name: 'Test card', last4: '1234' });
    expect(created.status).toBe(201);

    const list = await request(app).get('/api/cards');
    expect(list.status).toBe(200);
    expect(list.body.some((c: any) => c.id === created.body.id && c.credentials === undefined)).toBe(true);
    expect((db.prepare(`SELECT user_id FROM cards WHERE id = ?`).get(created.body.id) as any).user_id).toBe('owner');
  });

  it('GET /api/riseup/status returns a JSON error (no stack) when the token cannot be decrypted', async () => {
    const goodKey = randomBytes(32).toString('base64');
    const enc = encryptPat(PAT, 'owner', { TOKEN_ENC_KEY: goodKey });
    db.prepare(`INSERT INTO user_riseup (user_id, pat_ciphertext, iv, tag, key_version) VALUES ('owner', ?, ?, ?, ?)`)
      .run(enc.ciphertext, enc.iv, enc.tag, enc.keyVersion);
    const saved = process.env.TOKEN_ENC_KEY;
    try {
      process.env.TOKEN_ENC_KEY = goodKey;
      const ok = await request(app).get('/api/riseup/status');
      expect(ok.status).toBe(200);
      expect(ok.body.connected).toBe(true);

      process.env.TOKEN_ENC_KEY = randomBytes(32).toString('base64');
      const bad = await request(app).get('/api/riseup/status');
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
    const res = await request(app).post('/api/cards').set('Sec-Fetch-Site', 'same-origin').send({});
    expect(res.status).toBe(400);
  });

  it('PUT unknown card id returns 404', async () => {
    const res = await request(app).put('/api/cards/does-not-exist').set('Sec-Fetch-Site', 'same-origin').send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('rate limiting', () => {
  it('returns 429 after RATE_LIMIT_MAX requests', async () => {
    const limited = createApp({ rateLimitMax: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await request(limited).get('/api/cards')).status).toBe(200);
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
