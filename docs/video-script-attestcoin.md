# Demo Video Script — BUIDL CTC 2026 Fall (Attestcoin)

**Written for:** the BUIDL CTC judging panel. 3 minutes.

This is a different video from [`video-script.md`](video-script.md), which is the
SigNoz-hackathon cut. That one's subject is observability; this one's subject is
cross-chain verification, and the two should not be merged — a judge watching for
Attestcoin depth should not spend 90 seconds on a Stripe catalog.

**The spine:** an agent pays → the payment is proven onto Creditcoin without an oracle →
the agent can now read its own credit history → here is precisely what that proves.

**Do not skip Scene 6.** Stating the limit of the guarantee is the strongest thing in
the submission. A panel that has watched twenty teams overclaim will notice.

---

## Pre-flight

| Check | Command |
|---|---|
| Protocol live, contracts wired | `bun run packages/engine/scripts/attestcoin-probe.ts` — must exit 0 |
| Anchorer funded | Sepolia ETH + tCTC on the anchorer address |
| A payment already verified | One card with a `verified` proof, so Scene 4 has real data and doesn't wait 8 minutes on camera |
| Tabs open | Dashboard · Claude (card connected) · Creditcoin Blockscout · Sepolia Etherscan · Basescan · SigNoz |

Record Scene 3's payment live, but have the **pre-verified** payment from an earlier run
ready for Scenes 4–6. Attestation takes ~8 minutes; do not try to fill that on camera.

---

## SCENE 1 — The gap (0:00–0:25)

**🎥** Dashboard, one card, a few charges in the Activity pane.

**🎙️**
"This is an AI agent's spending card. Scoped, revocable, and it already works — the
agent pays USDC on Base within limits its owner set.

Here's what it couldn't do. Ask 'has this agent paid reliably?' and the only answer was
'trust our database'. The agent's track record was locked inside our server. It couldn't
carry it anywhere, and nobody else could check it."

**🎥** Overlay: **"A card that spends. A history nobody can verify."**

---

## SCENE 2 — What we built (0:25–0:45)

**🎥** The architecture diagram from the README's Cross-Chain section.

**🎙️**
"So every confirmed payment is now proven onto Creditcoin using the Attestcoin Protocol.

The payment happens on Base. Its facts are anchored on a chain the Attestcoin attestors
watch. Then a Creditcoin contract verifies a Merkle inclusion proof and a block
continuity proof — on-chain, in the same transaction that records the result, through
the Block Prover precompile.

No oracle signature is trusted. No bridge holds anything. The proof is checked by the
chain itself."

---

## SCENE 3 — The agent pays (0:45–1:15)

**🎥** Claude. Type: *"Check the card, then pay 2 USDC to 0x… for the API credits."*

**🎙️**
"The agent checks its budget, then pays. Two USDC on Base."

**🎥** The `pay` result returns — seconds. Then the dashboard's Activity pane shows the
charge as confirmed.

**🎙️**
"Confirmed in seconds. Note what did *not* happen: the agent didn't wait for the
cross-chain proof. Attestation takes about eight minutes, so the payment returns
immediately and the verification runs behind it."

**🎥** Switch to the **Cross-Chain** tab. The new payment sits at *Awaiting Attestation*.

**🎙️**
"And the pane says so honestly — 'Awaiting Attestation', not an error. It's waiting on
the attestor network, which is normal."

---

## SCENE 4 — Proven on Creditcoin (1:15–1:50)

**🎥** Same pane, scroll to the **pre-verified** payment. Three links on its row.

**🎙️**
"Here's one that finished. Three links, because there are three things to check.

The payment on Base."
**🎥** Click → Basescan, the USDC transfer.

**🎙️** "The anchor on Ethereum Sepolia."
**🎥** Click → Etherscan, the `PaymentAnchored` event with the Base tx hash inside it.

