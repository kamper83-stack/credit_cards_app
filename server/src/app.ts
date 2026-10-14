import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cardsRouter from './routes/cards.js';
import goalsRouter from './routes/goals.js';
import transactionsRouter from './routes/transactions.js';
import riseupRouter from './routes/riseup.js';
import db from './db.js';
import { createAuthRouter } from './routes/auth.js';
import { resolveAuthConfig, type AuthOptions } from './auth/config.js';
import { csrfProtection } from './auth/csrf.js';
import { sessionLoader } from './auth/middleware.js';
import { warnInsecureCookieMode } from './auth/cookies.js';

// TRUST_PROXY: which peers may set X-Forwarded-* (affects req.ip and thus rate limiting).
// Default 'loopback': only a proxy on the same host (nginx -> 127.0.0.1) is trusted, so a
// direct client cannot spoof X-Forwarded-For. Accepts a hop count, 'true'/'false', or any
// value Express understands ('loopback, linklocal, uniquelocal', a CIDR list, ...).
// Avoid a bare hop count when the server is reachable directly (HOST=0.0.0.0).
function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '') return 'loopback';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export interface AppOptions extends AuthOptions {
  trustProxy?: boolean | number | string;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const authConfig = resolveAuthConfig(options);

  app.set('trust proxy', options.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY));

  // Strict CSP for the Vite-built SPA. Google Fonts is loaded from index.html;
  // React `style={}` props need inline style attributes (not inline <style> blocks).
  // upgrade-insecure-requests is disabled and HSTS is production-only, so plain-HTTP
  // access (Tailscale IP, local dev) keeps working; browsers ignore HSTS over HTTP anyway.
  app.use(helmet({
    strictTransportSecurity: process.env.NODE_ENV === 'production',
    contentSecurityPolicy: {
      directives: {
        upgradeInsecureRequests: null,
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }));

  // Same-origin is the target; enable CORS only when CLIENT_URL is explicitly set.
  if (process.env.CLIENT_URL) app.use(cors({ origin: process.env.CLIENT_URL }));
  // CSRF check runs before body parsing so non-JSON bodies are refused unparsed.
  app.use('/api', csrfProtection(authConfig));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', rateLimit({
    windowMs: options.rateLimitWindowMs ?? (Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000),
    limit: options.rateLimitMax ?? (Number(process.env.RATE_LIMIT_MAX) || 300),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.path === '/health', // mounted at /api, so this is /api/health (Docker healthcheck)
  }));

  // Attaches req.user when a valid session cookie is present. Existing routes are not yet
  // protected with requireAuth (phase 4 scopes them per user).
  app.use('/api', warnInsecureCookieMode(authConfig));
  app.use('/api', sessionLoader(db, authConfig));
  app.use('/api/auth', createAuthRouter(db, authConfig));

  app.use('/api/cards', cardsRouter);
  app.use('/api/goals', goalsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/riseup', riseupRouter);

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // Serve the built SPA (client/dist) if present — used by the Docker image,
  // where nginx proxies the whole domain to this container.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = path.join(__dirname, '../../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback: any non-API route serves index.html
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // Last-resort handler: JSON only, never a stack trace or native error text.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err?.message);
    if (res.headersSent) return;
    const status = err?.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Bad request' });
  });

  return app;
}
