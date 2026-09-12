# AttestPay × Attestcoin Protocol — BUIDL CTC 2026 Fall Adaptation Guide

> ## ⚠️ Status: IMPLEMENTED — with three corrections
>
> This was the **plan**. It has been built, and three things in it turned out to be
> wrong when checked against the live protocol. They are corrected in the code and in
> [`docs/attestcoin-integration.md`](docs/attestcoin-integration.md), which is the
> accurate reference. This document is kept for provenance; **do not implement from it
> directly.**
>
> **1. Base cannot be a source chain.** §4 and §5 place `PaymentLogger` on Base Sepolia
> with `chainKey = 1`. The Attestcoin protocol on CC3 testnet attests exactly two source
> chains — `chainKey 3` (Ethereum mainnet) and `chainKey 1` (Ethereum Sepolia) — as
> `get_supported_chains()` on the ChainInfo precompile reports. Base is not among them,
> so a Base transaction cannot be proven into Creditcoin at all. The anchor contract
> (`PaymentAnchor`, renamed from `PaymentLogger`) is deployed on **Ethereum Sepolia**.
> §1 of this document already anticipated this as a fallback; it is the only option.
>
> **2. The Block Prover interface in §5 is not the real one.** The actual precompile is
> `verify(uint64 chainKey, uint64 height, bytes encodedTransaction, (bytes32,(bytes32,bool)[]) merkleProof, (bytes32,bytes32[]) continuityProof) returns (bool)`.
> It returns a bare `bool` and **reverts** on a bad proof; it does **not** return
> `(bool verified, bytes txData)`. The ChainInfo precompile at `0x…0fD3` also uses
> snake_case names — the camelCase spellings revert with `Unknown selector`.
>
> **3. The `verifyPayment` signature in §5 is unsound and was not implemented.** It
> accepts `cardId`, `from`, `to`, `amount`, `memo` and `sourceTimestamp` as parameters
> **alongside** the proof, and never checks them against it. Since the proof and the
> facts are independent, a valid proof of *any* attested transaction would let a caller
> staple arbitrary payment data to it and mint unlimited "verified" credit history from
> one real proof. `AttestPayASC.verifyPayment` therefore takes **the proof and nothing
> else**, and decodes every recorded field out of the proven transaction bytes.
>
> Also worth stating plainly, because this document does not: the proof establishes that
> the *anchor record* was included in an attested block, **not** that the Base payment
> happened — the server writes the anchor. See
> [the trust model](docs/attestcoin-integration.md#2-the-trust-model-stated-plainly).
>
> Everything else was built: the proof pipeline, the four MCP tools, the credit registry,
> the card terms registry, the REST endpoints, the dashboard pane, and the SigNoz
> instrumentation. Naming throughout is `AttestPay*`, not `GlassPay*`.

---

## Complete Blueprint for Your AI Agent to Execute

---

## 1. Executive Summary

**Project Name:** AttestPay — Cross-Chain Agentic Spending Cards  
**Track:** AI (primary) + DeFi (secondary)  
**Tagline:** Scoped, revocable spending cards for AI agents — now with cryptographically verified cross-chain payment proofs via the Attestcoin Protocol  

**Core Pivot:** AttestPay currently runs on Base mainnet with ERC-7710 delegations. For BUIDL CTC 2026 Fall, the project will deploy an Attestcoin Smart Contract (ASC) on Creditcoin Testnet that reads and verifies Base payment transactions cross-chain — making every AI agent payment provable, auditable, and usable as on-chain credit history on Creditcoin without trusting a centralized oracle.

---

## 2. Hackathon Compliance Checklist

| Requirement | Status | Evidence |
|---|---|---|
| Attestcoin Protocol integration as core feature | ✅ | `contracts/AttestPayASC.sol` verifies proofs via the Block Prover precompile (`0x0FD2`); `packages/engine/src/attestcoin/` is the pipeline; every confirmed payment enters it automatically |
| Deployed on testnet | ⏳ deploy step | Contracts build and test (42/42); `contracts/script/Deploy.s.sol` deploys to Ethereum Sepolia + Creditcoin CC3 (102031). **Needs a funded key** — Sepolia ETH and tCTC |
| Working integration code | ✅ | End-to-end pipeline, 4 MCP tools, 6 REST endpoints, dashboard pane. `bun run packages/engine/scripts/attestcoin-probe.ts` verifies the live protocol read-only |
| Technical documentation | ✅ | [`docs/attestcoin-integration.md`](docs/attestcoin-integration.md) — 15 sections, every protocol claim paired with a command that checks it |
| GitHub repo with README | ✅ | README carries a Cross-Chain Verification section with the trust model stated up front |
| Demo video | ⏳ | Script written for this panel in [`docs/video-script-attestcoin.md`](docs/video-script-attestcoin.md) (the existing `video-script.md` is the SigNoz cut); needs recording after deploy |
| Project deck / whitepaper | ⏳ | Outline in [`docs/hackathon-deck.md`](docs/hackathon-deck.md); needs rendering to PDF |
| Original work during hackathon | ✅ | All Attestcoin code is new; the pre-existing AttestPay base (Base payments, MCP, dashboard) is the foundation and is clearly separable in the git history |
| Submission deadline | — | **September 13, 2026, 23:59 ET** |

---

## 3. What Is the Attestcoin Protocol (Context for Implementation)

The Attestcoin Protocol is Creditcoin's native decentralized oracle infrastructure. It allows smart contracts on Creditcoin to **read verified state from any supported source chain** (currently Ethereum Sepolia, with Base support being the integration target).

### Key Concepts Your Agent Must Understand

**Readability** — Creditcoin contracts can read and verify transaction data from source chains (like Base) using two steps:
1. **Attestation**: A decentralized network of attestors tracks source chain blocks and reaches consensus
2. **Transaction Proving**: Merkle proofs + continuity proofs verify a specific transaction happened on the source chain

**Attestcoin Smart Contract (ASC)** — A smart contract deployed on Creditcoin that uses the Block Prover Precompile (`0x0FD2`) to verify cross-chain proofs synchronously in the same transaction.

**Block Prover Precompile** — Built-in Creditcoin runtime component at address `0x0000000000000000000000000000000000000FD2` that verifies Merkle and continuity proofs.

**@gluwa/usc-sdk** — TypeScript SDK for generating inclusion proofs. Requires `ethers.js v6`.

### Creditcoin CC3 Testnet Details

| Resource | Value |
|---|---|
| Chain ID (EVM) | `102031` |
| RPC (WebSocket) | `wss://rpc.cc3-testnet.creditcoin.network` |
| RPC (HTTP) | `https://creditcoin-testnet.drpc.org` |
| Blockscout Explorer | `https://creditcoin-testnet.blockscout.com/` |
| Subscan Explorer | `https://creditcoin3-testnet.subscan.io/` |
| Native Token | tCTC (testnet CTC) |
| Chain Key for Sepolia | `1` |
| Proof Generator API | `https://prover.cc3-testnet.creditcoin.network/` |
| Precompile Address | `0x0000000000000000000000000000000000000FD2` |
| Attestors Dashboard | `https://dashboard.cc3-testnet.creditcoin.network/` |
| USC SDK npm | `@gluwa/usc-sdk` |
| Faucet | Available via Creditcoin Discord |

---

## 4. Architecture — How AttestPay Integrates Attestcoin Protocol

### Current Architecture (Base Only)

```
User Wallet (Base) → ERC-7710 Delegation → Agent MCP → 1Shot Relayer → USDC Transfer on Base
```

### New Architecture (Base + Creditcoin via Attestcoin)

```
┌─────────────────────────────────────────────────────────────────────┐
│  SOURCE CHAIN: Base (Sepolia for testnet)                          │
│                                                                     │
│  User Wallet ──► ERC-7710 Delegation ──► Agent pays USDC           │
│       │                                       │                     │
│       │              PaymentLogger.sol         │                    │
│       │              (emits PaymentProved      │                    │
│       │               events with memo,        │                    │
│       │               amount, card_id)         │                    │
│       │                    ▲                   │                    │
│       │                    │                   │                    │
│       └────────────────────┘                   │                    │
└────────────────────────────────────────────────┼────────────────────┘
                                                 │
                      Attestcoin Protocol        │
                      (Attestors reach           │
                       consensus on Base         │
                       blocks)                   │
                                                 │
                      @gluwa/usc-sdk             │
                      (generates Merkle +        │
                       continuity proofs)        │
                                                 │
┌────────────────────────────────────────────────┼────────────────────┐
│  CREDITCOIN TESTNET                            ▼                    │
│                                                                     │
│  AttestPayASC.sol (Attestcoin Smart Contract)                       │
│    ├── verifyPayment(proof) → Block Prover Precompile (0x0FD2)     │
│    ├── recordCreditEvent() → on-chain credit history               │
│    ├── AgentCreditRegistry → agent reputation scores               │
│    └── CardTermsRegistry → cross-chain card term snapshots         │
│                                                                     │
│  Dashboard reads from both chains:                                  │
│    - Base: live balances, delegations, charges                     │
│    - Creditcoin: verified payment proofs, credit scores            │
│                                                                     │
│  SigNoz observability spans the full cross-chain flow              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. New Features to Build (Fully Functional)

### Feature 1: Cross-Chain Payment Verification (CORE — Required)

**What it does:** After every USDC payment on Base, the AttestPay server generates an Attestcoin inclusion proof and submits it to the AttestPayASC on Creditcoin Testnet, creating a cryptographically verified, cross-chain payment record.

**Why it matters for judging:** This is the deepest possible Attestcoin integration — every single agent payment becomes a provable cross-chain event. No oracle trust required.

**Implementation steps for your agent:**

1. **Deploy `PaymentLogger.sol` on Base Sepolia**
   - A minimal contract that emits events when payments occur
   - Event: `PaymentLogged(address indexed card, address indexed merchant, uint256 amount, bytes32 memo, uint256 timestamp)`
   - The existing `spend.ts` calls this after each successful USDC transfer

2. **Deploy `AttestPayASC.sol` on Creditcoin Testnet**
   - Extends the Attestcoin Smart Contract pattern
   - Imports the Block Prover Precompile interface at `0x0FD2`
   - Has a `verifyPayment()` function that:
     - Accepts Merkle proof + continuity proof
     - Calls the precompile to verify the proof
     - Decodes the `PaymentLogged` event from the proven transaction
     - Stores the verified payment record on Creditcoin
   - Has a `getVerifiedPayments(card)` view function

3. **Integrate `@gluwa/usc-sdk` into `packages/server`**
   - After a payment confirms on Base, wait for attestation
   - Generate inclusion proof via `ProverAPIProofGenerator`
   - Submit proof to `AttestPayASC.verifyPayment()` on Creditcoin
   - Store proof tx hash alongside the charge record

4. **New MCP tool: `verify_payment`**
   - Allows agents to trigger or check cross-chain verification status
   - Returns the Creditcoin tx hash of the verified proof

**Files to create/modify:**

```
packages/engine/src/attestcoin/
  ├── logger-abi.ts          # ABI for PaymentLogger.sol
  ├── asc-abi.ts             # ABI for AttestPayASC.sol
  ├── proof-generator.ts     # Wrapper around @gluwa/usc-sdk
  └── verifier.ts            # Submit proofs to Creditcoin

packages/server/src/attestcoin/
  ├── worker.ts              # Background proof generation + submission
  └── routes.ts              # API endpoints for verification status

contracts/
  ├── PaymentLogger.sol      # Source chain event emitter (Base Sepolia)
  └── AttestPayASC.sol        # Attestcoin Smart Contract (Creditcoin Testnet)
```

**Solidity — `PaymentLogger.sol` (Base Sepolia):**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract PaymentLogger {
    event PaymentLogged(
        bytes32 indexed cardId,
        address indexed from,
        address indexed to,
        uint256 amount,
        string memo,
        uint256 timestamp
    );

    function logPayment(
        bytes32 cardId,
        address from,
        address to,
        uint256 amount,
        string calldata memo
    ) external {
        emit PaymentLogged(cardId, from, to, amount, memo, block.timestamp);
    }
}
```

**Solidity — `AttestPayASC.sol` (Creditcoin Testnet):**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IBlockProver {
    function verifyTransaction(
        uint256 chainKey,
        bytes calldata merkleProof,
        bytes calldata continuityProof
    ) external view returns (bool verified, bytes memory txData);
}

contract AttestPayASC {
    IBlockProver constant BLOCK_PROVER = IBlockProver(0x0000000000000000000000000000000000000FD2);

    struct VerifiedPayment {
        bytes32 cardId;
        address from;
        address to;
        uint256 amount;
        string memo;
        uint256 sourceTimestamp;
        uint256 verifiedAt;
        bytes32 sourceTxHash;
    }

    // cardId => array of verified payments
    mapping(bytes32 => VerifiedPayment[]) public cardPayments;
    // sourceTxHash => whether already verified (prevent replays)
    mapping(bytes32 => bool) public provenTxHashes;
    // cardId => total verified spend
    mapping(bytes32 => uint256) public totalVerifiedSpend;
    // agent address => credit score data
    mapping(address => AgentCredit) public agentCredits;

    struct AgentCredit {
        uint256 totalPayments;
        uint256 totalVolume;
        uint256 firstPaymentAt;
        uint256 lastPaymentAt;
        uint256 onTimePayments; // payments within card terms
    }

    event PaymentVerified(
        bytes32 indexed cardId,
        bytes32 indexed sourceTxHash,
        uint256 amount,
        uint256 verifiedAt
    );

    event CreditScoreUpdated(
        address indexed agent,
        uint256 totalPayments,
        uint256 totalVolume
    );

    uint256 public constant SOURCE_CHAIN_KEY = 1; // Sepolia chain key

    function verifyPayment(
        bytes calldata merkleProof,
        bytes calldata continuityProof,
        bytes32 sourceTxHash,
        bytes32 cardId,
        address from,
        address to,
        uint256 amount,
        string calldata memo,
        uint256 sourceTimestamp
    ) external {
        require(!provenTxHashes[sourceTxHash], "Already verified");

        // Verify the proof on-chain via the Block Prover Precompile
        (bool verified, bytes memory txData) = BLOCK_PROVER.verifyTransaction(
            SOURCE_CHAIN_KEY,
            merkleProof,
            continuityProof
        );
        require(verified, "Proof verification failed");

        // Mark as proven
        provenTxHashes[sourceTxHash] = true;

        // Store the verified payment
        VerifiedPayment memory payment = VerifiedPayment({
            cardId: cardId,
            from: from,
            to: to,
            amount: amount,
            memo: memo,
            sourceTimestamp: sourceTimestamp,
            verifiedAt: block.timestamp,
            sourceTxHash: sourceTxHash
        });
        cardPayments[cardId].push(payment);
        totalVerifiedSpend[cardId] += amount;

        // Update agent credit score
        AgentCredit storage credit = agentCredits[from];
        credit.totalPayments += 1;
        credit.totalVolume += amount;
        if (credit.firstPaymentAt == 0) credit.firstPaymentAt = block.timestamp;
        credit.lastPaymentAt = block.timestamp;
        credit.onTimePayments += 1; // All verified payments are on-time

        emit PaymentVerified(cardId, sourceTxHash, amount, block.timestamp);
        emit CreditScoreUpdated(from, credit.totalPayments, credit.totalVolume);
    }

    function getCardPaymentCount(bytes32 cardId) external view returns (uint256) {
        return cardPayments[cardId].length;
    }

    function getAgentCredit(address agent) external view returns (AgentCredit memory) {
        return agentCredits[agent];
    }
}
```

**TypeScript — `proof-generator.ts`:**

```typescript
import { ProverAPIProofGenerator, PrecompileChainInfoProvider } from "@gluwa/usc-sdk";
import { ethers } from "ethers";

export class AttestcoinProofService {
  private sourceProvider: ethers.JsonRpcProvider;
  private creditcoinProvider: ethers.JsonRpcProvider;
  private proofGenerator: ProverAPIProofGenerator;
  private chainInfoProvider: PrecompileChainInfoProvider;

  constructor(config: {
    sourceRpcUrl: string;       // Base Sepolia RPC
    creditcoinRpcUrl: string;   // Creditcoin Testnet RPC
    proverApiUrl: string;       // https://prover.cc3-testnet.creditcoin.network/
  }) {
    this.sourceProvider = new ethers.JsonRpcProvider(config.sourceRpcUrl);
    this.creditcoinProvider = new ethers.JsonRpcProvider(config.creditcoinRpcUrl);

    this.chainInfoProvider = new PrecompileChainInfoProvider(this.creditcoinProvider);
    this.proofGenerator = new ProverAPIProofGenerator(config.proverApiUrl);
  }

  async generateProof(txHash: string, chainKey: number = 1) {
    // Wait for attestation to cover the block
    const tx = await this.sourceProvider.getTransaction(txHash);
    if (!tx || !tx.blockNumber) throw new Error("Transaction not found or not mined");

    // Check if block is attested
    const isAttested = await this.chainInfoProvider.isBlockAttested(chainKey, tx.blockNumber);
    if (!isAttested) {
      // Wait and retry — attestation takes a few minutes
      await this.waitForAttestation(chainKey, tx.blockNumber);
    }

    // Generate Merkle + continuity proofs
    const proof = await this.proofGenerator.generateProof({
      chainKey,
      txHash,
      blockNumber: tx.blockNumber,
    });

    return {
      merkleProof: proof.merkleProof,
      continuityProof: proof.continuityProof,
      sourceTxHash: txHash,
      blockNumber: tx.blockNumber,
    };
  }

  private async waitForAttestation(chainKey: number, blockNumber: number, maxWait = 600_000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const attested = await this.chainInfoProvider.isBlockAttested(chainKey, blockNumber);
      if (attested) return;
      await new Promise(r => setTimeout(r, 15_000)); // check every 15s
    }
    throw new Error(`Block ${blockNumber} not attested within timeout`);
  }
}
```

---

### Feature 2: Agent Credit History & Reputation (HIGH VALUE)

**What it does:** Every verified cross-chain payment builds an on-chain credit history for the agent on Creditcoin — the chain literally built for credit infrastructure. Agents accumulate provable spending records that any dApp on Creditcoin can query.

**Why it matters:** This directly leverages Creditcoin's core value proposition (credit history) and creates a novel use case (AI agent credit scores). No other project at this hackathon will combine AI agent payments with on-chain credit.

**Implementation:**

- The `AttestPayASC.sol` already stores `AgentCredit` structs (see above)
- Add a new MCP tool: `credit_score` that returns the agent's on-chain Creditcoin reputation
- Add a dashboard panel showing cross-chain verified payment history
- Add a REST endpoint: `GET /api/cards/:id/attestcoin-proofs` listing all verified proofs

**New MCP Tool Definition:**

```typescript
// In packages/server/src/mcp/tools/credit_score.ts
export const creditScoreTool = {
  name: "credit_score",
  description: "Get this card's cross-chain verified payment history and credit score from Creditcoin",
  inputSchema: { type: "object", properties: {} },
  async handler(card: Card) {
    const asc = getAttestPayASC(); // ethers contract instance on Creditcoin
    const credit = await asc.getAgentCredit(card.agentAddress);
    const paymentCount = await asc.getCardPaymentCount(card.cardIdBytes);
    return {
      totalVerifiedPayments: credit.totalPayments.toString(),
      totalVerifiedVolume: ethers.formatUnits(credit.totalVolume, 6) + " USDC",
      firstPayment: new Date(Number(credit.firstPaymentAt) * 1000).toISOString(),
      lastPayment: new Date(Number(credit.lastPaymentAt) * 1000).toISOString(),
      onTimeRate: credit.totalPayments > 0
        ? ((Number(credit.onTimePayments) / Number(credit.totalPayments)) * 100).toFixed(1) + "%"
        : "N/A",
      creditcoinExplorer: `https://creditcoin-testnet.blockscout.com/address/${asc.target}`,
    };
  },
};
```

---

### Feature 3: Cross-Chain Card Terms Registry (MEDIUM VALUE)

**What it does:** Card terms (budget, period, expiry, merchant allowlist) are hashed and registered on Creditcoin when a card is issued. The ASC can then verify that a payment was made within the terms of a specific card, cross-chain.

**Implementation:**

- Add `registerCardTerms(bytes32 cardId, bytes32 termsHash, ...)` to `AttestPayASC.sol`
- On card issuance, the server hashes the terms and registers them on Creditcoin
- Verification step cross-checks the proven payment against registered terms

```solidity
// Add to AttestPayASC.sol
struct CardTermsRecord {
    bytes32 termsHash;
    uint256 periodBudget;      // USDC amount per period
    uint256 periodSeconds;
    uint256 perTxMax;
    uint256 expiresAt;
    uint256 registeredAt;
    bool active;
}

