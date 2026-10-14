export interface AuthOptions {
  /** Force the Secure / __Host- cookie mode. Default: env COOKIE_SECURE, else NODE_ENV === 'production'. */
  cookieSecure?: boolean;
  /** Extra allowed Origins for the CSRF check (full origins, e.g. https://app.example.com). Default: env ALLOWED_ORIGINS + CLIENT_URL. */
  allowedOrigins?: string[];
  /** Injectable clock (ms since epoch) for tests. */
  now?: () => number;
  /** Per-IP login limit (default env LOGIN_RATE_LIMIT_IP_MAX or 20). */
  loginIpMax?: number;
  /** Per (email + IP) login limit (default env LOGIN_RATE_LIMIT_EMAIL_MAX or 10). */
  loginEmailMax?: number;
  /** Per-email ceiling across all IPs, a high backstop only (default env LOGIN_RATE_LIMIT_EMAIL_GLOBAL_MAX or 100). */
  loginEmailGlobalMax?: number;
  loginWindowMs?: number;
  /** Per-IP registration limit (default env REGISTER_RATE_LIMIT_MAX or 10). */
  registerIpMax?: number;
  registerWindowMs?: number;
}

export interface AuthConfig {
  secure: boolean;
  cookieName: string;
  /** Idle timeout (seconds): a session unused for this long dies. */
  idleSeconds: number;
  /** Absolute lifetime (seconds) from creation, regardless of activity. */
  absoluteSeconds: number;
  /** last_seen is written at most once per this many seconds. */
  touchSeconds: number;
  allowedOrigins: string[];
  now: () => number;
  loginIpMax: number;
  loginEmailMax: number;
  loginEmailGlobalMax: number;
  loginWindowMs: number;
  registerIpMax: number;
  registerWindowMs: number;
}

export const IDLE_SECONDS = 7 * 24 * 3600;
export const ABSOLUTE_SECONDS = 30 * 24 * 3600;
export const TOUCH_SECONDS = 3600;

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  const v = value.toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

function envNum(value: string | undefined): number | undefined {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : undefined;
}

function toOrigin(value: string): string | null {
  try {
    const u = new URL(value.trim());
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

export function resolveAuthConfig(o: AuthOptions = {}, env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const secure = o.cookieSecure ?? envBool(env.COOKIE_SECURE) ?? env.NODE_ENV === 'production';
  const origins = o.allowedOrigins ?? [
    ...(env.ALLOWED_ORIGINS ?? '').split(','),
    env.CLIENT_URL ?? '',
  ];
  return {
    secure,
    cookieName: secure ? '__Host-sid' : 'sid',
    idleSeconds: IDLE_SECONDS,
    absoluteSeconds: ABSOLUTE_SECONDS,
    touchSeconds: TOUCH_SECONDS,
    allowedOrigins: origins.map(toOrigin).filter((x): x is string => !!x),
    now: o.now ?? Date.now,
    loginIpMax: o.loginIpMax ?? envNum(env.LOGIN_RATE_LIMIT_IP_MAX) ?? 20,
    loginEmailMax: o.loginEmailMax ?? envNum(env.LOGIN_RATE_LIMIT_EMAIL_MAX) ?? 10,
    loginEmailGlobalMax: o.loginEmailGlobalMax ?? envNum(env.LOGIN_RATE_LIMIT_EMAIL_GLOBAL_MAX) ?? 100,
    loginWindowMs: o.loginWindowMs ?? envNum(env.LOGIN_RATE_LIMIT_WINDOW_MS) ?? 15 * 60 * 1000,
    registerIpMax: o.registerIpMax ?? envNum(env.REGISTER_RATE_LIMIT_MAX) ?? 10,
    registerWindowMs: o.registerWindowMs ?? envNum(env.REGISTER_RATE_LIMIT_WINDOW_MS) ?? 60 * 60 * 1000,
  };
}
