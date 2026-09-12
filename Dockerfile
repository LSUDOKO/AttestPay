# AttestPay API server (packages/server).
#
# Bun, not Node: the server uses `bun:sqlite` and `Bun.serve`, so the Bun image is a
# requirement rather than a preference. See docs/deployment-cloudflare.md for why this
# does not run on Cloudflare Workers.
FROM oven/bun:1.3.14-slim

WORKDIR /app

# Install dependencies first so a source-only change reuses this layer. The workspace
# manifests must all be present before `bun install`, or the workspace: links fail.
COPY package.json bun.lock ./
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
RUN bun install --frozen-lockfile

COPY . .

# SQLite lives here. Mount a persistent disk at /data to keep cards, delegations and the
# proof queue across restarts; without one the store resets on every deploy.
ENV ATTESTPAY_DB_PATH=/data/attestpay.sqlite
RUN mkdir -p /data

# Render (and most hosts) inject PORT; the server reads it and falls back to 4070.
ENV PORT=10000
EXPOSE 10000

# --preload ./src/otel.ts wires OpenTelemetry before anything imports it, exactly as the
# `start` script does locally.
CMD ["bun", "run", "--cwd", "packages/server", "start"]
