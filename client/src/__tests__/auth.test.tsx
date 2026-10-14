import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import App from '../App';
import { api, transactionsApi } from '../api';
import { safeRedirectPath } from '../lib/safeRedirect';
import { riseupErrorMessage, validateNewPassword } from '../lib/errors';
import { RECHECK_THROTTLE_MS } from '../auth/AuthContext';
import { mockApi, renderApp, user, type Handler } from './helpers';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

/** In-memory BroadcastChannel so tests control both sides deterministically. */
function installFakeChannels() {
  const all = new Set<FakeChannel>();
  const sent: unknown[] = [];
  class FakeChannel {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    constructor(public name: string) { all.add(this); }
    postMessage(data: unknown) {
      sent.push(data);
      for (const c of all) if (c !== this && c.name === this.name) c.onmessage?.({ data });
    }
    close() { all.delete(this); }
  }
  vi.stubGlobal('BroadcastChannel', FakeChannel);
  return {
    sent,
    /** A message from "another tab". */
    emit: (data: unknown) => act(() => { for (const c of all) c.onmessage?.({ data }); }),
  };
}

const userB = { id: 'u2', email: 'b@example.com', isAdmin: false };
const meCalls = (calls: string[]) => calls.filter(c => c === 'GET /auth/me').length;

describe('cross-tab identity', () => {
  function setup() {
    let me: { status: number; data: unknown } = { status: 200, data: user };
    const calls = mockApi((m, url, cfg) => (url === '/auth/me' ? me : authed(m, url, cfg)));
    return { calls, setMe: (v: typeof me) => { me = v; } };
  }

  it('window focus: a different user wipes the cache and updates the header', async () => {
    const { calls, setMe } = setup();
    const { qc } = renderApp(<App />, '/');
    await screen.findByText('a@example.com');
    qc.setQueryData(['secret'], 'user-a-data');
    setMe({ status: 200, data: userB });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByText('b@example.com')).toBeTruthy();
    expect(screen.queryByText('a@example.com')).toBeNull();
    expect(qc.getQueryData(['secret'])).toBeUndefined();
    expect(meCalls(calls)).toBe(2);
  });

  it('same user on focus changes nothing (cache kept)', async () => {
    const { calls } = setup();
    const { qc } = renderApp(<App />, '/');
    await screen.findByText('a@example.com');
    qc.setQueryData(['keep'], 1);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(meCalls(calls)).toBe(2));
    expect(qc.getQueryData(['keep'])).toBe(1);
  });

  it('visibilitychange (visible) re-checks; throttled to once per 5s across focus+visibility', async () => {
    const { calls } = setup();
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    renderApp(<App />, '/');
    await screen.findByText('a@example.com');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(meCalls(calls)).toBe(2));
    now += RECHECK_THROTTLE_MS - 1;
    act(() => { window.dispatchEvent(new Event('focus')); });
    await new Promise(r => setTimeout(r, 20));
    expect(meCalls(calls)).toBe(2);
    now += 2;
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(meCalls(calls)).toBe(3));
  });

  it('focus when the session is gone (401) drops to the login screen and wipes the cache', async () => {
    const { setMe } = setup();
    const { qc } = renderApp(<App />, '/');
    await screen.findByText('a@example.com');
    qc.setQueryData(['secret'], 'x');
    setMe({ status: 401, data: { error: 'נדרשת התחברות' } });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await screen.findByRole('heading', { name: 'התחברות' })).toBeTruthy();
    expect(qc.getQueryData(['secret'])).toBeUndefined();
  });

  it('a network error on re-check keeps the current user', async () => {
    const { calls, setMe } = setup();
    renderApp(<App />, '/');
    await screen.findByText('a@example.com');
    setMe({ status: 500, data: {} });
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(meCalls(calls)).toBe(2));
    expect(screen.getByText('a@example.com')).toBeTruthy();
  });

  it('a broadcast with another user switches identity, wipes the cache and does not echo or loop', async () => {
    const { calls } = setup();
    const ch = installFakeChannels();
    const { qc } = renderApp(<App />, '/');
    await screen.findByText('a@example.com');
    qc.setQueryData(['secret'], 'user-a-data');
    ch.emit({ type: 'user', user: userB });
    expect(await screen.findByText('b@example.com')).toBeTruthy();
    expect(qc.getQueryData(['secret'])).toBeUndefined();
    await new Promise(r => setTimeout(r, 20));
    expect(ch.sent).toEqual([]); // applying a received user never re-broadcasts
    expect(meCalls(calls)).toBe(1);
  });

  it('a broadcast logout moves this tab to the login screen; same-user broadcast is a no-op', async () => {
    setup();
    const ch = installFakeChannels();
    const { qc } = renderApp(<App />, '/');
    await screen.findByText('a@example.com');
    qc.setQueryData(['keep'], 1);
    ch.emit({ type: 'user', user });
    expect(qc.getQueryData(['keep'])).toBe(1);
    ch.emit({ type: 'user', user: null });
    expect(await screen.findByRole('heading', { name: 'התחברות' })).toBeTruthy();
    expect(qc.getQueryData(['keep'])).toBeUndefined();
  });

  it('login in this tab broadcasts the new user; logout broadcasts null only after the server confirms', async () => {
    const ch = installFakeChannels();
    mockApi((m, url, cfg) => {
      if (url === '/auth/login') return { status: 200, data: user };
      if (url === '/auth/logout') return { status: 200, data: { ok: true } };
      return url === '/auth/me' && m === 'GET' ? { status: 401, data: {} } : authed(m, url, cfg);
    });
    renderApp(<App />, '/login');
    await screen.findByRole('heading', { name: 'התחברות' });
    type('אימייל', 'a@example.com');
    type('סיסמה', 'correct horse battery');
    fireEvent.click(screen.getByRole('button', { name: 'התחבר' }));
    fireEvent.click(await screen.findByRole('button', { name: 'תפריט משתמש' }));
    expect(ch.sent).toEqual([{ type: 'user', user }]);
    fireEvent.click(screen.getByRole('menuitem', { name: /התנתק/ }));
    await screen.findByRole('heading', { name: 'התחברות' });
    expect(ch.sent).toEqual([{ type: 'user', user }, { type: 'user', user: null }]);
  });

  it('works when BroadcastChannel does not exist', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    setup();
    renderApp(<App />, '/');
    expect(await screen.findByText('a@example.com')).toBeTruthy();
  });

  it('a late 401 from the previous user\'s request does not log the new user out', async () => {
    const { setMe } = setup();
    const base = api.defaults.adapter as (cfg: never) => Promise<unknown>;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    api.defaults.adapter = (async (cfg: { url?: string }) => {
      if (cfg.url === '/slow') {
        await gate;
        const { AxiosError } = await import('axios');
        throw new AxiosError('HTTP 401', 'ERR_BAD_REQUEST', cfg as never, null,
          { status: 401, statusText: '', data: {}, headers: {}, config: cfg as never });
      }
      return base(cfg as never);
    }) as never;
    renderApp(<App />, '/');
    await screen.findByText('a@example.com');
    const slow = api.get('/slow').catch(() => 'rejected');
    setMe({ status: 200, data: userB });
    act(() => { window.dispatchEvent(new Event('focus')); });
    await screen.findByText('b@example.com');
    release();
    expect(await slow).toBe('rejected');
    await new Promise(r => setTimeout(r, 20));
    expect(screen.getByText('b@example.com')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'התחברות' })).toBeNull();
  });
});

