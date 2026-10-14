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

Server tests (vitest + supertest, in-memory SQLite via `DB_PATH=:memory:`): `npm test --workspace=server`.

Client tests: `npm test --workspace=client` (vitest + Testing Library + jsdom, `client/src/__tests__/`; run in CI). There is no linter configured in this repo.

## Architecture

### Data flow: RiseUp sync

`server/src/riseup.ts` spawns `@riseup-oss/mcp` as a local stdio MCP subprocess (via `@modelcontextprotocol/sdk`), passing the user's RiseUp Personal Access Token (decrypted from `user_riseup`) as an env var (`RISEUP_PAT`). It calls the `get_transactions` tool per cashflow month, filters to `sourceType === 'creditCard'` and non-income transactions, and groups them into "accounts" (cards).

Grouping key: `accountKey()` uses `transaction.accountNumberHash` when present (stable per-card hash, added in `@riseup-oss/mcp` v0.3.0), falling back to `transaction.source` (provider name only, e.g. `"isracard"`) for older server versions — meaning two same-issuer cards can only be distinguished when `accountNumberHash` is available.

`server/src/routes/riseup.ts` (`PUT /token`, `POST /sync`) owns the sync flow: validates PAT format, test-connects, stores the PAT AES-256-GCM-encrypted in `user_riseup`, then on sync upserts one `cards` row per RiseUp account (keyed on the unique `riseup_account_id` column) and upserts `transactions` rows keyed by RiseUp's own `transactionId`. Sync results and errors are appended to `sync_log`.

### Server

