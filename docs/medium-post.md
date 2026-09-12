# I Gave an AI Agent a Credit Card, Then Watched Every Move It Made With SigNoz

**The moment I realized I had no observability:** A user's AI agent tried to buy $50 worth of API credits. The Stripe webhook got the authorization request, had 2 seconds to reply, and timed out. The POS terminal declined. The agent saw a cryptic `isError: true` response. The user saw "card declined" on their phone. I saw a log line that just said "timeout" — zero information about which of the five sequential hops between "agent wants to spend" and "money moves" had stalled.

I had built an agentic spending card platform — AttestPay — where users hand a card URL to an AI agent and the agent spends money within programmable limits. And I couldn't tell anyone *why* their card was declined.

This is how I instrumented the whole thing with OpenTelemetry and SigNoz: traces that span HTTP calls, on-chain settlements, and LLM prompts; metrics that track real money; and structured logs that let me click from a failure straight into its correlated trace. Along the way I learned that **observability for agentic systems isn't the same as observability for normal web apps**, and that the hardest part isn't setting up the pipeline — it's knowing what to instrument once the pipeline is running.

![IMG-1: Hero screenshot — SigNoz Traces view showing the AttestPay request waterfall with the HTTP root span at top and child spans below (mcp_tool_card, fetch, sqlite, stripe_webhook_auth). This is your "one trace = the whole story" money shot.](screenshots/img-01.png)

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
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";

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

Every API request gets a root span from Hono middleware. The important part is that it uses `startActiveSpan`, not `startSpan` — making the HTTP span the **active root** so every child span waterfalls under it as one distributed trace:

```typescript
// packages/server/src/app.ts — route-level tracing middleware
import { trace, SpanStatusCode } from "@opentelemetry/api";
const otel = trace.getTracer("attestpay-server");

app.use("*", async (c, next) => {
  await otel.startActiveSpan(`HTTP ${c.req.method} ${c.req.routePath ?? c.req.path}`, async (span) => {
    span.setAttribute("http.method", c.req.method);
    span.setAttribute("http.url", c.req.path);
    span.setAttribute("http.route", c.req.routePath ?? c.req.path);
    try {
      await next();
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      span.setAttribute("http.status_code", c.res.status);
      span.end();
    }
  });
});
```

In SigNoz, I can filter traces by `service.name = attestpay-server`, group by `http.route`, and see exactly which endpoints are slow.

![IMG-2: SigNoz Traces list filtered to service.name = attestpay-server, grouped by http.route — showing endpoint latency so you can spot the slow routes.](screenshots/img-02.png)

Beyond the route-level spans, there are two layers of business-logic spans.

### The five system spans

**`stripe_webhook_auth`** — The 2-second timer is the scariest SLA in the system. This span fires on every Stripe real-time auth callback and carries the decision directly: `app.response.approved`, `app.response.reason`, plus `card_id` and `latency_critical`. If a trace shows this span taking >1800ms, I know the authorization will fail before Stripe even tells me. The bottleneck was almost always a cold SQLite query — fixed by warming the cache at boot.

**`1shot_relayer_redeem`** — Fires on every on-chain USDC redemption. Carries `usdc_amount`, `card_id`, `chain_id`, and `smart_account_address`. This span revealed that the relayer was failing silently when gas estimates were too low — the span would show `ERROR` status but the app kept going. Now it throws a proper refusal.

**`nl_compile`** — Tracks Venice AI chat completion calls. Carries `prompt_tokens` and `completion_tokens`. This is how I discovered we were spending $0.03 per card compilation on tokens alone — enough to justify caching repeated intents.

**`reconcile_sweep`** — Runs every 5 minutes, resolves stuck pending charges. Attributes: `reconciled` count, `still_pending` count. Before this span, I didn't even know charges were getting stuck. The span flatlined at "0 reconciled" for three days before I looked — meaning charges were piling up silently.