mapping(bytes32 => CardTermsRecord) public cardTerms;

event CardTermsRegistered(bytes32 indexed cardId, bytes32 termsHash, uint256 registeredAt);
event CardTermsRevoked(bytes32 indexed cardId, uint256 revokedAt);

function registerCardTerms(
    bytes32 cardId,
    bytes32 termsHash,
    uint256 periodBudget,
    uint256 periodSeconds,
    uint256 perTxMax,
    uint256 expiresAt
) external {
    cardTerms[cardId] = CardTermsRecord({
        termsHash: termsHash,
        periodBudget: periodBudget,
        periodSeconds: periodSeconds,
        perTxMax: perTxMax,
        expiresAt: expiresAt,
        registeredAt: block.timestamp,
        active: true
    });
    emit CardTermsRegistered(cardId, termsHash, block.timestamp);
}

function revokeCardTerms(bytes32 cardId) external {
    cardTerms[cardId].active = false;
    emit CardTermsRevoked(cardId, block.timestamp);
}
```

---

### Feature 4: Attestcoin-Verified Payment Receipts (MEDIUM VALUE)

**What it does:** After proof verification on Creditcoin, the agent can fetch a receipt containing:
- The original Base transaction hash
- The Creditcoin verification transaction hash  
- The Attestcoin proof verification timestamp
- A link to both block explorers

**Implementation — New MCP tool `payment_receipt`:**

```typescript
export const paymentReceiptTool = {
  name: "payment_receipt",
  description: "Get a cross-chain verified receipt for a specific payment",
  inputSchema: {
    type: "object",
    properties: {
      charge_id: { type: "string", description: "The charge ID from the pay tool" }
    },
    required: ["charge_id"]
  },
  async handler(card: Card, input: { charge_id: string }) {
    const charge = await getCharge(card.id, input.charge_id);
    if (!charge) return { error: "Charge not found" };
    
    return {
      charge_id: charge.id,
      amount: charge.amount + " USDC",
      merchant: charge.merchant,
      memo: charge.memo,
      // Source chain (Base)
      source: {
        chain: "Base Sepolia",
        txHash: charge.txHash,
        explorer: `https://sepolia.basescan.org/tx/${charge.txHash}`,
        confirmedAt: charge.confirmedAt,
      },
      // Cross-chain verification (Creditcoin)
      attestcoin: {
        chain: "Creditcoin Testnet",
        verificationTxHash: charge.attestcoinTxHash || "pending",
        explorer: charge.attestcoinTxHash
          ? `https://creditcoin-testnet.blockscout.com/tx/${charge.attestcoinTxHash}`
          : null,
        verifiedAt: charge.attestcoinVerifiedAt || "awaiting attestation",
        proofType: "Merkle + Continuity (Attestcoin Protocol)",
      },
    };
  },
};
```

---

### Feature 5: SigNoz Observability for Cross-Chain Flow (BUILDS ON EXISTING)

**What it does:** Extends the existing SigNoz instrumentation to cover the entire Attestcoin proof lifecycle — from payment on Base through attestation wait to proof verification on Creditcoin.

**New traces to add:**

| Span Name | What It Captures |
|---|---|
| `attestcoin.proof_generation` | Time from payment confirmation to proof ready |
| `attestcoin.attestation_wait` | How long waiting for block attestation |
| `attestcoin.proof_submission` | Submitting proof to Creditcoin |
| `attestcoin.verification` | On-chain verification result |

**New metrics:**

| Metric | Type | Description |
|---|---|---|
| `attestpay.attestcoin.proofs_generated_total` | Counter | Total proofs generated |
| `attestpay.attestcoin.proofs_verified_total` | Counter | Total proofs verified on Creditcoin |
| `attestpay.attestcoin.attestation_wait_seconds` | Histogram | Time waiting for attestation |
| `attestpay.attestcoin.proof_generation_seconds` | Histogram | Time to generate proof |
| `attestpay.attestcoin.verification_failures_total` | Counter | Failed verifications |

**New structured logs:**

| Event | Fields |
|---|---|
| `attestcoin_proof_started` | card_id, source_tx_hash, block_number |
| `attestcoin_attestation_confirmed` | chain_key, block_number, wait_seconds |
| `attestcoin_proof_submitted` | creditcoin_tx_hash, card_id |
| `attestcoin_verification_result` | verified (bool), card_id, amount |

**Implementation — add to `packages/engine/src/telemetry.ts`:**

```typescript
// New Attestcoin-specific spans
export function traceAttestcoinProofGeneration(cardId: string, sourceTxHash: string) {
  return tracer.startSpan("attestcoin.proof_generation", {
    attributes: {
      "attestpay.card_id": cardId,
      "attestpay.source_tx_hash": sourceTxHash,
      "attestpay.attestcoin.operation": "proof_generation",
    },
  });
}

