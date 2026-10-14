import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../src/app.js';

const ORIGIN = 'http://app.test';
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-dist-'));
fs.mkdirSync(path.join(dist, 'assets'));
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title>');
fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
fs.writeFileSync(path.join(dist, 'card.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

const app = createApp({ allowedOrigins: [ORIGIN], cookieSecure: false, clientDist: dist, rateLimitMax: 1000 });

describe('Cache-Control', () => {
  it('/api responses are no-store: 200, 401, 404, 403 (CSRF) and 415', async () => {
    const cases = [
      request(app).get('/api/health'),
      request(app).get('/api/cards'),
      request(app).get('/api/auth/me'),
      request(app).post('/api/auth/login').set('Origin', 'http://evil.test').send({}),
      request(app).post('/api/auth/login').set('Origin', ORIGIN).set('Content-Type', 'text/plain').send('x'),
    ];
    const res = await Promise.all(cases);
    expect(res.map(r => r.status)).toEqual([200, 401, 401, 403, 415]);
    for (const r of res) {
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['pragma']).toBe('no-cache');
    }
  });

  it('unknown /api paths (JSON 404 for signed-in users, 401 otherwise) are no-store', async () => {
    const r = await request(app).get('/api/nope');
    expect([401, 404]).toContain(r.status);
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('the HTML shell is no-cache; hashed assets are immutable', async () => {
    const root = await request(app).get('/');
    expect(root.status).toBe(200);
    expect(root.headers['cache-control']).toBe('no-cache');
    const index = await request(app).get('/index.html');
    expect(index.headers['cache-control']).toBe('no-cache');
    const fallback = await request(app).get('/cards/some/deep/link');
    expect(fallback.status).toBe(200);
    expect(fallback.headers['cache-control']).toBe('no-cache');
    const asset = await request(app).get('/assets/app-abc123.js');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const svg = await request(app).get('/card.svg');
    expect(svg.headers['cache-control']).toBe('no-cache');
  });
});
