# I Gave an AI Agent a Credit Card, Then Watched Every Move It Made With SigNoz

**The moment I realized I had no observability:** A user's AI agent tried to buy $50 worth of API credits. The Stripe webhook got the authorization request, had 2 seconds to reply, and timed out. The POS terminal declined. The agent saw a cryptic `isError: true` response. The user saw "card declined" on their phone. I saw a log line that just said "timeout" — zero information about which of the five sequential hops between "agent wants to spend" and "money moves" had stalled.

I had built an agentic spending card platform — AttestPay — where users hand a card URL to an AI agent and the agent spends money within programmable limits. And I couldn't tell anyone *why* their card was declined.

This is how I instrumented the whole thing with OpenTelemetry and SigNoz: traces that span HTTP calls, on-chain settlements, and LLM prompts; metrics that track real money; and structured logs that let me click from a failure straight into its correlated trace. Along the way I learned that **observability for agentic systems isn't the same as observability for normal web apps**, and that the hardest part isn't setting up the pipeline — it's knowing what to instrument once the pipeline is running.

---

## The System: Three External Hops, One 2-Second Deadline

AttestPay is a Hono TypeScript server with a smart contract engine that turns plain-language rules into on-chain delegation policies. The full flow from "agent wants to spend" to "money moves" crosses three completely separate systems:

1. **Venice AI** — turns natural language intent (`"$5/week for research APIs"`) into structured card terms
2. **Stripe Issuing** — authorizes the Visa transaction with a **hard 2-second deadline**
3. **1Shot Relayer** — settles the USDC on-chain gaslessly through the DelegationManager contract

Each can fail independently, and failures compound because they're sequential. If the relayer is slow, the Stripe auth still succeeds — now you have a Visa charge with no corresponding on-chain settlement. That's a reconciliation problem orders of magnitude worse than a timeout.

Before OTel, debugging looked like: SSH in, grep logs for the card ID, find a bare "timeout" message, guess which hop, add more logging, wait for it to happen again. I needed correlated data that tells a story, not isolated lines.

---

## Setting Up the OTel Pipeline

The trickiest part was initialization order. Bun loads modules eagerly, and if OTel SDK initialization happens *after* the Hono app imports, the auto-instrumentation misses the route registration. The fix is Bun's `--preload` flag:

```typescript
// packages/server/src/otel.ts — loaded via `bun --preload ./src/otel.ts`
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";

const sdk = new NodeSDK({
  serviceName: "attestpay-server",
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 10_000,
  }),
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter()),
  instrumentations: [getNodeAutoInstrumentations({
    "@opentelemetry/instrumentation-dns": { enabled: false },
    "@opentelemetry/instrumentation-fs": { enabled: false },
  })],
});
process.on("SIGTERM", () => sdk.shutdown());
await sdk.start();
```

The `--preload` flag means this runs before anything else in the bundle. The auto-instrumentation wraps every module as it loads. I disabled `dns` and `fs` immediately — without that, every file read and DNS lookup becomes a span, and the trace waterfall becomes unreadable noise.

---

## Traces: Wrapping Every Hop With Business Context

Every API request gets a root span from Hono middleware:

```typescript
// packages/server/src/app.ts — route-level tracing middleware
import { trace } from "@opentelemetry/api";
const otel = trace.getTracer("attestpay-server");

app.use("*", async (c, next) => {
  const span = otel.startSpan(`HTTP ${c.req.method} ${c.req.routePath ?? c.req.path}`);
  span.setAttribute("http.method", c.req.method);
  span.setAttribute("http.url", c.req.path);
  span.setAttribute("http.route", c.req.routePath ?? c.req.path);
  try {
    await next();
    span.setAttribute("http.status_code", c.res.status);
  } catch (e) {
    span.setAttribute("http.status_code", 500);
    span.recordException(e as Error);
    throw e;
  } finally {
    span.end();
  }
});
```

In SigNoz, I can filter traces by `service.name = attestpay-server`, group by `http.route`, and see exactly which endpoints are slow. The `/cards/:id` route was running at 800ms P99 because of a missing index — visible immediately in the trace view.

*[Screenshot: SigNoz Traces view filtered by `service.name = attestpay-server`, showing the route-level span waterfall with HTTP method, status, and duration columns]*

Beyond the route-level spans, I added five business-logic spans that run on their own intervals or inside request handlers:

**`stripe_webhook_auth`** — The 2-second timer is the scariest SLA in the system. This span fires on every Stripe real-time auth callback and carries `decision`, `card_id`, `amount`, and `merchant` as attributes. If a trace shows this span taking >1800ms, I know the authorization will fail before Stripe even tells me. The bottleneck was almost always a cold SQLite query — fixed by warming the cache at boot.

