import type { Request, Response } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { AuthConfig } from './config.js';

export function normalizeEmail(value: unknown): string | null {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

const tooMany = (_req: Request, res: Response) => res.status(429).json({ error: 'יותר מדי ניסיונות, נסו שוב מאוחר יותר' });

const common = { standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany } as const;

/** Must run after express.json() so the body email is available to the per-email key. */
export function createAuthLimiters(cfg: AuthConfig) {
  return {
    loginIp: rateLimit({
      ...common, windowMs: cfg.loginWindowMs, limit: cfg.loginIpMax,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
    }),
    // Keyed on (email + IP): an attacker burning their own quota against a victim's address cannot
    // lock the victim out from a different IP. Successful logins are not counted. Unknown and known
    // emails are limited identically (no enumeration signal).
    loginEmail: rateLimit({
      ...common, windowMs: cfg.loginWindowMs, limit: cfg.loginEmailMax, skipSuccessfulRequests: true,
      keyGenerator: (req) => {
        const ip = ipKeyGenerator(req.ip ?? '');
        const email = normalizeEmail(req.body?.email);
        return email ? `email+ip:${email.slice(0, 254)}|${ip}` : ip;
      },
    }),
    // Per email across all IPs: a deliberately high backstop against distributed guessing. Reaching it
    // needs many source IPs, and it is the one place a botnet could still deny a victim service.
    loginEmailGlobal: rateLimit({
      ...common, windowMs: cfg.loginWindowMs, limit: cfg.loginEmailGlobalMax, skipSuccessfulRequests: true,
      keyGenerator: (req) => {
        const email = normalizeEmail(req.body?.email);
        return email ? `email:${email.slice(0, 254)}` : ipKeyGenerator(req.ip ?? '');
      },
    }),
    // Counts only registrations rejected for an invalid invite (handler sets res.locals.invalidInvite),
    // so tokens cannot be guessed; valid registrations and other errors do not consume this quota.
    inviteFailIp: rateLimit({
      ...common, windowMs: cfg.inviteFailWindowMs, limit: cfg.inviteFailMax,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
      requestWasSuccessful: (_req, res) => !res.locals.invalidInvite,
      skipSuccessfulRequests: true,
    }),
    registerIp: rateLimit({
      ...common, windowMs: cfg.registerWindowMs, limit: cfg.registerIpMax,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
    }),
  };
}