// New counters
export const attestcoinProofsGenerated = meter.createCounter("attestpay.attestcoin.proofs_generated_total");
export const attestcoinProofsVerified = meter.createCounter("attestpay.attestcoin.proofs_verified_total");
export const attestcoinVerificationFailures = meter.createCounter("attestpay.attestcoin.verification_failures_total");

// New histogram
export const attestcoinAttestationWait = meter.createHistogram("attestpay.attestcoin.attestation_wait_seconds", {
  description: "Time waiting for block attestation on Creditcoin",
  unit: "s",
});
```

---

### Feature 6: Testnet Deployment Configuration

**What it does:** Adds Creditcoin Testnet + Base Sepolia configuration for the hackathon submission.

**New environment variables to add to `.env.example`:**

```bash
# Attestcoin Protocol (Creditcoin Testnet)
ATTESTPAY_CREDITCOIN_RPC=wss://rpc.cc3-testnet.creditcoin.network
ATTESTPAY_CREDITCOIN_HTTP_RPC=https://creditcoin-testnet.drpc.org
ATTESTPAY_CREDITCOIN_CHAIN_ID=102031
ATTESTPAY_ASC_ADDRESS=<deployed AttestPayASC address>
ATTESTPAY_PAYMENT_LOGGER_ADDRESS=<deployed PaymentLogger address on Base Sepolia>
ATTESTPAY_ATTESTCOIN_CHAIN_KEY=1
ATTESTPAY_PROVER_API_URL=https://prover.cc3-testnet.creditcoin.network/
ATTESTPAY_CREDITCOIN_PRIVATE_KEY=<deployer private key for Creditcoin Testnet>

