import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import App from '../App';
import { parseInvite } from '../lib/errors';
import { mockApi, renderApp, user, type Handler } from './helpers';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const TOKEN = 'Zx9_secretInviteToken-0123456789abcdefghijk';
const admin = { id: 'a1', email: 'admin@example.com', isAdmin: true };
const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

function Probe() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname + l.search}</div>;
}
const withProbe = (
  <>
    <App />
    <Probe />
  </>
);

const anonymous: Handler = (_m, url) => (url === '/auth/me' ? { status: 401, data: { error: 'נדרשת התחברות' } } : { status: 200, data: [] });

function fillRegister() {
  type('אימייל', 'new@example.com');
  type(/^סיסמה/, 'a-long-enough-password');
  type('אימות סיסמה', 'a-long-enough-password');
  fireEvent.click(screen.getByRole('button', { name: 'הרשמה' }));
}

describe('parseInvite', () => {
  it('accepts raw tokens, full links, paths and queries; rejects junk', () => {
    expect(parseInvite(TOKEN)).toBe(TOKEN);
    expect(parseInvite(`  https://rewards.example.com/register?invite=${TOKEN}  `)).toBe(TOKEN);
    expect(parseInvite(`/register?invite=${TOKEN}&x=1`)).toBe(TOKEN);
    expect(parseInvite(`?invite=${TOKEN}`)).toBe(TOKEN);
    for (const bad of ['', '   ', 'short', 'https://x.com/register', 'a b c d e f g h i', '<script>alert(1)</script>', 'https://x.com/?invite=' + 'a'.repeat(300)]) {
      expect(parseInvite(bad)).toBe('');
    }
  });
});

describe('Register with an invite', () => {
  it('sends the invite from ?invite=, strips it from the URL and never stores it', async () => {
    const bodies: unknown[] = [];
    mockApi((m, url, cfg) => {
      if (url === '/auth/register') { bodies.push(JSON.parse(String(cfg.data))); return { status: 201, data: { ...user, email: 'new@example.com' } }; }
      return anonymous(m, url, cfg);
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderApp(withProbe, `/register?invite=${TOKEN}`);
    await screen.findByRole('heading', { name: 'יצירת חשבון' });
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/register'));
    expect(document.body.innerHTML).not.toContain(TOKEN);
    fillRegister();
    await waitFor(() => expect(bodies).toEqual([{ email: 'new@example.com', password: 'a-long-enough-password', invite: TOKEN }]));
    expect(setItem.mock.calls.flat().join('|')).not.toContain(TOKEN);
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
  });

  it('maps the uniform invalid-invite 400 to a friendly message and lets the user change invite', async () => {
    mockApi((m, url, cfg) => (url === '/auth/register' ? { status: 400, data: { error: 'ההזמנה אינה תקפה' } } : anonymous(m, url, cfg)));
    renderApp(<App />, `/register?invite=${TOKEN}`);
    await screen.findByRole('heading', { name: 'יצירת חשבון' });
    fillRegister();
    expect(await screen.findByText(/ההזמנה אינה תקפה או שפג תוקפה/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'הזנת הזמנה אחרת' }));
    expect(await screen.findByText('ההרשמה אפשרית בהזמנה בלבד.')).toBeTruthy();
  });
});

describe('Register without an invite', () => {
  it('shows the closed message and accepts a pasted link or raw token', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    mockApi((m, url, cfg) => {
      if (url === '/auth/register') { bodies.push(JSON.parse(String(cfg.data))); return { status: 201, data: user }; }
      return anonymous(m, url, cfg);
    });
    renderApp(<App />, '/register');
    expect(await screen.findByText('ההרשמה אפשרית בהזמנה בלבד.')).toBeTruthy();
    expect(screen.queryByLabelText('אימות סיסמה')).toBeNull();

    type('קישור או קוד הזמנה', 'garbage');
    fireEvent.click(screen.getByRole('button', { name: 'המשך' }));
    expect(await screen.findByText('לא נמצאה הזמנה תקינה בטקסט שהוזן')).toBeTruthy();

    type('קישור או קוד הזמנה', `https://rewards.example.com/register?invite=${TOKEN}`);
    fireEvent.click(screen.getByRole('button', { name: 'המשך' }));
    await screen.findByLabelText('אימות סיסמה');
    fillRegister();
    await waitFor(() => expect(bodies[0]?.invite).toBe(TOKEN));
  });

  it('also accepts the raw token', async () => {
    mockApi(anonymous);
    renderApp(<App />, '/register');
    await screen.findByText('ההרשמה אפשרית בהזמנה בלבד.');
    type('קישור או קוד הזמנה', TOKEN);
    fireEvent.click(screen.getByRole('button', { name: 'המשך' }));
    expect(await screen.findByLabelText('אימות סיסמה')).toBeTruthy();
  });
});

