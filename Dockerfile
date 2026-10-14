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
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