**`1shot_relayer_redeem`** — Fires on every on-chain USDC redemption. Carries `usdc_amount`, `gas_fee_usdc`, `tx_hash`, and `memo`. This span revealed that the relayer was failing silently when gas estimates were too low — the span would show `ERROR` status but the app kept going. Now it throws a proper refusal.

**`nl_compile`** — Tracks Venice AI chat completion calls. Carries `prompt_tokens` and `completion_tokens`. This is how I discovered we were spending $0.03 per card compilation on tokens alone — enough to justify caching repeated intents.

**`reconcile_sweep`** — Runs every 5 minutes, resolves stuck pending charges. Attributes: `reconciled` count, `still_pending` count. Before this span, I didn't even know charges were getting stuck. The span flatlined at "0 reconciled" for three days before I looked — meaning charges were piling up silently.

**`fiat_settle_sweep`** — Settles approved Visa charges as on-chain USDC transfers. Attributes: `settled` count, `left` count. This one catches when the fiat settlement queue backs up.

```typescript
// packages/server/src/index.ts — background sweep with tracing
setInterval(async () => {
  await otel.startActiveSpan("reconcile_sweep", async (span) => {
    try {
      const r = await reconcilePending({ store: deps.store, relayer: deps.relayer });
      span.setAttribute("reconciled", r.reconciled);
      span.setAttribute("still_pending", r.stillPending);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      span.end();
    }
  });
}, reconcileIntervalMs);
```

---

## Metrics: Five Counters That Tell Me If We're Making Money

The engine package emits five custom counters, created once and shared across the codebase:

```typescript
// packages/engine/src/telemetry.ts
import { metrics } from "@opentelemetry/api";
const meter = metrics.getMeter("attestpay-engine");

export const usdcSpentTotal = meter.createCounter("attestpay.usdc_spent_total", {
  description: "Total USDC spent across all confirmed redemptions",
});
export const activeCards = meter.createUpDownCounter("attestpay.active_cards", {
  description: "Current live cards (issued − revoked)",
});
export const cardsIssuedTotal = meter.createCounter("attestpay.cards_issued_total", {
  description: "Total cards issued across all users",
});
export const errorsTotal = meter.createCounter("attestpay.errors_total", {
  description: "Total API-level errors and refusals",
});
export const chargesTotal = meter.createCounter("attestpay.charges_total", {
  description: "Total charges processed (confirmed + pending + failed)",
});
```

These increment in the critical code paths:

- `cardsIssuedTotal.add(1)` in `issuance.ts` — fires on every root card, sub-card, and finalized issue
- `chargesTotal.add(1)` in `spend.ts` — fires on every confirmed payment with the `kind` attribute
- `errorsTotal.add(1)` in `routes.ts` — fires on every 403/422/502/500 response
- `activeCards.add(1)` on issue, `activeCards.add(-1)` on revoke/nuke

In SigNoz, I built a dashboard with five panels using raw ClickHouse queries:

*[Screenshot: SigNoz dashboard showing the complete AttestPay layout — Cards Issued (Time Series), Active Cards (Value gauge), USDC Spent (Time Series), API Errors (Time Series), and API Latency by Route (Time Series) panels]*

```sql
-- Cards issued over time (Time Series)
SELECT toStartOfInterval(toDateTime(intDiv(timestamp_ms, 1000)), INTERVAL 5 MINUTE) AS ts,
       sum(value) AS value
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay_cards_issued_total'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts ORDER BY ts;

-- Active cards (Value / big number)
SELECT sum(value) AS active_cards
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay_active_cards'
  AND timestamp_ms > toUnixTimestamp(now()) * 1000 - 60000;
```

**Metric naming gotcha:** When you create a counter in the OTel Metrics API with `meter.createCounter("attestpay.usdc_spent_total")`, the metric name appears in SigNoz exactly as written — dots, slashes, and all. But in the SigNoz Metrics explorer, the autocomplete only shows metrics that have sent at least one data point. If you just deployed and haven't triggered the code path yet, the metric won't appear in the dropdown, and you'll think the exporter is broken. Run a test call first, then refresh the explorer.

---

## Structured Logs: Card Lifecycle Events With Trace Correlation

The most impactful thing we did was emit a structured log at every significant card lifecycle transition. There are 29 typed refusal points in `spend.ts` alone (plus another 16 across `ops.ts`, `issuance.ts`, and the MCP server), and each one now emits a log with the card ID, refusal reason, and attempted amount:

