# Deploying the dashboard to Cloudflare Workers

**Live:** https://attestpay-dashboard.adoranto737.workers.dev

## Why OpenNext and not a static export

The dashboard is entirely client-side — every page is a client component, there are no
route handlers and no server-only APIs — so a static export looks like the obvious fit.
It isn't: `/card/[id]` takes a runtime card id, and `output: "export"` refuses to build
a dynamic segment without `generateStaticParams()`. Card ids are not knowable at build
time, so the options were to change the URL shape or run the real Next server.

`@opennextjs/cloudflare` runs the Next server on Workers and keeps `/card/<id>` working.
Its supported range is `next >=15.5.24 <16 || >=16.3.3`, so the dashboard moved from
16.2.7 (inside that gap) to 16.3.5.

## Build and deploy

```bash
# The API base is baked in at BUILD time — NEXT_PUBLIC_* is inlined into the bundle,
# so it cannot be changed by setting a Worker variable afterwards.
export NEXT_PUBLIC_ATTESTPAY_API="https://<your-api-host>/api"
export NEXT_PUBLIC_PRIVY_APP_ID="<your privy app id>"
export NEXT_PUBLIC_PRIVY_CLIENT_ID="<your privy client id>"
export NEXT_PUBLIC_BASE_RPC="<your Base RPC>"      # optional; defaults to mainnet.base.org

bun run --cwd packages/dashboard cf:build
bun run --cwd packages/dashboard cf:deploy
```

`cf:preview` runs the built Worker locally against the real Workers runtime, which is
worth doing before a deploy — it catches Node-API use that `next build` does not.

## Current deployment

Deployed 2026-09-13 (Worker version `b64cd9c4`) from the sketchbook redesign, built with
`NEXT_PUBLIC_ATTESTPAY_API=https://attestpay-api.onrender.com/api`, so the bundle talks to
the Render API (`render.yaml`, service `attestpay-api`). The Privy app id and client id
fall back to the public defaults in `lib/chain.ts`, so they need no build variable.

Routes verified live after deploy: `/`, `/app`, `/docs`, `/connect`, `/settings`, `/shop`,
`/card/<id>`, `/passport/<address>` (200) and an unknown path (branded 404).

Two things must be true on the Render side before a visitor can sign in and onboard:

1. The API has to be booting: its secrets (`ATTESTPAY_MASTER_KEY`, `ATTESTPAY_ADMIN_TOKEN`,
   `ATTESTPAY_ATTESTCOIN_PRIVATE_KEY`, `ATTESTPAY_PRIVY_APP_ID`) are set only in the Render
   dashboard, never committed.
2. `ATTESTPAY_CORS_ORIGINS` must include `https://attestpay-dashboard.adoranto737.workers.dev`
   (it is in `render.yaml`; the server defaults to `http://localhost:4071` otherwise, and
   the browser will see a CORS failure on every `/api/*` call).

The Worker is redeployed with `cf:build` + `cf:deploy`; nothing on Cloudflare holds state.

### Workers, not Pages

The dashboard is a Worker with static assets, not a Cloudflare Pages project. Cloudflare's
Next.js path is `@opennextjs/cloudflare` on Workers; the Pages adapter
(`@cloudflare/next-on-pages`) is deprecated and Pages is in maintenance mode. A
`*.workers.dev` hostname is the equivalent of a `*.pages.dev` one, and a custom domain
attaches the same way (Workers → Settings → Domains & Routes).

## Why the server is not on Workers

`packages/server` is not portable to Workers as written, and this is a port rather than a
configuration change:

| Blocker | Detail |
|---|---|
| `bun:sqlite` | 37 call sites across three stores, all **synchronous**. Workers have no SQLite; D1's API is async, so every call site and its callers change |
| `@opentelemetry/sdk-node` + auto-instrumentations | Node-only; does not run on Workers |
| Three `setInterval` sweeps | Workers have no long-lived process; these become Cron Triggers |
| Durable state | The SQLite file *is* the card tree, the delegations, and the proof queue |

The delegation and spend paths are where a bug moves money, so this is deliberately not
being rushed. Options, in order of how much they change:

1. **Any host with a filesystem** (Railway, Fly, a VM). `railway.json` is already
   configured with a healthcheck and restart policy. Nothing to port.
2. **Cloudflare Containers** — runs the Bun image as-is, but container storage is
   ephemeral, so it still needs D1 or external Postgres for anything worth keeping.
3. **Workers + D1** — the real port. Make `Store` async end to end, move the sweeps to
   Cron Triggers, and drop the Node OTel SDK for a Workers-compatible exporter.
