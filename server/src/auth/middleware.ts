import type { NextFunction, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { AuthConfig } from './config.js';
import { readCookie } from './cookies.js';
import { lookupSession, type AuthUser } from './sessions.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by sessionLoader when a valid session cookie was presented. */
      user?: AuthUser;
      /** Raw session token from the cookie (valid or not), for logout/rotation. */
      sessionToken?: string;
    }
  }
}

/** Attaches req.user when the request carries a valid session cookie. Never rejects. */
export function sessionLoader(db: Database.Database, cfg: AuthConfig) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = readCookie(req, cfg.cookieName);
    if (token) {
      req.sessionToken = token;
      try {
        const user = lookupSession(db, cfg, token);
        if (user) req.user = user;
      } catch (err) {
        return next(err);
      }
    }
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'נדרשת התחברות' });
  next();
}

/** 401 when anonymous, 403 when authenticated but not an admin. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'נדרשת התחברות' });
  if (!req.user.isAdmin) return res.status(403).json({ error: 'אין הרשאה' });
  next();
}