describe('admin access', () => {
  const nonAdminApi: Handler = (_m, url) => {
    if (url === '/auth/me') return { status: 200, data: user };
    if (url === '/riseup/status') return { status: 200, data: { connected: false, tokenPreview: null, lastSyncedAt: null } };
    return { status: 200, data: [] };
  };

  it('hides the nav link and redirects /admin to / for non-admins, with no admin requests', async () => {
    const calls = mockApi(nonAdminApi);
    renderApp(withProbe, '/admin');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/'));
    expect(screen.queryByRole('link', { name: /ניהול/ })).toBeNull();
    expect(calls.some(c => c.includes('/admin'))).toBe(false);
  });

  it('shows the nav link for admins', async () => {
    mockApi((m, url, cfg) => (url === '/auth/me' ? { status: 200, data: admin } : nonAdminApi(m, url, cfg)));
    renderApp(<App />, '/');
    expect(await screen.findByRole('link', { name: /ניהול/ })).toBeTruthy();
  });

  it('a 403 from /admin/* shows "אין הרשאה" and does not log out', async () => {
    mockApi((m, url, cfg) => {
      if (url === '/auth/me') return { status: 200, data: admin };
      if (url.startsWith('/admin/')) return { status: 403, data: { error: 'אין הרשאה' } };
      return nonAdminApi(m, url, cfg);
    });
    renderApp(<App />, '/admin');
    expect((await screen.findAllByText('אין הרשאה')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'התחברות' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'ניהול' })).toBeTruthy();
  });
});