describe('logout failure', () => {
  it('clears local state, warns on the login screen and retries POST /auth/logout', async () => {
    let logoutStatus = 500;
    let signedIn = true;
    const calls = mockApi((m, url, cfg) => {
      if (url === '/auth/logout') return { status: logoutStatus, data: { ok: true } };
      if (url === '/auth/me') return signedIn ? { status: 200, data: user } : { status: 401, data: {} };
      return authed(m, url, cfg);
    });
    const { qc } = renderApp(<App />, '/');
    fireEvent.click(await screen.findByRole('button', { name: 'תפריט משתמש' }));
    qc.setQueryData(['secret'], 'x');
    fireEvent.click(screen.getByRole('menuitem', { name: /התנתק/ }));
    expect(await screen.findByRole('heading', { name: 'התחברות' })).toBeTruthy();
    expect(qc.getQueryData(['secret'])).toBeUndefined(); // local state cleared regardless
    expect(await screen.findByText(/ההתנתקות מול השרת נכשלה — ייתכן שהחיבור עדיין פעיל\. נסו להתנתק שוב/)).toBeTruthy();

    logoutStatus = 200;
    signedIn = false;
    fireEvent.click(screen.getByRole('button', { name: 'נסו להתנתק שוב' }));
    await waitFor(() => expect(screen.queryByText(/ההתנתקות מול השרת נכשלה/)).toBeNull());
    expect(calls.filter(c => c === 'POST /auth/logout')).toHaveLength(2);
  });

  it('keeps the warning when the retry fails too', async () => {
    mockApi((m, url, cfg) => (url === '/auth/logout' ? { status: 503, data: {} } : authed(m, url, cfg)));
    renderApp(<App />, '/');
    fireEvent.click(await screen.findByRole('button', { name: 'תפריט משתמש' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /התנתק/ }));
    await screen.findByText(/ההתנתקות מול השרת נכשלה/);
    fireEvent.click(screen.getByRole('button', { name: 'נסו להתנתק שוב' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'נסו להתנתק שוב' })).toHaveProperty('disabled', false));
    expect(screen.getByText(/ההתנתקות מול השרת נכשלה/)).toBeTruthy();
  });
});

