import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../../data/rewards.db');

import fs from 'fs';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    last4 TEXT,
    color TEXT DEFAULT '#6366f1',
    icon TEXT,
    credentials TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    riseup_account_id TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    target_amount REAL NOT NULL,
    period_type TEXT NOT NULL CHECK(period_type IN ('monthly', 'quarterly', 'yearly', 'custom')),
    period_start TEXT,
    period_end TEXT,
    reward_description TEXT,
    reward_value REAL,
    active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    description TEXT,
    category TEXT,
    original_currency TEXT,
    original_amount REAL,
    type TEXT DEFAULT 'normal',
    raw TEXT,
    FOREIGN KEY(card_id) REFERENCES cards(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    synced_at INTEGER DEFAULT (unixepoch())
  );
`);

const cardColumns = db.prepare(`PRAGMA table_info(cards)`).all() as Array<{ name: string }>;
const cardColumnNames = new Set(cardColumns.map(c => c.name));
if (!cardColumnNames.has('source')) {
  db.exec(`ALTER TABLE cards ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
}
if (!cardColumnNames.has('riseup_account_id')) {
  db.exec(`ALTER TABLE cards ADD COLUMN riseup_account_id TEXT`);
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_riseup_account
    ON cards(riseup_account_id) WHERE riseup_account_id IS NOT NULL;
`);

export default db;
