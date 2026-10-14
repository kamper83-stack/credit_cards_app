export interface ApiErrorLike {
  response?: { status?: number; data?: { error?: unknown }; headers?: Record<string, unknown> };
}

export const statusOf = (e: unknown): number | undefined => (e as ApiErrorLike)?.response?.status;

/** Server-provided Hebrew message, if any. */
export function serverMessage(e: unknown): string | undefined {
  const m = (e as ApiErrorLike)?.response?.data?.error;
  return typeof m === 'string' && m ? m : undefined;
}

function retryAfterSeconds(e: unknown): number | undefined {
  const raw = (e as ApiErrorLike)?.response?.headers?.['retry-after'];
  const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

const retryHint = (s?: number) => (s ? ` (בעוד ${s} שניות)` : '');

export type RiseupOperation = 'sync' | 'connect';

/** Friendly Hebrew message for 409/503/429 from /riseup/sync (default) and PUT /riseup/token ('connect'). */
export function riseupErrorMessage(e: unknown, fallback: string, operation: RiseupOperation = 'sync'): string {
  switch (statusOf(e)) {
    case 409: return operation === 'connect' ? 'פעולה אחרת מול RiseUp כבר רצה, נסו שוב בעוד רגע' : 'סנכרון כבר רץ';
    case 503: return `השרת עסוק, נסו שוב בעוד רגע${retryHint(retryAfterSeconds(e))}`;
    case 429: return `יותר מדי ניסיונות${retryHint(retryAfterSeconds(e))}`;
    default: return serverMessage(e) ?? fallback;
  }
}

/** True when a sync failure message says the RiseUp PAT is expired/invalid. */
export const looksLikeExpiredToken = (message: string | null | undefined): boolean =>
  !!message && /פג תוקף|לא תקין/.test(message);

/** Errors for auth forms (login / register / change password). */
export function authErrorMessage(e: unknown): string {
  const status = statusOf(e);
  if (status === 429) return 'יותר מדי ניסיונות, נסו שוב מאוחר יותר';
  if (status === undefined) return 'שגיאת תקשורת, נסו שוב';
  if (status === 413 || status === 415) return 'הבקשה לא תקינה';
  return serverMessage(e) ?? (status === 401 ? 'אימייל או סיסמה שגויים' : 'הפעולה נכשלה, נסו שוב');
}

/** Client-side mirror of the server's auth input rules. Returns a Hebrew message or null. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export function validateEmail(email: string): string | null {
  const v = email.trim();
  if (!v) return 'יש להזין כתובת אימייל';
  if (v.length > 254 || !EMAIL_RE.test(v)) return 'כתובת האימייל אינה תקינה';
  return null;
}

export function validateNewPassword(password: string, email?: string): string | null {
  if (!password) return 'יש להזין סיסמה';
  // Mirror the server (auth/passwordPolicy.ts): NFC-normalised, length in Unicode code points.
  const pw = password.normalize('NFC');
  if (pw.includes('\u0000')) return 'הסיסמה מכילה תווים לא חוקיים';
  if (pw.trim() === '') return 'הסיסמה לא יכולה להכיל רק רווחים';
  const len = [...pw].length;
  if (len < PASSWORD_MIN) return `הסיסמה חייבת להכיל לפחות ${PASSWORD_MIN} תווים`;
  if (len > PASSWORD_MAX) return `הסיסמה ארוכה מדי (עד ${PASSWORD_MAX} תווים)`;
  if (email && pw.trim().toLowerCase() === email.trim().toLowerCase()) return 'הסיסמה לא יכולה להיות זהה לכתובת האימייל';
  return null;
}

/** Register errors: the generic auth mapping plus a friendly text for the (single, uniform) invalid-invite 400. */
export function registerErrorMessage(e: unknown): string {
  if (statusOf(e) === 400 && serverMessage(e) === INVALID_INVITE_MESSAGE) {
    return 'ההזמנה אינה תקפה או שפג תוקפה. בקשו קישור הזמנה חדש ממנהל המערכת.';
  }
  return authErrorMessage(e);
}
export const INVALID_INVITE_MESSAGE = 'ההזמנה אינה תקפה';

/**
 * Extracts an invite token from what a user pasted: a full link (`https://host/register#invite=TOKEN`, or the legacy `?invite=TOKEN`),
 * a relative path, a bare query (`?invite=TOKEN`) or the raw token. Never throws; returns '' if nothing usable.
 */
export function parseInvite(input: string): string {
  const v = input.trim();
  if (!v || v.length > 2000) return '';
  let candidate = v;
  if (/[?&#/]|invite=/.test(v)) {
    try {
      const u = new URL(v, 'http://invite.invalid');
      candidate = u.searchParams.get('invite') ?? new URLSearchParams(u.hash.replace(/^#/, '')).get('invite') ?? '';
    } catch { return ''; }
  }
  return /^[A-Za-z0-9_-]{8,200}$/.test(candidate) ? candidate : '';
}

/** Admin API errors. 403 is a plain "no permission", never a logout; 409 covers self / last-admin guards. */
export function adminErrorMessage(e: unknown, fallback = 'הפעולה נכשלה, נסו שוב'): string {
  switch (statusOf(e)) {
    case 403: return 'אין הרשאה';
    case 409: return serverMessage(e) ?? 'לא ניתן לבצע את הפעולה (משתמש עצמי או מנהל אחרון)';
    case 429: return 'יותר מדי ניסיונות, נסו שוב מאוחר יותר';
    case undefined: return 'שגיאת תקשורת, נסו שוב';
    default: return serverMessage(e) ?? fallback;
  }
}