```typescript
// packages/engine/src/telemetry.ts — structured log functions
export function emitCardLog(event: string, cardId: string, extra?: Record<string, string | number>): void {
  logger.emit({
    severityNumber: 9,   // INFO
    severityText: "INFO",
    body: `Card ${event}: ${cardId}`,
    attributes: { card_event: event, card_id: cardId, ...extra },
  });
}

export function emitErrorLog(operation: string, message: string, extra?: Record<string, string | number>): void {
  logger.emit({
    severityNumber: 17,  // ERROR
    severityText: "ERROR",
    body: `Error in ${operation}: ${message}`,
    attributes: { operation, error_message: message, ...extra },
  });
}
```

These fire across the full card lifecycle:

| Log Call | Event | Where |
|----------|-------|-------|
| `emitCardLog("issued", cardId, { k_agent_address })` | Card created | `issuance.ts` |
| `emitCardLog("onboarded", userId, { address })` | User registered | `routes.ts` |
| `emitCardLog("frozen", cardId)` | Card paused | `ops.ts` |
| `emitCardLog("revoked", cardId)` | Card killed | `ops.ts` |
| `emitCardLog("nuked", userId)` | All cards killed | `ops.ts` |
| `emitCardLog("url_revealed", cardId)` | Secret viewed | `routes.ts` |
| `emitCardLog("secret_rotated", cardId)` | Secret rotated | `routes.ts` |
| `emitErrorLog("HTTP POST /cards", e.message, { status: "500" })` | API error | `routes.ts` (error handler) |

In SigNoz Logs, I created a saved view called **"Card Lifecycle"** filtered to `card_event:*`. Another called **"API Errors"** filtered to `severityText:ERROR` grouped by `operation`.

*[Screenshot: SigNoz Logs explorer showing a structured log entry with `card_event: issued` attribute and the linked `trace_id` that opens the associated distributed trace]*

The killer feature is the `trace_id` that OTel attaches to every log automatically — I can click any refusal log, see its trace ID, and jump to the full distributed trace showing exactly which hop caused the failure.

---

## The MCP Server: Agents Observing Themselves

Here's the meta-twist. SigNoz ships an MCP server that exposes observability tools to AI agents. The `casting.yaml` includes it:

```yaml
services:
  signoz-mcp-server:
    image: signoz/mcp-server:latest
    ports:
      - "8000:8000"
    environment:
      SIGNOZ_API_URL: http://query-service:8080
      SIGNOZ_MCP_AUTH_TOKEN: attestpay_mcp_dev
```

This exposes 8 MCP tools to any connected AI agent:

| Tool | What It Does |
|------|-------------|
| `signoz_search_docs` | Search SigNoz documentation |
| `signoz_create_dashboard` | Build dashboard panels from AttestPay metrics |
| `signoz_modify_dashboard` | Update existing dashboard configurations |
| `signoz_create_alert` | Set up alerts for error spikes, card stalls |
| `signoz_investigate_alert` | Deep-dive alert-triggered incidents |
| `signoz_generate_query` | Generate ClickHouse queries for observability data |
| `signoz_explain_dashboard` | Understand dashboard layout semantics |
| `signoz_manage_views` | Create and manage saved log views |

**The recursion:** The same agents that spend money through AttestPay can query their own observability data through SigNoz MCP. An agent that gets a `"card declined"` response can call `signoz_search_docs` to look up refusal codes, generate a ClickHouse query to find its own logs, and figure out *why* it was declined — without a human touching the dashboard. The agent asks: "Show me my last 5 refusal logs" and SigNoz MCP returns structured answers.

I connected it to Claude Code:

```bash
claude mcp add --scope user --transport http signoz https://mcp.us2.signoz.cloud/mcp
# Then: /mcp → select signoz → authenticate via OAuth
```

Now when I'm debugging, I can ask Claude: *"Show me the attestpay_cards_issued_total metric over the last hour"* and it queries SigNoz via MCP and returns the result inline. No context-switching to the SigNoz UI.

*[Screenshot: Terminal showing an AI agent querying SigNoz via MCP — the `signoz_generate_query` or `card` tool returning AttestPay trace data inline in the chat]*

---

## The Dashboard Layout That Tells the Story

I arranged the SigNoz dashboard in a narrative flow. Top row: "Are cards being created?" (Cards Issued + Active Cards gauges). Middle row: "Is money moving?" (USDC Spent + Charges Processed time series). Bottom row: "Is anything breaking?" (API Error Rate + P99 Latency by Route).

When I present this in the hackathon demo, the script is:

1. Open SigNoz → **Traces** → filter `service.name = attestpay-server` — show the full request waterfall
2. Issue a card on the AttestPay dashboard — watch the `card_event: "issued"` log appear in SigNoz in real-time
3. Make a payment — trace the `1shot_relayer_redeem` span + `charge_event: "confirmed"` log
4. Freeze the card — see `card_event: "frozen"` with timestamp
5. Switch to the dashboard — see Cards Issued counter go up, USDC Spent increase