describe('admin page', () => {
  const now = Math.floor(Date.now() / 1000);
  const invites = [
    { id: 'i1', label: 'משפחה', maxUses: 2, usedCount: 1, expiresAt: now + 86400 * 3, revokedAt: null, createdAt: now - 100, status: 'active' },
    { id: 'i2', label: 'ישנה', maxUses: 1, usedCount: 0, expiresAt: now - 100, revokedAt: null, createdAt: now - 9999, status: 'expired' },
  ];
  const users = [
    { id: 'a1', email: 'admin@example.com', isAdmin: true, disabled: false, createdAt: now - 5000, lastSeen: now - 60, inviteLabel: null, cardCount: 0 },
    { id: 'u2', email: 'bob@example.com', isAdmin: false, disabled: false, createdAt: now - 4000, lastSeen: null, inviteLabel: 'משפחה', cardCount: 3 },
  ];

  function setup(over?: (...a: Parameters<Handler>) => ReturnType<Handler> | undefined) {
    const calls: string[] = [];
    const bodies: Record<string, unknown> = {};
    mockApi((m, url, cfg) => {
      calls.push(`${m} ${url}`);
      if (cfg.data) bodies[`${m} ${url}`] = JSON.parse(String(cfg.data));
      const o = over?.(m, url, cfg);
      if (o) return o;
      if (url === '/auth/me') return { status: 200, data: admin };
      if (url === '/admin/invites' && m === 'GET') return { status: 200, data: invites };
      if (url === '/admin/invites' && m === 'POST') return { status: 201, data: { id: 'i3', token: TOKEN, path: `/register?invite=${TOKEN}`, label: 'חבר', maxUses: 2, expiresAt: now + 86400 * 7 } };
      if (url === '/admin/users' && m === 'GET') return { status: 200, data: users };
      if (url.startsWith('/admin/')) return { status: 200, data: { ok: true } };
      if (url === '/riseup/status') return { status: 200, data: { connected: false, tokenPreview: null, lastSyncedAt: null } };
      return { status: 200, data: [] };
    });
    return { calls, bodies };
  }

  it('lists invites with status badges and users with roles', async () => {
    setup();
    renderApp(<App />, '/admin');
    expect(await screen.findByText('פעילה')).toBeTruthy();
    expect(screen.getByText('פגה')).toBeTruthy();
    expect(screen.getByText('1/2')).toBeTruthy();
    expect(await screen.findByText('bob@example.com')).toBeTruthy();
    expect(screen.getByText('מנהל')).toBeTruthy();
  });

  it('creates an invite, shows the link once with the page origin, then clears it', async () => {
    const { bodies } = setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderApp(<App />, '/admin');
    await screen.findByText('פעילה');
    type('תווית (אופציונלי)', 'חבר');
    type(/תוקף בימים/, '14');
    type(/מספר שימושים/, '2');
    fireEvent.click(screen.getByRole('button', { name: /יצירת הזמנה/ }));

    const box = await screen.findByRole('region', { name: 'קישור הזמנה חדש' });
    expect(bodies['POST /admin/invites']).toEqual({ label: 'חבר', expiresInDays: 14, maxUses: 2 });
    const expected = `${window.location.origin}/register?invite=${TOKEN}`;
    expect((within(box).getByLabelText('קישור הזמנה') as HTMLInputElement).value).toBe(expected);
    expect(within(box).getByText(/מוצג פעם אחת/)).toBeTruthy();

    fireEvent.click(within(box).getByRole('button', { name: /העתקת קישור/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
    expect(await within(box).findByText('הועתק')).toBeTruthy();
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(TOKEN);

    fireEvent.click(within(box).getByRole('button', { name: /סגירה והסתרה/ }));
    expect(screen.queryByRole('region', { name: 'קישור הזמנה חדש' })).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('drops the link when navigating away and back', async () => {
    setup();
    renderApp(<App />, '/admin');
    await screen.findByText('פעילה');
    fireEvent.click(screen.getByRole('button', { name: /יצירת הזמנה/ }));
    await screen.findByRole('region', { name: 'קישור הזמנה חדש' });
    fireEvent.click(screen.getByRole('link', { name: /הגדרות/ }));
    await screen.findByRole('heading', { name: 'הגדרות' });
    fireEvent.click(screen.getByRole('link', { name: /ניהול/ }));
    await screen.findByText('פעילה');
    expect(screen.queryByRole('region', { name: 'קישור הזמנה חדש' })).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it('validates create-form ranges client-side', async () => {
    const { calls } = setup();
    renderApp(<App />, '/admin');
    await screen.findByText('פעילה');
    type(/תוקף בימים/, '91');
    fireEvent.click(screen.getByRole('button', { name: /יצירת הזמנה/ }));
    expect(await screen.findByText(/בין 1 ל-90/)).toBeTruthy();
    expect(calls).not.toContain('POST /admin/invites');
  });

  it('revoke asks for confirmation and calls the revoke endpoint', async () => {
    const { calls } = setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderApp(<App />, '/admin');
    await screen.findByText('פעילה');
    const btn = screen.getByRole('button', { name: /ביטול הזמנה משפחה/ });
    fireEvent.click(btn);
    expect(calls).not.toContain('POST /admin/invites/i1/revoke');
    fireEvent.click(btn);
    await waitFor(() => expect(calls).toContain('POST /admin/invites/i1/revoke'));
    expect(confirm).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(calls.filter(c => c === 'GET /admin/invites').length).toBe(2)); // invalidated
  });

  it('disable asks for confirmation (explaining the effect) and calls the endpoint; self button is disabled', async () => {
    const { calls } = setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp(<App />, '/admin');
    await screen.findByText('bob@example.com');
    expect((screen.getByRole('button', { name: 'השבתת admin@example.com' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'השבתת bob@example.com' }));
    expect(String(confirm.mock.calls[0][0])).toMatch(/יתבטלו מיד/);
    expect(String(confirm.mock.calls[0][0])).toMatch(/הנתונים נשמרים/);
    await waitFor(() => expect(calls).toContain('POST /admin/users/u2/disable'));
  });

  it('enable calls the enable endpoint', async () => {
    const { calls } = setup((m, url) => (url === '/admin/users' && m === 'GET'
      ? { status: 200, data: [users[0], { ...users[1], disabled: true }] } : undefined));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp(<App />, '/admin');
    fireEvent.click(await screen.findByRole('button', { name: 'הפעלת bob@example.com' }));
    await waitFor(() => expect(calls).toContain('POST /admin/users/u2/enable'));
  });

  it('shows the Hebrew 409 message inline', async () => {
    setup((m, url) => (url === '/admin/users/u2/disable' ? { status: 409, data: { error: 'לא ניתן להשבית את המנהל האחרון' } } : undefined));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp(<App />, '/admin');
    fireEvent.click(await screen.findByRole('button', { name: 'השבתת bob@example.com' }));
    expect(await screen.findByText('לא ניתן להשבית את המנהל האחרון')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'התחברות' })).toBeNull();
  });

  it('admin data is dropped from the query cache on logout (queryClient.clear)', async () => {
    setup((m, url) => (url === '/auth/logout' ? { status: 200, data: { ok: true } } : undefined));
    const { qc } = renderApp(<App />, '/admin');
    await screen.findByText('bob@example.com');
    expect(qc.getQueryData(['admin', 'users'])).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'תפריט משתמש' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /התנתק/ }));
    await screen.findByRole('heading', { name: 'התחברות' });
    expect(qc.getQueryData(['admin', 'users'])).toBeUndefined();
    expect(qc.getQueryData(['admin', 'invites'])).toBeUndefined();
  });
});