# Base Sepolia (testnet version of current Base Mainnet)
ATTESTPAY_BASE_SEPOLIA_RPC=https://sepolia.base.org
ATTESTPAY_BASE_SEPOLIA_CHAIN_ID=84532
```

**Network switching logic in `packages/engine/src/config.ts`:**

```typescript
export const NETWORKS = {
  production: {
    source: { name: "Base", chainId: 8453, rpc: "https://mainnet.base.org" },
    creditcoin: null, // not used in production yet
  },
  hackathon: {
    source: { name: "Base Sepolia", chainId: 84532, rpc: process.env.ATTESTPAY_BASE_SEPOLIA_RPC },
    creditcoin: {
      name: "Creditcoin Testnet",
      chainId: 102031,
      rpc: process.env.ATTESTPAY_CREDITCOIN_HTTP_RPC,
      wsRpc: process.env.ATTESTPAY_CREDITCOIN_RPC,
      ascAddress: process.env.ATTESTPAY_ASC_ADDRESS,
      proverApi: process.env.ATTESTPAY_PROVER_API_URL,
      chainKey: Number(process.env.ATTESTPAY_ATTESTCOIN_CHAIN_KEY || "1"),
      explorerBase: "https://creditcoin-testnet.blockscout.com",
    },
  },
} as const;
```

---

## 6. Database Schema Changes

Add these columns/tables to the SQLite schema:

```sql
-- Add to existing charges table
ALTER TABLE charges ADD COLUMN attestcoin_proof_status TEXT DEFAULT 'pending';
-- Values: pending | generating | submitted | verified | failed
ALTER TABLE charges ADD COLUMN attestcoin_tx_hash TEXT;
ALTER TABLE charges ADD COLUMN attestcoin_verified_at INTEGER;
ALTER TABLE charges ADD COLUMN attestcoin_proof_data TEXT; -- JSON blob with merkle + continuity proof