The demo took 30 seconds to set up live and it's the most convincing thing I've built for debugging.

---

## Alert Recipes That Actually Catch Things

Beyond the dashboard, I set up alerts in SigNoz for conditions that matter in a financial system:

| Alert | Condition | Why |
|-------|-----------|-----|
| **High Error Rate** | `attestpay_errors_total` rate > 10/min for 5 min | Catches API degradation before users notice |
| **No Cards Issued** | `attestpay_cards_issued_total` flat for 30 min | Either the onboarding flow is broken or nobody is using the app |
| **High API Latency** | P99 HTTP duration > 5000ms for 5 min | Usually a cold DB query or a relayer stall |
| **Refusal Spike** | Log count with `refusal_reason:*` > 20/min | An agent could be in a retry loop burning users' budgets on failed attempts |

These live in SigNoz and push notifications to Slack. The "Refusal Spike" alert caught an agent that was accidentally in a 1-second retry loop — it tried to spend $5 every second, getting refused each time by the per-period limit. Without the alert, it would have run for hours generating 3,600+ refused transactions and confusing the user.

---

## What I'd Tell My Past Self

1. **The Hono middleware must be the first `app.use()` call.** If anything registers a route before the tracing middleware, that route won't have a root span. Learned this the hard way — the health check endpoint was invisible in SigNoz for a week.

2. **Background jobs need explicit spans.** They don't inherit a parent span from an HTTP request, so they're invisible in the trace waterfall unless you manually wrap them with `startActiveSpan`. The `reconcile_sweep` and `fiat_settle_sweep` intervals were silent failures until I added spans.

3. **Auto-instrumentation is too noisy by default.** Disable `dns` and `fs` instrumentations immediately. Every file read and DNS lookup becomes a span and the waterfall becomes unreadable.

4. **Self-hosted SigNoz works but needs RAM.** ClickHouse needs ~4GB, so Railway free tier won't cut it. Use SigNoz Cloud for small deployments — the same OTLP pipeline works with just different env vars.

---

## The Pipeline

```yaml
# casting.yaml — one command to deploy
mode: docker
flavor: compose
services:
  clickhouse:          clickhouse/clickhouse-server:24.12
  otel-collector:      signoz/signoz-otel-collector:0.119.3
  query-service:       signoz/query-service:0.81.0
  frontend:            signoz/frontend:0.81.0        # UI at :3301
  signoz-mcp-server:   signoz/mcp-server:latest       # MCP at :8000
```

The `casting.yaml.lock` pins every image to its digest for reproducible judging. Deploy with `foundryctl cast -f casting.yaml --locked` and the entire stack — ClickHouse, Collector, Query Service, Frontend, and MCP Server — comes up with one command.

AttestPay's OTel SDK exports to `http://localhost:4318` by default. Switching to SigNoz Cloud is two env vars:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.us2.signoz.cloud
OTEL_EXPORTER_OTLP_HEADERS=signoz-ingestion-key=<your-key>
```

The SDK passes headers to all three exporters automatically — traces, metrics, and logs go through the same pipeline.

---

## After

The debugging loop went from:

> User reports "card declined" → SSH → grep logs → find "timeout" → guess which service → add more logging → wait for it to happen again

To:

> User reports "card declined" → open SigNoz → filter by `card_id` → see full trace with correlated logs → fix the slow hop in 2 minutes

The difference isn't more data. It's **correlated data that tells a story**. The trace waterfall shows the sequential hops. The metrics show the trend. The logs show the context. All linked by `trace_id` — click any log line and jump to its full trace.

For agentic systems, this correlation matters more than anywhere else. An AI agent doesn't know the Stripe webhook has a 2-second deadline. It doesn't know the relayer failed silently. It just sees a "card declined" response. If I can't trace that response back to the root cause in under a minute, the agent will retry, the refusals will pile up, and the user's budget will look like it's under attack.

SigNoz turns the firehose of events into a coherent timeline. And with the MCP server, even the agents themselves can read it.

---

*AttestPay is open source at [github.com/LSUDOKO/AttestPay](https://github.com/LSUDOKO/AttestPay). The SigNoz deployment config is in `casting.yaml` at the project root. Built for the MetaMask Smart Accounts Kit × 1Shot API × Venice AI Dev Cook Off and the SigNoz Hackathon. If you're building agentic payment systems — or just want to see how OTel works with Bun + Hono — the full instrumentation is in `packages/engine/src/telemetry.ts` and `packages/server/src/app.ts`.*
