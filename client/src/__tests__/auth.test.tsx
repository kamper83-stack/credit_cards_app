import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import App from '../App';
import { api, transactionsApi } from '../api';
import { safeRedirectPath } from '../lib/safeRedirect';
import { mockApi, renderApp, user, type Handler } from './helpers';

afterEach(() => { cleanup(); });

const anonymous: Handler = (_m, url) => (url === '/auth/me' ? { status: 401, data: { error: 'נדרשת התחברות' } } : { status: 200, data: [] });
const authed: Handler = (_m, url) => {
  if (url === '/auth/me') return { status: 200, data: user };
  if (url === '/riseup/status') return { status: 200, data: { connected: false, tokenPreview: null, lastSyncedAt: null } };
  return { status: 200, data: [] };
};

const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('ProtectedRoute', () => {
  it('redirects anonymous users to /login and fires no data requests', async () => {
    const calls = mockApi(anonymous);
    renderApp(<App />, '/cards');
    expect(await screen.findByRole('heading', { name: 'התחברות' })).toBeTruthy();
    expect(calls).toEqual(['GET /auth/me']); // no /cards, /goals, /riseup/* (AutoSync) before login
  });

  it('redirects a logged-in user away from /login', async () => {
    mockApi(authed);
    renderApp(<App />, '/login');
    expect(await screen.findByText('מעקב הטבות כרטיסי אשראי')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'התחברות' })).toBeNull();
  });
});

describe('safeRedirectPath (open-redirect guard)', () => {
  it('accepts only same-origin relative paths', () => {
    expect(safeRedirectPath('/cards?x=1')).toBe('/cards?x=1');
    for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)', '/a\nb', 'cards', '', null, 42, '/login', '/register?x=1']) {
      expect(safeRedirectPath(bad)).toBe('/');
    }
  });
});

describe('cache isolation', () => {
  it('login success wipes the whole query cache', async () => {
    mockApi((m, url) => (url === '/auth/login' && m === 'POST' ? { status: 200, data: user } : anonymous(m, url, {} as never)));
    const { qc } = renderApp(<App />, '/login');
    await screen.findByRole('heading', { name: 'התחברות' });
    qc.setQueryData(['cards'], [{ id: 'prev-user-card' }]);
    type('אימייל', 'a@example.com');
    type('סיסמה', 'correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: 'התחבר' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'התחברות' })).toBeNull());
    expect(JSON.stringify(qc.getQueryData(['cards']) ?? null)).not.toContain('prev-user-card');
  });

  it('shows a generic message on a 401 login and keeps the form usable', async () => {
    mockApi((m, url) => (url === '/auth/login' ? { status: 401, data: { error: 'אימייל או סיסמה שגויים' } } : anonymous(m, url, {} as never)));
    renderApp(<App />, '/login');
    await screen.findByRole('heading', { name: 'התחברות' });
    type('אימייל', 'a@example.com');
    type('סיסמה', 'whatever-pass');
    fireEvent.click(screen.getByRole('button', { name: 'התחבר' }));
    expect(await screen.findByText('אימייל או סיסמה שגויים')).toBeTruthy();
  });

  it('logout wipes the cache and returns to /login', async () => {
    mockApi((m, url) => (url === '/auth/logout' ? { status: 200, data: { ok: true } } : authed(m, url, {} as never)));
    const { qc } = renderApp(<App />, '/');
    fireEvent.click(await screen.findByRole('button', { name: 'תפריט משתמש' }));
    qc.setQueryData(['secret'], 'user-a-data');
    fireEvent.click(screen.getByRole('menuitem', { name: /התנתק/ }));
    expect(await screen.findByRole('heading', { name: 'התחברות' })).toBeTruthy();
    expect(qc.getQueryData(['secret'])).toBeUndefined();
  });

  it('a 401 from a data request clears the cache and redirects to /login', async () => {
    let expired = false;
    mockApi((m, url) => {
      if (url === '/auth/me') return { status: 200, data: user };
      if (expired) return { status: 401, data: { error: 'נדרשת התחברות' } };
      return { status: 200, data: [] };
    });
    const { qc } = renderApp(<App />, '/');
    await screen.findByRole('button', { name: 'תפריט משתמש' });
    qc.setQueryData(['secret'], 'user-a-data');
    expired = true;
    await qc.refetchQueries({ queryKey: ['goals'] }).catch(() => undefined);
    expect(await screen.findByRole('heading', { name: 'התחברות' })).toBeTruthy();
    expect(qc.getQueryData(['secret'])).toBeUndefined();
  });

  it('a 401 from /auth/* does not trigger the global handler', async () => {
    mockApi(anonymous);
    await expect(api.get('/auth/me')).rejects.toBeTruthy();
  });
});

describe('Register form validation', () => {
  it('shows Hebrew messages and sends nothing when invalid', async () => {
    const calls = mockApi(anonymous);
    renderApp(<App />, '/register');
    await screen.findByRole('heading', { name: 'יצירת חשבון' });
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    expect(await screen.findByText('יש להזין כתובת אימייל')).toBeTruthy();

    type('אימייל', 'not-an-email');
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    expect(await screen.findByText('כתובת האימייל אינה תקינה')).toBeTruthy();

    type('אימייל', 'a@example.com');
    type(/^סיסמה/, 'short');
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    expect(await screen.findByText('הסיסמה חייבת להכיל לפחות 10 תווים')).toBeTruthy();

    type(/^סיסמה/, 'a-long-enough-password');
    type('אימות סיסמה', 'different-password-1');
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    expect(await screen.findByText('הסיסמאות אינן תואמות')).toBeTruthy();
    expect(calls.some(c => c.startsWith('POST'))).toBe(false);
  });

  it('maps 409 and 429 server responses', async () => {
    let status = 409;
    mockApi((m, url) => (url === '/auth/register'
      ? { status, data: { error: 'כתובת האימייל כבר רשומה' } }
      : anonymous(m, url, {} as never)));
    renderApp(<App />, '/register');
    await screen.findByRole('heading', { name: 'יצירת חשבון' });
    type('אימייל', 'a@example.com');
    type(/^סיסמה/, 'a-long-enough-password');
    type('אימות סיסמה', 'a-long-enough-password');
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    expect(await screen.findByText('כתובת האימייל כבר רשומה')).toBeTruthy();
    status = 429;
    fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
    expect(await screen.findByText('יותר מדי ניסיונות, נסו שוב מאוחר יותר')).toBeTruthy();
  });
});

describe('transactionsApi.delete', () => {
  it('sends card_id as a query param', async () => {
    let seen: unknown;
    mockApi((_m, _u, cfg) => { seen = cfg.params; return { status: 200, data: { ok: true } }; });
    await transactionsApi.delete('tx-1', 'card-9');
    expect(seen).toEqual({ card_id: 'card-9' });
  });
});
