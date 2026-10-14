import type { NextFunction, Request, Response } from 'express';
import type { AuthConfig } from './config.js';

/** Minimal Cookie header parser (no dependency). Returns the first value for `name`. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function attrs(cfg: AuthConfig): string {
  // No Domain attribute (host-only) - required for the __Host- prefix and keeps the cookie off subdomains.
  return `Path=/; HttpOnly; SameSite=Lax${cfg.secure ? '; Secure' : ''}`;
}

export function setSessionCookie(res: Response, cfg: AuthConfig, token: string): void {
  res.append('Set-Cookie', `${cfg.cookieName}=${token}; ${attrs(cfg)}; Max-Age=${cfg.absoluteSeconds}`);
}

export function clearSessionCookie(res: Response, cfg: AuthConfig): void {
  res.append('Set-Cookie', `${cfg.cookieName}=; ${attrs(cfg)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

/**
 * Logs once if secure-cookie mode is on but a request arrives over plain http (after trust-proxy
 * handling, i.e. honouring X-Forwarded-Proto from a trusted proxy). Browsers silently drop Secure
 * cookies received over http, so login would look successful but never stick.
 */
export function warnInsecureCookieMode(cfg: AuthConfig) {
  let warned = false;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (cfg.secure && !warned && req.protocol === 'http') {
      warned = true;
      console.warn('WARNING: COOKIE_SECURE is on but a request arrived over plain http. Browsers drop Secure cookies ' +
        'received over http, so logins will not stick. Serve over HTTPS (with X-Forwarded-Proto and a matching TRUST_PROXY) ' +
        'or set COOKIE_SECURE=false for a plain-HTTP deployment.');
    }
    next();
  };
}