**`fiat_settle_sweep`** — Settles approved Visa charges as on-chain USDC transfers. Attributes: `settled` count, `left` count. This one catches when the fiat settlement queue backs up.

```typescript
// packages/server/src/index.ts — background sweep with tracing
setInterval(() => {
  otel.startActiveSpan("reconcile_sweep", async (span) => {
    try {
      const r = await reconcilePending({ store: deps.store, relayer: deps.relayer });
      span.setAttribute("reconciled", r.reconciled);
      span.setAttribute("still_pending", r.stillPending);
      if (r.reconciled) console.log(`[reconcile] settled ${r.reconciled} stuck charge(s)`);
    } catch (e) {
      span.recordException(e as Error);
    } finally {
      span.end();
    }
  });
}, reconcileIntervalMs);
```

### The mcp_tool_* spans: every agent action is observable

This is the layer I'm proudest of. AttestPay exposes its agent tools over MCP (Model Context Protocol), so every tool call — `card`, `pay`, `paid_fetch`, `shop_buy`, `issue_subcard`, and the rest — is a named span with the card ID and outcome as attributes:

```typescript
// packages/server/src/mcp/server.ts — every agent tool call is a span
const mcpTracer = trace.getTracer("attestpay-server");

async function run(toolName: string, cardId: string, fn: () => Promise<unknown>): Promise<ToolResult> {
  return mcpTracer.startActiveSpan(`mcp_tool_${toolName}`, async (span) => {
    span.setAttribute("mcp.tool", toolName);
    span.setAttribute("mcp.kind", "tool_call");
    span.setAttribute("card_id", cardId);
    try {
      const result = await fn();
      const isError = result.isError ?? false;
      span.setAttribute("mcp.is_error", isError);
      if (isError) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: "tool call failed" });
        // the typed refusal code lands on the span: over_period_limit, merchant_not_allowed, ...
        const first = result.content[0];
        if (first && first.type === "text") {
          try {
            const parsed = JSON.parse(first.text) as { code?: string; message?: string };
            if (parsed.code) span.setAttribute("mcp.refusal_code", parsed.code);
            if (parsed.message) span.setAttribute("mcp.error_message", parsed.message);
          } catch { /* body not JSON — ignore */ }
        }
      }
      return result;
    } finally {
      span.end();
    }
  });
}
```

Now when an agent is mid-conversation with AttestPay, SigNoz shows me exactly what it did: search `name LIKE 'mcp_tool_%'` and every tool invocation appears with its duration. And when one fails, the typed refusal code (`over_period_limit`, `merchant_not_allowed`, `card_frozen`, ...) is right there on the span — no more guessing whether the agent or the policy was at fault.

![IMG-3: SigNoz trace search for name LIKE 'mcp_tool_%' — showing every agent tool call (mcp_tool_card, mcp_tool_shop_buy, ...) with duration, card_id, and mcp.is_error columns.](screenshots/img-03.png)

![IMG-4: One failing mcp_tool_* span expanded — attributes showing mcp.refusal_code = over_period_limit and mcp.error_message, proving refusals are visible right on the span.](screenshots/img-04.png)

---

## Metrics: Five Counters That Tell Me If We're Making Money

The engine package emits five custom counters, created once and shared across the codebase:

```typescript
// packages/engine/src/telemetry.ts
import { metrics } from "@opentelemetry/api";
const meter = metrics.getMeter("attestpay-engine");

export const usdcSpentTotal = meter.createCounter("attestpay.usdc_spent_total", {
  description: "Total USDC spent across all confirmed redemptions and fiat settlements",
});
export const activeCards = meter.createUpDownCounter("attestpay.active_cards", {
  description: "Number of currently active (issued minus revoked) cards",
});
export const cardsIssuedTotal = meter.createCounter("attestpay.cards_issued_total", {
  description: "Total cards issued across all users (root + sub-cards)",
});
export const errorsTotal = meter.createCounter("attestpay.errors_total", {
  description: "Total API-level errors and refusals",
});
export const chargesTotal = meter.createCounter("attestpay.charges_total", {
  description: "Total charges processed across all cards",
});
```

