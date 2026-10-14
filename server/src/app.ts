import 'dotenv/config';
import express from 'express';
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

// TRUST_PROXY: number of proxy hops (default 1 = nginx in front), 'true'/'false',
// or any other value accepted by Express (e.g. 'loopback', a CIDR list).
function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '') return 1;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function createApp() {
  const app = express();

  app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

  // Strict CSP for the Vite-built SPA. Google Fonts is loaded from index.html;
  // React `style={}` props need inline style attributes (not inline <style> blocks).
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
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
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_MAX) || 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }));

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

  return app;
}

export const app = createApp();
