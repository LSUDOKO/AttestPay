<div align="center" >
   <img width="592" height="421" alt="Gemini_Generated_Image_hxmu4nhxmu4nhxmu-removebg-preview" src="https://github.com/user-attachments/assets/1dffe4ac-46ce-4b46-860d-147ba50838a1" />
</div>

# AttestPay

Agentic spending cards: scoped, revocable payment delegations that any AI agent can plug in and pay with, fully instrumented with OpenTelemetry and SigNoz.

[![SigNoz Hackathon](https://img.shields.io/badge/SigNoz-Hackathon-3021ff)](https://signoz.io)
[![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-Instrumented-3021ff)](https://opentelemetry.io)
[![Base Mainnet](https://img.shields.io/badge/Base-Mainnet-0052FF)](https://base.org)
[![ERC-7710](https://img.shields.io/badge/ERC-7710-blue)](https://eips.ethereum.org/EIPS/eip-7710)
[![Attestcoin](https://img.shields.io/badge/Attestcoin-Creditcoin%20CC3-00d18f)](https://creditcoin.org)

Issue scoped, revocable spending cards from your wallet. Any agent plugs one in and pays within your limits: no keys, no gas, dead the moment you revoke. Built on Smart Accounts (ERC-7710), settled gaslessly by 1Shot, pays the open web with x402, and plugs into any agent over MCP.

Every confirmed payment is then **proven cross-chain onto Creditcoin** via the Attestcoin Protocol — no oracle, no bridge — building public, checkable credit history for the agent that spent. See [Cross-Chain Verification](#cross-chain-verification-attestcoin) for what that proves, and what it does not.

---

## Table of Contents

- [The Idea](#the-idea)
- [How a Payment Works](#how-a-payment-works)
- [Agent Tools](#agent-tools)
- [Connecting a Card to an Agent](#connecting-a-card-to-an-agent)
- [Cross-Chain Verification (Attestcoin)](#cross-chain-verification-attestcoin)
- [Architecture](#architecture)
- [Contracts](#contracts-base-mainnet)
- [Observability (SigNoz)](#observability-signoz)
- [Getting Started](#getting-started)
- [Tests](#tests)
- [Environment Variables](#environment-variables)
- [Security Model](#security-model)
- [Demo Merchant](#demo-merchant)
- [Documentation](#documentation)

---

## The Idea

Agents need to spend money. Handing an agent your private key is unsafe; funding a standalone agent wallet loses custody and limits. AttestPay applies the model the card industry settled on decades ago to agents:

- **Your wallet is the account.** Funds never leave it until the moment of payment.
- **The card is a delegation.** A scoped ERC-7710 delegation, signed by your wallet, wrapped in caveats: budget per period, per-transaction max, merchant allowlist, expiry, usage count.
- **The agent holds the card, not the money.** The agent gets an MCP endpoint URL. Behind it, the card can spend only what its terms allow.
- **Revoke kills it instantly.** Freeze or revoke a card (or its whole sub-card tree) and every payment from it stops, server-side immediately and on-chain underneath.

```
your wallet (EIP-7702 smart account)
   +-- card  ($25/week, expires Jul 6)          <- root delegation, signed by you
       +-- agent A plugs it in over MCP
       +-- sub-card ($1/week, one merchant)     <- redelegation, narrower terms
           +-- sub-agent B plugs it in
```

**Live:**

| Surface | URL |
|---|---|
| Dashboard (issue + manage cards) | deploy your own |
| Docs (the full reference, in-app) | deploy your own |
| Demo merchant (accepts the cards' Visas) | deploy your own |
| API + MCP endpoint | deploy your own |
| Source (this repo) | https://github.com/LSUDOKO/AttestPay |
| Demo video | [YouTube](https://vimeo.com/1214671814?share=copy&fl=sv&fe=ci) |
| Docs | https://glass-pay.vercel.app/docs |
| Demo Link | https://glass-pay.vercel.app |
| Medium Blog | https://medium.com/@adoranto737/i-gave-an-ai-agent-a-credit-card-then-watched-every-move-it-made-with-signoz-d6b6cdd9d5b8?sharedUserId=adoranto737 |

Everything runs on Base mainnet with real USDC; the only simulated leg is the Visa rail (Stripe test-mode Issuing), labeled honestly wherever it appears.

---

## How a Payment Works

1. You sign in to the dashboard (Privy embedded wallet, Google login) and issue a card with terms, set by hand in the composer or drafted from a plain-language request by the Venice-powered NL compiler (the model only names tokens, protocols, and merchants; the server resolves every address from its own verified registry, and you still review and sign the draft).
2. The dashboard compiles the terms into on-chain caveats (delegation-framework enforcers). Your wallet signs the delegation in the browser; the server stores it alongside a fresh agent key that holds nothing.
3. You hand the card URL to any agent (one `claude mcp add`, a Cursor deeplink, a pasted connector URL).
4. When the agent calls `pay`, the server validates the terms, then redeems the delegation through the 1Shot relayer: gasless, on Base mainnet, settled in USDC from your wallet.
5. Every charge lands in the card's ledger with memo, fee, and tx hash.

The agent never sees a private key, never holds a balance, and never needs ETH. The first spend even deploys your wallet's 7702 smart-account code automatically in the same transaction.

---

## Agent Tools

MCP tools served over Streamable HTTP. The exact set a card exposes matches its capabilities, so the tool list itself is the permission surface (a pay-only card never sees `execute`; a contract-only card never sees `pay`):

| Tool | Purpose |
|---|---|
| `card` | Live state: remaining budget, terms, expiry, recent charges, sub-cards |
| `pay` | Send USDC on Base within the card's limits; blocks until confirmed on-chain |
| `paid_fetch` | Fetch a URL; on HTTP 402 (x402), pay automatically and return the content |
| `fiat_pay` | Buy over Visa rails (simulated: Stripe test-mode Issuing) against the same budget; with settlement on, the receipt carries the on-chain tx |
| `card_credentials` | Reveal the card's test-mode virtual Visa (number/expiry/cvc) so the agent can check out at a merchant; every card auto-links one on first need |
| `execute` | Run scoped contract calls (e.g. approve + swap, stake, mint) atomically in one redemption; only on cards with contract scope |
| `issue_subcard` | Mint a tighter child card for a sub-agent; pay caps and contract scope must both nest inside the parent's |
| `revoke_subcard` | Instantly kill a sub-card (and its descendants), server-side; for on-chain permanence, revoke the root card or nuke |
| `verify_payment` | Where a payment has reached in the Attestcoin cross-chain proof pipeline |
| `payment_receipt` | The full three-chain receipt for one payment, with an explorer link per leg and a plain statement of what the proof establishes |
| `credit_score` | The card's cross-chain-verified payment history and credit standing on Creditcoin |
| `cross_chain_status` | Attestcoin protocol health: attestation lag and proof-queue depth |

The last four appear only when cross-chain verification is configured — the tool list is the capability surface, so a card is never offered a tool that can only answer "not configured".

Refusals are typed (`over_period_limit`, `merchant_not_allowed`, `price_exceeds_max`, `per_trade_exceeded`, `exceeds_parent_terms`, `target_not_allowed`, `method_not_allowed`, ...) so agents can relay them honestly instead of guessing.

**Contract cards.** A card can be scoped to specific contract targets + method selectors instead of (or alongside) a USDC budget. The agent calls `execute` with either `{target, method, args}` (the server ABI-encodes) or `{target, data}` raw calldata for tuple/array/multicall methods like Uniswap `exactInputSingle`. For a call that needs a recipient (e.g. `exactInputSingle`'s `recipient`), the `card` tool surfaces the card's on-chain `account` (the root delegator that holds the USDC and receives any output tokens), so the agent routes a swap's output there itself. Targets and selectors outside the card's declared scope are refused before anything reaches the chain, and the on-chain `allowedTargets`/`allowedMethods` enforcers check the same scope again. Method signatures are normalized to their canonical form (`uint` -> `uint256`) so the encoder, the raw-data selector check, and the on-chain enforcer all agree. Safety on contract cards is the target/method allowlist plus `maxUses` and `expiry` (contract calls are not USDC-metered); pair contract scope with a `pay` cap in one composite card when you want both. A contract card can also carry an allowance token list (`contract.tokens`: the only tokens it may `approve`, every approval exact-amount pinned on-chain) and a per-trade ceiling (`contract.perTradeMax`, capping each USDC approval; v1 enforces the ceiling on USDC legs only). Both narrow subset-only on sub-cards. Calls carry no native ETH value in v1 (the carved leaf caps value at 0 on-chain); payable-with-value is a planned extension.

---

## Connecting a Card to an Agent

Three lanes. The first two carry a per-card credential directly; the third is OAuth, where the agent never holds the card secret.

```bash
# Lane A: secret in the URL path (works everywhere, treat the URL as a password)
claude mcp add --transport http remit https://<host>/c/<card-secret>/mcp

# Lane B: bearer header
claude mcp add --transport http remit https://<host>/mcp \
  --header "Authorization: Bearer <card-secret>"
```

Lanes A and B work in Cursor, VS Code, Gemini CLI, Windsurf, claude.ai custom connectors, or any MCP client that speaks Streamable HTTP. Rotate the secret any time from the dashboard; the old URL dies instantly.

Per-harness one-liners for Lane A:

```bash
codex mcp add remit --url https://<host>/c/<card-secret>/mcp
openclaw mcp add remit --url https://<host>/c/<card-secret>/mcp --transport streamable-http  # flag required: omitting it defaults to SSE
hermes mcp add remit --url "https://<host>/c/<card-secret>/mcp"
gemini mcp add -t http remit https://<host>/c/<card-secret>/mcp
goose session --with-streamable-http-extension "https://<host>/c/<card-secret>/mcp"
amp mcp add remit https://<host>/c/<card-secret>/mcp
droid mcp add remit https://<host>/c/<card-secret>/mcp --type http
```

claude.ai web: Customize -> Connectors -> Add custom connector -> paste the card URL. ChatGPT Developer Mode: create a connector with the card URL as No Authentication, or use Lane C for a real auth story.

**Lane C: OAuth 2.1 (card-picker consent).** Add the bare endpoint with no credential:

```bash
claude mcp add --transport http remit https://<host>/mcp
```

The client discovers the OAuth lane (RFC 9728 protected-resource metadata on the `401`), registers itself (Dynamic Client Registration), and opens a browser. You sign in with your existing dashboard login and pick which card to grant. The agent receives a short-lived, card-scoped, independently revocable access token, never the raw card secret. This is the lane OAuth-only clients such as ChatGPT require; it also works in Claude Code, claude.ai, Cursor, VS Code, Codex, Gemini CLI, Goose, opencode, Amp, and Factory Droid. Clients that complete OAuth out-of-band read the authorization code straight off the consent success screen: OpenClaw finishes with `openclaw mcp login remit --code <code>` (it runs no callback listener), and headless Hermes uses its paste-back flow the same way. The server is a self-hosted OAuth authorization server (public clients, PKCE S256, rotating refresh tokens); revoking the card kills every token issued for it.

---

## Cross-Chain Verification (Attestcoin)

Every confirmed payment is proven onto **Creditcoin CC3 testnet** using the Attestcoin
Protocol, turning an AI agent's spending into public, append-only credit history that
any Creditcoin contract can read without trusting AttestPay.

Full technical write-up: **[docs/attestcoin-integration.md](docs/attestcoin-integration.md)**

### What the proof establishes — and what it does not

This is stated first because the honest version is narrower than "every payment is
cryptographically verified", and the agent-facing `payment_receipt` tool returns both
halves verbatim so a model relaying it cannot overstate it.

**Proven, trustlessly:** that a `PaymentAnchored` record with *exactly these field
values* was included in a block attested by the Attestcoin attestor network. The Block
Prover precompile checks a Merkle inclusion proof and a block-continuity proof in the
same Creditcoin transaction that records the result, and `AttestPayASC` decodes the
payment's fields **out of the proven transaction bytes** — so no relayer, AttestPay's
server included, can alter a value in flight.

**Not proven:** that the underlying Base payment happened. AttestPay's server writes
the anchor, so that hop is the server's own attestation. Two things keep it
accountable: every anchor records the Base `sourceTxHash` so anyone can check the
payment independently, and it records `anchoredBy` — with the ASC crediting only its
configured `trustedAnchorer`.

So a verified payment means: *AttestPay asserted this payment on an attested chain, and
that assertion is now cryptographically immutable, publicly timestamped, attributable
to a named anchorer, and checkable against the Base transaction it names.* Stronger
than a private database row; weaker than proving the transfer itself.

### Why the anchor is on Ethereum Sepolia, not Base

Attestcoin on CC3 testnet attests exactly two source chains. Check it yourself:

```bash
cast call 0x0000000000000000000000000000000000000fd3 "get_supported_chains()" \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network \
| xargs cast decode-abi "get_supported_chains()((uint64,uint64,bytes,uint8)[])"
# [(3, 1, "Ethereum", 1), (1, 11155111, "Sepolia ethereum", 1)]
```

Base is not among them, so a Base transaction cannot be proven into Creditcoin at all.
AttestPay's payments execute on Base (the ERC-7710 stack and the 1Shot relayer only
exist there), so `PaymentAnchor` is deployed on Ethereum Sepolia (`chainKey = 1`) and
records the Base payment's facts; that anchoring transaction is what gets proven.

### The flow

```
Base            agent pays USDC ──▶ charge confirmed
                                         │ onChargeConfirmed (enqueue, ~1ms)
                                         ▼
                            attestcoin_proofs (sqlite state machine)
                            pending → anchoring → anchored → attested → proving → verified
                                         │
Eth Sepolia     PaymentAnchor.anchorPayment(...) ──▶ PaymentAnchored event
                                         │
                 Attestcoin attestors reach consensus (~8 min, measured)
                 prover API → { headerNumber, txBytes, merkleProof, continuityProof }
                                         │
Creditcoin      AttestPayASC.verifyPayment(height, txBytes, merkle, continuity)
                  ├─ 0x0FD2 BlockProver.verify(...)        proof checked on-chain
                  ├─ decode receipt logs from PROVEN bytes  facts bound to the proof
                  ├─ require anchoredBy == trustedAnchorer
                  └─ store VerifiedPayment · update AgentCredit · check CardTerms
```

`pay` never waits for any of this. Attestation takes minutes, so the pipeline is a
background worker over persisted state: `spend()` only enqueues, via a new
`onChargeConfirmed` hook that every confirmation path feeds (pay, execute, fiat
settlement, and the reconcile sweep alike).

### The one design decision that matters

`verifyPayment` takes **the proof and nothing else**.

The natural-looking alternative — `verifyPayment(proof, cardId, amount, from, ...)` —
is unsound, and it is worth being explicit about why. The proof and the facts would be
independent, so a valid proof of *any* attested transaction would let a caller staple
arbitrary payment data to it and mint unlimited "verified" credit history from one real
proof. Here the facts cannot be separated from the proof, because the facts *are* the
proven bytes. Three tests pin it down: an impostor anchor's event inside a valid proof
records nothing, an untrusted anchorer is refused, and a proven-but-reverted
transaction is not a payment.

### Contracts

| Contract | Chain | Role |
|---|---|---|
| `PaymentAnchor.sol` | Ethereum Sepolia | Emits `PaymentAnchored` on an attested chain; guards double-anchoring |
| `AttestPayASC.sol` | Creditcoin CC3 | Verifies proofs, decodes payments, maintains credit + terms registry |
| `ProvenTxDecoder.sol` | library | Recovers receipt logs from Attestcoin-encoded transaction bytes |
| `IBlockProver.sol` | interfaces | The real precompile ABIs (`0x0FD2` prover, `0x0FD3` chain info) |

Foundry project in [`contracts/`](contracts/). `forge test` — 42 tests.

### Agent credit history

Each verified payment updates an `AgentCredit` record against the card tree's **root
funding account** (sub-cards spend from their root's account, so that is where history
belongs): payment count, verified volume, first and last payment, and terms compliance.

Compliance is tracked as `withinTermsPayments` over `termsCheckedPayments`, not over
`totalPayments` — so **a card with no registered terms does not score a free 100%**.
With nothing to comply with, a payment is neither credited nor penalised, and terms
registered after a payment are not applied retroactively.

The letter grade is a published formula over three capped inputs — payment count (≤40),
verified volume (≤30), history length in days (≤30), scaled by the within-terms rate
where terms exist. It is a readable summary of public on-chain facts, **not a risk
model**, and it is labelled that way everywhere it appears, including in the tool
output.

### Observability

The pipeline is slow and multi-hop, so each stage is separately traced — "it didn't
verify" is useless on its own; the question is which hop stalled.

Spans `attestcoin.anchor`, `.proof_generation`, `.proof_submission`, `.register_terms`,
`attestcoin_sweep`. Metrics include `attestpay.attestcoin.attestation_wait_seconds`,
`.proof_generation_seconds`, `.proof_submission_seconds`, `.end_to_end_seconds` and
`.attestation_lag_blocks`, plus counters for anchors written, proofs generated,
verified, and failed (tagged by stage).

### Verify it against the live protocol

One read-only command, no gas, no funded key:

```bash
bun run packages/engine/scripts/attestcoin-probe.ts
```

```
1. Creditcoin RPC
  ✓ chain 102031 (Creditcoin CC3 Testnet), head 5,474,464
2. ChainInfo precompile (0x…0fD3)
  ✓ 2 attested source chain(s):
      chainKey 3 → chainId 1 (Ethereum)
      chainKey 1 → chainId 11155111 (Sepolia ethereum)
  ✓ Base is NOT an attested source chain → anchoring on an attested chain is required
3. Attestation liveness
  ✓ latest attested height 11,688,220   source head 11,688,259
  ✓ lag 39 blocks (~8 min): attestation is live and current
4. Prover API
  ✓ prover reports attested height 11,688,220 · agrees with the precompile (drift 0)
5. Proof generation for a real attested transaction
  ✓ proof generated
6. Proof structure matches what AttestPayASC expects
  ✓ txBytes: 2688 bytes · 7 Merkle siblings · 1 continuity root
  ✓ txBytes envelope starts with a valid tx type tag (2)
```

The Solidity decoder is tested against that same real prover output rather than against
blobs this repo encodes itself — see
[docs/attestcoin-integration.md §14](docs/attestcoin-integration.md#14-verifying-the-protocol-facts-yourself).

### Setup

Optional and off by default: with no Attestcoin variables set, AttestPay behaves
exactly as it did before — the four tools are simply not offered, and the dashboard's
Cross-Chain pane says so. See [`.env.example`](.env.example) for the variables and
[docs/attestcoin-integration.md](docs/attestcoin-integration.md#13-deployment) for the
deploy steps. At boot the server verifies the deployed ASC agrees with its own
configuration (same chain key, anchor and anchorer) and reports a mismatch loudly,
once, rather than letting it surface one stuck payment at a time.

---

## Architecture

Bun monorepo, three packages:

```
packages/
  engine/     pure core: caveat compiler, issuance, spend, redelegation, revocation,
              and attestcoin/ — the cross-chain proof pipeline
  server/     Hono: REST API + MCP endpoint + x402 facilitator + demo seller + Stripe webhook,
              plus the Attestcoin proof worker
  dashboard/  Next.js: Privy login, one-screen cockpit (card deck + dossier, light/dark),
              NL issue modal (client-signed), demo shop, Cross-Chain pane
contracts/    Foundry: PaymentAnchor (Ethereum Sepolia) + AttestPayASC (Creditcoin CC3)
```

Key pieces:

- **Caveat compiler** (`engine/src/compiler.ts`): turns human terms (`{"pay": {"period": {"amount": "25", "seconds": 604800}}}`) into delegation-framework enforcer caveats.
- **NL compiler** (`server/src/venice/`): Venice AI turns a plain-language request into a plan of named entities + numbers; the server resolves every name against its own verified registry (model output can never place an address in a draft) and assembles a `CardTerms` draft for the user to review and sign.
- **Issuance**: server prepares an unsigned delegation, the user's wallet signs it in the browser (prepare/finalize), so the server never holds the user's key for client-signed cards.
- **Spend** (`engine/src/spend.ts`): validates terms server-side, then redeems the delegation chain through the 1Shot Public Relayer (which calls `DelegationManager.redeemDelegations` on-chain on your behalf), attaching the user's EIP-7702 authorization on first spend.
- **Sub-cards**: ERC-7710 redelegations. Caps only narrow. Revoking a parent kills the subtree.
- **Two payment rails off one delegation**: x402 (real USDC, live) and Stripe Issuing real-time auth (test mode, fiat leg simulated honestly).
- **MCP server**: stateless Streamable HTTP, identity = the card credential on every request, no sessions.
- **Cross-chain verification** (`engine/src/attestcoin/`): a persisted state machine that anchors each confirmed payment on an attested chain and proves it into Creditcoin. Entered through a single `onChargeConfirmed` hook on `SpendDeps`, so every confirmation path feeds it; run by a background worker, because attestation takes minutes and `pay` must return in seconds. See [Cross-Chain Verification](#cross-chain-verification-attestcoin).
- **OAuth lane** (`server/src/oauth/`): a self-hosted OAuth 2.1 authorization server (RFC 9728 + RFC 8414 discovery, RFC 7591 dynamic client registration, PKCE S256, RFC 8707 resource binding, rotating refresh tokens, RFC 7009 revocation). Login and the card-picker consent reuse the existing Privy dashboard session; issued tokens are opaque, card-scoped, hash-stored beside the card secrets, and die when the card is revoked.

### Contracts (Base mainnet)

| Contract | Address |
|---|---|
| DelegationManager | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` |
| Stateless7702 delegator impl | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

### Attestcoin precompiles (Creditcoin CC3 testnet, chain 102031)

| Precompile | Address | Role |
|---|---|---|
| Block Prover | `0x0000000000000000000000000000000000000FD2` | Verifies Merkle inclusion + block continuity proofs on-chain |
| Chain Info | `0x0000000000000000000000000000000000000fD3` | Supported source chains, attestation heights (snake_case ABI) |

---

## Observability (SigNoz)

AttestPay is fully instrumented with OpenTelemetry and sends traces, metrics, and logs to SigNoz Cloud (and can self-host locally via the included `casting.yaml`). The full observability architecture (16 use cases, RED metrics, SLOs, saved views, dashboards, alerts, cost control, and the service map) is documented in [docs/architecture.md](docs/architecture.md).

### Instrumented Surface

| Category | Signal | What's Tracked | How to See in SigNoz |
|----------|--------|----------------|----------------------|
| API Requests | Trace | Every HTTP request with route pattern, method, status code, auth info | Traces -> filter `service.name = attestpay-server` |
| MCP Tool Calls | Trace | Every agent tool call (`card`, `pay`, `shop_buy`, ...) with card context and typed refusal codes | Traces -> search `name LIKE 'mcp_tool_%'` |
| Stripe Webhooks | Trace | Auth decision flow (approve/decline) with decision and card context | Traces -> search `stripe_webhook_auth` |
| On-Chain Payments | Trace | Relayer redemption with USDC amount, gas, tx hash | Traces -> search `1shot_relayer_redeem` |
| AI Compilation | Trace | Plain-language card intent -> compiled terms, token usage | Traces -> search `nl_compile` |
| Reconcile Sweep | Trace | Stuck-pending charge resolution (reconciled/still_pending counts) | Traces -> search `reconcile_sweep` |
| Fiat Settlement | Trace | Visa->on-chain settlement sweep (settled/left counts) | Traces -> search `fiat_settle_sweep` |
| Cards Issued | Metric | `attestpay.cards_issued_total` - root + sub-cards across all users | Metrics -> counter |
| USDC Spent | Metric | `attestpay.usdc_spent_total` - total USDC across all rails | Metrics -> counter |
| Active Cards | Metric | `attestpay.active_cards` - live gauge of issued - revoked | Metrics -> up-down counter |
| Charges Processed | Metric | `attestpay.charges_total` - confirmed + pending + failed charges | Metrics -> counter |
| API Errors | Metric | `attestpay.errors_total` - every 403/422/502/500 response | Metrics -> counter |
| Refusal Logs | Log | Typed refusals with reason, card_id, attempted_amount | Logs -> filter `refusal_reason` |
| Card Lifecycle | Log | `issued`, `frozen`, `unfrozen`, `revoked`, `nuked`, `url_revealed`, `secret_rotated`, `onboarded` | Logs -> filter `card_event` |
| Charge Confirmed | Log | Successful payments with amount, kind, card_id | Logs -> filter `charge_event = confirmed` |
| API Errors | Log | Every error with operation, status code, route, method | Logs -> filter `operation` or `error_message` |

### Pipeline

```
attestpay-server (Node.js)
  |
  |- @opentelemetry/auto-instrumentations-node  (automatic HTTP/fetch/DB spans)
  |- Manual instrumentation via trace API       (custom business spans)
  |- Metrics via Meter API                      (counters + up-down counters)
  |- Logs via Logger API                        (structured card lifecycle events)
  |
  +- OTLP HTTP exporter (port 4318)
       |
       v
  SigNoz Cloud (ingest.us2.signoz.cloud:443)
       |
       |- Traces  -> distributed tracing waterfall
       |- Metrics -> dashboard panels + alerts
       +- Logs    -> structured log explorer
```

The OTel SDK is initialized early via Bun `--preload` (`packages/server/src/otel.ts`) so auto-instrumentation wraps every module from boot. The engine package (`packages/engine/src/telemetry.ts`) declares all custom metrics and structured log functions.

### Self-Hosted SigNoz (Local Dev)

A `casting.yaml` is included for deploying SigNoz locally with Foundry:

```bash
# Deploy SigNoz stack locally
foundryctl cast -f casting.yaml --locked

# SigNoz UI: http://localhost:3301
# OTLP endpoint: http://localhost:4318
# SigNoz MCP: http://localhost:8000
```

The `casting.yaml.lock` pins every Docker image to its content digest for reproducible deployments.

### SigNoz Dashboard Panels

Create a AttestPay dashboard in SigNoz with these panels:

**Panel 1: Cards Issued Over Time (Time Series)**

```sql
SELECT toStartOfInterval(toDateTime(intDiv(timestamp_ms, 1000)), INTERVAL 5 MINUTE) AS ts,
       sum(value) AS value
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay.cards_issued_total'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts
ORDER BY ts
```

**Panel 2: Active Cards (Value / Gauge)**

```sql
SELECT sum(value) AS active_cards
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay.active_cards'
  AND timestamp_ms > toUnixTimestamp(now()) * 1000 - 60000
```

**Panel 3: USDC Spent (Time Series)**

```sql
SELECT toStartOfInterval(toDateTime(intDiv(timestamp_ms, 1000)), INTERVAL 5 MINUTE) AS ts,
       sum(value) AS value
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay.usdc_spent_total'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts
ORDER BY ts
```

**Panel 4: API Errors (Time Series)**

```sql
SELECT toStartOfInterval(toDateTime(intDiv(timestamp_ms, 1000)), INTERVAL 5 MINUTE) AS ts,
       sum(value) AS errors
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay.errors_total'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts
ORDER BY ts
```

**Panel 5: API Request Duration by Route**

```sql
SELECT toStartOfInterval(timestamp, INTERVAL 5 MINUTE) AS ts,
       attributes_string['http.route'] AS route,
       avg(durationNano) / 1000000 AS avg_ms
FROM signoz_traces.distributed_signoz_index_v2
WHERE resources_string['service.name'] = 'attestpay-server'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts, route
ORDER BY ts
```

### Alerts

Create alerts in SigNoz for these conditions:

| Alert | Condition | Severity |
|-------|-----------|----------|
| High Error Rate | `attestpay.errors_total` rate > 10/min for 5 min | Critical |
| No Cards Issued | `attestpay.cards_issued_total` has no new value for 30 min | Warning |
| High API Latency | P99 HTTP duration > 5000ms for 5 min | Warning |
| Spike in Refusals | Log count with `refusal_reason: *` > 20/min | Warning |

### SigNoz MCP Integration

AttestPay includes the SigNoz MCP server for agentic observability workflows:

```bash
# Add the SigNoz MCP server to your AI agent
claude mcp add signoz http://localhost:8000 \
  --header "Authorization: Bearer $SIGNOZ_MCP_AUTH_TOKEN"
```

Your AI agent can then use SigNoz MCP tools to query traces and logs from AttestPay, create and modify dashboards, set up and investigate alerts, and run ClickHouse queries against the observability data.

### Screenshots


**Traces**

<img width="1908" height="942" alt="swappy-20260731-190527" src="https://github.com/user-attachments/assets/8e328e2e-e5f0-4fe9-a246-0f2a431c35fd" />

<img width="1904" height="939" alt="swappy-20260731-231952" src="https://github.com/user-attachments/assets/b48df685-119d-4c1e-b87b-9e798a571349" />

<img width="1903" height="952" alt="swappy-20260731-185624" src="https://github.com/user-attachments/assets/67c55376-2b20-4b45-bff5-da3334df6773" />


**Metrics**

<img width="1846" height="917" alt="swappy-20260731-232129" src="https://github.com/user-attachments/assets/6adf56b2-aec7-4c05-94d8-47bcf03021b5" />


**Logs**

<img width="1908" height="933" alt="swappy-20260731-185656" src="https://github.com/user-attachments/assets/79e9c153-8d7a-4213-928d-3599d958f573" />


**Dashboards and Alerts**

<img width="954" height="724" alt="swappy-20260731-232540" src="https://github.com/user-attachments/assets/595d3729-3f69-435a-a46e-1b07eb2a0193" />

<img width="1918" height="954" alt="swappy-20260731-191321" src="https://github.com/user-attachments/assets/78f648c2-e63d-4332-9d9c-4f88f703b43a" />

<img width="1851" height="603" alt="swappy-20260727-215523" src="https://github.com/user-attachments/assets/74e31813-cd5d-480a-8971-59697237ebfe" />

<img width="922" height="467" alt="swappy-20260727-215311" src="https://github.com/user-attachments/assets/4be239bc-6492-47a2-af68-17161cd18d98" />

<img width="911" height="323" alt="swappy-20260727-215324" src="https://github.com/user-attachments/assets/9f69dc3f-da86-4464-bddf-a11fb7a69b98" />

<img width="913" height="331" alt="swappy-20260727-215333" src="https://github.com/user-attachments/assets/7b558d32-a152-410a-9501-50f34343b2d8" />

<img width="914" height="662" alt="swappy-20260727-215346" src="https://github.com/user-attachments/assets/1df182b1-ccda-424c-b607-580e6d1a6794" />

<img width="909" height="668" alt="swappy-20260727-215357" src="https://github.com/user-attachments/assets/4554aabb-bb5a-4a19-b523-765477756886" />

<img width="917" height="338" alt="swappy-20260727-215406" src="https://github.com/user-attachments/assets/0dfa165e-7173-48bf-989e-4af9f6af230b" />

---

## Getting Started

Requires [bun](https://bun.sh). Real money moves on Base mainnet; use small budgets.

```bash
bun install
cp .env.example .env                       # then fill in the two required vars:
# ATTESTPAY_MASTER_KEY=<64 hex chars>            encrypts agent keys + card secrets at rest
# ATTESTPAY_ADMIN_TOKEN=<random token>           protects the management API

bun dev                                    # server on :4070
bun run --cwd packages/dashboard dev       # dashboard on :4071
```

Issue a card from the dashboard (Privy login), or via the admin API:

```bash
curl -X POST localhost:4070/api/cards \
  -H "Authorization: Bearer $ATTESTPAY_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"my agent card","terms":{"pay":{"period":{"amount":"5","seconds":604800}}}}'
# -> { "card_id": ..., "card_url": "http://localhost:4070/c/<secret>/mcp" }
```

Plug the `card_url` into an agent and it can spend.

---

## Tests

```bash
bun test                 # engine + server suites (408 tests)
bun run typecheck        # per-package tsc
cd contracts && forge test   # Solidity suite (42 tests)
```

Attestcoin-specific suites:

```bash
cd contracts && forge test                        # proofs, impostor anchors, replay, terms,
                                                  # and the decoder against REAL prover output
bun run packages/engine/scripts/attestcoin-probe.ts  # live, read-only protocol probe
bun test packages/engine/test/attestcoin.test.ts  # proof state machine, grading, config
bun test packages/server/test/attestcoin.test.ts  # routes + tools, configured AND not
```

The server suite runs the whole Attestcoin surface in **both** configurations. The
disabled case is the one that protects existing deployments: it asserts that a server
which never configures Attestcoin is unchanged, that every route still answers with
`configured: false`, and that the four cross-chain tools are absent.

---

## Environment Variables

| Var | Required | Purpose |
|---|---|---|
| `ATTESTPAY_MASTER_KEY` | yes | 32-byte hex key; encrypts agent keys and card secrets at rest |
| `ATTESTPAY_ADMIN_TOKEN` | yes | ops bearer token for the management API (`/api/*`): full access, server-side scripts only, never shipped to a browser |
| `ATTESTPAY_PRIVY_APP_ID` | dashboard lane | enables per-user API auth: Privy access tokens verified offline against the app's JWKS; every route scoped to the authenticated user |
| `PORT` | no | server port (default 4070) |
| `ATTESTPAY_DB_PATH` | no | SQLite path (default `.dev/remit.sqlite`) |
| `ATTESTPAY_RPC_URL` | no | Base RPC (default `https://mainnet.base.org`) |
| `ATTESTPAY_PUBLIC_MCP_BASE` | prod | public origin used when rendering card URLs (unset = localhost; also arms the MCP Host allowlist) |
| `ATTESTPAY_ALLOWED_HOSTS` | no | extra Host headers accepted on the MCP endpoint (comma-separated; e.g. a platform fallback domain) |
| `ATTESTPAY_CORS_ORIGINS` | no | comma-separated allowed origins for the API |
| `ATTESTPAY_DEV_USER_PK` | no | dev-only server-custodied user key (server-signed issuance lane) |
| `ATTESTPAY_FACILITATOR_BASE` | no | x402 facilitator base URL (defaults to self) |
| `ATTESTPAY_SELLER_PAYTO` | no | payout address for the built-in demo seller |
| `ATTESTPAY_PAID_FETCH_ALLOW_LOCAL` | no | allow `paid_fetch` to hit local/private hosts (dev only) |
| `ATTESTPAY_STRIPE_WEBHOOK_SECRET` | no | Stripe real-time auth webhook signing secret (test mode); unset = the fiat leg answers 503 (disabled) |
| `STRIPE_SECRET_KEY` | no | Stripe TEST-mode secret key (`sk_test_`/`rk_test_` only; anything else is refused); enables `fiat_pay`, `card_credentials`, and the demo shop |
| `ATTESTPAY_FIAT_SETTLEMENT` | no | `1` = approved Visa charges settle on-chain as real delegated USDC transfers (see `ATTESTPAY_SETTLEMENT_ADDRESS`, `ATTESTPAY_FIAT_FEE_HEADROOM`, `ATTESTPAY_FIAT_SETTLE_INTERVAL_MS`) |
| `ATTESTPAY_SETTLEMENT_ADDRESS` | settlement | recipient of the fiat settlement transfers (validated at boot; default = the fee collector) |
| `VENICE_API_KEY` | no | enables `POST /cards/compile` (plain-language card drafting); unset = the compile endpoint refuses (disabled) |
| `VENICE_MODEL` | with key | Venice model id for the NL compiler; pin it (the fallback default is unvalidated) |
| `VENICE_BASE_URL` | no | Venice API base override (defaults to the public Venice endpoint) |
| `BASESCAN_API_KEY` | no | enables verified-contract labels from Basescan when resolving compiled drafts |
| `ATTESTPAY_DASHBOARD_BASE` | OAuth lane | dashboard origin that hosts the OAuth consent (card-picker) page (default `http://localhost:4071`) |
| `ATTESTPAY_RECONCILE_INTERVAL_MS` | no | stuck-pending-charge reconcile sweep interval (default 300000; 0 disables) |
| `ATTESTPAY_MCP_RATE_LIMIT` / `ATTESTPAY_MCP_BAD_SECRET_LIMIT` | no | per-card and per-IP-bad-secret request ceilings per minute (defaults 240 / 30) |
| `ATTESTPAY_OAUTH_ACCESS_TTL` / `ATTESTPAY_OAUTH_REFRESH_TTL` | no | OAuth access / refresh token lifetimes in seconds (defaults 3600 / 2592000) |
| `ATTESTPAY_OAUTH_REDIRECT_HOSTS` | no | if set, restricts OAuth `https` redirect-URI hosts to this allowlist (loopback + custom schemes always allowed; recommended in prod) |
| `ATTESTPAY_OAUTH_ACCEPTED_RESOURCES` | no | extra RFC 8707 resource URIs still honored (legacy values during a base-URL migration) |
| `ATTESTPAY_TRUST_PROXY_HOPS` | no | trusted proxy hops for client-IP rate limiting (default 1 = Railway edge; 0 disables XFF trust) |
| `ATTESTPAY_PAYMENT_ANCHOR_ADDRESS` | attestcoin | `PaymentAnchor` on Ethereum Sepolia; one of three values required to enable cross-chain verification |
| `ATTESTPAY_ASC_ADDRESS` | attestcoin | `AttestPayASC` on Creditcoin CC3 testnet |
| `ATTESTPAY_ATTESTCOIN_PRIVATE_KEY` | attestcoin | signer for both legs (needs Sepolia ETH + tCTC); must match the ASC's `trustedAnchorer` |
| `ATTESTPAY_ATTESTCOIN_CHAIN_KEY` | no | Attestcoin source-chain key, **not** an EVM chain id (default 1 = Ethereum Sepolia; 3 = mainnet) |
| `ATTESTPAY_SEPOLIA_RPC` | no | source-chain RPC where `PaymentAnchor` lives |
| `ATTESTPAY_CREDITCOIN_HTTP_RPC` | no | Creditcoin CC3 RPC (HTTP, not WebSocket: the USC SDK needs a `JsonRpcApiProvider`) |
| `ATTESTPAY_PROVER_API_URL` | no | Attestcoin proof generator API |
| `ATTESTPAY_ATTESTCOIN_SWEEP_INTERVAL_MS` | no | proof worker tick (default 60000; 0 stops it, so payments queue but never verify) |
| `ATTESTPAY_ATTESTCOIN_BATCH_SIZE` | no | rows advanced per tick (default 10) |
| `ATTESTPAY_ATTESTCOIN_ENABLED` | no | set to `0` to force the integration off even when fully configured |
| `NEXT_PUBLIC_PRIVY_APP_ID` / `NEXT_PUBLIC_PRIVY_CLIENT_ID` | dashboard | Privy app credentials (public identifiers, not secrets) |
| `NEXT_PUBLIC_ATTESTPAY_API` | dashboard | server API base, e.g. `http://localhost:4070/api` |
| `NEXT_PUBLIC_BASE_RPC` | dashboard | Base RPC for client-side reads |

Cross-chain verification is optional: leave the three `attestcoin` rows blank and
AttestPay runs exactly as it does without the integration. The server logs which
variables are missing at boot rather than no-oping silently.

The dashboard carries no shared secret: every API call sends the signed-in user's Privy session token, which the server verifies and scopes. The deployed dashboard origin must be listed in the server's `ATTESTPAY_CORS_ORIGINS`.

OpenTelemetry / SigNoz variables (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `ATTESTPAY_OTEL_DEBUG`) are documented in `.env.example`.

---

## Security Model

- **Custody**: your funds stay in your wallet. The per-card agent key signs redelegations only; it holds no assets and is encrypted at rest. You can export your wallet's private key from the account menu at any time (through Privy's secure modal, rendered in a separate-domain iframe remit never reads) and walk away to any client.
- **Dashboard auth**: per-user Privy sessions, verified server-side against the app JWKS. At onboard, the embedded wallet signs `attestpay-onboard:v1:<did>` to prove key possession bound to that login; from then on, every card route is scoped to the authenticated user's own cards.
- **Issuance integrity**: the server verifies the delegation signature recovers to the delegator on both issuance lanes before persisting a card.
- **Card secrets**: 256-bit, stored as a hash for auth and AES-256-GCM-encrypted at rest for the reveal/rotate feature; the URL is a credential, rotate it like a password.
- **Limits enforced twice**: server-side at call time (typed refusals) and on-chain by caveat enforcers at redemption. Period, lifetime, expiry, usage count, and contract target/method have dedicated on-chain enforcers; the per-transaction max and merchant allowlist are server-side carve policy, backstopped on-chain by the leaf's amount scope.
- **Revocation layers**: freeze (server, reversible) -> revoke (card + subtree, permanent) -> nuke (on-chain nonce bump, kills every delegation ever issued by the wallet). All three are user-operable from the dashboard; on-chain revoke and nuke are signed by the user's own embedded wallet in the browser (an admin leaf delegation) and ride the relayer gaslessly.
- **MCP surface hardening**: Host allowlist (DNS-rebinding guard), per-card and bad-secret rate limits, 1 MiB body cap, secrets never echoed in errors or logs.
- **Stripe leg**: test mode only, by design; the real-time auth webhook answers from cached delegation state within Stripe's 2s window. With settlement enabled, an approved charge settles as a real delegated USDC transfer afterwards (the same enforcers count both rails), and a charge whose settlement cannot land parks `settlement_unconfirmed` and freezes the card rather than ever releasing its budget.

---

## Demo Merchant

`/shop` (also served at https://shop.s0nderlabs.xyz) is a small storefront, "s0nder supply co.", that accepts the cards' Visas. It exists to show the fiat lane end to end with nothing mocked on our side of the rail:

1. An agent asks its card for credentials (`card_credentials`) and fills the checkout form like it would at any web store.
2. The shop fires a real Stripe test-mode authorization; Stripe calls our real-time auth webhook; the webhook answers approve/decline from the card's on-chain delegation state within Stripe's 2-second window.
3. A decline (e.g. an item over the card's weekly budget) comes back typed, from the card's terms, not from the merchant.
4. With settlement enabled, the approved charge settles as a real delegated USDC transfer on Base, through the same enforcers that meter the crypto rail. One budget, two rails.

Catalog prices are all $5 or less because approved purchases move real USDC.

---

## Documentation

| Document | Contents |
|---|---|
| [docs/attestcoin-integration.md](docs/attestcoin-integration.md) | The Attestcoin Protocol integration in full: trust model, contracts, the proof pipeline, credit scoring, and commands to verify every protocol claim yourself |
| [docs/architecture.md](docs/architecture.md) | Full system architecture with all 16 SigNoz use cases (traces, metrics, logs, dashboards, alerts, saved views, cost control, service map, SigNoz MCP) |
| [docs/signoz-verification.md](docs/signoz-verification.md) | Step-by-step guide to verify every SigNoz feature in the live deployment |
| [docs/blog-post.md](docs/blog-post.md) | The observability story: instrumenting agentic payments with OpenTelemetry + SigNoz |
| [docs/medium-post.md](docs/medium-post.md) | Medium-ready version of the observability story with screenshot placeholders (IMG-1..IMG-13) |
| [docs/screenshots/README.md](docs/screenshots/README.md) | Which screenshot goes where: drop files as `img-01.png`..`img-13.png` |
| [docs/video-script.md](docs/video-script.md) | Demo video script, SigNoz cut (3 minutes) |
| [docs/video-script-attestcoin.md](docs/video-script-attestcoin.md) | Demo video script, cross-chain cut for BUIDL CTC (3 minutes) |
| [docs/hackathon-deck.md](docs/hackathon-deck.md) | Project deck source (10 slides; renders to PDF with Marp) |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

---

## License

MIT. See [LICENSE](LICENSE).
