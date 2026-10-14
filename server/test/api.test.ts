import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app = createApp();

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

  it('creates and lists a card (DB-backed)', async () => {
    const created = await request(app).post('/api/cards').send({ name: 'Test card', last4: '1234' });
    expect(created.status).toBe(201);

    const list = await request(app).get('/api/cards');
    expect(list.status).toBe(200);
    expect(list.body.some((c: any) => c.id === created.body.id && c.credentials === undefined)).toBe(true);
  });

  it('rejects invalid card body', async () => {
    const res = await request(app).post('/api/cards').send({});
    expect(res.status).toBe(400);
  });

  it('PUT unknown card id returns 404', async () => {
    const res = await request(app).put('/api/cards/does-not-exist').send({ name: 'x' });
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
