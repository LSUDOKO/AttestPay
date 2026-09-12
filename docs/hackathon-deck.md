---
marp: true
theme: default
paginate: true
size: 16:9
style: |
  section { font-size: 21px; padding: 44px 60px; justify-content: flex-start; }
  h2 { font-size: 30px; margin: 0 0 .5em; }
  h3 { font-size: 24px; }
  pre { font-size: 0.82em; line-height: 1.35; }
  code { font-size: 0.92em; }
  table { font-size: 0.95em; }
  li { margin-bottom: .35em; }
  p { margin: .55em 0; }
---

<!--
Deck source. Ten slides. Render to PDF:

    npx @marp-team/marp-cli@latest docs/hackathon-deck.md -o docs/hackathon-deck.pdf --pdf-notes

Speaker notes are HTML comments, so they stay off the slide and ride along as PDF
notes annotations with --pdf-notes.
-->

## 1 — AttestPay

### Agentic spending cards, with provable history

Scoped, revocable payment delegations any AI agent can plug in and pay with — now with
every payment proven cross-chain onto Creditcoin.

`github.com/LSUDOKO/AttestPay`

**Track:** AI (primary) · DeFi (secondary)

<!--
Notes: One sentence to open. "We give AI agents a spending card the owner controls, and
we make every payment that card makes into public, checkable credit history on
Creditcoin." Don't explain the mechanism yet.
-->

---

## 2 — The problem

An AI agent that needs to pay has two bad options:

- **Give it a key.** It can now spend everything, forever.
- **Put a human in the loop.** It is no longer an agent.

AttestPay already solved that part: a card is a scoped, revocable delegation.

**But a card builds no reputation.** Ask "has this agent paid reliably?" and the only
answer is "trust our database". An agent cannot carry its track record anywhere, and
nobody else can verify it.

<!--
Notes: Land the second half. The payment problem is solved; the *credibility* problem is
not, and credibility is what Creditcoin exists for.
-->

---

## 3 — The solution

Every confirmed payment is **proven onto Creditcoin** — no oracle, no bridge.

```
agent pays USDC on Base
        ↓
anchored on an attested chain
        ↓
Attestcoin attestors reach consensus
        ↓
proof verified ON-CHAIN by the Block Prover precompile (0x0FD2)
        ↓
AgentCredit on Creditcoin — readable by any dApp, trusting nobody
```

An agent's payment history becomes portable, public, and checkable.

<!--
Notes: Emphasise "verified on-chain, in the same transaction that records the result".
No attestor signature is trusted; no bridge custodies anything.
-->

---

## 4 — How it works

| Chain | Contract | Role |
|---|---|---|
| Base | (existing) ERC-7710 delegation | The money actually moves |
| Ethereum Sepolia | `PaymentAnchor` | Records the payment's facts on an **attested** chain |
| Creditcoin CC3 | `AttestPayASC` | Proves the anchor, decodes it, keeps the credit record |

`spend()` enqueues via one `onChargeConfirmed` hook, so every payment path feeds the
pipeline. A background worker drives persisted state:

`pending → anchoring → anchored → attested → proving → verified`

**`pay` never waits.** Attestation takes ~8 minutes; an agent's payment returns in
seconds.

<!--
Notes: If asked why a worker and not inline: the 8 minutes is measured, not guessed —
show the probe on slide 9.
-->

---

## 5 — Why the anchor is on Sepolia, not Base

We checked what the protocol actually attests:

```bash
cast call 0x…0fd3 "get_supported_chains()" --rpc-url <creditcoin>
→ chainKey 3 → Ethereum mainnet
  chainKey 1 → Ethereum Sepolia
```

**Base is not attested** — a Base transaction cannot be proven into Creditcoin at all.
So `PaymentAnchor` lives on Sepolia and records the Base payment's facts; *that*
transaction is what gets proven.

**Proven, trustlessly:** this anchor record, with exactly these values, was in an
attested block.
**Not proven:** that the Base payment happened — our server writes the anchor. Every
anchor records the Base tx hash and the anchorer's address, so the claim is
attributable and independently checkable.

<!--
Notes: Say this part out loud rather than skipping it. Judges notice a team that knows
the boundary of its own guarantee — and it is the slide most likely to earn a question.
-->

