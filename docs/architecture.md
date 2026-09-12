# AttestPay — System Architecture & SigNoz Observability

> **The agentic card.** Issue scoped, revocable spending cards from your wallet. Any agent plugs one in and pays within your limits — over crypto (USDC/Base) or simulated Visa (Stripe test-mode). **Fully instrumented with OpenTelemetry → SigNoz (traces + metrics + logs).**

---

## 1. High-Level System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          USERS & AGENTS                                   │
│                                                                          │
│   Dashboard (Next.js)          Claude / Cursor / Gemini / Codex ...      │
│   glass-pay.vercel.app         (MCP clients — Streamable HTTP)           │
│   Privy Google login                                                     │
└───────────────┬──────────────────────────────┬──────────────────────────┘
                │ /api (Privy token)           │ MCP tools (card secret URL)
                ▼                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    attestpay-server (Bun + Hono, Railway)                 │
│                            service.name = attestpay-server                 │
│                                                                            │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌───────────────┐   │
│  │  REST API    │ │ MCP endpoint │ │ x402 Facil-  │ │ Stripe Webhook│   │
│  │  /api/*      │ │ /c/<s>/mcp   │ │ itator       │ │ /stripe/webhook│  │
│  │  (cards,     │ │ (card, pay,  │ │ /facilitator │ │ (2s decision) │   │
│  │   oauth,     │ │  fiat_pay,   │ │  verify/     │ └───────────────┘   │
│  │   compile)   │ │  shop_buy…)  │ │  settle      │                      │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘                      │
│         │                │                │                              │
│         └────────────────┴───────┬────────┘                              │
│                                  ▼                                       │
│                    ┌─────────────────────────┐                           │
│                    │  @attestpay/engine core  │                           │
│                    │  compiler · issuance ·  │                           │
│                    │  spend · delegations ·  │                           │
│                    │  store (SQLite) · ops   │                           │
│                    └──────┬─────────┬────────┘                           │
│                           │         │                                    │
│              ┌────────────┘         └───────────┐                        │
│              ▼                                ▼                          │
│   ┌────────────────────┐          ┌─────────────────────┐                │
│   │ 1Shot Public       │          │ Stripe Issuing      │                │
│   │ Relayer (Base)     │          │ (test-mode Visa)    │                │
│   │ gasless USDC       │          │ virtual card per    │                │
│   │ redemption         │          │ AttestPay card       │                │
│   └────────────────────┘          └─────────────────────┘                │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ OTLP HTTP (port 4318) — traces, metrics, logs
                               ▼
                ┌──────────────────────────────┐
                │         SIGNOZ               │
                │  Cloud (ingest.us2.signoz)   │
                │  or self-hosted (casting.yaml)│
                │                              │
                │  Traces · Metrics · Logs     │
                │  Dashboards · Alerts         │
                │  SigNoz MCP server (:8000)   │
                └──────────────────────────────┘
```

---

## 2. Repository Layout (Bun monorepo)

| Package | Role | SigNoz relevance |
|---|---|---|
| `packages/engine` | Pure core: caveat compiler, issuance, spend, delegations, store, ops | Declares **all custom metrics + structured log functions** (`telemetry.ts`) |
| `packages/server` | Hono process: REST API + MCP + x402 facilitator + Stripe webhook + shop + seller | Hosts the **OTel SDK init** (`otel.ts`) + **HTTP middleware spans** (`app.ts`) + **business spans** |
| `packages/dashboard` | Next.js: Privy login, card cockpit, demo shop | Browser-side only; no direct telemetry |
| `casting.yaml` | Self-hosted SigNoz (Foundry/Docker) | ClickHouse + OTel collector + Query Service + Frontend + **SigNoz MCP server** |
| `agent-skills/` | Official SigNoz agent skills (MCP setup, dashboards, alerts, queries) | Lets AI agents operate SigNoz |

---

## 3. The SigNoz Telemetry Pipeline

### 3.1 Init — `packages/server/src/otel.ts`

Loaded via **`bun --preload ./src/otel.ts`** so the SDK starts *before any other module* — auto-instrumentation then wraps every HTTP, fetch, and DB call from boot.

- `NodeSDK` with `serviceName: "attestpay-server"`
- `getNodeAutoInstrumentations()` — HTTP/fetch/DB/dns/fs spans (dns + fs **disabled** to avoid noise)
- **All 3 signals** exported over OTLP HTTP:
  - Traces → `OTLPTraceExporter`
  - Metrics → `OTLPMetricExporter`
  - Logs → `OTLPLogExporter` (BatchLogRecordProcessor)
- Exporters auto-detected from env: `OTEL_EXPORTER_OTLP_ENDPOINT` + `OTEL_EXPORTER_OTLP_HEADERS` (the `signoz-ingestion-key`)
- Graceful shutdown on `SIGTERM` (Railway sends this)

### 3.2 Three Signals, One Pipeline

```
otel.ts (SDK) ──► auto-instrumentation (HTTP/fetch/DB)
              ──► Hono middleware span per request        (server/src/app.ts)
              ──► business spans                          (stripe, relayer, compiler, sweeps)
              ──► Meter API counters / up-down counters   (engine/src/telemetry.ts)
              ──► Logger API structured logs              (engine/src/telemetry.ts)
                              │
                              ▼
                    SigNoz (traces / metrics / logs)
```

---

## 4. ALL SigNoz Use Cases in This Project

### 🅰️ USE CASE 1 — Automatic HTTP Tracing (auto-instrumentation)

**Where:** `packages/server/src/otel.ts` + `@opentelemetry/auto-instrumentations-node`

Every inbound HTTP request, outbound `fetch`, and SQLite call is wrapped automatically:
- HTTP request spans with method, route, status, headers
- Fetch client spans (relayer calls, Venice API, Stripe API, Basescan)
- DB spans (SQLite queries)

**See in SigNoz:** Traces → filter `service.name = attestpay-server` → every request shows a waterfall of its internal fetch/DB hops.

---

### 🅱️ USE CASE 2 — Route-Level Request Spans (Hono middleware)

**Where:** `packages/server/src/app.ts` — `app.use("*", ...)`

Every request gets a manual span with rich attributes:

| Attribute | Value |
|---|---|
| `http.method` | GET/POST/… |
| `http.url` | request path |
| `http.route` | route *pattern* (e.g. `/cards/:id`) — enables grouping |
| `http.status_code` | final response status |

Errors are captured: `span.recordException(e)` + `SpanStatusCode.ERROR`.

**See in SigNoz:** Traces → group by `http.route` → find slow endpoints (the README notes the `/cards/:id` P99 of 800ms from a missing index was found exactly this way).

---

### 🅲 USE CASE 3 — Business-Logic Spans (the money moments)

Five custom spans wrap the domain-critical operations. These are the **hackathon gold** — each one carries money/decision context.

| Span name | Where | Attributes | Why it matters |
|---|---|---|---|
| `stripe_webhook_auth` | `server/src/stripe/routes.ts` | `stripe.charge_id`, `card_id`, `latency_critical=true`, `app.response.approved`, `app.response.reason` | The **2-second SLA** — Stripe declines if we take >2s. Watch latency + every approve/decline reason |
| `1shot_relayer_redeem` | `engine/src/spend.ts` + `engine/src/relayer.ts` | `usdc_amount`, `gas_fee_usdc`, `tx_hash`, `memo` (per README) | Every real on-chain USDC payment, gasless via 1Shot |
| `nl_compile` | `server/src/venice/client.ts` + `server/src/venice/compiler.ts` | token usage, intent metadata (per README) | Plain-language → CardTerms compilation (Venice AI) |
| `relayer_get_capabilities` / `relayer_get_fee_data` | `engine/src/relayer.ts` | — | Latency of relayer capability/fee probes during a spend |
| `reconcile_sweep` | `server/src/index.ts` (every 5 min) | `reconciled`, `still_pending` | Detects stuck-pending charges silently piling up |
| `fiat_settle_sweep` | `server/src/index.ts` (every 60s + startup) | `settled`, `left` | Visa → on-chain settlement drift recovery |

**See in SigNoz:** Traces → search the span name → see duration, decision, and error status. A `stripe_webhook_auth` trace trending toward 1800ms predicts Stripe timeouts *before* they happen. (Attributes on `1shot_relayer_redeem` / `nl_compile` follow the README; the span names themselves are confirmed in the code above.)

---

### 🅳 USE CASE 4 — Custom Business Metrics (Meter API)

**Where:** `packages/engine/src/telemetry.ts` — counters created once, imported everywhere.

| Metric | Type | Emitted when |
|---|---|---|
| `attestpay.cards_issued_total` | Counter | A card (root or sub) is issued |
| `attestpay.active_cards` | UpDownCounter | Issue (+1) / revoke (−1) |
| `attestpay.usdc_spent_total` | Counter | Confirmed redemptions + fiat settlements |
| `attestpay.charges_total` | Counter | Charges processed (confirmed + pending + failed) |
| `attestpay.errors_total` | Counter | Every 403/422/502/500 (`api/routes.ts` `handle()`) |

> ⚠️ **Metric naming gotcha (from blog-post.md):** metric names appear in SigNoz exactly as written — dots and all. The Metrics explorer only shows metrics that have *sent at least one data point*, so trigger a code path first (issue a card, make a payment) before looking for them in the dropdown.

**See in SigNoz:** Metrics explorer + dashboard panels (below).

---

### 🅴 USE CASE 5 — Structured Logs (Logger API)

**Where:** `packages/engine/src/telemetry.ts` — four emitters, correlated to traces automatically.

| Log function | severityText | Attributes | Example event |
|---|---|---|---|
| `emitRefusalLog` | WARN | `card_id`, `refusal_reason`, `attempted_amount` | `over_period_limit` |
| `emitCardLog` | INFO | `card_event` (issued/frozen/revoked/nuked/url_revealed/secret_rotated/onboarded), `card_id` | Card lifecycle |
| `emitChargeLog` | INFO | `charge_event` (confirmed/pending/failed), `card_id`, `amount`, `kind` | Payment confirmed |
| `emitErrorLog` | ERROR | `operation`, `error_message`, `status`, `code` | API errors (403/422/502/500) |

Every log carries the ambient `trace_id` → **click a log entry in SigNoz and jump straight into its distributed trace.**

**See in SigNoz:** Logs explorer → saved views like *"Card Lifecycle"* (filter `card_event:*`) and *"API Errors"* (filter `severityText:ERROR`).

---

### 🅵 USE CASE 6 — SigNoz Dashboards (the judge-ready panels)

Ready-made SQL for a **AttestPay dashboard** (also in `README.md`):

| Panel | Signal | Query source |
|---|---|---|
| Cards Issued Over Time (time series) | Metrics | `signoz_metrics.distributed_samples_v2` → `attestpay_cards_issued_total` |
| Active Cards (value/gauge) | Metrics | `attestpay_active_cards` last 60s |
| USDC Spent (time series) | Metrics | `attestpay_usdc_spent_total` |
| API Errors (time series) | Metrics | `attestpay_errors_total` |
| API Request Duration by Route | Traces | `signoz_traces.distributed_signoz_index_v2` grouped by `http.route` |

---

### 🅶 USE CASE 7 — SigNoz Alerts (proactive monitoring)

| Alert | Condition | Severity |
|---|---|---|
| High Error Rate | `attestpay_errors_total` rate > 10/min for 5 min | Critical |
| No Cards Issued | `attestpay_cards_issued_total` flat for 30 min | Warning |
| High API Latency | P99 HTTP duration > 5000ms for 5 min | Warning |
| Spike in Refusals | Log count with `refusal_reason:*` > 20/min | Warning |

---

### 🅷 USE CASE 8 — SigNoz MCP (agents monitoring the money-agents)

AttestPay bundles the **SigNoz MCP server** (`casting.yaml` → `signoz-mcp-server:latest` on `:8000`), or point at SigNoz Cloud's hosted MCP:

```bash
claude mcp add signoz http://localhost:8000 \
  --header "Authorization: Bearer $SIGNOZ_MCP_AUTH_TOKEN"
```

Then an AI agent can:
- Query AttestPay traces/logs/metrics (`signoz_search_traces`, `signoz_search_logs`)
- Run ClickHouse queries (`signoz_generate_query`)
- Create/modify dashboards (`signoz_create_dashboard`, `signoz_modify_dashboard`)
- Create & investigate alerts (`signoz_create_alert`, `signoz_investigate_alert`)
- Manage saved views (`signoz_manage_views`)

**The meta-loop:** a AttestPay agent-card pays for things *and* an AI agent watches those payments through SigNoz MCP. Money-agents + observability-agents in one system.

---

### 🅸 USE CASE 9 — Self-Hosted SigNoz (reproducible local dev)

`casting.yaml` deploys the full SigNoz stack with Foundry (`foundryctl cast -f casting.yaml`):

| Service | Image | Role |
|---|---|---|
| ClickHouse | `clickhouse/clickhouse-server:24.12` | Storage |
| OTel Collector | `signoz/signoz-otel-collector:0.119.3` | Ingest :4317/:4318 |
| Query Service | `signoz/query-service:0.81.0` | Backend API |
| Frontend | `signoz/frontend:0.81.0` | UI at `:3301` |
| MCP Server | `signoz/mcp-server:latest` | Agent tools at `:8000` |

---

### 🅹 USE CASE 10 — MCP Tool-Level Spans (agent activity)

**Where:** `packages/server/src/mcp/server.ts` — the `run()` helper now wraps **every** tool call in an `mcp_tool_<name>` span.

| Span name | Attributes | What it captures |
|---|---|---|
| `mcp_tool_card` | `mcp.tool`, `card_id`, `mcp.is_error`, `mcp.refusal_code` | Card status read |
| `mcp_tool_pay` | same | USDC payment |
| `mcp_tool_paid_fetch` | same | 402 auto-pay fetch |
| `mcp_tool_fiat_pay` | same | Visa purchase (Stripe test) |
| `mcp_tool_card_credentials` | same | Visa credential reveal |
| `mcp_tool_shop_products` | same | Catalog browse |
| `mcp_tool_shop_buy` | same | Product purchase |
| `mcp_tool_execute` | same | Scoped contract call |
| `mcp_tool_issue_subcard` / `mcp_tool_revoke_subcard` | same | Sub-card lifecycle |

Every span carries `card_id` + a typed `mcp.refusal_code` on failure (e.g. `over_period_limit`, `merchant_not_allowed`). Because the HTTP middleware uses `startActiveSpan` (USE CASE 2), each tool span **waterfalls under its request span** — one click from HTTP → MCP tool → Stripe/relayer/DB hops.

**See in SigNoz:** Traces → search `mcp_tool_` → filter by tool or refusal code. Answer questions like *"which tools do agents call most?"*, *"which card is erroring?"*, *"what got refused and why?"*.

---

### 🅺 USE CASE 11 — RED Metrics + SLOs (the SRE layer)

AttestPay is set up for the full **RED** method (Rate, Errors, Duration) and SLO-driven alerting, per the `signoz-setting-up-observability` workflow:

| RED dimension | AttestPay signal | Where it comes from |
|---|---|---|
| **R**ate | Requests/sec per route or tool | HTTP spans / `mcp_tool_*` spans |
| **E**rrors | Error rate per route / refusal rate | `attestpay.errors_total` metric + error logs + span status |
| **D**uration | p50/p95/p99 per route and per tool | Span latencies (HTTP, `stripe_webhook_auth`, `mcp_tool_*`) |

**Suggested SLI/SLO for the demo:**

| SLI | Formula | SLO | Error budget |
|---|---|---|---|
| Payment authorization success | approved webhooks / total webhooks | 99.5% / 30d | 0.5% |
| MCP tool availability | successful tool calls / total calls | 99% / 30d | 1% |
| API request success | non-5xx / all requests (excl. health checks, scanners) | 99.9% / 30d | 0.1% |

> **SLI hygiene:** exclude `/health`, synthetic probes, and scanner traffic (`/.env`, `/.git`, `/.aws`) from denominators — the `signoz-setting-up-observability` skill's bare-negation rule (`NOT REGEXP '\.(env|git|aws|ssh|well-known)'`).

---

### 🅻 USE CASE 12 — Saved Explorer Views (one-click drill-downs)

Ready-made views to create in SigNoz (via the MCP server or UI, per `signoz-managing-views`):

| View name | Source page | Filter | Use case |
|---|---|---|---|
| **Card Lifecycle** | Logs | `card_event:*` | Watch issued/frozen/revoked/nuked events |
| **API Errors** | Logs | `severityText:ERROR` | All error logs with trace jump |
| **Refusals** | Logs | `refusal_reason:*` | Every typed refusal + amount + card |
| **Failing Tool Calls** | Traces | `name LIKE 'mcp_tool_%'` + `has_error = true` | Agent failures by tool |
| **Slow Webhooks** | Traces | `name = 'stripe_webhook_auth'` + `duration > 1500ms` | Predict Stripe 2s timeouts |
| **Slow API Routes** | Traces | `duration_nano > 1s` | Latency outliers by route |

Every view carries the same `service.name = attestpay-server` + environment filter, so prod/staging never mix.

---

### 🅼 USE CASE 13 — Extended Dashboard Panels (beyond the 5 core)

Add these to the AttestPay dashboard:

| Panel | Signal | Query sketch |
|---|---|---|
| **Refusal reasons breakdown** (pie/bar) | Logs | `refusal_reason:*` grouped by `refusal_reason` |
| **Charge success rate** (time series) | Metrics | `attestpay.charges_total` with `charge_event` attribute → confirmed vs failed ratio |
| **MCP tool usage** (bar) | Traces | `mcp_tool_*` spans grouped by `mcp.tool` |
| **Webhook decision mix** (stacked) | Traces | `stripe_webhook_auth` grouped by `app.response.approved` + `app.response.reason` |
| **USDC spent per card** (top-N table) | Metrics | `attestpay.usdc_spent_total` grouped by card label |
| **Active vs revoked cards** (gauge) | Metrics | `attestpay.active_cards` + log count of `card_event: revoked` |
| **Dependency latency** (time series) | Traces | client spans grouped by `server.address` (Stripe, 1Shot, Venice, Basescan, SQLite) |

---

### 🅽 USE CASE 14 — Alerts with Notification Channels + Anomaly Detection

Beyond the 4 core alerts (USE CASE 7), wire them to real channels:

| Alert | Condition | Channel suggestion | Severity |
|---|---|---|---|
| High Error Rate | `attestpay.errors_total` > 10/min, 5 min | Slack #attestpay-critical (or PagerDuty) | Critical |
| Webhook SLA breach | `stripe_webhook_auth` p99 > 1800ms | Slack | Warning |
| Refusal spike | `refusal_reason:*` > 20/min | Slack | Warning |
| **No card activity** (absent-data) | no `mcp_tool_*` spans for 30 min | Email | Info |
| **Anomaly on refusals** | deviation from learned baseline (SigNoz anomaly detection) | Slack | Warning |

Key practices from `signoz-setting-up-observability`:
- **Burn-rate pairs** for SLO alerts (14.4×/1h-5m critical, 6×/6h-30m warning), both windows must trip together.
- **Recovery thresholds** (hysteresis): fire at 80%, recover at 70% to avoid flapping.
- **Absent-data alert** on the primary signal — a service that stops emitting never burns error budget, so telemetry-presence is its own alert.
- Create channels **first** with a test message, then the rules — never invent channel names.

---

### 🅾 USE CASE 15 — Cost Meter & Cardinality Control

SigNoz's **Cost Meter** shows ingestion by signal, service, and env — the `signoz-reducing-telemetry-cost` skill's workflow applies directly:

| Signal | Volume driver | AttestPay posture |
|---|---|---|
| Traces | Auto-instrumentation HTTP/fetch + spans | Low-cardinality labels only (`card_id` on traces is fine; **never** as a metric label) |
| Metrics | 5 custom counters | No high-cardinality attributes — kept clean by design |
| Logs | Card lifecycle + refusals + errors | Severity-filtered; INFO/WARN only by default |

**Rules that keep the bill small:**
- Metric labels must stay bounded (<100 values). Never put URLs, user IDs, or request IDs on metric series — they belong on traces/logs only.
- `dns`/`fs` auto-instrumentation already disabled at the SDK (noise reduction).
- Don't sample traces (breaks APM RED metrics); drop known-noise operations at the SDK/collector instead.
- When dev/staging > 40% of volume, set an ingestion limit on that env.

---

### 🅿 USE CASE 16 — Service Map & Infra Monitoring

SigNoz's **Service Map** auto-derives AttestPay's dependency topology from client spans:

```
attestpay-server
  ├── Stripe API        (fetch client spans — webhook/issuing calls)
  ├── 1Shot Relayer     (1shot_relayer_redeem + HTTP client spans)
  ├── Venice AI         (nl_compile — LLM compilation)
  ├── Basescan          (verified-contract lookups)
  ├── SQLite            (DB spans — local store)
  └── MCP clients       (Claude/Cursor/agents → tool calls)
```

| Panel | What it answers |
|---|---|
| Dependency error rate | Which external service is failing (Stripe vs relayer vs Venice)? |
| Dependency p99 latency | Which hop is slow? (client-span `server.address` grouping) |
| Service Map view | Live topology + health per node |
| Infra panels (optional) | CPU/memory/restarts — only if AttestPay ships host metrics (Railway) |

**The classic finding:** a healthy `attestpay-server` fronting a sick dependency (e.g. relayer latency) still fails users — the service map makes that visible immediately.

---

## 5. End-to-End Money Flow × What SigNoz Sees

### Flow A — Agent pays over crypto (x402/`pay`)

```
Agent calls MCP `pay`  ──► HTTP span (auto) + MCP tool span
  └─ engine validates terms  ──► refusal? emitRefusalLog (WARN) + errors_total++
  └─ relayer redeems on Base  ──► 1shot_relayer_redeem span (usdc_amount, tx_hash)
  └─ charge confirmed          ──► emitChargeLog("confirmed") + usdcSpentTotal++
  └─ card issued               ──► cardsIssuedTotal++ / activeCards++
```

### Flow B — Agent buys at the shop over Visa (Stripe test-mode)

```
Agent calls MCP `shop_buy`  ──► HTTP span
  └─ Stripe fires issuing_authorization.request webhook
       └─ stripe_webhook_auth span (latency_critical=true)
            └─ decideAuthorization() — budget/terms check (≤2s)
            └─ approved=true? emitChargeLog + usdcSpentTotal++ (settlement off)
            └─ declined? reason attribute: over_period_limit / merchant_scoped_card …
  └─ agent sees typed refusal or approval — with the span showing WHY in SigNoz
```

### Flow C — Background sweeps (crash recovery)

```
Every 5 min  ──► reconcile_sweep span (reconciled / still_pending)
Every 60s    ──► fiat_settle_sweep span (settled / left)   [settlement mode]
```

---

## 6. Env Config for SigNoz (`.env`)

```env
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.us2.signoz.cloud
SIGNOZ_INGESTION_KEY=<your-key>
OTEL_EXPORTER_OTLP_HEADERS=signoz-ingestion-key=${SIGNOZ_INGESTION_KEY}
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
ATTESTPAY_OTEL_DEBUG=1     # optional: verbose SDK diagnostics
```

Local self-hosted: set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.

---

## 7. Judge's Checklist — everything this repo proves

1. **Multiple signals** ✅ Traces + Metrics + Logs all flowing to SigNoz
2. **Custom business metrics** ✅ 5 counters mapping directly to product KPIs (cards, USDC, errors, charges, active)
3. **Structured logs** ✅ typed lifecycle events with correlated trace_id
4. **Custom spans** ✅ 5 domain spans with money/decision attributes
5. **Auto-instrumentation** ✅ HTTP/fetch/DB via `auto-instrumentations-node`
6. **Hono middleware** ✅ route-level span per request
7. **SigNoz MCP** ✅ included `signoz-mcp-server` — agents can observe the agent-money system
8. **Reproducible deployment** ✅ `casting.yaml` for `foundryctl cast`
9. **Operational value** ✅ real incidents found: `/cards/:id` 800ms P99, silently stuck pending charges, relayer gas-fee silent failures

---

## 8. Where Each Piece Lives (file map)

| Concern | File |
|---|---|
| OTel SDK init (preload) | `packages/server/src/otel.ts` |
| HTTP root span (startActiveSpan) | `packages/server/src/app.ts` |
| MCP tool spans (`mcp_tool_*`) | `packages/server/src/mcp/server.ts` (`run()`) |
| Business spans (webhook / sweeps) | `packages/server/src/stripe/routes.ts`, `packages/server/src/index.ts` |
| Metrics + log emitters | `packages/engine/src/telemetry.ts` |
| Error counter + error logs | `packages/server/src/api/routes.ts` (`handle()`) |
| Self-hosted SigNoz | `casting.yaml` |
| Agent skills for SigNoz | `agent-skills/` (12 skills: dashboards, alerts, queries, cost…) |
| Dashboard SQL + alerts | `README.md` §"SigNoz Dashboard Panels" / §"Alerts" |
| The full story | `blog-post.md` |
