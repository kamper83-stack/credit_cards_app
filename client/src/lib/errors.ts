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

/** Friendly Hebrew message for 409/503/429 from /riseup/sync and PUT /riseup/token. */
export function riseupErrorMessage(e: unknown, fallback: string): string {
  switch (statusOf(e)) {
    case 409: return 'סנכרון כבר רץ';
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
  if (password.length < PASSWORD_MIN) return `הסיסמה חייבת להכיל לפחות ${PASSWORD_MIN} תווים`;
  if (password.length > PASSWORD_MAX) return `הסיסמה ארוכה מדי (עד ${PASSWORD_MAX} תווים)`;
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) return 'הסיסמה לא יכולה להיות זהה לכתובת האימייל';
  return null;
}
