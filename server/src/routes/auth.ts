import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../password.js';
import type { AuthConfig } from '../auth/config.js';
import { clearSessionCookie, setSessionCookie } from '../auth/cookies.js';
import { createAuthLimiters, normalizeEmail } from '../auth/limiters.js';
import { requireAuth } from '../auth/middleware.js';
import { checkPassword } from '../auth/passwordPolicy.js';
import { createSession, revokeAllSessions, revokeSession, rotateSession } from '../auth/sessions.js';

export const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_SECONDS = 60;
const LOCKOUT_MAX_SECONDS = 15 * 60;

const GENERIC_LOGIN_ERROR = 'אימייל או סיסמה שגויים';
const INVALID_INPUT = 'פרטים לא תקינים';

const EmailSchema = z.string().transform((s) => s.trim().toLowerCase())
  .pipe(z.string().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/));

const RegisterSchema = z.object({ email: EmailSchema, password: z.string().min(1).max(1024) });
const LoginSchema = z.object({ email: z.string().max(254), password: z.string().min(1).max(1024) });
const ChangeSchema = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(1).max(1024) });

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  is_admin: number;
  failed_attempts: number | null;
  locked_until: number | null;
}

export function createAuthRouter(db: Database.Database, cfg: AuthConfig): Router {
  const router = Router();
  const limits = createAuthLimiters(cfg);
  const nowSec = () => Math.floor(cfg.now() / 1000);

  // A real argon2 hash verified when the account is missing/locked, so those paths cost the same
  // CPU time as a genuine wrong-password attempt. Created lazily, once.
  let dummy: Promise<string> | undefined;
  const dummyHash = () => (dummy ??= hashPassword(randomUUID()));

  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const userPayload = (u: { id: string; email: string; is_admin: number }) => ({ id: u.id, email: u.email, isAdmin: !!u.is_admin });
  const isLocked = (u: UserRow) => !!u.locked_until && u.locked_until > nowSec();

  /** Counts a failed password check. From the 5th consecutive failure: lock 1m, 2m, 4m ... max 15m. */
  function recordFailure(userId: string): void {
    db.transaction(() => {
      db.prepare(`UPDATE users SET failed_attempts = COALESCE(failed_attempts, 0) + 1 WHERE id = ?`).run(userId);
      const n = (db.prepare(`SELECT failed_attempts AS n FROM users WHERE id = ?`).get(userId) as { n: number }).n;
      if (n >= LOCKOUT_THRESHOLD) {
        const delay = Math.min(LOCKOUT_MAX_SECONDS, LOCKOUT_BASE_SECONDS * 2 ** Math.min(n - LOCKOUT_THRESHOLD, 10));
        db.prepare(`UPDATE users SET locked_until = ? WHERE id = ?`).run(nowSec() + delay, userId);
      }
    })();
  }

  const resetFailures = (userId: string) =>
    db.prepare(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?`).run(userId);

  const startSession = (req: Request, res: Response, userId: string) => {
    const token = rotateSession(db, cfg, userId, req.sessionToken, req.get('user-agent'));
    setSessionCookie(res, cfg, token);
  };

  // Registration is open. With no email verification, a duplicate email is answered with an explicit
  // 409 (accepted enumeration tradeoff: a generic reply would need an out-of-band channel); the
  // endpoint is rate limited per IP, and argon2 is run before the uniqueness check so timing
  // does not distinguish new from existing addresses.
  router.post('/register', limits.registerIp, async (req, res, next) => {
    try {
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: INVALID_INPUT });
      const { email, password } = parsed.data;
      const policy = checkPassword(password, email);
      if (policy) return res.status(400).json({ error: policy });

      const passwordHash = await hashPassword(password);
      const id = randomUUID();
      try {
        db.prepare(`INSERT INTO users (id, email, password_hash, is_admin, created_at) VALUES (?, ?, ?, 0, ?)`)
          .run(id, email, passwordHash, nowSec());
      } catch (err: any) {
        if (typeof err?.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
          return res.status(409).json({ error: 'כתובת האימייל כבר רשומה' });
        }
        throw err;
      }
      startSession(req, res, id);
      res.status(201).json({ id, email, isAdmin: false });
    } catch (err) {
      next(err);
    }
  });

  // Login: wrong password, unknown email and locked account all return the same 401 body, no
  // Retry-After and equal argon2 work, so neither messages nor timing reveal whether an account
  // exists. Tradeoff: a locked user is not told to wait (the UI should hint at it generically);
  // the per-email limiter's 429 is uniform for existing and unknown addresses.
  router.post('/login', limits.loginIp, limits.loginEmail, async (req, res, next) => {
    try {
      const parsed = LoginSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: INVALID_INPUT });
      const email = normalizeEmail(parsed.data.email)!;
      const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as UserRow | undefined;
      const usable = !!user && !isLocked(user);

      const ok = await verifyPassword(usable ? user!.password_hash : await dummyHash(), parsed.data.password);
      if (!user || !usable || !ok) {
        // Failures during a lockout are not counted (an attacker cannot extend it).
        if (user && usable) recordFailure(user.id);
        return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
      }
      resetFailures(user.id);
      startSession(req, res, user.id);
      res.json(userPayload(user));
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (req, res) => {
    if (req.sessionToken) revokeSession(db, req.sessionToken);
    clearSessionCookie(res, cfg);
    res.json({ ok: true });
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json(req.user);
  });

  router.post('/change-password', requireAuth, async (req, res, next) => {
    try {
      const parsed = ChangeSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: INVALID_INPUT });
      const { currentPassword, newPassword } = parsed.data;
      const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user!.id) as UserRow | undefined;
      if (!user) return res.status(401).json({ error: 'נדרשת התחברות' });

      // Same lockout counter as login, so a stolen session cannot be used to guess the password.
      const usable = !isLocked(user);
      const ok = await verifyPassword(usable ? user.password_hash : await dummyHash(), currentPassword);
      if (!usable || !ok) {
        if (usable) recordFailure(user.id);
        return res.status(403).json({ error: 'הסיסמה הנוכחית שגויה' });
      }
      const policy = checkPassword(newPassword, user.email);
      if (policy) return res.status(400).json({ error: policy });
      if (newPassword === currentPassword) return res.status(400).json({ error: 'הסיסמה החדשה זהה לנוכחית' });

      const newHash = await hashPassword(newPassword);
      db.transaction(() => {
        db.prepare(`UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?`).run(newHash, user.id);
        revokeAllSessions(db, user.id); // including the current one: a fresh session replaces it
      })();
      setSessionCookie(res, cfg, createSession(db, cfg, user.id, req.get('user-agent')));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
