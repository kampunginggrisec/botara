# Botara production image - one Dockerfile, one target per app.
# Build examples:
#   docker build --target api      -t botara-api .
#   docker build --target worker   -t botara-worker .
#   docker build --target realtime -t botara-realtime .
#   docker build --target web      -t botara-web .
# infra/docker/docker-compose.prod.yml builds all of them.

FROM oven/bun:1 AS base
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

# --- API (Hono, port 3000) ---
FROM base AS api
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/index.ts"]

# --- Worker (BullMQ) ---
FROM base AS worker
ENV NODE_ENV=production
CMD ["bun", "run", "apps/worker/src/index.ts"]

# --- Realtime (Bun WebSocket, port 3002) ---
FROM base AS realtime
ENV NODE_ENV=production
EXPOSE 3002
CMD ["bun", "run", "apps/realtime/src/index.ts"]

# --- MCP server (Streamable HTTP, port 3003; optional, profile-gated in compose) ---
FROM base AS mcp
ENV NODE_ENV=production
EXPOSE 3003
CMD ["bun", "run", "apps/mcp/src/index.ts"]

# --- Web: build the SPA, serve the static dist with Caddy ---
FROM base AS web-build
RUN bun run --cwd apps/web build

FROM caddy:2-alpine AS web
COPY --from=web-build /app/apps/web/dist /srv
COPY infra/deploy/Caddyfile.web /etc/caddy/Caddyfile
EXPOSE 80
