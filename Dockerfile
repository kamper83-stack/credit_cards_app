# Multi-stage build — credit_cards_app (npm workspaces: client + server)

# Stage 1: build client (Vite) + server (tsc)
FROM node:22-alpine AS build
WORKDIR /app
# better-sqlite3 compiles from source on alpine/musl — needs the toolchain
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN npm ci
COPY . .
# The SPA is built for the domain root ('/'), served by the Node server
RUN npm run build

# Stage 2: runtime
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
RUN apk add --no-cache ca-certificates wget
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist
COPY --from=build /app/server/package.json ./server/package.json
# Fail the build (not the first request) if a native module has no usable binary for this libc/arch:
# @node-rs/argon2 (needs its -musl prebuilt, installed by `npm ci` as an optional dependency),
# better-sqlite3 (compiled above) and the @riseup-oss/mcp entry that riseup.ts spawns with `node`.
RUN node -e "require('@node-rs/argon2'); new (require('better-sqlite3'))(':memory:').close(); require.resolve('@riseup-oss/mcp')"
# The app only writes to /app/data. A bind mount (./data:/app/data in docker-compose.yml) replaces
# this directory, so on the host it must be owned by uid 1000:  sudo chown -R 1000:1000 data
# (see deploy/DEPLOY.md). Otherwise the server cannot open the database and exits at startup.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
CMD ["node", "server/dist/index.js"]
