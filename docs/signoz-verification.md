# SigNoz Verification Guide — Step-by-Step

> Verify every SigNoz feature we added: **traces (incl. `mcp_tool_*` spans), metrics, logs, dashboards, saved views, alerts, service map, cost meter, and SigNoz MCP.**

---

## ⚠️ STEP 0 — Deploy the new code first (2 min)

The `mcp_tool_*` spans and the trace-root HTTP spans are **code changes** — they only exist in SigNoz after the server is redeployed.

1. Go to **Railway Dashboard → your AttestPay project → Deployments**
2. It should auto-detect commit `4cf5313` (`feat(otel): mcp_tool_* spans...`)
3. If it didn't auto-deploy → click **Deploy → Redeploy**
4. Wait ~2 minutes until the deployment shows **Healthy**

✅ **Quick sanity check** (endpoint is up):
```
curl -s https://glasspay-production.up.railway.app/health
```
→ should return `{"ok":true,...}`

---

## STEP 1 — Generate traffic (the "money moments")

Telemetry only appears after real activity. Do this with Claude (MCP connector) or via curl:

| Action | What it triggers in SigNoz |
|---|---|
| Tell Claude: `card` | `mcp_tool_card` span |
| Tell Claude: `shop_products` | `mcp_tool_shop_products` span |
| Tell Claude: `shop_buy product_id: "prod_UxNGMyUf5XGCvh"` | `mcp_tool_shop_buy` span + `stripe_webhook_auth` span + a log |
| Tell Claude: `card` again | another `mcp_tool_card` span |
| Any of the above failing | `mcp.refusal_code` attribute on the span + a `refusal_reason` log |