---

## 6 — The decision that matters

The obvious signature is unsound:

```solidity
// UNSOUND
verifyPayment(proof, cardId, amount, from, memo)   // ← facts unchecked
```

The proof and the facts are **independent**. One valid proof of *any* attested
transaction would let a caller staple on arbitrary payment data and mint unlimited
"verified" credit history.

```solidity
// What we built
verifyPayment(height, txBytes, merkleProof, continuityProof)
```

The proof **and nothing else.** Every field is decoded out of the proven transaction
bytes, so the facts *are* the proof.

<!--
Notes: This is the technical centrepiece. Three tests pin it: impostor anchor, untrusted
anchorer, reverted source transaction.
-->

---

## 7 — Agent credit history

```solidity
struct AgentCredit {
    uint256 totalPayments;        uint256 totalVolume;
    uint256 firstPaymentAt;       uint256 lastPaymentAt;
    uint256 withinTermsPayments;  uint256 termsCheckedPayments;
}
```

Two honesty decisions, because a credit score invites more trust than the data supports:

- **`termsCheckedPayments` is the denominator, not `totalPayments`** — a card with no
  registered terms does **not** score a free 100% compliance rate.
- **The grade is a published formula**, printed in the tool output: count (≤40) +
  volume (≤30) + history days (≤30), scaled by the within-terms rate. A summary of
  public facts, not a risk model — and labelled as such.

Readable by any Creditcoin contract: `getAgentCredit(payer)`.

<!--
Notes: A single small first payment grades F. That is deliberate — a grade that
flattered thin history would be worth less.
-->

---

## 8 — What the agent sees

Four MCP tools, offered only when the integration is configured:

| Tool | Answers |
|---|---|
| `verify_payment` | Where is this payment in the pipeline? |
| `payment_receipt` | Three-chain receipt + what the proof establishes |
| `credit_score` | This card's verified history and standing |
| `cross_chain_status` | Attestation lag and queue health |

Responses are written for a model that will relay them: ISO timestamps, decimal USDC,
an explorer link per leg, and the trust model **verbatim** — so an agent telling a human
"cryptographically verified" can say exactly what that covers.

<!--
Notes: Demo `payment_receipt` live if time allows. The trust-model paragraph in the
response is the thing to point at.
-->

---

## 9 — Verified, not asserted

```
$ bun run packages/engine/scripts/attestcoin-probe.ts

✓ chain 102031 (Creditcoin CC3 Testnet)
✓ 2 attested source chains · Base is NOT attested → anchoring required
✓ attested 11,688,220 vs source head 11,688,259 → lag 39 blocks (~8 min)
✓ prover agrees with the precompile (drift 0)
✓ proof generated: 2688 txBytes · 7 Merkle siblings · 1 continuity root
```

| | |
|---|---|
| Solidity | **42 tests** — including the decoder run against **real prover output**, not our own fixtures |
| TypeScript | **408 tests** — the Attestcoin surface tested with the integration both **on and off** |
| Docs | Every protocol claim paired with the command that checks it |

<!--
Notes: The real-fixtures point is worth 15 seconds: we decode an encoding defined by
someone else's SDK, so testing against our own encoder would prove only
self-consistency.
-->

---

## 10 — Team & roadmap

**Built this hackathon:** the anchor + ASC contracts, the proof pipeline, the credit and
terms registries, 4 MCP tools, 6 REST endpoints, the dashboard's Cross-Chain pane, and
SigNoz instrumentation of the whole proof lifecycle.

**Next:**

1. **Base as an attested source chain** closes the one trust gap — the design already
   decodes from proven receipt logs, so it becomes a change of source chain, not a
   redesign.
2. **Period-budget verification on-chain**, once the ASC can see the period anchor.
3. **Credit-gated spending:** a card whose limits rise with its verified history — the
   first real use of agent credit, and what Creditcoin is for.

`github.com/LSUDOKO/AttestPay` · [docs/attestcoin-integration.md](attestcoin-integration.md)

<!--
Notes: Close on (3). It reframes the work: this is not reporting on payments, it is the
groundwork for agents that earn financial trust.
-->