- `server/src/db.ts` — single `better-sqlite3` connection (`data/rewards.db` at repo root), synchronous queries throughout. Schema is created inline with `CREATE TABLE IF NOT EXISTS` plus ad-hoc `ALTER TABLE ... ADD COLUMN` guards for backward-compatible migrations (no migration framework — new columns need a matching guard block here).
- `server/src/crypto.ts` (AES-256-GCM PAT encryption, AAD = user id, key from `TOKEN_ENC_KEY`, rotation via `TOKEN_ENC_KEY_VERSION`/`TOKEN_ENC_KEY_PREV`), `password.ts` (argon2id via `@node-rs/argon2`, prebuilt incl. musl), `migrate.ts` (legacy backup + async `runStartupMigrations()`, awaited in `index.ts` before listen).
- Multi-user schema (phase 2): `users`, `sessions`, `user_riseup`; `cards` and `sync_log` have `user_id`; `cards` is unique on `(user_id, riseup_account_id)`; `transactions` PK is `(card_id, id)` (RiseUp ids are not globally unique). Foreign keys are ON, WAL mode, DB file chmod 600.
- **Auth (phase 3)** — `server/src/auth/` + `routes/auth.ts` (mounted at `/api/auth`: `register`, `login`, `logout`, `me`, `change-password`).
  - Sessions: opaque 32-byte base64url token in an HttpOnly, SameSite=Lax, Path=/ , no-Domain cookie; the DB (`sessions`) stores only its SHA-256. Idle timeout 7d (sliding; `last_seen` written at most hourly), absolute 30d; expired rows purged at startup and hourly (`startSessionCleanup`, unref'd). Login/register/change-password always issue a fresh token (rotation; old one revoked); change-password revokes every session of the user.
  - Cookie name/flags: `COOKIE_SECURE` (default true in production, false otherwise) => `__Host-sid` + Secure, else `sid`. Plain-HTTP production (Tailscale) needs `COOKIE_SECURE=false`.
  - `sessionLoader` (global on `/api`) sets `req.user`; `requireAuth` (401) / `requireAdmin` (403) live in `auth/middleware.ts`. Routers do NOT mount `requireAuth` individually: `app.ts` has a default-deny guard on `/api` (see phase 4).
  - CSRF (`auth/csrf.ts`, all non-GET/HEAD/OPTIONS under `/api`): Origin must match the request Host (or `ALLOWED_ORIGINS`/`CLIENT_URL`); else Referer; else `Sec-Fetch-Site` same-origin/none; else 403. Bodies must be `application/json` (415). Non-browser clients must send an `Origin` header. Runs before `express.json`.
  - Login: generic 401 `אימייל או סיסמה שגויים` for wrong password / unknown email / locked account (dummy argon2 verify keeps timing equal). 5 consecutive failures lock the account (`users.failed_attempts/locked_until`) for 1m, 2m, 4m ... max 15m; failures while locked are not counted; success resets. Register returns 409 for a duplicate email (accepted enumeration tradeoff, rate limited). Password policy: 10-128 chars, not the email, not in a small common list (`auth/passwordPolicy.ts`).
  - Rate limits (`auth/limiters.ts`, env in `.env.example`): login per IP 20 + per email 10 / 15 min, register per IP 10 / hour, plus the general `/api` limiter.
  - Admin password reset: `npm run build --workspace=server && npm run reset-password --workspace=server -- <email>` (hidden prompt / stdin; revokes sessions, clears lockout). Tests inject `now`, `cookieSecure`, `allowedOrigins`, limiter maxes via `createApp()` options.
- **Per-user data isolation (phase 4) — security-critical, keep when editing routes.**
  - Default-deny guard: `app.ts` runs `requireAuth` for every `/api` request before any router unless it is on the exact-match `PUBLIC_API_ROUTES` allowlist (`POST /auth/register|login|logout`, `GET|HEAD /health`); new routes are protected automatically. `Cache-Control: no-store` (+ `Pragma: no-cache`) is set on every `/api` response by the first `/api` middleware; the HTML shell is `no-cache`, `/assets/*` immutable (`server/test/caching.test.ts`; mirrored in `deploy/nginx-app.conf.example`). Handlers use `req.user!.id` (the old `getLegacyOwnerId()` is gone).
  - Every query is user-scoped: cards by `cards.user_id = ?`; goals and transactions have no owner column and are always scoped through their card (`JOIN cards ... WHERE cards.user_id = ?`, or `card_id IN (SELECT id FROM cards WHERE user_id = ?)` in UPDATE/DELETE). Goal `spent` sums only the user's own transactions. `last_synced` comes from `sync_log WHERE user_id = ?`.
  - 404 policy: any object that belongs to another user (GET/PUT/DELETE by id, a foreign `card_id` in a body or in a list filter) answers exactly like a missing one: 404, never 403, same body. Do not add a "forbidden" branch.
  - Responses use explicit column lists: never `credentials`, `user_id`, or `transactions.raw` (the client does not use `raw`). `DELETE /transactions/:id` matches `(card_id, id)` only on the caller's cards; if the id matches rows on several of the caller's cards, pass `?card_id=` (otherwise 400).
  - RiseUp (`routes/riseup.ts`): PAT in `user_riseup` (encrypted), responses carry only the masked preview (`riseup_pat_...` + last 4). One in-flight RiseUp operation per user (409) and a global cap of `RISEUP_MAX_CONCURRENT` (default 3) simultaneous MCP subprocesses (503 + Retry-After); in-memory, so single-process only. The 24h auto-sync throttle is per user. `DELETE /token` removes only the token; already-synced cards/transactions/goals are kept.
  - Secret hygiene (`riseup.ts`): the MCP child gets a minimal env (`buildChildEnv`: `RISEUP_PAT` + proxy/CA/tmp allow-list; the SDK adds HOME/PATH/USER/...; never `TOKEN_ENC_KEY`, `ADMIN_*`, DB path). Client-facing RiseUp errors are fixed Hebrew messages by category (`RiseupError`: auth/network/timeout/unknown); detail goes to the server log only, passed through `redactSecrets` (strips `riseup_pat_...`). Never return `err.message` from the MCP/SDK.
  - Tests: `server/test/isolation.test.ts` (two users, every route/method, shared RiseUp transaction ids, leak scans, sanitized errors) includes a **route-inventory test** that walks the Express router stack and checks that arbitrary routes (via the `extraApiRoutes` test hook) cannot bypass the guard. `server/test/riseup.test.ts` asserts the MCP child env and error redaction.
- `server/src/index.ts` — Express app wiring; one router per resource under `/api/{cards,goals,transactions,riseup}`.
- Routers (`server/src/routes/*.ts`) validate request bodies with `zod` and talk to SQLite directly — no service/repository layer.
- **Goal progress is computed on read, not stored.** `GET /api/goals` derives the current period's date range from `period_type` (`getPeriodDates` in `goals.ts`: monthly/quarterly/yearly windows are computed from "now"; `custom` uses the stored `period_start`/`period_end`), then sums the user's own matching transactions (installment rows are currently included; the sum is joined to `cards.user_id`) to get `spent`, `progress`, `remaining`, `days_left`. There's no cron/scheduled recompute.

### Client

- Vite + React 18 + TypeScript, React Router (`client/src/App.tsx`), TanStack Query for all server state, axios instance with `baseURL: '/api'` (`client/src/api/index.ts`).
- The SPA is served from the domain root (`/`) by the Node server / nginx; there is no GitHub Pages hosting, no `base` override and no router `basename`. Keep the dev proxy `changeOrigin: false` in `vite.config.ts` (the server's CSRF check compares `Origin` with `Host`).
- **Auth flow:** the session is an HttpOnly cookie the client never reads. `auth/AuthContext.tsx` (`AuthProvider`/`useAuth`) probes `GET /auth/me` once (status `loading | authenticated | anonymous`) and exposes login/register/logout/changePassword mutations. `App.tsx` routes: `/login` and `/register` are wrapped in `GuestRoute` (signed-in users are bounced to `/`), everything else in `ProtectedRoute` (spinner while loading, then redirect to `/login` with the intended path in router state). `AppLayout` (header, `AutoSync`, all data pages) is only mounted when authenticated, so no data query or sync fires before `/me` resolves or on login screens. The redirect target goes through `lib/safeRedirect.ts` (same-origin relative paths only; open-redirect guard).
- **Cache isolation (critical):** every change of user (login, register, logout, or a 401) goes through `applyUser` in `AuthContext`, which calls `queryClient.clear()` BEFORE publishing the new user, so user B never sees user A's cached data. The axios response interceptor in `api/index.ts` calls the registered unauthorized handler on any 401 from a non-`/auth/*` request. Requests are tagged with a user "generation" (bumped by `applyUser`), so a late 401 from the previous user's request is ignored. Tabs share one cookie, so `AuthContext` also re-checks `/auth/me` on window focus / `visibilitychange` (throttled to 5s) and syncs via `BroadcastChannel('auth')`; a different user id goes through `applyUser` (cache wipe) before it is published. A failed server logout still clears local state but shows a retry warning on the login screen. Don't add `withCredentials` (same-origin) and don't cache auth state in localStorage.
- Shared error/validation helpers live in `lib/errors.ts` (Hebrew messages for 409/429/503 from RiseUp sync/token, auth form validation mirroring server rules: 10-128 char passwords). `transactionsApi.delete(id, card_id)` must pass `card_id` (server disambiguates synced rows).
- Pages under `client/src/pages/`, reusable UI under `client/src/components/`; shared API response types in `client/src/types/index.ts` mirror the server's SQL row shapes (including the computed goal fields above) — update both sides together when changing a route's response shape.

### Deployment

The deployment is documented in [deploy/DEPLOY.md](deploy/DEPLOY.md):
- Server + client together (the server also serves the built client) on a private VPS reachable only via Tailscale (nginx reverse-proxies `/api` to the Node process; `pm2` via `deploy/ecosystem.config.cjs` keeps it running; server binds `HOST=127.0.0.1` so it's never reachable except through nginx). Accounts, sessions and per-user data isolation are in place (phases 3-4); see DEPLOY.md for what is still required before exposing this beyond Tailscale.

### Security notes specific to this app

- The RiseUp PAT is stored encrypted (AES-256-GCM, per-user AAD) in `user_riseup`; `TOKEN_ENC_KEY` is required (`openssl rand -base64 32`). Upgrading a legacy DB moves the plaintext PAT out of `settings` and needs `ADMIN_EMAIL`/`ADMIN_PASSWORD` once; a read-only pre-flight (`preflight()` in `migrate.ts`, run by `openDatabase` before any backup or schema change) refuses to start, leaving the DB untouched, if the key/admin env is unusable; a one-time `rewards.db.bak-<timestamp>` copy (0600, still containing the old plaintext PAT) is then left next to the DB - delete it once verified. Rows on an older key version are re-encrypted lazily and at startup (see rotation in deploy/DEPLOY.md). The PAT is read-only and 30-day-expiring by design on RiseUp's side.
- `GET /api/cards` explicitly strips the `credentials` column from responses (`{ ...c, credentials: undefined }`) — preserve this if that query changes.
- PAT format is validated server-side only, against `/^riseup_pat_[A-Za-z0-9_-]{20,}$/` (`isValidPatFormat` in `server/src/riseup.ts`) before use. The client (`Settings.tsx`) has no matching check - a malformed token round-trips to the server before being rejected.