💡 No Claude handy? Trigger the webhook directly (expect `bad signature` — that's still a trace!):
```
curl -s -X POST https://glasspay-production.up.railway.app/stripe/webhook \
  -H 'content-type: application/json' -d '{"type":"test"}'
```

Do 5–10 actions so there's a decent volume to look at.

---

## STEP 2 — Verify TRACES (the big one) 🔭

1. Open **SigNoz** → **Traces** (left sidebar)
2. Filter: `service.name = attestpay-server` (or just search)
3. You should see a list of recent traces. Now verify each new feature:

| What to check | How |
|---|---|
| **HTTP root span** | Click any trace → the top span is `HTTP POST /c/<secret>/mcp` or similar |
| **Trace waterfall** | Expand the trace → children hang under the HTTP span: `mcp_tool_*`, fetch/DB auto-spans |
| **`mcp_tool_*` spans** | In the trace search bar type `name LIKE 'mcp_tool_%'` → every tool call appears with duration |
| **Refusal codes** | Click an erroring `mcp_tool_*` span → attributes show `mcp.refusal_code` (e.g. `over_period_limit`) + `mcp.error_message` |
| **Card context** | Every `mcp_tool_*` span carries `card_id` attribute |
| **`stripe_webhook_auth`** | Search `stripe_webhook_auth` → the 2-second-SLA span with `app.response.approved` + `app.response.reason` |
| **Sweeps** | Search `reconcile_sweep` or `fiat_settle_sweep` (they run every 5 min / 60 s automatically) |

✅ **Pass =** you can click a trace and see HTTP → `mcp_tool_shop_buy` → Stripe fetch → webhook decision as one waterfall.

---

## STEP 3 — Verify METRICS 📈

1. SigNoz → **Metrics**
2. Look for the 5 custom counters (they appear **only after** the code path ran — this is the README gotcha):

| Metric | Trigger to make it appear |
|---|---|
| `attestpay.cards_issued_total` | Issue a card |
| `attestpay.active_cards` | Issue a card |
| `attestpay.usdc_spent_total` | A confirmed payment |
| `attestpay.charges_total` | A charge processed |
| `attestpay.errors_total` | Any API 4xx/5xx (e.g. bad curl) |

3. Click one → you should see a graph of values over time.

✅ **Pass =** at least `attestpay.errors_total` has data points (easiest to trigger).

---

## STEP 4 — Verify LOGS 📝

1. SigNoz → **Logs**
2. Run these filters (one at a time):

| Filter | Shows |
|---|---|
| `card_event:*` | Card lifecycle (issued/frozen/revoked/onboarded) |
| `refusal_reason:*` | Every typed refusal + amount + card_id |
| `severityText:ERROR` | All API errors |
| `charge_event = "confirmed"` | Successful payments |

3. **The killer feature:** click any log row → it has a `trace_id` → click it → **jumps straight to the full distributed trace**. Log ⇄ trace correlation in one click.

✅ **Pass =** you can click a refusal log and land on the matching trace.

---

## STEP 5 — Create the Dashboard (5 core + 7 extended panels) 📊

1. SigNoz → **Dashboards → New Dashboard → Import JSON or create panels**
2. Add the 5 core panels (SQL ready in `README.md` §"SigNoz Dashboard Panels"):
   - Cards Issued Over Time
   - Active Cards (gauge)
   - USDC Spent (time series)
   - API Errors (time series)
   - API Request Duration by Route
3. Add the extended panels from `architecture.md` (USE CASE 13 🅼):
   - **Refusal reasons breakdown** (logs, group by `refusal_reason`)
   - **Charge success rate** (`attestpay.charges_total`)
   - **MCP tool usage** (traces, group by `mcp.tool`)
   - **Webhook decision mix** (`stripe_webhook_auth` group by `app.response.reason`)
   - **Dependency latency** (client spans by `server.address`)

💡 **Pro tip for the demo:** make "MCP Tool Usage" and "Refusal Reasons" the visible panels, then call `shop_buy` and watch the bar chart update live.

---

## STEP 6 — Create Saved Views (one-click drill-downs) 🔖

SigNoz → **Traces / Logs explorer → set the filter → "Save view"**

| View name | Source | Filter |
|---|---|---|
| Card Lifecycle | Logs | `card_event:*` |
| Refusals | Logs | `refusal_reason:*` |
| Failing Tool Calls | Traces | `name LIKE 'mcp_tool_%'` + `has_error = true` |
| Slow Webhooks | Traces | `name = 'stripe_webhook_auth'` + `duration > 1500ms` |

✅ These make the demo look pro — one click from "show me failures" to the exact failing spans.

---

## STEP 7 — Create Alerts + Notification Channel 🔔

1. **First:** SigNoz → **Settings → Notification Channels** → add **Slack** (or email/webhook) with a test message
2. Then: **Alerts → New Alert** and create:

| Alert | Signal | Condition |
|---|---|---|
| High Error Rate | `attestpay.errors_total` | rate > 10/min for 5 min → **Critical → Slack** |
| Refusal Spike | Logs `refusal_reason:*` | count > 20/min → **Warning → Slack** |
| Webhook SLA | `stripe_webhook_auth` | p99 > 1800ms → **Warning** |
| No Card Activity | `mcp_tool_*` spans | absent for 30 min → **Info → Email** (absent-data alert) |

✅ **Demo tip:** set Refusal Spike threshold to 1/min temporarily, trigger 2 refusals, and the Slack notification fires live on camera.

---

## STEP 8 — Service Map 🗺️

1. SigNoz → **Services** (or APM → Service Map)
2. You should see `attestpay-server` as a node with edges to its dependencies:
   - **Stripe** (fetch client spans)
   - **1Shot Relayer** (`1shot_relayer_redeem`)
   - **Venice AI** (`nl_compile`)
   - **Basescan** / **SQLite** (DB spans)
   - **MCP clients** (agent tool calls)
3. Click each edge → error rate + latency per dependency.

✅ **Pass =** the map shows the full agent-payment topology.

---

## STEP 9 — Cost Meter 💸

1. SigNoz → **Cost Meter** (Settings or the meter icon)
2. Verify:
   - Which signal costs most (traces vs logs vs metrics)
   - Volume by service and environment (dev vs prod)
3. This proves you care about telemetry cost — mention in the demo.

---

## STEP 10 — SigNoz MCP (the meta-twist) 🤖

1. In Claude Code (or any MCP client):
   ```
   claude mcp add signoz http://localhost:8000 \
     --header "Authorization: Bearer $SIGNOZ_MCP_AUTH_TOKEN"
   ```
   (For SigNoz Cloud, use `https://mcp.us2.signoz.cloud/mcp` — your region may differ.)
2. Then ask Claude:
   > "List the AttestPay saved views" / "Show me error traces from the last hour" / "Create an alert if mcp_tool errors spike"

✅ **Demo gold:** a AttestPay agent-card *pays* for things while an AI agent *watches* those payments through SigNoz MCP.

---

## 📋 Quick Checklist (paste into the demo notes)

```
[ ] Railway redeployed with 4cf5313
[ ] Claude: card, shop_products, shop_buy → traces in SigNoz
[ ] HTTP span is the trace root (waterfall works)
[ ] mcp_tool_* spans visible with card_id
[ ] A refusal shows mcp.refusal_code on the span
[ ] stripe_webhook_auth span with approve/decline reason
[ ] attestpay.errors_total has data points
[ ] Log click → jumps to its trace (trace_id correlation)
[ ] Dashboard has 5 core + MCP Tool Usage + Refusal panels
[ ] Saved views: Card Lifecycle, Refusals, Failing Tool Calls
[ ] Slack channel connected + at least 1 alert
[ ] Service map shows Stripe / 1Shot / Venice / SQLite
[ ] Cost Meter shows per-signal breakdown
[ ] SigNoz MCP answers a query
```

---

## 🚨 Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| No `mcp_tool_*` spans | Old code still deployed | Redeploy Railway to `4cf5313` |
| No metrics in dropdown | Metric never emitted (README gotcha) | Trigger the code path, then refresh |
| No `stripe_webhook_auth` | Webhook URL/secret wrong on Stripe/Railway | URL must be `/stripe/webhook` + `ATTESTPAY_STRIPE_WEBHOOK_SECRET` set |
| Logs show but no trace link | Log emitted outside a request context (sweeps) | Check request-triggered logs (card, shop_buy) |
| Traces slow to appear | Batch export (~a few seconds) | Wait 10–30 s, refresh |
