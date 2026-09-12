# Screenshots

Drop the AttestPay + SigNoz screenshots in this folder as `img-01.png` through `img-13.png`. The `README.md` (Screenshots section) and `docs/medium-post.md` reference these by number, so the images render automatically once the files are in place.

| File | Content |
|---|---|
| img-01.png | Trace waterfall - HTTP root span with child spans (mcp_tool_card, fetch, sqlite, stripe_webhook_auth) |
| img-02.png | Traces list filtered to service.name = attestpay-server, endpoint latency by route |
| img-03.png | Trace search for name LIKE 'mcp_tool_%' - agent tool calls with duration, card_id, mcp.is_error |
| img-04.png | Erroring mcp_tool_* span - mcp.refusal_code and mcp.error_message attributes |
| img-05.png | Metrics explorer showing the five attestpay.* metrics |
| img-06.png | A metric time-series graph (e.g. attestpay.cards_issued_total) |
| img-07.png | Logs explorer filtered to card_event:* - lifecycle lines with severity and card_id |
| img-08.png | A refusal log with trace_id - the log-to-trace correlation jump |
| img-09.png | Claude Code answering a query through the SigNoz MCP server |
| img-10.png | The AttestPay dashboard (Cards Issued, Active Cards, USDC Spent, API Errors, MCP Tool Usage, Refusal Reasons) |
| img-11.png | SigNoz Service Map - attestpay-server with edges to Stripe, Venice AI, 1Shot, SQLite |
| img-12.png | SigNoz Cost Meter - per-signal telemetry volume |
| img-13.png | SigNoz Alerts list (High Error Rate, Refusal Spike, Webhook SLA) |
