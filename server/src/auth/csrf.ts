import type { NextFunction, Request, Response } from 'express';
import type { AuthConfig } from './config.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

/** Hosts (host[:port]) this request may legitimately be addressed to. */
function ownHosts(req: Request): string[] {
  const hosts: string[] = [];
  const host = req.get('host');
  if (host) hosts.push(host.toLowerCase());
  // X-Forwarded-Host only counts when the immediate peer is a trusted proxy (see TRUST_PROXY).
  const trust = req.app.get('trust proxy fn') as ((addr: string, i: number) => boolean) | undefined;
  const fwd = req.get('x-forwarded-host');
  if (fwd && trust && req.socket.remoteAddress && trust(req.socket.remoteAddress, 0)) {
    hosts.push(fwd.split(',')[0].trim().toLowerCase());
  }
  return hosts;
}

/**
 * CSRF defence for every state-changing /api request (anything but GET/HEAD/OPTIONS), on top of
 * SameSite=Lax cookies. Strict, in order:
 *  1. Origin present: must be one of our own hosts or ALLOWED_ORIGINS/CLIENT_URL ("null" is rejected).
 *  2. else Referer present: its origin must pass the same test.
 *  3. else Sec-Fetch-Site must be 'same-origin' or 'none'.
 *  4. else rejected (403) - non-browser clients (curl) must send an Origin header.
 * Then any request carrying a body must be application/json (415), which rules out the
 * form/text-plain "simple request" encodings.
 */
export function csrfProtection(cfg: AuthConfig) {
  const reject = (res: Response) => res.status(403).json({ error: 'הבקשה נדחתה (מקור לא מורשה)' });

  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE.has(req.method)) return next();

    const sameOrigin = (origin: string | null): boolean => {
      if (!origin) return false;
      if (cfg.allowedOrigins.includes(origin)) return true;
      return ownHosts(req).includes(new URL(origin).host.toLowerCase());
    };

    const origin = req.get('origin');
    const referer = req.get('referer');
    if (origin !== undefined) {
      if (!sameOrigin(originOf(origin))) return reject(res);
    } else if (referer !== undefined) {
      if (!sameOrigin(originOf(referer))) return reject(res);
    } else {
      const site = req.get('sec-fetch-site');
      if (site !== 'same-origin' && site !== 'none') return reject(res);
    }

    const hasBody = (req.headers['content-length'] && req.headers['content-length'] !== '0') || req.headers['transfer-encoding'];
    if (hasBody && !req.is('application/json')) {
      return res.status(415).json({ error: 'נדרש Content-Type: application/json' });
    }
    next();
  };
}
