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
    // Per target account, regardless of source IP (slows distributed guessing). Successful logins
    // are not counted. Unknown and known emails are limited identically (no enumeration signal).
    loginEmail: rateLimit({
      ...common, windowMs: cfg.loginWindowMs, limit: cfg.loginEmailMax, skipSuccessfulRequests: true,
      keyGenerator: (req) => {
        const email = normalizeEmail(req.body?.email);
        return email ? `email:${email.slice(0, 254)}` : ipKeyGenerator(req.ip ?? '');
      },
    }),
    registerIp: rateLimit({
      ...common, windowMs: cfg.registerWindowMs, limit: cfg.registerIpMax,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ''),
    }),
  };
}
