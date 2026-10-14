import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the SDK transport + client so no subprocess is spawned; capture constructor params.
const captured: { params?: any } = {};
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/stdio.js')>();
  class StubTransport { constructor(params: any) { captured.params = params; } }
  return { ...actual, StdioClientTransport: StubTransport };
});
const connectImpl = vi.fn();
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class { connect = connectImpl; close = async () => {}; callTool = vi.fn(); },
}));

import { existsSync } from 'fs';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  buildChildEnv, redactSecrets, classifyRiseupFailure, toRiseupError, RiseupError,
  testRiseupConnection, RISEUP_ERROR_MESSAGES,
} from '../src/riseup.js';

const PAT = 'riseup_pat_' + 'Z'.repeat(30);
const SECRETS = {
  TOKEN_ENC_KEY: 'k'.repeat(44), TOKEN_ENC_KEY_PREV: 'p'.repeat(44), ADMIN_EMAIL: 'admin@x.com',
  ADMIN_PASSWORD: 'hunter2hunter2', ADMIN_PASSWORD_FILE: '/run/secrets/admin', DB_PATH: '/data/rewards.db',
  SESSION_SECRET: 'sess', COOKIE_SECURE: 'true', ALLOWED_ORIGINS: 'https://x', CLIENT_URL: 'https://x',
};

beforeEach(() => { captured.params = undefined; connectImpl.mockReset(); });

describe('MCP child environment', () => {
  it('contains only RISEUP_PAT and allow-listed network settings', () => {
    const env = buildChildEnv(PAT, { ...SECRETS, PATH: '/usr/bin', HOME: '/home/x', HTTPS_PROXY: 'http://proxy:8080', NODE_ENV: 'production' });
    expect(env).toEqual({ RISEUP_PAT: PAT, HTTPS_PROXY: 'http://proxy:8080' });
  });

  it('the real spawn env (SDK defaults merged with ours) leaks no server secrets', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, SECRETS, { PATH: process.env.PATH ?? '/usr/bin' });
    try {
      connectImpl.mockRejectedValue(new Error('boom'));
      await expect(testRiseupConnection(PAT)).rejects.toBeInstanceOf(RiseupError);
      expect(captured.params.command).toBe(process.execPath);
      expect(captured.params.args).toHaveLength(1);
      expect(captured.params.args[0]).toMatch(/@riseup-oss[\\/]mcp[\\/].*index\.js$/);
      expect(existsSync(captured.params.args[0])).toBe(true);
      // This is exactly what StdioClientTransport.start() passes to spawn().
      const effective = { ...getDefaultEnvironment(), ...captured.params.env };
      expect(effective.RISEUP_PAT).toBe(PAT);
      for (const k of Object.keys(SECRETS)) expect(effective).not.toHaveProperty(k);
      const joined = Object.values(effective).join('\n');
      for (const v of Object.values(SECRETS)) expect(joined).not.toContain(v);
      expect(Object.keys(effective).every(k => ['RISEUP_PAT', 'HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'TMPDIR', 'TEMP', 'TMP'].includes(k))).toBe(true);
      // the child's stderr is not forwarded into our process output
      expect(captured.params.stderr).toBe('ignore');
    } finally {
      for (const k of Object.keys(SECRETS)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('error sanitization', () => {
  it('redactSecrets removes PAT-shaped strings and literal secrets', () => {
    const out = redactSecrets(`failed riseup_pat_abc-DEF_123 and also ${PAT} plus sekret-literal-1`, 'sekret-literal-1');
    expect(out).not.toMatch(/riseup_pat_[A-Za-z0-9]/);
    expect(out).not.toContain('sekret-literal-1');
    expect(out).toContain('[REDACTED]');
  });

  it.each([
    ['401 Unauthorized', 'auth'], ['token expired', 'auth'], ['Invalid token', 'auth'],
    ['getaddrinfo ENOTFOUND api.riseup.co.il', 'network'], ['fetch failed', 'network'], ['ECONNREFUSED', 'network'],
    ['request timed out', 'timeout'], ['ETIMEDOUT', 'timeout'],
    ['something weird', 'unknown'],
  ])('classifies %j as %s', (raw, cat) => {
    expect(classifyRiseupFailure(raw)).toBe(cat);
  });

  it('connect failures surface only a fixed Hebrew message; detail is scrubbed', async () => {
    connectImpl.mockRejectedValue(new Error(`spawn /home/x/.npm/npx ENOENT with ${PAT}`));
    const err = await testRiseupConnection(PAT).catch(e => e);
    expect(err).toBeInstanceOf(RiseupError);
    expect(Object.values(RISEUP_ERROR_MESSAGES)).toContain(err.message);
    expect(err.message).not.toMatch(/ENOENT|\/home|riseup_pat_/);
    expect(err.detail).not.toContain(PAT);
  });

  it('toRiseupError is idempotent and never keeps the token', () => {
    const e = toRiseupError(new Error(`bad ${PAT}`), PAT);
    expect(toRiseupError(e)).toBe(e);
    expect(e.detail).not.toContain(PAT);
  });
});
