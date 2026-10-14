import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

const app = createApp();

describe('API', () => {
  it('GET /api/health', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
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
});
