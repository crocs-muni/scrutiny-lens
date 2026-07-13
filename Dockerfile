# Scrutiny Session Explorer — SvelteKit (adapter-node), standalone repo.
#
# PUBLIC_RELAY_URL is read via `$env/static/public` (src/lib/search/relay.ts,
# fetcher.ts) -- SvelteKit inlines that at BUILD time, so it must be a build
# ARG here, not a docker-compose `environment:` entry (those only affect the
# already-built server process at runtime and would be silently ignored for
# this one). The default below matches the relay port docker-compose.yml
# publishes on the host, since the browser (not the container) connects to it.
#
#   docker build -t scrutiny-session-explorer .
#   (normally built via `docker compose up` instead -- see docker-compose.yml)

ARG NODE_IMAGE=node:22-slim

# --- builder -------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

# better-sqlite3 (a transitive dep) needs a native build toolchain to install.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Install against the lockfile only: this layer is cached until it changes.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .

ARG PUBLIC_RELAY_URL=ws://localhost:8080
ENV PUBLIC_RELAY_URL=${PUBLIC_RELAY_URL}
RUN pnpm run build

# Resolve a production-only node_modules (adapter-node's build/ doesn't bundle deps).
RUN pnpm prune --prod

# --- runtime -------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
# ORIGIN must equal the URL the BROWSER uses (host-published port), or
# SvelteKit rejects /api/chat's POST as cross-origin.
ENV ORIGIN=http://localhost:5173

EXPOSE 3000
ENTRYPOINT ["node", "build"]
