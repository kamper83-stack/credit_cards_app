# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

מעקב הטבות כרטיסי אשראי — a personal credit-card rewards tracker. Users define spending goals per card (e.g. "spend ₪3,000 this month for cashback") and the app tracks progress against them. Transactions are either synced automatically from RiseUp (Israeli budgeting service) via its official MCP server, or entered manually. All data is local (SQLite); nothing leaves the machine except calls to RiseUp itself. The UI is in Hebrew (RTL content, LTR layout).

npm workspaces monorepo: `client` (React SPA) and `server` (Express API), plus a top-level orchestrator `package.json`.

## Commands

Run from the repo root unless noted.

```bash
npm install && cd server && npm install && cd ../client && npm install  # first-time setup (workspaces need each installed)
npm run dev            # runs server (tsx watch) + client (vite) concurrently
npm run build           # builds client then server
npm start                # runs the built server (dist/index.js)
```

Client dev server: http://localhost:5173 (proxies `/api` to `http://localhost:3001`).
Server dev: http://localhost:3001.

Per-workspace commands (when working on just one side):
```bash
npm run dev --workspace=server     # tsx watch src/index.ts
npm run build --workspace=server   # tsc -> server/dist
npm run dev --workspace=client     # vite
npm run build --workspace=client   # tsc && vite build -> client/dist
```

There is no test suite and no linter configured in this repo.

Client also has `npm run deploy` (`gh-pages -d dist`) for publishing the built client to GitHub Pages — see routing note below.

## Architecture

### Data flow: RiseUp sync

`server/src/riseup.ts` spawns `@riseup-oss/mcp` as a local stdio MCP subprocess (via `@modelcontextprotocol/sdk`), passing the user's RiseUp Personal Access Token as an env var (`RISEUP_PAT`). It calls the `get_transactions` tool per cashflow month, filters to `sourceType === 'creditCard'` and non-income transactions, and groups them into "accounts" (cards).

Grouping key: `accountKey()` uses `transaction.accountNumberHash` when present (stable per-card hash, added in `@riseup-oss/mcp` v0.3.0), falling back to `transaction.source` (provider name only, e.g. `"isracard"`) for older server versions — meaning two same-issuer cards can only be distinguished when `accountNumberHash` is available.

`server/src/routes/riseup.ts` (`PUT /token`, `POST /sync`) owns the sync flow: validates PAT format, test-connects, stores the PAT in the `settings` table, then on sync upserts one `cards` row per RiseUp account (keyed on the unique `riseup_account_id` column) and upserts `transactions` rows keyed by RiseUp's own `transactionId`. Sync results and errors are appended to `sync_log`.

### Server

- `server/src/db.ts` — single `better-sqlite3` connection (`data/rewards.db` at repo root), synchronous queries throughout. Schema is created inline with `CREATE TABLE IF NOT EXISTS` plus ad-hoc `ALTER TABLE ... ADD COLUMN` guards for backward-compatible migrations (no migration framework — new columns need a matching guard block here).
- `server/src/index.ts` — Express app wiring; one router per resource under `/api/{cards,goals,transactions,riseup}`.
- Routers (`server/src/routes/*.ts`) validate request bodies with `zod` and talk to SQLite directly — no service/repository layer.
- **Goal progress is computed on read, not stored.** `GET /api/goals` derives the current period's date range from `period_type` (`getPeriodDates` in `goals.ts`: monthly/quarterly/yearly windows are computed from "now"; `custom` uses the stored `period_start`/`period_end`), then sums matching transactions (excluding `type = 'installments'`) to get `spent`, `progress`, `remaining`, `days_left`. There's no cron/scheduled recompute.

### Client

- Vite + React 18 + TypeScript, React Router (`client/src/App.tsx`), TanStack Query for all server state, axios instance with `baseURL: '/api'` (`client/src/api/index.ts`).
- **`vite.config.ts` sets `base: "/credit_cards_app/"`** for GitHub Pages hosting, and `main.tsx` passes `basename={import.meta.env.BASE_URL}` into `BrowserRouter` to match — both must stay in sync if the deploy path changes.
- Pages under `client/src/pages/`, reusable UI under `client/src/components/`; shared API response types in `client/src/types/index.ts` mirror the server's SQL row shapes (including the computed goal fields above) — update both sides together when changing a route's response shape.

### Deployment

Two deployment targets exist side by side, documented in [deploy/DEPLOY.md](deploy/DEPLOY.md):
- Client as a static build to GitHub Pages (`base: "/credit_cards_app/"`).
- Server + client together on a private VPS reachable only via Tailscale (nginx reverse-proxies `/api` to the Node process; `pm2` via `deploy/ecosystem.config.cjs` keeps it running; server binds `HOST=127.0.0.1` so it's never reachable except through nginx). There is intentionally no auth layer — see the note in DEPLOY.md before exposing this beyond Tailscale.

### Security notes specific to this app

- The RiseUp PAT is stored in plaintext in the `settings` table (local SQLite only) and is read-only, 30-day-expiring by design on RiseUp's side.
- `GET /api/cards` explicitly strips the `credentials` column from responses (`{ ...c, credentials: undefined }`) — preserve this if that query changes.
- PAT format is validated server-side only, against `/^riseup_pat_[A-Za-z0-9_-]{20,}$/` (`isValidPatFormat` in `server/src/riseup.ts`) before use. The client (`Settings.tsx`) has no matching check - a malformed token round-trips to the server before being rejected.