describe('Settings RiseUp token field', () => {
  it('is a masked, non-autofilling, labelled input with a show/hide toggle', async () => {
    mockApi(authed);
    renderApp(<App />, '/settings');
    const input = (await screen.findByLabelText('טוקן גישה אישי (PAT)')) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('autocorrect')).toBe('off');
    expect(input.required).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'הצג סיסמה' })[0]);
    expect(input.type).toBe('text');
  });

  it('clears the token after a successful connect and maps 409 to a general message', async () => {
    let status = 409;
    mockApi((m, url, cfg) => (url === '/riseup/token' && m === 'PUT' ? { status, data: {} } : authed(m, url, cfg)));
    renderApp(<App />, '/settings');
    const input = (await screen.findByLabelText('טוקן גישה אישי (PAT)')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'riseup_pat_' + 'A'.repeat(30) } });
    fireEvent.click(screen.getByRole('button', { name: 'התחבר' }));
    expect(await screen.findByText('פעולה אחרת מול RiseUp כבר רצה, נסו שוב בעוד רגע')).toBeTruthy();
    status = 200;
    fireEvent.click(screen.getByRole('button', { name: 'התחבר' }));
    await waitFor(() => expect(input.value).toBe(''));
  });
});

describe('small helpers', () => {
  it('409 message differs between sync and connect', () => {
    const e = { response: { status: 409 } };
    expect(riseupErrorMessage(e, 'x')).toBe('סנכרון כבר רץ');
    expect(riseupErrorMessage(e, 'x', 'connect')).toBe('פעולה אחרת מול RiseUp כבר רצה, נסו שוב בעוד רגע');
  });

  it('password length is counted in code points after NFC (mirrors the server)', () => {
    expect(validateNewPassword('😀'.repeat(10))).toBeNull(); // 20 UTF-16 units, 10 code points
    expect(validateNewPassword('😀'.repeat(9))).not.toBeNull();
    expect(validateNewPassword('e\u0301'.repeat(10))).toBeNull(); // composes to 10 x "é"
    expect(validateNewPassword('e\u0301'.repeat(9) + 'xx')).toBeNull(); // 11 after NFC
    expect(validateNewPassword('😀'.repeat(129))).not.toBeNull();
    expect(validateNewPassword('😀'.repeat(128))).toBeNull();
    expect(validateNewPassword(' '.repeat(12))).not.toBeNull();
  });

  it('path params are URL-encoded', async () => {
    const urls: string[] = [];
    mockApi((_m, url) => { urls.push(url); return { status: 200, data: {} }; });
    await transactionsApi.delete('a/b?c#d', 'card-1');
    expect(urls).toEqual(['/transactions/a%2Fb%3Fc%23d']);
  });

  it('a double submit on the login form sends one request', async () => {
    const calls = mockApi((m, url, cfg) => (url === '/auth/login' ? { status: 401, data: {} } : anonymous(m, url, cfg)));
    renderApp(<App />, '/login');
    await screen.findByRole('heading', { name: 'התחברות' });
    type('אימייל', 'a@example.com');
    type('סיסמה', 'whatever-pass');
    const form = screen.getByRole('button', { name: 'התחבר' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByText('אימייל או סיסמה שגויים');
    expect(calls.filter(c => c === 'POST /auth/login')).toHaveLength(1);
  });
});