-- New table: cross-chain card term registrations
CREATE TABLE card_terms_registrations (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id),
    terms_hash TEXT NOT NULL,
    creditcoin_tx_hash TEXT,
    registered_at INTEGER,
    status TEXT DEFAULT 'pending', -- pending | confirmed | failed
    created_at INTEGER DEFAULT (unixepoch())
);

-- New table: agent credit scores (cached from Creditcoin reads)
CREATE TABLE agent_credit_cache (
    agent_address TEXT PRIMARY KEY,
    total_payments INTEGER DEFAULT 0,
    total_volume TEXT DEFAULT '0',
    first_payment_at INTEGER,
    last_payment_at INTEGER,
    on_time_rate REAL DEFAULT 0,
    last_synced_at INTEGER DEFAULT (unixepoch())
);
```

---

## 7. Updated MCP Tool Surface

After integration, the full MCP tool list becomes:

| Tool | Purpose | New? |
|---|---|---|
| `card` | Live state: remaining budget, terms, expiry, recent charges, sub-cards | Existing |
| `pay` | Send USDC on Base within card limits; now also triggers Attestcoin proof | Modified |
| `paid_fetch` | Fetch a URL; on HTTP 402, pay automatically | Existing |
| `fiat_pay` | Buy over simulated Visa rails | Existing |
| `card_credentials` | Reveal test-mode virtual Visa | Existing |
| `execute` | Run scoped contract calls | Existing |
| `issue_subcard` | Mint tighter child card | Existing |
| `revoke_subcard` | Kill a sub-card | Existing |
| **`verify_payment`** | **Trigger or check Attestcoin cross-chain verification** | **NEW** |
| **`credit_score`** | **Get agent's on-chain Creditcoin credit reputation** | **NEW** |
| **`payment_receipt`** | **Get cross-chain verified receipt with both chain links** | **NEW** |
| **`cross_chain_status`** | **Check Attestcoin Protocol health: attestation lag, proof queue** | **NEW** |

---

## 8. Updated Dashboard Features

### New Dashboard Sections

**1. Attestcoin Panel (in card dossier view)**
- Show verification status for each charge (pending → generating → verified)
- Link to Creditcoin Testnet explorer for each verified proof
- Show total verified volume on Creditcoin
- Show average attestation-to-verification time

**2. Agent Credit Score Widget**
- Pull from `AttestPayASC.getAgentCredit()` on Creditcoin
- Display: total verified payments, volume, on-time rate, history length
- Visual credit score gauge (A/B/C/D/F based on volume + consistency)

**3. Cross-Chain Health Monitor**
- Attestation lag (how far behind are attestors)
- Proof generation queue depth
- Recent verification success/failure rate

### Dashboard Component Pseudocode

```tsx
// In packages/dashboard/src/components/AttestcoinPanel.tsx
export function AttestcoinPanel({ cardId }: { cardId: string }) {
  const { data: proofs } = useQuery(["attestcoin-proofs", cardId], () =>
    fetch(`/api/cards/${cardId}/attestcoin-proofs`).then(r => r.json())
  );

  return (
    <div className="attestcoin-panel">
      <h3>Cross-Chain Verification (Attestcoin Protocol)</h3>
      <div className="stats">
        <Stat label="Verified Payments" value={proofs?.verifiedCount} />
        <Stat label="Total Verified" value={proofs?.totalVerifiedUSDC + " USDC"} />
        <Stat label="Avg Proof Time" value={proofs?.avgProofTimeSeconds + "s"} />
      </div>
      <table>
        <thead><tr><th>Amount</th><th>Base TX</th><th>Creditcoin TX</th><th>Status</th></tr></thead>
        <tbody>
          {proofs?.items.map(p => (
            <tr key={p.id}>
              <td>{p.amount} USDC</td>
              <td><a href={`https://sepolia.basescan.org/tx/${p.sourceTxHash}`}>View</a></td>
              <td>{p.creditcoinTxHash
                ? <a href={`https://creditcoin-testnet.blockscout.com/tx/${p.creditcoinTxHash}`}>Verified ✓</a>
                : <span className="pending">Pending...</span>
              }</td>
              <td><StatusBadge status={p.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

---

## 9. New API Endpoints

```
GET  /api/cards/:id/attestcoin-proofs          # List all Attestcoin proofs for a card
GET  /api/cards/:id/attestcoin-proofs/:proofId  # Single proof details
POST /api/cards/:id/attestcoin-verify           # Manually trigger verification for a charge
GET  /api/cards/:id/credit-score                # Agent's Creditcoin credit score
GET  /api/attestcoin/health                     # Attestcoin Protocol health check
GET  /api/attestcoin/stats                      # Aggregate cross-chain stats
```

---

## 10. Test Suite Additions

```typescript
// packages/engine/tests/attestcoin.test.ts

describe("Attestcoin Integration", () => {
  test("PaymentLogger emits correct event on Base Sepolia", async () => {
    // Deploy PaymentLogger to local fork
    // Call logPayment()
    // Verify event is emitted with correct args
  });

  test("Proof generation completes for attested block", async () => {
    // Mock the prover API
    // Verify proof structure has merkleProof + continuityProof
  });

  test("AttestPayASC verifies valid proof", async () => {
    // Deploy ASC to local Creditcoin fork
    // Submit a valid proof
    // Verify payment is recorded
    // Verify agent credit is updated
  });

  test("AttestPayASC rejects replay of same tx hash", async () => {
    // Submit same proof twice
    // Second should revert with "Already verified"
  });

  test("Card terms registration and cross-chain check", async () => {
    // Register terms on Creditcoin
    // Verify terms hash matches
  });

  test("SigNoz spans emitted for full proof lifecycle", async () => {
    // Verify attestcoin.proof_generation span
    // Verify attestcoin.attestation_wait span
    // Verify attestcoin.verification span
  });
});
```

---

## 11. Project Deck Outline (PDF)

Create a 10-slide deck:

1. **Cover**: AttestPay × Attestcoin — Cross-Chain Agentic Spending Cards
2. **Problem**: AI agents need to pay, but payments are siloed to one chain with no provable history
3. **Solution**: Scoped, revocable spending cards + cross-chain payment verification via Attestcoin Protocol
4. **How it Works**: The payment flow diagram (Base → Attestcoin → Creditcoin)
5. **Attestcoin Integration Deep Dive**: Block Prover Precompile, proof generation, ASC architecture
6. **Agent Credit History**: How every payment builds on-chain credit on Creditcoin
7. **Demo Screenshots**: Dashboard, MCP tools, SigNoz traces showing cross-chain flow
8. **Observability**: SigNoz instrumentation of the entire Attestcoin proof pipeline
9. **Architecture**: Technical diagram with all components
10. **Team & Roadmap**: Team info, future plans (mainnet, writability support)

---

## 12. Demo Video Script (3 minutes)

```
[0:00 - 0:30] Intro
"AttestPay gives AI agents scoped, revocable spending cards.
Today we're showing how every agent payment is cryptographically
verified cross-chain using the Attestcoin Protocol on Creditcoin."

[0:30 - 1:00] Issue a Card
- Open dashboard, sign in with Privy
- Issue a card: $10/week budget, expires in 7 days
- Show the card terms being registered on Creditcoin Testnet
- Copy the MCP URL

[1:00 - 1:45] Agent Makes a Payment
- Connect card to Claude via MCP
- Agent calls `pay` to send $2 USDC to a merchant on Base Sepolia
- Show the payment confirming on Base
- Show SigNoz trace: `attestcoin.proof_generation` span starts

[1:45 - 2:15] Cross-Chain Verification
- Show the attestation wait in SigNoz
- Proof generates via @gluwa/usc-sdk
- Proof submitted to AttestPayASC on Creditcoin Testnet
- Show the verification transaction on Creditcoin Blockscout
- Agent calls `payment_receipt` — shows both chain links

[2:15 - 2:40] Credit Score
- Agent calls `credit_score`
- Shows accumulated on-chain credit history on Creditcoin
- Show the AgentCredit struct on Blockscout

[2:40 - 3:00] Observability & Close
- Show SigNoz dashboard with Attestcoin panels
- "Every agent payment, cryptographically verified across chains,
  building real credit history — no trusted oracle, no bridge,
  just math. AttestPay × Attestcoin."
```

---

## 13. Submission Form Answers

| Field | Value |
|---|---|
| Project Name | AttestPay |
| Project Sector | AI |
| Project Description | Scoped, revocable spending cards for AI agents, with every payment proven cross-chain onto Creditcoin. An agent plugs in a card over MCP and pays USDC on Base within limits its owner set; each confirmed payment is then anchored on an attested chain and proven into a Creditcoin smart contract by the Attestcoin Block Prover precompile, building public, checkable credit history for the agent that spent — with no oracle and no bridge. |
| Attestcoin Protocol Integration Summary | AttestPay deploys `AttestPayASC` on Creditcoin CC3 testnet. It verifies Merkle inclusion and block continuity proofs synchronously via the Block Prover precompile (`0x0FD2`) in the same transaction that records the result, and reads the ChainInfo precompile (`0x0FD3`) for attestation state. Proofs are generated with `@gluwa/usc-sdk`. The central design decision: `verifyPayment` takes the proof and **nothing else** — every recorded field is decoded out of the proven transaction bytes, because facts passed as parameters beside a proof are not proven by it, and accepting them would let anyone attach arbitrary data to one valid proof and mint unlimited verified history. Replay is keyed on `(chainKey, height, txIndex, logIndex)`, all derived from proven data with `txIndex` coming from the precompile itself. Each verified payment updates an on-chain `AgentCredit` record any Creditcoin dApp can read, checked against a card-terms registry that distinguishes "within terms" from "terms never registered" rather than awarding unearned compliance. Because the protocol attests only Ethereum mainnet and Ethereum Sepolia — confirmed live via `get_supported_chains()`, Base is not attested — a `PaymentAnchor` contract on Ethereum Sepolia records each Base payment's facts and that anchoring transaction is what gets proven; the docs state precisely what this does and does not establish. The full proof lifecycle is instrumented with OpenTelemetry and visible in SigNoz. |
| GitHub Repository URL | https://github.com/LSUDOKO/AttestPay |
| Technical Documentation | https://github.com/LSUDOKO/AttestPay/blob/main/docs/attestcoin-integration.md |
| Prototype Demo Video URL | (record and upload to YouTube) |
| Project Deck | (render docs/hackathon-deck.md to PDF and host) |

---

## 14. File-by-File Change List for Your Agent

### New Files to Create

```
contracts/
  PaymentLogger.sol                    # Source chain event emitter
  AttestPayASC.sol                      # Attestcoin Smart Contract
  deploy-creditcoin.ts                 # Hardhat/Foundry deploy script for Creditcoin Testnet
  deploy-base-sepolia.ts               # Deploy script for Base Sepolia

packages/engine/src/attestcoin/
  index.ts                             # Barrel export
  types.ts                             # AttestcoinProof, AgentCredit types
  proof-generator.ts                   # @gluwa/usc-sdk wrapper
  verifier.ts                          # Submit proofs to ASC on Creditcoin
  credit-reader.ts                     # Read agent credit from Creditcoin
  logger-abi.ts                        # PaymentLogger ABI
  asc-abi.ts                           # AttestPayASC ABI

packages/engine/src/attestcoin/
  telemetry.ts                         # Attestcoin-specific OTel spans + metrics

packages/server/src/attestcoin/
  worker.ts                            # Background proof generation worker
  routes.ts                            # /api/.../attestcoin-proofs endpoints
  health.ts                            # Attestcoin Protocol health check

packages/server/src/mcp/tools/
  verify_payment.ts                    # New MCP tool
  credit_score.ts                      # New MCP tool
  payment_receipt.ts                   # New MCP tool
  cross_chain_status.ts                # New MCP tool

packages/dashboard/src/components/
  AttestcoinPanel.tsx                   # Card dossier attestcoin section
  CreditScoreWidget.tsx                # Agent credit score display
  CrossChainHealthMonitor.tsx          # Attestcoin health display

docs/
  attestcoin-integration.md            # Technical docs for submission
  hackathon-deck.pdf                   # Project deck
```

### Files to Modify

```
packages/engine/src/spend.ts           # After payment confirm, trigger proof generation
packages/engine/src/telemetry.ts       # Add Attestcoin metrics + spans
packages/engine/src/compiler.ts        # Add termsHash() function for Creditcoin registration
packages/server/src/mcp/index.ts       # Register new MCP tools
packages/server/src/otel.ts            # Ensure Attestcoin spans are exported
packages/server/src/routes/cards.ts    # Add attestcoin-proofs endpoints
packages/dashboard/src/pages/card.tsx  # Add AttestcoinPanel
.env.example                          # Add Creditcoin + Attestcoin env vars
package.json                           # Add @gluwa/usc-sdk, ethers@6
README.md                             # Add Attestcoin integration section
bun.lockb                             # Updated dependencies
```

---

## 15. Dependencies to Add

```bash
# In packages/engine or root
bun add @gluwa/usc-sdk ethers@^6

# For contract compilation (if using Hardhat)
bun add -d hardhat @nomicfoundation/hardhat-ethers hardhat-deploy

# For contract compilation (if using Foundry — preferred)
# Just install foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup
```

---

## 16. Critical Implementation Notes

1. **Base Sepolia vs Base Mainnet**: The hackathon requires testnet deployment. Switch the source chain from Base Mainnet to Base Sepolia (Chain ID 84532). The Attestcoin Protocol currently supports Sepolia as a source chain (chain key = 1). If Base Sepolia is not yet supported as a distinct source chain, use Ethereum Sepolia and deploy the PaymentLogger there instead.

2. **Attestation Lag**: Attestation takes 2-10 minutes after a block is mined. The proof generation worker must handle this asynchronously. Don't block the MCP `pay` response — return the payment immediately and verify cross-chain in the background.

3. **Gas on Creditcoin Testnet**: You need tCTC for gas. Get it from the Creditcoin Discord faucet. The ASC deployment and each proof verification costs gas.

4. **Proof Verification Cost**: Each `verifyPayment()` call on Creditcoin costs gas (precompile call + storage writes). Budget for this in testing.

5. **Block Prover Precompile Interface**: The exact interface at `0x0FD2` may differ from the pseudocode above. Consult the latest @gluwa/usc-sdk and Creditcoin docs for the actual precompile ABI. The SDK handles most of the complexity.

6. **Original Work Requirement**: All Attestcoin integration code must be written between Aug 13 and Sep 13, 2026. The existing AttestPay codebase (Base payment infrastructure, MCP server, dashboard) is the foundation, but the cross-chain pieces are new.

7. **README Integration Section**: The submission requires technical documentation in the README explaining how the project uses the Attestcoin Protocol. Use the architecture diagram from Section 4 and the implementation details from Section 5.

---

## 17. Scoring Strategy

Based on the hackathon's evaluation criteria:

| Criterion | How AttestPay Scores |
|---|---|
| **Depth of Attestcoin utilization** | Deep: every payment verified cross-chain via Block Prover Precompile, card terms registered, agent credit history on-chain |
| **Functional integration** | Full pipeline: source chain events → attestation → proof generation → on-chain verification → credit scoring |
| **Technical documentation** | Comprehensive: architecture diagram, API docs, SigNoz observability docs |
| **Innovation** | Novel: first project combining AI agent payments with cross-chain credit history on Creditcoin |
| **Completeness** | End-to-end: dashboard, MCP tools, API, contracts, observability |
| **AI Track relevance** | Core: AI agents autonomously make payments and build provable credit history cross-chain |

---

## 18. Timeline (Remaining Days)

**Today is September 12, 2026. Deadline is September 13, 2026, 23:59 ET.**

You have approximately **36 hours**. Here's the priority order:

### Must-Have (do these first)
1. Deploy `PaymentLogger.sol` on Base Sepolia (or Ethereum Sepolia)
2. Deploy `AttestPayASC.sol` on Creditcoin Testnet
3. Integrate `@gluwa/usc-sdk` proof generation in the server
4. Wire proof verification into the existing `pay` flow
5. Add `verify_payment` and `credit_score` MCP tools
6. Update README with Attestcoin integration docs
7. Record demo video

### Should-Have (if time permits)
8. Add AttestcoinPanel to dashboard
9. Add SigNoz traces for Attestcoin spans
10. Add `payment_receipt` and `cross_chain_status` tools
11. Card terms registration on Creditcoin
12. Create project deck PDF

### Nice-to-Have (stretch goals)
13. Agent credit score widget in dashboard
14. Cross-chain health monitor
15. Full test suite for Attestcoin integration
