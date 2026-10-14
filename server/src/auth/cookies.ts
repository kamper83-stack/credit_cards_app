import type { Request, Response } from 'express';
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