These increment in the critical code paths:

- `cardsIssuedTotal.add(1)` + `activeCards.add(1)` in `issuance.ts` — fires on every root card, sub-card, and finalized issue
- `chargesTotal.add(1)` in `spend.ts` — fires on every confirmed payment with the `kind` attribute
- `activeCards.add(-subtreeCount)` on revoke/nuke in `ops.ts`
- `errorsTotal.add(1)` on every 403/422/502/500 response

In SigNoz, I built a dashboard with panels using raw ClickHouse queries:

```sql
-- Cards issued over time (Time Series)
SELECT toStartOfInterval(toDateTime(intDiv(timestamp_ms, 1000)), INTERVAL 5 MINUTE) AS ts,
       sum(value) AS value
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay.cards_issued_total'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts ORDER BY ts;

-- Active cards (Value / big number)
SELECT sum(value) AS active_cards
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay.active_cards'
  AND timestamp_ms > toInt64(toUnixTimestamp(now())) * 1000 - 600000;
```

**Metric naming gotcha:** ClickHouse stores metric names as plain strings — dots, slashes, and all. I standardized on dot style (`attestpay.cards_issued_total`, `attestpay.active_cards`, ...) and that exact string is what you must query. But the deeper gotcha: the SigNoz Metrics explorer only lists metrics that have **sent at least one data point**. If you just deployed and haven't triggered the code path yet, the metric won't appear in the dropdown — and you'll think the exporter is broken. Run a test call first, then refresh the explorer.

![IMG-5: SigNoz Metrics explorer showing the five attestpay.* metrics in the list (attestpay.cards_issued_total, attestpay.active_cards, attestpay.usdc_spent_total, attestpay.charges_total, attestpay.errors_total).](screenshots/img-05.png)

![IMG-6: One metric opened — a time-series graph (e.g. attestpay.cards_issued_total climbing) so readers see the "live money" visual.](screenshots/img-06.png)

---

## Structured Logs: Card Lifecycle Events With Trace Correlation

The most impactful thing we did was emit a structured log at every significant card lifecycle transition. There are 20 typed refusal points in `spend.ts` alone (plus more across `ops.ts`, `issuance.ts`, and the MCP server), and each one now emits a log with the card ID, refusal reason, and attempted amount:

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

