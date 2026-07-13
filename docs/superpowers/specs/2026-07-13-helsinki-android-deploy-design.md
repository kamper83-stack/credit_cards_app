# Deploy to Helsinki VPS + Android access — Design

## Goal

Run the credit-card rewards tracker (Express backend + React/Vite frontend,
currently only reachable on the developer's Mac) on the existing Helsinki
VPS, and access it from an Android phone, so it doesn't depend on the Mac
being on and doesn't require being on the same LAN.

## Constraints / decisions

- No public internet exposure. Helsinki's firewall (`ufw`) already only
  allows traffic on the Tailscale interface plus loopback — this deploy
  must stay inside that model, matching the app's "data stays local/private"
  premise from the README.
- Data: **fresh start**. The existing local SQLite DB (cards, goals,
  synced transactions, RiseUp PAT) is not migrated. A new empty DB is
  created on Helsinki on first run; the user re-enters the RiseUp PAT and
  re-syncs, and re-creates any goals, once the deployed instance is live.
- Access shape: **dedicated Tailscale Serve port**, not a path prefix on
  the existing `:443` mapping. Helsinki already has
  `tailscale serve` publishing `https://openclaw-server.taileb3fe2.ts.net`
  on `:443` for another service (`Handlers["/"] -> proxy http://127.0.0.1:18789`).
  This deploy adds a second HTTPS port (`:8443`) rather than sharing `/`,
  so no path-prefix changes are needed in the React router, Vite build
  config, or API client.
- PWA scope: **installable icon only**. Manifest + minimal service worker
  sufficient for Chrome's "Add to Home Screen" / standalone install
  criteria. No offline caching of data — every open requires a live
  connection to Helsinki over Tailscale.
- Update workflow: **manual deploy script**, run from the Mac. No
  webhook/cron auto-deploy. The user runs one script when they want to
  ship a change.

## Architecture

```
Android phone (Tailscale client, tailnet: kamper83)
   |
   |  https://openclaw-server.taileb3fe2.ts.net:8443
   v
Helsinki VPS (100.117.23.108, "openclaw-server")
   tailscale serve --https=8443
     /      -> static files: client/dist  (built React app)
     /api   -> proxy http://127.0.0.1:4001 (Express backend)

   pm2 process "credit-cards-server"
     runs: node server/dist/index.js (or tsx, see open question below)
     port: 4001 (loopback only, not bound to a public interface)
     reads: server/.env (PORT=4001, CLIENT_URL=https://openclaw-server.taileb3fe2.ts.net:8443)
     data: data/rewards.db (SQLite, created on first boot, gitignored)
```

Existing services on Helsinki (hermes bridge on :3000, hermes dashboard on
:9119, the other `tailscale serve` mapping on :443 -> :18789) are untouched;
port 4001 and the new tailscale serve `:8443` entry are new and don't
collide with anything currently running (verified via `ss -tlnp` and
`tailscale serve status --json`).

## Components

**1. Helsinki checkout**
A clone of `github.com/kamper83-stack/credit_cards_app` on Helsinki, e.g.
at `/home/ai_admin/apps/credit-cards`. Kept up to date by the deploy
script (`git pull`), never edited by hand on the server.

**2. Backend runtime config**
`server/.env` on Helsinki (not committed — same pattern as local `.env`):
```
PORT=4001
CLIENT_URL=https://openclaw-server.taileb3fe2.ts.net:8443
```
Only difference from local dev: the port and the CORS origin.

**3. pm2 process**
One pm2 app, `credit-cards-server`, running the backend. Needs a
production start command — currently `server/package.json` only has
`dev` (tsx watch) and `build`/`start` (compiles to `dist/` then
`node dist/index.js`). The deploy will use the compiled `start` path,
not `tsx watch`, so pm2 supervises a plain `node` process rather than a
dev-mode file watcher.
`pm2 save` after first start so it survives a VPS reboot (pm2 startup
hook — confirm during implementation whether one is already registered
on this box from the hermes services, likely yes).

**4. Frontend build**
`npm run build --workspace=client` produces `client/dist`. No Node
process needed to serve it — `tailscale serve` reads static files
straight from disk.

**5. tailscale serve config**
Two handlers added under `--https=8443`:
- `/` → static dir `client/dist`
- `/api` → proxy `http://127.0.0.1:4001`
This config is a machine-local `tailscaled` setting, not something
committed to the repo — the deploy script (re-)applies it idempotently
so it survives a `tailscale serve reset` or VPS rebuild.

**6. Deploy script**
`scripts/deploy-helsinki.sh`, run from the Mac (SSH out to Helsinki, not
run on Helsinki itself). Responsibilities:
- SSH to Helsinki
- `git pull` in the app checkout
- `npm install` (root, resolves workspaces)
- `npm run build` (client build + server `tsc` compile)
- `pm2 restart credit-cards-server` (or `pm2 start` + `pm2 save` on very
  first deploy)
- re-apply the `tailscale serve` mapping (safe to re-run; no-op if
  already correct)
- print the final URL for convenience

**7. PWA assets**
- `client/public/manifest.json` — name, short_name, icons (need at least
  one 192x192 and one 512x512 PNG), `display: standalone`,
  `start_url: /`, theme/background colors matching the app's existing
  Tailwind palette.
- A minimal service worker (`client/public/sw.js` or via a small Vite
  plugin) registered from the app entry point — just enough of an
  install/activate lifecycle to pass Chrome's installability check. No
  runtime caching strategy.
- `index.html` gets a `<link rel="manifest">` and theme-color meta tag.

## Data flow

1. User opens `https://openclaw-server.taileb3fe2.ts.net:8443` on their
   phone (Tailscale must be on).
2. Tailscale serve routes `/` to the static `client/dist` files (the
   React app loads).
3. React app calls `/api/...` (same-origin, since both are behind the
   same tailscale-serve port) — routed to the Express backend on 4001.
4. Backend reads/writes `data/rewards.db` on Helsinki's local disk —
   entirely separate from the Mac's local DB.
5. RiseUp sync calls go from Helsinki directly to RiseUp's API/MCP
   server, same as they currently do from the Mac — no change to that
   flow, just a different machine making the outbound call.

## Error handling / edge cases

- **Tailscale off on the phone**: page simply fails to load (DNS/connection
  error) — expected, no special in-app handling needed.
- **Backend crash**: pm2 auto-restarts it; `pm2 logs credit-cards-server`
  for diagnosis. No alerting beyond what pm2 already provides for the
  other services on this box.
- **First boot on Helsinki**: `data/` directory doesn't exist yet —
  already handled by existing code (`fs.mkdirSync(path.dirname(DB_PATH),
  { recursive: true })` in `server/src/db.ts`), so the fresh-start DB
  creation needs no new code.
- **Port/handler collisions**: deploy script only ever touches port 4001
  and the `:8443` tailscale-serve entry; it must not touch or reset the
  existing `:443` mapping used by another service.
- **CORS**: `CLIENT_URL` env var must exactly match the tailscale-serve
  origin (`https://openclaw-server.taileb3fe2.ts.net:8443`) or the
  Express `cors()` middleware will reject the frontend's requests.

## Testing / verification

- After first deploy: hit `https://openclaw-server.taileb3fe2.ts.net:8443/api/health`
  from the Mac (over Tailscale) and confirm `{ ok: true }`.
- Load the root URL in a phone browser (Tailscale on), confirm the
  dashboard renders with an empty state (fresh DB).
- Enter the RiseUp PAT in Settings on the phone, sync, confirm cards and
  transactions populate (exercises the same upsert path just fixed
  locally).
- Chrome menu → "Add to Home Screen" on the phone, confirm it installs
  and opens standalone (no browser chrome).
- Re-run the deploy script a second time with no code changes, confirm
  it's idempotent (pm2 restart succeeds, tailscale serve config unchanged,
  no duplicate handlers).

## Open questions for the implementation plan

- Confirm exact `tailscale serve` CLI syntax for combining a static-file
  handler and a proxy handler under the same `--https` port (flag names
  across Tailscale versions have shifted; verify against the installed
  version on Helsinki before scripting it).
- Confirm whether a `pm2 startup` boot hook already exists on Helsinki
  (likely, given the hermes services) so `credit-cards-server` survives a
  reboot without extra setup.
- Pick/generate actual PWA icon assets (192x192 / 512x512 PNG) — not
  specified here, just that they're needed.
