# Attestcoin Protocol Integration

How AttestPay uses Creditcoin's Attestcoin Protocol to turn AI agent payments into
cross-chain-verified, on-chain credit history.

This document is written to be checked rather than believed. Every claim about the
protocol below can be verified with a command included in the text, and the section
on the trust model states plainly what the integration does **not** prove.

---

## Contents

1. [What this integration does](#1-what-this-integration-does)
2. [The trust model, stated plainly](#2-the-trust-model-stated-plainly)
3. [Why the anchor lives on Ethereum Sepolia](#3-why-the-anchor-lives-on-ethereum-sepolia)
4. [Architecture](#4-architecture)
5. [The contracts](#5-the-contracts)
6. [Why `verifyPayment` takes only a proof](#6-why-verifypayment-takes-only-a-proof)
7. [The proof pipeline](#7-the-proof-pipeline)
8. [Agent credit history](#8-agent-credit-history)
9. [Card terms registry](#9-card-terms-registry)
10. [Agent tools](#10-agent-tools)
11. [REST API](#11-rest-api)
12. [Observability](#12-observability)
13. [Deployment](#13-deployment)
14. [Verifying the protocol facts yourself](#14-verifying-the-protocol-facts-yourself)
15. [Known limitations](#15-known-limitations)
16. [Credit lines, disputes, guarantees and the passport](#16-credit-lines-disputes-guarantees-and-the-passport)

---

## 1. What this integration does

AttestPay issues scoped, revocable spending cards to AI agents. An agent holding a
card can pay USDC on Base within limits its owner set — a period budget, a per-payment
cap, an expiry, a merchant allowlist.

This integration adds a second claim on top of each payment: **a cryptographic,
oracle-free proof, recorded on Creditcoin, that the payment record exists.** Every
verified payment accrues to the card's funding account as public credit history that
any Creditcoin contract can read.

Concretely, per payment:

| | |
|---|---|
| **Before** | The payment exists on Base. Anyone asking "has this agent paid reliably?" must trust AttestPay's database. |
| **After** | The payment record is proven into a Creditcoin contract by the Attestcoin Block Prover precompile. The agent's history is public, append-only, and readable by any Creditcoin dApp without trusting AttestPay at all. |

---

## 2. The trust model, stated plainly

This is the most important section, and it is deliberately first, because the honest
version is narrower than "every payment is cryptographically verified".

### What IS proven, trustlessly

That a `PaymentAnchored` event **with exactly these field values** was included in a
transaction in a block **attested by the Attestcoin attestor network**.

No oracle is trusted for this. The Block Prover precompile checks a Merkle inclusion
proof and a block-continuity proof inside the same Creditcoin transaction that records
the result. `AttestPayASC` then decodes the payment's fields **out of the proven
transaction bytes**, so no relayer — including AttestPay's own server — can alter a
value in flight. Submitting a proof is permissionless: a valid proof is
self-authenticating, and relaying someone else's can only record what the anchor
truly said.

### What is NOT proven

**That the underlying Base payment happened.**

The AttestPay server writes the anchor. So the hop from "USDC moved on Base" to "an
anchor says USDC moved on Base" is the server's own attestation, not Attestcoin's.

Two things keep that honest rather than hand-wavy:

- Every anchor records `sourceTxHash` — the Base transaction hash — so **anyone can
  independently check the Base transaction** and hold the anchor to account. A
  mismatch is publicly detectable.
- Every anchor records `anchoredBy`, and `AttestPayASC` credits **only** its
  configured `trustedAnchorer`. The party making the off-chain claim is pinned
  on-chain rather than left open.

So the correct description of a verified payment is:

> AttestPay asserted this payment on an attested chain, and that assertion is now
> cryptographically immutable, publicly timestamped, attributable to a named
> anchorer, and checkable against the Base transaction it names.

That is materially stronger than a private database row, and materially weaker than
proving the Base transfer itself. The agent-facing `payment_receipt` tool returns both
halves of this paragraph verbatim, so an agent relaying the result to a human cannot
accidentally overstate it.

### What would remove the gap

Attestcoin attesting Base as a source chain. Then `PaymentAnchor` becomes unnecessary
and the USDC transfer itself is proven directly into the ASC. The design is
deliberately shaped so that this is a change of source chain and contract address, not
a redesign: `AttestPayASC` already derives everything from proven receipt logs, and
would only need to decode USDC's `Transfer` instead of `PaymentAnchored`.

---

## 3. Why the anchor lives on Ethereum Sepolia

The Attestcoin protocol on Creditcoin CC3 testnet attests exactly **two** source
chains. Ask the ChainInfo precompile:

```bash
cast call 0x0000000000000000000000000000000000000fd3 \
  "get_supported_chains()" \
  --rpc-url https://rpc.cc3-testnet.creditcoin.network \
| xargs cast decode-abi "get_supported_chains()((uint64,uint64,bytes,uint8)[])"
```

```
[(3, 1, 0x457468657265756d, 1), (1, 11155111, 0x5365706f6c696120657468657265756d, 1)]
#  ^chainKey 3 = "Ethereum" (chainId 1)   ^chainKey 1 = "Sepolia ethereum" (11155111)
```

Base (8453) and Base Sepolia (84532) are **not** in that list, so a Base transaction
cannot be proven into Creditcoin at all. AttestPay's payments execute on Base — the
ERC-7710 delegation stack and the 1Shot relayer only exist there — so the integration
anchors to Ethereum Sepolia (`chainKey = 1`) and proves the anchoring transaction.

Attestation is live and current. At the time of writing:

```bash
# latest attested Sepolia height, per the prover API
curl -s https://prover.cc3-testnet.creditcoin.network/api/v1/attested-height/1
# {"attestedHeight":11687990}
```

against a Sepolia head of 11688030 — a lag of **40 blocks, roughly 8 minutes**. That
number is why the proof pipeline is a background worker rather than an inline step.

---

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  BASE  (chain 8453 — where the money actually moves)                     │
│                                                                           │
│   User wallet ──ERC-7710 delegation──▶ Agent ──▶ USDC transfer            │
│                                                      │                    │
│                             charge row: status = confirmed                │
│                                                      │                    │
└──────────────────────────────────────────────────────┼───────────────────┘
                                                       │
                           spend.ts onChargeConfirmed ──┤  (enqueue, ~1ms)
                                                       ▼
                                      ┌────────────────────────────┐
                                      │  attestcoin_proofs (sqlite) │
                                      │  pending → … → verified     │
                                      └──────────────┬─────────────┘
                                                      │ background worker
┌─────────────────────────────────────────────────────┼───────────────────┐
│  ETHEREUM SEPOLIA  (chainKey 1 — an ATTESTED chain) ▼                    │
│                                                                           │
│   PaymentAnchor.anchorPayment(...)                                        │
│     emits PaymentAnchored(cardId, payer, merchant, amount,                │
│                           sourceChainId, sourceTxHash, paidAt,            │
│                           anchoredBy, memo)                               │
└──────────────────────────────────────────────────────┬───────────────────┘
                                                       │
           Attestcoin attestors reach consensus (~8 min)│
                                                       │
           prover API: /api/v1/proof-by-tx/1/<txHash>  │
             → { headerNumber, txBytes, merkleProof,    │
                 continuityProof }                      │
                                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  CREDITCOIN CC3 TESTNET  (chain 102031)                                   │
│                                                                           │
│   AttestPayASC.verifyPayment(height, txBytes, merkleProof, continuity)    │
│     │                                                                     │
│     ├─▶ 0x0FD2 BlockProver.verify(...)          ← proof checked on-chain  │
│     ├─▶ 0x0FD2 BlockProver.calculateTxIndex(..) ← replay key, from proof  │
│     ├─▶ ProvenTxDecoder: receipt logs out of the PROVEN txBytes           │
│     ├─▶ match emitter == paymentAnchor && topics[0] == PaymentAnchored    │
│     ├─▶ require anchoredBy == trustedAnchorer                             │
│     └─▶ store VerifiedPayment · update AgentCredit · check CardTerms      │
│                                                                           │
│   Readable by ANY Creditcoin contract, with no trust in AttestPay:        │
│     getAgentCredit(payer) · getCardPayments(cardId, offset, limit)        │
└──────────────────────────────────────────────────────────────────────────┘

SigNoz traces the whole path: attestcoin.anchor → .proof_generation →
.proof_submission, plus attestation-lag and end-to-end-latency histograms.
```

---

## 5. The contracts

`contracts/` is a Foundry project. 35 tests, `forge test`.

### `PaymentAnchor.sol` — Ethereum Sepolia

Emits one event and guards against double-anchoring.

```solidity
event PaymentAnchored(
    bytes32 indexed cardId,    // keccak256(utf8(card.id))
    address indexed payer,     // the card tree's ROOT funding account
    address indexed merchant,
    uint256 amount,            // USDC atoms (6dp)
    uint256 sourceChainId,     // 8453 Base / 84532 Base Sepolia
    bytes32 sourceTxHash,      // the Base transaction — go check it
    uint256 paidAt,
    address anchoredBy,        // msg.sender: who made this claim
    string  memo
);
```

Anchoring is **permissionless by design** — anyone may write an anchor, and the writer
is recorded. Consumers decide which anchorers they trust rather than this contract
maintaining a privileged writer set. `AttestPayASC` takes the stricter line and
credits only its configured anchorer.

Replay is keyed on `keccak256(sourceChainId, sourceTxHash)`, so one Base payment
cannot be anchored twice and inflate a credit score by repetition — while the same
hash on a different chain stays a distinct payment.

### `IBlockProver.sol` — the real precompile interfaces

Transcribed from `@gluwa/usc-sdk@0.18.0`. Two details differ from most write-ups of
this precompile, and both shaped the design:

```solidity
function verify(
    uint64 chainKey,
    uint64 height,
    bytes calldata encodedTransaction,
    TransactionMerkleProof calldata merkleProof,   // (bytes32 root, (bytes32,bool)[] siblings)
    ContinuityProof calldata continuityProof       // (bytes32 lowerEndpointDigest, bytes32[] roots)
) external view returns (bool);
```

1. It returns a **bare `bool`** — it does not hand back the proven transaction's
   contents.
2. It **reverts** on a failed verification rather than returning `false`.

The ChainInfo precompile at `0x…0fD3` uses **snake_case** names
(`get_supported_chains`, `is_height_attested`). The SDK's TypeScript wrapper presents
camelCase equivalents; calling the camelCase spellings against the precompile reverts
with `Unknown selector`.

### `ProvenTxDecoder.sol` — recovering the facts

Because `verify` returns only a bool, the only trustworthy way to learn what a proven
transaction did is to decode it yourself. The Attestcoin encoding
(`@gluwa/usc-sdk`, `dist/encoding/abi/v1.js`) is:

```
encodedTransaction = abi.encode(uint8 txType, bytes[] chunks)

  txType 0,1,2 → 3 chunks: [common, typeSpecific,  receipt]
  txType 3,4   → 4 chunks: [common, typeSpecific1, typeSpecific2, receipt]

receipt chunk  = abi.encode(uint8 status, uint64 gasUsed,
                            (address,bytes32[],bytes)[] logs, bytes logsBloom)
```

The receipt is **always the last chunk**, so `chunks[chunks.length - 1]` works for
every transaction type without branching on `txType`. The decoder also rejects a
proven transaction whose `status == 0`: a reverted transaction emits no real payment,
and recording one would turn a failed payment into credit history.

### `AttestPayASC.sol` — Creditcoin

The Attestcoin Smart Contract. Verifies proofs, decodes payments, maintains credit.

```solidity
function verifyPayment(
    uint64 height,
    bytes calldata encodedTransaction,
    IBlockProver.TransactionMerkleProof calldata merkleProof,
    IBlockProver.ContinuityProof calldata continuityProof
) external returns (uint256 recorded);
```

Immutable trust anchors, set once at deploy: `sourceChainKey`, `paymentAnchor`,
`trustedAnchorer`, `blockProver`. None is swappable.

Replay is keyed on `keccak256(chainKey, height, txIndex, logIndex)` — all four derived
from proven data, with `txIndex` coming from the precompile's own `calculateTxIndex`
rather than from the caller. One anchoring transaction carrying several
`PaymentAnchored` events therefore records each exactly once, and a repeat submission
returns `recorded == 0` instead of reverting, so relayers can safely retry.

---

## 6. Why `verifyPayment` takes only a proof

This is the central design decision, so it is worth stating as a rule:

> **Never accept payment facts as parameters alongside a proof.**

The natural-looking signature is:

```solidity
// UNSOUND — do not do this
function verifyPayment(
    bytes merkleProof, bytes continuityProof,
    bytes32 cardId, address from, uint256 amount, string memo   // ← unchecked!
) external;
```

The proof and the facts are independent. A valid proof of **any** attested transaction
— a random Uniswap swap, someone else's transfer — would let a caller staple arbitrary
payment data to it. Anyone could mint unlimited "verified" credit history from one
real proof. The verification would be real and the record meaningless.

So `AttestPayASC.verifyPayment` takes the proof **and nothing else**. Every recorded
field is decoded out of the transaction bytes the precompile just proved. The proof
and the facts cannot be separated, because the facts *are* the proven bytes.

Three tests pin this down (`contracts/test/AttestPayASC.t.sol`):

- `test_rejectsLogFromImpostorAnchor` — a look-alike anchor's event, inside a
  perfectly valid proof of its own transaction, records nothing.
- `test_rejectsAnchorFromUntrustedAnchorer` — anchoring is permissionless, so the ASC
  must refuse a stranger's anchor even when the proof is sound.
- `test_rejectsRevertedSourceTransaction` — a proven-but-reverted transaction is not a
  payment.

---

## 7. The proof pipeline

`packages/engine/src/attestcoin/`. A persisted state machine, driven by a background
worker.

```
pending → anchoring → anchored → attested → proving → verified
                                                    ↘ failed
```

| State | Meaning |
|---|---|
| `pending` | Payment confirmed on Base; nothing anchored yet |
| `anchoring` | Writing the anchor to Sepolia |
| `anchored` | Anchor landed; waiting on the attestor network (**the slow part**) |
| `attested` | The anchor's block is attested; a proof can be generated |
| `proving` | Generating the proof and submitting it to the ASC |
| `verified` | Terminal, successful |
| `failed` | Terminal; `error` says why, and an operator can retry |

### Three decisions that matter

**It is a background worker, not a step in `pay`.** Attestation takes minutes; an
agent's `pay` must return in seconds. `spend()` only enqueues — via a new
`onChargeConfirmed` hook on `SpendDeps`, so *every* confirmation path feeds the
pipeline (pay, execute, fiat settlement, and the reconcile sweep alike). The hook is
wrapped so a broken queue can never fail a payment that already landed on-chain.

**One transition per row per tick.** `advance()` does not loop a row through to
completion. That stops a single slow row starving the queue, and makes the attestation
wait a natural consequence of re-checking rather than a sleep held inside a process.
State lives in sqlite, so a restart loses at most one step.

**Waiting does not consume a retry attempt.** The prover API reports "not attested
yet" the same way it reports a real failure. Counting the wait as a failed attempt
would expire perfectly healthy rows, so the `anchored` state re-checks without
incrementing `attempts`.

### Idempotency throughout

- `enqueue` uses `ON CONFLICT DO NOTHING` — a reconcile sweep re-confirming a charge
  cannot rewind an in-flight row to `pending` and re-anchor it.
- An already-anchored payment is not an error: the client locates the existing anchor
  by log scan and carries on, so a crash between "tx landed" and "row updated"
  converges instead of sticking.
- A proof submitted twice records nothing new and returns `recorded == 0`.

---

## 8. Agent credit history

Every verified payment updates an `AgentCredit` record against the card tree's **root
funding account** — sub-cards spend from their root's account, so that is where the
history belongs.

```solidity
struct AgentCredit {
    uint256 totalPayments;
    uint256 totalVolume;          // USDC atoms
    uint256 firstPaymentAt;       // history length: harder to fake than volume
    uint256 lastPaymentAt;
    uint256 withinTermsPayments;
    uint256 termsCheckedPayments; // the honest denominator
}
```

`withinTermsPayments` is tracked against `termsCheckedPayments`, not against
`totalPayments`, and that distinction is deliberate: **a card with no registered terms
does not score a free 100% compliance rate.** With nothing to comply with, a payment
is neither credited nor penalised. Terms registered *after* a payment are likewise not
applied retroactively — they say nothing about whether that payment complied.

Proofs can arrive out of order, so `firstPaymentAt` tracks the true earliest `paidAt`
rather than assuming each new payment is the newest seen.

### The grade

`creditGrade()` produces a letter from three capped inputs, scaled by terms
compliance where measurable:

```
count  → min(40, payments × 4)      consistency
volume → min(30, USDC × 3)          scale
age    → min(30, historyDays)       a long record is harder to fake than a large one
score  = (count + volume + age) × withinTermsRate   [when terms were registered]

A ≥ 80   B ≥ 60   C ≥ 40   D ≥ 20   F < 20
```

This is a readable summary of public on-chain facts, **not a risk model**, and it is
labelled as such everywhere it appears. The formula is published in the tool output
itself so a consumer can decide whether they agree with it, and anyone wanting a real
assessment should read the underlying payments from the ASC directly.

One consequence worth noting: a single small first payment grades **F** (score 7).
That is intentional — one payment is thin credit, and a grade that flattered it would
be worth less. A score of exactly 0 is reserved for "no verified payments at all",
which is a different statement.

---

## 9. Card terms registry

A card's terms are hashed and registered on Creditcoin at issuance, so verified
payments can be checked against the limits that were in force.

```solidity
function registerCardTerms(
    bytes32 cardId, bytes32 termsHash,
    uint256 periodBudget, uint256 periodSeconds,
    uint256 perTxMax, uint256 expiresAt
) external;
```

The first registrant **claims** the card; only that owner may update or revoke it
afterwards, so one card owner cannot overwrite another's declared terms.

The terms hash covers the card id **and** its full terms —
`keccak256(cardId || stableStringify(terms))` — because a bare terms hash would
collide across cards with identical terms and be useless for saying whose terms were
registered. `stableStringify` sorts keys recursively so logically identical terms hash
identically.

Registration and revocation are **fire-and-forget** at issuance and revoke. The
registry makes verified payments judgeable; it is not a precondition for spending, so
an unreachable Creditcoin must never make cards un-issuable.

### What the on-chain check actually covers

`perTxMax` and `expiresAt` are checked. **Period budgets are deliberately not
enforced on-chain**, because doing it honestly needs the card's period anchor and the
total spend inside that window, and a half-checked budget reported as a pass would be
worse than an explicit per-payment-only check. The contract claims only what it
verifies. The full period budget is enforced where it has the data to be enforced
correctly — in the engine, on the spend path, against the chain's own
`ERC20PeriodTransferEnforcer`.

---

## 10. Agent tools

Four MCP tools, registered **only** when the integration is configured — the tool list
is the capability surface, so a card must never be offered a tool that can only answer
"not configured".

| Tool | Answers |
|---|---|
| `verify_payment` | Where has this payment reached in the pipeline? (or list all) |
| `payment_receipt` | The full three-chain receipt for one payment, plus the trust model |
| `credit_score` | This card's verified history and credit standing on Creditcoin |
| `cross_chain_status` | Is the protocol healthy? Attestation lag and queue depth |

Responses are written for a model that will relay them to a human:

- **ISO 8601 timestamps, never raw epochs.** A bare epoch invites misconversion — the
  existing `card` tool already converts for exactly this reason.
- **Decimal USDC, not atoms.**
- **Explorer links on every leg**, so a claim can be checked rather than trusted.
- **The trust model in the receipt itself.** `payment_receipt` returns the "proven /
  not proven / why anchored" paragraphs from §2 verbatim, so an agent telling its user
  a payment is cryptographically verified can say precisely what that covers.
- **A named stage for anything unverified**, with the note that a recent payment still
  waiting on attestation is normal rather than broken.

---

## 11. REST API

All under `/api`, inheriting that router's auth (admin token or verified Privy
session) and its per-user card scoping.

| Route | Returns |
|---|---|
| `GET /cards/:id/attestcoin-proofs` | Pipeline state joined onto charges, three explorer links per row, card stats |
| `GET /cards/:id/attestcoin-proofs/:chargeId` | One proof in detail, including what the ASC itself holds |
| `POST /cards/:id/attestcoin-verify` | Re-enqueue a charge; resets a `failed` row's attempt budget |
| `GET /cards/:id/credit-score` | Graded credit standing for the card's funding account |
| `GET /attestcoin/health` | Attestation lag, source head, queue depth, contract wiring |
| `GET /attestcoin/stats` | Aggregate queue and verification rate |

Two conventions run through all of them:

- **Reads serve from sqlite, not Creditcoin.** The dashboard must render instantly and
  must still work when the Creditcoin RPC is down.
- **Degraded answers say they are degraded.** A credit figure served from cache
  carries `live: false` and a `synced_at`; a failed health probe returns `null` for the
  numeric fields with the error attached, because "we could not find out" must never
  render as a reassuring zero.

---

## 12. Observability

SigNoz, via OpenTelemetry. The pipeline is slow and multi-hop, so "it didn't verify"
is useless on its own — the question is always *which hop stalled*. Each stage gets
its own span and its own histogram.

### Spans

| Span | Covers |
|---|---|
| `attestcoin.anchor` | Writing the anchor to the source chain |
| `attestcoin.proof_generation` | Prover API round trip |
| `attestcoin.proof_submission` | Simulate + send + confirm on Creditcoin |
| `attestcoin.register_terms` | Card terms registration |
| `attestcoin_sweep` | One worker tick (examined / advanced / verified / failed / waiting) |

### Metrics

| Metric | Type |
|---|---|
| `attestpay.attestcoin.anchors_written_total` | Counter |
| `attestpay.attestcoin.proofs_generated_total` | Counter |
| `attestpay.attestcoin.proofs_verified_total` | Counter |
| `attestpay.attestcoin.verification_failures_total` | Counter (tagged by `stage`) |
| `attestpay.attestcoin.attestation_wait_seconds` | Histogram |
| `attestpay.attestcoin.proof_generation_seconds` | Histogram |
| `attestpay.attestcoin.proof_submission_seconds` | Histogram |
| `attestpay.attestcoin.end_to_end_seconds` | Histogram — payment → verified |
| `attestpay.attestcoin.attestation_lag_blocks` | Histogram — how far behind attestors run |

### Structured logs

`attestcoin_event` is the filter key: `anchor_written`, `attestation_confirmed`,
`verification_result`, `stage_failed`.

---

## 13. Deployment

### 1. Prerequisites

- Sepolia ETH for the anchorer ([sepoliafaucet.com](https://sepoliafaucet.com))
- tCTC for Creditcoin gas (Creditcoin Discord faucet)
- Foundry

### 2. Deploy `PaymentAnchor` on Ethereum Sepolia

```bash
cd contracts
forge install                       # or: git submodule update --init --recursive
export PRIVATE_KEY=0x...
export ATTESTPAY_SEPOLIA_RPC=https://ethereum-sepolia-rpc.publicnode.com

forge script script/Deploy.s.sol:DeployAnchor \
  --rpc-url "$ATTESTPAY_SEPOLIA_RPC" --broadcast
# → PaymentAnchor deployed to: 0x...
```

### 3. Deploy `AttestPayASC` on Creditcoin CC3 testnet

```bash
export ATTESTPAY_PAYMENT_ANCHOR_ADDRESS=0x...    # from step 2
export ATTESTPAY_CREDITCOIN_HTTP_RPC=https://rpc.cc3-testnet.creditcoin.network
# ATTESTPAY_ANCHORER_ADDRESS defaults to the deployer — set it if the server
# anchors from a different key. The ASC credits ONLY this address.

forge script script/Deploy.s.sol:DeployASC \
  --rpc-url "$ATTESTPAY_CREDITCOIN_HTTP_RPC" --broadcast
# → AttestPayASC deployed to: 0x...
```

### 4. Configure the server

```bash
ATTESTPAY_PAYMENT_ANCHOR_ADDRESS=0x...
ATTESTPAY_ASC_ADDRESS=0x...
ATTESTPAY_ATTESTCOIN_PRIVATE_KEY=0x...     # must match trustedAnchorer
ATTESTPAY_ATTESTCOIN_CHAIN_KEY=1
```

All three required values must be present or the integration stays off — and the
server logs exactly which are missing at boot rather than no-oping silently.

### 5. Confirm the wiring

On startup the server reads the deployed ASC and checks it agrees with its own
configuration — same chain key, same anchor, same anchorer:

```
[attestcoin] enabled · chainKey=1 anchor=0x… asc=0x…
[attestcoin] deployment check OK · anchorer=0x…
[attestcoin] proof worker every 60000ms
```

A mismatch rejects every proof, so it is reported loudly, once, at boot rather than
discovered one stuck payment at a time:

```
[attestcoin] DEPLOYMENT MISMATCH: ASC trustedAnchorer is 0xAAA but this process
anchors from 0xBBB; proofs will be rejected with UntrustedAnchorer
```

---

## 14. Verifying the protocol facts yourself

Every protocol claim in this document is checkable.

```bash
CC=https://rpc.cc3-testnet.creditcoin.network

# Creditcoin CC3 testnet chain id → 0x18e8f = 102031
cast chain-id --rpc-url $CC

# which source chains are attested (§3)
cast call 0x0000000000000000000000000000000000000fd3 "get_supported_chains()" --rpc-url $CC \
| xargs cast decode-abi "get_supported_chains()((uint64,uint64,bytes,uint8)[])"

# latest attested Sepolia height, from the precompile
cast call 0x0000000000000000000000000000000000000fd3 \
  "get_latest_attestation_height_and_hash(uint64)" 1 --rpc-url $CC \
| xargs cast decode-abi "f()((uint64,bytes32,bool,bool))"

# ...and from the prover API, which should agree
curl -s https://prover.cc3-testnet.creditcoin.network/api/v1/attested-height/1

# a real proof for a real Sepolia transaction
curl -s https://prover.cc3-testnet.creditcoin.network/api/v1/proof-by-tx/1/<txHash> | jq 'keys'
# → ["cached","chainKey","continuityProof","generatedAt","headerNumber",
#    "merkleProof","txBytes","txHash","txIndex"]
```

### The live probe

One command checks the whole integration against the real network, read-only, spending
no gas and needing no funded key:

```bash
bun run packages/engine/scripts/attestcoin-probe.ts
```

It verifies, in dependency order: the Creditcoin RPC is really chain 102031; the
ChainInfo precompile answers and the configured `chainKey` is attested; attestation is
*live* (lag bounded, not merely present); the prover API agrees with the precompile;
a real proof can be generated for a real attested transaction; the proof has the exact
structure `AttestPayASC` expects; and — once `ATTESTPAY_ASC_ADDRESS` is set — that the
deployed ASC's wiring matches the local configuration.

Sample output is in the README. Run it before spending tCTC on a deploy, and again
whenever something stops verifying.

### Tests

```bash
cd contracts && forge test            # 42 tests: proofs, impostors, replay, terms
bun test packages/engine/test/attestcoin.test.ts    # 44: state machine, grading, config
bun test packages/server/test/attestcoin.test.ts    # 21: routes + tools, on AND off
```

The server suite runs the whole surface in **both** configurations. The disabled case
is the one that protects existing deployments: it asserts that a server which never
configures Attestcoin is unchanged, that every route still answers with
`configured: false`, and that the four tools are absent.

`contracts/test/ProvenTxDecoder.t.sol` deserves a note. `ProvenTxDecoder` reads an
encoding defined by someone else's SDK, so a test feeding it blobs built by this repo's
own encoder would prove only self-consistency — it would pass just as happily if the
encoding had been misread. Those tests therefore decode the **exact `txBytes` the live
prover API returned** for real Sepolia transactions (captured in
`RealProofFixtures.sol`, with the originating tx hash and block recorded), for both a
type-2 and a type-0 transaction. One test also asserts that the synthetic encoder used
by the other suites produces the same envelope shape as the real prover, so the rest of
the suite cannot drift onto a format that does not exist.

---

## 15. Known limitations

Stated rather than buried.

1. **The Base → Sepolia hop is the server's attestation, not Attestcoin's.** See §2.
   This is inherent to Base not being an attested source chain, and is mitigated —
   not removed — by recording `sourceTxHash` and pinning `anchoredBy`.

2. **Verification latency is ~8–10 minutes**, set by the attestor network, not by
   AttestPay. Receipts are honest about this; `pay` never waits for it.

3. **Period budgets are not checked on-chain.** Only `perTxMax` and `expiresAt` are.
   See §9 for why a half-check would be worse than none.

4. **Credit scores are a published formula over public facts, not a risk model.** §8.

5. **One anchorer key signs both legs.** It needs Sepolia ETH and tCTC. Splitting the
   roles would be better operational hygiene; it is one key today for simplicity.

6. **The anchor log scan looks back 50,000 blocks.** Enough for crash recovery by a
   wide margin, and bounded to stay inside public-RPC log-range limits. An anchor
   older than that would not be re-found, and the row fails with a clear,
   non-retryable message rather than looping.

7. **Testnet only.** Attestcoin mainnet attests Ethereum mainnet (`chainKey = 3`);
   the code takes the chain key from configuration, but no mainnet deployment exists.

## Deployed addresses (CC3 testnet, 2026-09-12)

| Chain | Contract | Address |
|---|---|---|
| Ethereum Sepolia (11155111) | `PaymentAnchor` | [`0x881c55745372DfCB7dEC9B13F499b167164e2121`](https://sepolia.etherscan.io/address/0x881c55745372DfCB7dEC9B13F499b167164e2121) |
| Creditcoin CC3 (102031) | `AttestPayASC` | [`0x881c55745372DfCB7dEC9B13F499b167164e2121`](https://creditcoin-testnet.blockscout.com/address/0x881c55745372DfCB7dEC9B13F499b167164e2121) |

Same address on both chains: one deployer at nonce 0 on each chain, not a mistake.

`AttestPayASC` immutables, read back from the live chain:

```
sourceChainKey  1                                           # Ethereum Sepolia
paymentAnchor   0x881c55745372DfCB7dEC9B13F499b167164e2121
trustedAnchorer 0x66b6082Eb6c7a9457F25479fa35b6061F2c4EC5a
blockProver     0x0000000000000000000000000000000000000FD2   # canonical precompile
```

### Deploying the ASC: forge script does not work on CC3

`forge script` fails against the Creditcoin RPC with:

```
EVM error; header validation error: `prevrandao` not set
```

The node does not report `mixHash`/`prevrandao` on its block headers, so forge's local
simulation refuses the block before any broadcast happens. The deployment itself is
fine — skip the simulation and send the create directly:

```bash
BIN=$(jq -r '.bytecode.object' out/AttestPayASC.sol/AttestPayASC.json)
ARGS=$(cast abi-encode "c(uint64,address,address,address)" \
  1 "$ATTESTPAY_PAYMENT_ANCHOR_ADDRESS" "$ANCHORER" 0x0000000000000000000000000000000000000000)
cast send --private-key "$PRIVATE_KEY" --rpc-url "$ATTESTPAY_CREDITCOIN_HTTP_RPC" \
  --create "${BIN}${ARGS#0x}"
```

`DeployAnchor` on Sepolia works normally through `forge script`.

## Live end-to-end run (2026-09-12)

The full pipeline, executed against the deployed contracts on the real networks. Every
hash below resolves on a public explorer.

| Step | Result |
|---|---|
| Source transaction (Sepolia) | [`0x2f1b0122…4ccb0`](https://sepolia.etherscan.io/tx/0x2f1b0122e4fd989ea30f931493db7385bcd5cf1d4a68c165abd3bf4b4494ccb0) |
| Anchor written (Sepolia) | [`0xb0cc21b3…05454`](https://sepolia.etherscan.io/tx/0xb0cc21b30cfa7cfc42d1d107f21719431ae8748a2744673de653ee2d9d705454) @ height 11,688,737 |
| Attestation wait | **464 s (7.7 min)** — measured, from anchor to the attestors covering that height |
| Proof | txIndex 71 · 2,240 B txBytes · 7 Merkle siblings · 4 continuity roots |
| Verified (Creditcoin) | [`0x0aa8570e…79432`](https://creditcoin-testnet.blockscout.com/tx/0x0aa8570e967644991aaebfb97fad1866214e589620cf44c522817d9817e79432) · recorded 1 payment |

`AgentCredit` read back off Creditcoin afterwards:

```json
{ "totalPayments": 1, "totalVolume": 2000000,
  "firstPaymentAt": 1789213962, "lastPaymentAt": 1789213962,
  "withinTermsPayments": 0, "termsCheckedPayments": 0 }
```

`termsCheckedPayments: 0` is the designed behaviour, not a gap: no terms were registered
for this card, so the payment is neither credited nor penalised on compliance. The card
does not receive a free 100%.

### Replay protection, checked on the live contract

The same proof was regenerated and resubmitted under a different charge id:

```
tx 0xb121088c779807edaba08c1785f06383dbb1aeee21ce2ecc6f033a00bcdde2bd
recorded 0 payment(s)
AgentCredit.totalPayments after replay: 1
```

The event key `keccak256(chainKey, height, txIndex, logIndex)` was already proven, so the
second submission recorded nothing and minted no credit. The transaction still succeeds —
it is a no-op, not a revert, so a worker retrying after an ambiguous receipt converges
rather than failing.

### A note on this particular run

The anchored amount is synthetic and the memo says so on-chain
(`E2E PIPELINE TEST - synthetic amount, not a real payment`). The anchoring key holds no
funds on Base, so rather than anchor a claim about someone else's Base transaction —
which would put a false statement on a public chain, in a project whose case rests on
honest records — the source transaction is a real transaction of the anchorer's own on
Sepolia. Every leg of the proof pipeline is exercised for real; only the amount is
notional, and it is labelled as such in the record itself.

## 16. Credit lines, disputes, guarantees and the passport

Everything above proves one kind of fact: a payment. This section covers the second
generation of contracts, which prove the facts a payment history is incomplete
without, and which turn the history into something an agent can borrow against. The
proving discipline is identical and is deliberately not restated: `ProvenFacts` is the
`verifyPayment` core factored out (precompile verify, precompile-derived `txIndex`
replay key, facts decoded only from proven bytes, trusted-anchorer gate), and every
consumer below inherits it.

### The contracts

| Contract | Chain | What it proves / does |
|---|---|---|
| `FactAnchor` | Ethereum Sepolia | Anchors `CreditDrawn`, `CreditRepaid`, `DisputeOpened`, `DisputeResolved`, `CardRevoked`; one replay guard per kind |
| `ProvenFacts` | abstract | The shared consumer core; `_understands(topic0)` + `_consumeLog(log)` per subclass |
| `AttestPayCreditLine` | Creditcoin CC3 | EIP-712 dual-signed lines; `Open → Active → Repaid` / `Defaulted` / `Closed` from proven draws and repayments; `BorrowerRecord` per account |
| `AttestPayLedger` | Creditcoin CC3 | Disputes (`Open → Upheld / Rejected / Withdrawn`) and `cardRevokedAt`; `wasRevokedAt(cardId, at)` |
| `AttestPayGuarantee` | Creditcoin CC3 | Native CTC bonds behind a borrower; `slash(lineId)` on a `Defaulted` line, 1 CTC per 1 USDC outstanding, 7-day unbond delay |
| `CreditPassport` | Creditcoin CC3 | `passportOf(account)`: the four records composed, score and grade computed on-chain; `formula()` states the arithmetic |

### What changed from the protocol's `ASCLoanManager` example

The loan flow in `attestcoin-protocol-examples` is the blueprint, with two changes that
matter once the contract is a product rather than a tutorial:

1. **Domain-bound signatures.** The example hashes the terms with `abi.encodePacked`
   and no domain, contract address or nonce, so one signature is valid on every
   deployment of the manager and can be re-registered at will. `AttestPayCreditLine`
   signs under an EIP-712 domain (chain id + contract address) with a per-lender nonce;
   `test_signatureIsBoundToDeployment` pins it.
2. **Permissionless registration.** The example's `registerLoan` is `onlyOwner`. Both
   parties' signatures are required anyway, so the submitter does not matter; removing
   the owner removes a key whose compromise could make lines appear.

Draws and repayments are ordinary Base USDC transfers through `spend()`: a draw pays from
the lender's designated funding card to the borrower's funding account (so the lender's
own card terms are the Base-side ceiling), a repayment pays the lender from the agent's
card. The charge is booked against the line, and on confirmation the fact is queued for
the same anchor → attest → prove → submit worker that handles payments (`sweepFacts`).

### The trust model, unchanged

The proof establishes that `FactAnchor` recorded a draw / repayment / dispute /
revocation with exactly these values in an attested block. It does not establish that
the underlying Base transfer happened: the anchorer asserts it, `sourceTxHash` lets
anyone check it, and the consumers credit only the `trustedAnchorer` they were deployed
with. Same hop, same honesty, same reason.

### Chain key discovery

`AttestcoinClient.resolveChainKey()` reads `get_supported_chains()` from the ChainInfo
precompile at boot. With `ATTESTPAY_ATTESTCOIN_CHAIN_KEY=auto` the key whose chain id
matches the source RPC is adopted and an unattested source chain disables the worker
loudly; with a numeric key, disagreements are logged as warnings. Health reports
`supportedChains` and `paymentChainAttested` — the honest answer to "is Base attested
yet?", straight from the registry.

### Deployed addresses (CC3 testnet, 2026-09-12)

| Chain | Contract | Address |
|---|---|---|
| Ethereum Sepolia (11155111) | `FactAnchor` | [`0xE984375956027C4989C6A806eBb2A1223607aefe`](https://sepolia.etherscan.io/address/0xE984375956027C4989C6A806eBb2A1223607aefe) |
| Creditcoin CC3 (102031) | `AttestPayCreditLine` | [`0xe984375956027c4989c6a806ebb2a1223607aefe`](https://creditcoin-testnet.blockscout.com/address/0xe984375956027c4989c6a806ebb2a1223607aefe) |
| Creditcoin CC3 (102031) | `AttestPayLedger` | [`0x56733223c688cce7fc65826b692b3f8521e4ab3e`](https://creditcoin-testnet.blockscout.com/address/0x56733223c688cce7fc65826b692b3f8521e4ab3e) |
| Creditcoin CC3 (102031) | `AttestPayGuarantee` | [`0x3543bfcb460ab40acd3ba21c486eea285ce07f1b`](https://creditcoin-testnet.blockscout.com/address/0x3543bfcb460ab40acd3ba21c486eea285ce07f1b) |
| Creditcoin CC3 (102031) | `CreditPassport` | [`0xfd1dc807ad1714c4c80a6c2145be200f61265b57`](https://creditcoin-testnet.blockscout.com/address/0xfd1dc807ad1714c4c80a6c2145be200f61265b57) |

`FactAnchor` on Sepolia and `AttestPayCreditLine` on CC3 share an address for the same
reason `PaymentAnchor` and `AttestPayASC` do: one deployer, the same nonce on each chain.

Immutables read back from the live chain:

```
AttestPayCreditLine.trustedAnchorer  0x66b6082Eb6c7a9457F25479fa35b6061F2c4EC5a
AttestPayCreditLine.factAnchor       0xE984375956027C4989C6A806eBb2A1223607aefe
AttestPayCreditLine.sourceChainKey   1
AttestPayCreditLine.blockProver      0x0000000000000000000000000000000000000FD2
AttestPayLedger.trustedAnchorer      0x66b6082Eb6c7a9457F25479fa35b6061F2c4EC5a
AttestPayGuarantee.creditLine        0xE984375956027C4989C6A806eBb2A1223607aefe
CreditPassport.asc                   0x881c55745372DfCB7dEC9B13F499b167164e2121
CreditPassport.scoreOf(anchorer)     10, "F"   # the anchorer's own verified payments from §"Live end-to-end run"
```

### Deploying

`DeployFactAnchor` works through `forge script` on Sepolia. `DeployCredit` is the
reference for the constructor wiring but, like `DeployASC`, cannot run against the CC3
RPC (`prevrandao` not set — `--skip-simulation` does not help, the failure is in the
script's local EVM). The four CC3 deployments are `cast send --create`, in this order,
each feeding the next:

```bash
deploy() { local name=$1 sig=$2; shift 2
  local bin=$(jq -r '.bytecode.object' out/$name.sol/$name.json)
  local args=$(cast abi-encode "$sig" "$@")
  cast send --private-key "$PRIVATE_KEY" --rpc-url "$CC3" --json --create "${bin}${args#0x}" | jq -r .contractAddress; }
CL=$(deploy AttestPayCreditLine "c(uint64,address,address,address)" 1 $FACT_ANCHOR $ANCHORER 0x0000000000000000000000000000000000000000)
LG=$(deploy AttestPayLedger     "c(uint64,address,address,address)" 1 $FACT_ANCHOR $ANCHORER 0x0000000000000000000000000000000000000000)
GU=$(deploy AttestPayGuarantee  "c(address)" $CL)
PP=$(deploy CreditPassport      "c(address,address,address,address)" $ASC $CL $LG $GU)
```

Then set `ATTESTPAY_FACT_ANCHOR_ADDRESS`, `ATTESTPAY_CREDIT_LINE_ADDRESS`,
`ATTESTPAY_LEDGER_ADDRESS`, `ATTESTPAY_GUARANTEE_ADDRESS`, `ATTESTPAY_PASSPORT_ADDRESS`.
`checkDeployment()` at boot verifies the consumers' `factAnchor`, `trustedAnchorer` and
`sourceChainKey` against the process configuration, the same way it does for the ASC.

