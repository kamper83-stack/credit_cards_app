import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import cardsRouter from './routes/cards.js';
import goalsRouter from './routes/goals.js';
import transactionsRouter from './routes/transactions.js';
import riseupRouter from './routes/riseup.js';

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json());

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

app.listen(Number(PORT), HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