export function emitRefusalLog(cardId: string, refusalReason: string, attemptedAmount: string): void {
  logger.emit({
    severityNumber: 13,  // WARN
    severityText: "WARN",
    body: `Refusal: ${refusalReason} for card ${cardId}`,
    attributes: { card_id: cardId, refusal_reason: refusalReason, attempted_amount: attemptedAmount },
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
| `emitRefusalLog(cardId, "over_period_limit", amount)` | Budget refusal | `spend.ts` |
| `emitErrorLog("HTTP POST /cards", e.message, { status: "500" })` | API error | `routes.ts` (error handler) |

In SigNoz Logs, I created a saved view called **"Card Lifecycle"** filtered to `card_event:*`. Another called **"Refusals"** filtered to `refusal_reason:*`.

![IMG-7: SigNoz Logs explorer with the card_event:* filter — showing issued/frozen/revoked log lines with severity, timestamp, and the card_id attribute column.](screenshots/img-07.png)

The killer feature is the `trace_id` that OTel attaches to every log automatically — I can click any refusal log, see its trace ID, and jump to the full distributed trace showing exactly which hop caused the failure.

![IMG-8: A single refusal log expanded showing trace_id — with a highlight/arrow on the trace id link that jumps to the correlated distributed trace. This proves log ⇄ trace correlation.](screenshots/img-08.png)

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

Now when I'm debugging, I can ask Claude: *"Show me the attestpay.cards_issued_total metric over the last hour"* and it queries SigNoz via MCP and returns the result inline. No context-switching to the SigNoz UI.

![IMG-9: Terminal/Claude Code showing an MCP query against SigNoz — e.g. a question about error traces or saved views with the structured answer inline.](screenshots/img-09.png)

---

## The Dashboard Layout That Tells the Story

I arranged the SigNoz dashboard in a narrative flow. Top row: "Are cards being created?" (Cards Issued + Active Cards gauges). Middle row: "Is money moving?" (USDC Spent + Charges Processed time series). Bottom row: "Is anything breaking?" (API Error Rate + P99 Latency by Route). I also added **MCP Tool Usage** (grouped by `mcp.tool`) and **Refusal Reasons** (grouped by `refusal_reason`) panels — those two are the demo gold because they update live while an agent works.

![IMG-10: The full SigNoz dashboard — Cards Issued, Active Cards, USDC Spent, API Errors, plus MCP Tool Usage and Refusal Reasons panels.](screenshots/img-10.png)

When I present this in the hackathon demo, the script is:

1. Open SigNoz → **Traces** → filter `service.name = attestpay-server` — show the full request waterfall
2. Issue a card on the AttestPay dashboard — watch the `card_event: "issued"` log appear in SigNoz in real-time
3. Make a payment — trace the `1shot_relayer_redeem` span + `charge_event: "confirmed"` log
4. Call `shop_buy` via the agent — watch the `mcp_tool_shop_buy` span and the MCP Tool Usage panel tick up
5. Freeze the card — see `card_event: "frozen"` with timestamp
6. Switch to the dashboard — see Cards Issued counter go up, USDC Spent increase

The demo took 30 seconds to set up live and it's the most convincing thing I've built for debugging.

---

## The Service Map: The Whole Topology at a Glance

SigNoz builds a service map automatically from trace spans. AttestPay shows up as `attestpay-server` with edges to everything it touches: **Stripe** (the webhook fetches), **Venice AI** (`nl_compile`), **1Shot Relayer** (`1shot_relayer_redeem`), and **SQLite** (the store). Clicking any edge gives the error rate and latency for that dependency — I can see at a glance which external service is the current bottleneck.

![IMG-11: SigNoz Service Map — attestpay-server node with edges to Stripe, Venice AI, 1Shot, and SQLite.](screenshots/img-11.png)

Once you have real traffic flowing through it, SigNoz's **Cost Meter** shows exactly what the telemetry is costing per signal — traces usually dwarf logs, which dwarf metrics. For a startup, that's the difference between "observability is free" and "observability is my biggest infra line item."

![IMG-12: SigNoz Cost Meter — per-signal breakdown (traces vs logs vs metrics) with volume by service.](screenshots/img-12.png)

---

## Alert Recipes That Actually Catch Things

Beyond the dashboard, I set up alerts in SigNoz for conditions that matter in a financial system:

| Alert | Condition | Why |
|-------|-----------|-----|
| **High Error Rate** | `attestpay.errors_total` rate > 10/min for 5 min | Catches API degradation before users notice |
| **No Cards Issued** | `attestpay.cards_issued_total` flat for 30 min | Either the onboarding flow is broken or nobody is using the app |
| **High API Latency** | P99 HTTP duration > 5000ms for 5 min | Usually a cold DB query or a relayer stall |
| **Refusal Spike** | Log count with `refusal_reason:*` > 20/min | An agent could be in a retry loop burning users' budgets on failed attempts |
| **Webhook SLA** | `stripe_webhook_auth` p99 > 1800ms | The 2-second Stripe deadline is the tightest constraint in the system |

These live in SigNoz and push notifications to Slack. The "Refusal Spike" alert caught an agent that was accidentally in a 1-second retry loop — it tried to spend $5 every second, getting refused each time by the per-period limit. Without the alert, it would have run for hours generating 3,600+ refused transactions and confusing the user.

![IMG-13: SigNoz Alerts list showing the configured alerts (High Error Rate, Refusal Spike, Webhook SLA) with their status.](screenshots/img-13.png)

---

## What I'd Tell My Past Self

1. **Start with a clean metric naming convention.** Decide dot vs underscore on day one. Renaming metrics later means you lose the historical data under the old name — I standardized on `attestpay.*` dots and never looked back.

2. **The Hono middleware must be the first `app.use()` call — and use `startActiveSpan`, not `startSpan`.** If anything registers a route before the tracing middleware, that route won't have a root span. Learned this the hard way — the health check endpoint was invisible in SigNoz for a week. And without `startActiveSpan`, the HTTP span isn't the active parent, so your child spans don't waterfall under it.

3. **Background jobs need explicit spans.** They don't inherit a parent span from an HTTP request, so they're invisible in the trace waterfall unless you manually wrap them with `startActiveSpan`. The `reconcile_sweep` and `fiat_settle_sweep` intervals were silent failures until I added spans.

4. **Don't instrument DNS and filesystem.** The auto-instrumentation package enables too much by default. Every `fs.readFile` becomes a span. Disable the noisy ones immediately.

5. **Self-hosted SigNoz works but needs RAM.** The `foundryctl cast -f casting.yaml --locked` command is clean but ClickHouse needs ~4GB. On a Railway free tier, use SigNoz Cloud. The same OTLP pipeline works with just different env vars.

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

---

## Screenshot checklist (delete this section before publishing)

Numbered placeholders `![IMG-n: ...]` above — drop your screenshots into `screenshots/` as `img-01.png` through `img-13.png` (mapping in [screenshots/README.md](screenshots/README.md)), following your verification-guide steps:

| Image | What to capture (from your verification guide) |
|-------|-----------------------------------------------|
| IMG-1 | STEP 2: The trace waterfall — HTTP root → mcp_tool_card → fetch → sqlite → stripe_webhook_auth |
| IMG-2 | STEP 2: Traces list filtered `service.name = attestpay-server` (group by http.route) |
| IMG-3 | STEP 2: Search `name LIKE 'mcp_tool_%'` — the tool-call spans list |
| IMG-4 | STEP 2: An erroring mcp_tool_* span expanded — `mcp.refusal_code` + `mcp.error_message` attributes |
| IMG-5 | STEP 3: Metrics explorer showing all five `attestpay.*` metric names |
| IMG-6 | STEP 3: One metric's time-series graph (e.g. errors_total or cards_issued_total) |
| IMG-7 | STEP 4: Logs filtered `card_event:*` — lifecycle lines with severity + card_id |
| IMG-8 | STEP 4: A refusal log expanded with `trace_id` (the log ⇄ trace jump) |
| IMG-9 | STEP 10: Claude Code answering a SigNoz MCP query (traces/saved views) |
| IMG-10 | STEP 5: The finished dashboard — core panels + MCP Tool Usage + Refusal Reasons |
| IMG-11 | STEP 8: Service Map — attestpay-server → Stripe / Venice / 1Shot / SQLite |
| IMG-12 | STEP 9 (Cost Meter): The per-signal telemetry cost breakdown |
| IMG-13 | STEP 7: The Alerts list (High Error Rate, Refusal Spike, Webhook SLA) |

Quick tips for Medium:
- **Upload order:** drag each screenshot into the editor at the matching `![IMG-n]` marker, then delete the placeholder line.
- **Alt text:** Medium auto-fills alt text from the image name — rename files like `traces-waterfall.png`, `mcp-tool-spans.png` before uploading so the alt text is meaningful.
- **Crop tight:** SigNoz screenshots read better cropped to the relevant panel rather than full-screen.
- **Highlight the money shot:** for IMG-4 (refusal code on a span) and IMG-8 (trace_id click), use an arrow/box annotation — those two prove the correlation story.