**🎙️** "And the proof verified on Creditcoin."
**🎥** Click → Creditcoin Blockscout, the `verifyPayment` transaction and its
`PaymentVerified` event.

**🎙️**
"That's the whole chain of custody, and every link is public. Nothing here asks you to
take our word for it."

---

## SCENE 5 — The agent reads its own credit (1:50–2:15)

**🎥** Claude. Type: *"What's my credit standing?"*

**🎙️**
"Now the part that matters. The agent can read its own history — from Creditcoin, not
from us."

**🎥** `credit_score` output: grade, verified payment count, volume, history length, and
the `grading_formula` line.

**🎙️**
"Verified payments, volume, how long the history runs. It returns the grading formula
too, so the number isn't a black box — it's a summary of public facts, and it says so.

And look at compliance: this counts payments within *registered* terms against payments
we could actually check. A card with no registered terms doesn't get a free hundred
percent."

**🎥** Credit Standing card in the dashboard, same figures.

**🎙️**
"Any contract on Creditcoin can read this record. That's an agent's reputation becoming
portable."

---

## SCENE 6 — What this proves, and what it doesn't (2:15–2:40)

**🎥** Claude. Type: *"Show me the receipt for that payment."* Scroll to `trust_model`.

**🎙️**
"One thing we want to be precise about, because it's easy to overclaim.

What's proven, trustlessly: that this anchor record, with exactly these values, was in
an attested block. The contract decodes the fields out of the proven transaction bytes,
so nobody — including us — can alter a value in flight.

What's *not* proven: that the Base payment happened. Our server writes the anchor. So
every anchor records the Base transaction hash and the address that made the claim.
Anyone can go check, and a lie would be publicly detectable."

**🎥** Highlight `trust_model.not_proven` in the tool output.

**🎙️**
"The receipt says this itself, so an agent relaying it to a human can't accidentally
overstate it. Base isn't an attested source chain yet — when it is, this gap closes and
the contract barely changes."

---

## SCENE 7 — Observability + close (2:40–3:00)

**🎥** SigNoz. The `attestcoin.*` spans; then the `attestation_wait_seconds` histogram.

**🎙️**
"The whole pipeline is instrumented — anchor, attestation wait, proof generation,
submission — so when something stalls, we know which hop."

**🎥** Split: dashboard Cross-Chain pane · Claude · Creditcoin Blockscout.

**🎙️**
"AttestPay. An AI agent gets a card its owner controls — and every payment it makes
becomes credit history anyone can verify, on the chain built for credit.

No oracle. No bridge. Just proofs."

**🎥** `github.com/LSUDOKO/AttestPay`

---

## Shot list

| Time | Screen | Beat |
|---|---|---|
| 0:00–0:25 | Dashboard, Activity | The gap: a card with unverifiable history |
| 0:25–0:45 | Architecture diagram | Base → anchor → Creditcoin, proven on-chain |
| 0:45–1:15 | Claude `pay` → Cross-Chain tab | Pays in seconds; proof runs behind it |
| 1:15–1:50 | Three explorers | Full public chain of custody |
| 1:50–2:15 | Claude `credit_score` + dashboard | Portable agent reputation |
| 2:15–2:40 | Claude `payment_receipt` | **What it proves, and what it doesn't** |
| 2:40–3:00 | SigNoz → split screen | Observability + close |

---

## Things to say exactly

- "Verified **on-chain**, in the same transaction that records the result" — not
  "verified by attestors".
- "`verifyPayment` takes the proof and **nothing else**" — if there's a moment for the
  design decision, this is the sentence.
- "A card with no registered terms doesn't get a free hundred percent."

## Things not to say

- ~~"Every payment is cryptographically proven."~~ The *anchor* is. Scene 6 exists for
  this reason.
- ~~"Proven from Base."~~ Base is not an attested source chain.
- ~~"Credit score"~~ as though it were a risk model. It's a published formula over
  public facts.
