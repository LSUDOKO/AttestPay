// Attestcoin cross-chain verification: domain types.
//
// The lifecycle of one payment's proof, and why each state exists:
//
//   pending    — the payment confirmed on Base; nothing anchored yet.
//   anchoring  — the anchor transaction is being sent to the source chain.
//   anchored   — the anchor landed; now waiting for Attestcoin attestors to cover
//                its block. This wait is the slow part (minutes), which is exactly
//                why the pipeline is a background worker and not inline in `pay`.
//   attested   — the anchor's block is attested, so a proof can be generated.
//   proving    — generating the proof and submitting it to the ASC on Creditcoin.
//   verified   — the ASC accepted the proof. Terminal, successful.
//   failed     — terminal and retryable by an operator; `error` says why.
//
// The same lifecycle drives every other fact AttestPay proves — credit-line draws
// and repayments, disputes, card revocations — through `FactAnchor` instead of
// `PaymentAnchor`. One state machine, two anchors, several consumers.
//
// States are stored as strings in sqlite (see store.ts), so the union is the schema.

import type { Address, Hex } from "viem";

export type ProofStatus =
  | "pending"
  | "anchoring"
  | "anchored"
  | "attested"
  | "proving"
  | "verified"
  | "failed";

/** Statuses from which the worker has no further work to do. */
export const TERMINAL_PROOF_STATUSES: readonly ProofStatus[] = ["verified", "failed"] as const;

export function isTerminalProofStatus(s: ProofStatus): boolean {
  return TERMINAL_PROOF_STATUSES.includes(s);
}

/** Attestcoin source-chain keys on Creditcoin CC3 testnet.
 *
 * These are NOT EVM chain ids — they are Attestcoin's own registry keys, and the
 * mapping is confirmed live via `get_supported_chains()` on the ChainInfo precompile:
 *   key 1 -> chainId 11155111 (Ethereum Sepolia)
 *   key 3 -> chainId 1        (Ethereum mainnet)
 * Base (8453) and Base Sepolia (84532) are NOT attested, which is why AttestPay
 * anchors to Ethereum Sepolia rather than proving Base transactions directly.
 *
 * This table is the FALLBACK. The live registry is authoritative: `discoverChains`
 * reads it at boot, and `ATTESTPAY_ATTESTCOIN_CHAIN_KEY=auto` selects the key from
 * it rather than from here. The day Base is attested, nothing in this file needs
 * to change for the pipeline to prove Base transactions directly. */
export const ATTESTCOIN_CHAIN_KEYS = {
  ethereumSepolia: 1,
  ethereumMainnet: 3,
} as const;

/** EVM chain id for each known Attestcoin source chain key (fallback table). */
export const CHAIN_KEY_TO_EVM_CHAIN_ID: Record<number, number> = {
  1: 11155111,
  3: 1,
};

/** One row of the ChainInfo precompile's `get_supported_chains()`. */
export type SupportedChain = {
  chainKey: number;
  chainId: number;
  name: string;
  /** Attestcoin's transaction-encoding version for this chain (1 = EVM v1). */
  encoding: number;
};

/** The Attestcoin precompiles on Creditcoin. */
export const PRECOMPILES = {
  blockProver: "0x0000000000000000000000000000000000000FD2",
  chainInfo: "0x0000000000000000000000000000000000000fD3",
} as const;

/** Creditcoin CC3 testnet. */
export const CREDITCOIN_TESTNET = {
  chainId: 102031,
  name: "Creditcoin CC3 Testnet",
  explorer: "https://creditcoin-testnet.blockscout.com",
  proverApi: "https://prover.cc3-testnet.creditcoin.network",
} as const;

/** A card payment ready to be anchored on the source chain. */
export type AnchorRequest = {
  /** AttestPay charge id this anchor corresponds to. */
  chargeId: string;
  /** AttestPay card id (the string id; hashed to bytes32 at the contract boundary). */
  cardId: string;
  /** The card tree's root delegator: where the USDC actually left from. */
  payer: Address;
  /** Payment recipient. */
  merchant: Address;
  /** USDC atoms (6 decimals). */
  amountAtoms: bigint;
  /** EVM chain id the USDC moved on (8453 Base, 84532 Base Sepolia). */
  sourceChainId: number;
  /** The payment's transaction hash on `sourceChainId`. */
  sourceTxHash: Hex;
  /** Unix seconds the payment confirmed. */
  paidAt: number;
  memo: string;
};

/** An Attestcoin inclusion proof, as returned by the prover API. */
export type AttestcoinProof = {
  chainKey: number;
  /** Attested source-chain block height holding the anchor transaction. */
  headerNumber: number;
  txIndex: number;
  txHash: string;
  /** Attestcoin-encoded transaction + receipt; the ASC decodes payment facts from this. */
  txBytes: string;
  merkleProof: { root: string; siblings: Array<{ hash: string; isLeft: boolean }> };
  continuityProof: { lowerEndpointDigest: string; roots: string[] };
};

/** Per-charge cross-chain verification record (mirrors the `attestcoin_proofs` table). */
export type ProofRow = {
  charge_id: string;
  card_id: string;
  status: ProofStatus;
  /** Anchor transaction hash on the source chain. */
  anchor_tx_hash: string | null;
  /** Attested source-chain height of the anchor transaction. */
  anchor_height: number | null;
  /** Verification transaction hash on Creditcoin. */
  creditcoin_tx_hash: string | null;
  verified_at: number | null;
  /** Last failure reason; kept even after a later success, as an audit trail. */
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
};

// ---------------------------------------------------------------------------
// Facts: everything proven through FactAnchor rather than PaymentAnchor
// ---------------------------------------------------------------------------

export type FactKind = "draw" | "repayment" | "dispute_opened" | "dispute_resolved" | "card_revoked";

/** Which Creditcoin contract consumes a fact's proof. */
export type FactTarget = "credit_line" | "ledger";

export const FACT_TARGETS: Record<FactKind, FactTarget> = {
  draw: "credit_line",
  repayment: "credit_line",
  dispute_opened: "ledger",
  dispute_resolved: "ledger",
  card_revoked: "ledger",
};

/** The anchor arguments for each fact kind. Amounts are decimal strings of atoms so
 * the payload survives JSON. */
export type FactPayload =
  | {
      kind: "draw" | "repayment";
      lineId: Hex;
      borrower: Address;
      lender: Address;
      amountAtoms: string;
      sourceChainId: number;
      sourceTxHash: Hex;
      at: number;
    }
  | {
      kind: "dispute_opened";
      disputeId: Hex;
      cardIdHash: Hex;
      payer: Address;
      merchant: Address;
      sourceChainId: number;
      sourceTxHash: Hex;
      amountAtoms: string;
      at: number;
      reason: string;
    }
  | {
      kind: "dispute_resolved";
      disputeId: Hex;
      cardIdHash: Hex;
      payer: Address;
      /** 1 upheld, 2 rejected, 3 withdrawn. */
      outcome: 1 | 2 | 3;
      at: number;
    }
  | { kind: "card_revoked"; cardIdHash: Hex; payer: Address; revokedAt: number };

/** One fact's proof pipeline record (mirrors the `attestcoin_facts` table). */
export type FactRow = {
  id: string;
  kind: FactKind;
  /** The domain object this fact belongs to: line id, dispute id, or card id. */
  ref_id: string;
  /** The AttestPay card the fact is scoped to, for per-card views. */
  card_id: string | null;
  payload: FactPayload;
  target: FactTarget;
  status: ProofStatus;
  anchor_tx_hash: string | null;
  anchor_height: number | null;
  creditcoin_tx_hash: string | null;
  verified_at: number | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
};

// ---------------------------------------------------------------------------
// Credit lines
// ---------------------------------------------------------------------------

/** Local lifecycle of a credit line. On-chain statuses map onto the tail of this. */
export type CreditLineStatus =
  | "proposed" // terms drafted; awaiting one or both signatures
  | "signed" // both signatures held; on-chain registration queued
  | "opening" // openLine transaction in flight
  | "open" // registered on Creditcoin, nothing drawn yet
  | "active" // at least one proven draw
  | "repaid"
  | "defaulted"
  | "closed"
  | "failed"; // registration failed permanently; `error` says why

export type CreditLineRow = {
  /** The EIP-712 struct hash of the terms: the on-chain line id. */
  id: Hex;
  lender_user_id: string;
  lender_address: Address;
  borrower_address: Address;
  /** The borrower's root card, whose agent may draw. */
  borrower_card_id: string | null;
  /** The lender's card that draws are paid from. */
  funding_card_id: string;
  limit_atoms: bigint;
  interest_bps: number;
  expires_at: number;
  nonce: bigint;
  lender_sig: Hex | null;
  borrower_sig: Hex | null;
  status: CreditLineStatus;
  creditcoin_tx_hash: string | null;
  error: string | null;
  drawn_atoms: bigint;
  repaid_atoms: bigint;
  created_at: number;
  updated_at: number;
};

export type CreditLineEventRow = {
  id: string;
  line_id: Hex;
  kind: "draw" | "repayment";
  charge_id: string;
  amount_atoms: bigint;
  created_at: number;
};

/** A line as read back from `AttestPayCreditLine`. */
export type CreditLineOnChain = {
  lender: Address;
  borrower: Address;
  limit: bigint;
  interestBps: bigint;
  expiresAt: bigint;
  nonce: bigint;
  status: number;
  drawn: bigint;
  repaid: bigint;
  openedAt: bigint;
  lastEventAt: bigint;
  defaultedAt: bigint;
  repaidAt: bigint;
  owed: bigint;
  outstanding: bigint;
  available: bigint;
};

export const LINE_STATUS_NAMES = ["none", "open", "active", "repaid", "defaulted", "closed"] as const;

export type BorrowerRecord = {
  linesOpened: bigint;
  linesRepaid: bigint;
  linesDefaulted: bigint;
  totalDrawn: bigint;
  totalRepaid: bigint;
};

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

export type DisputeStatus = "open" | "upheld" | "rejected" | "withdrawn";

export type DisputeRow = {
  id: string;
  charge_id: string;
  card_id: string;
  opened_by_user_id: string;
  reason: string;
  status: DisputeStatus;
  resolution_note: string | null;
  resolved_by: string | null;
  opened_at: number;
  resolved_at: number | null;
};

export const DISPUTE_OUTCOME_CODES: Record<Exclude<DisputeStatus, "open">, 1 | 2 | 3> = {
  upheld: 1,
  rejected: 2,
  withdrawn: 3,
};

export type DisputeRecord = {
  opened: bigint;
  upheld: bigint;
  rejected: bigint;
  withdrawn: bigint;
  disputedVolume: bigint;
};

// ---------------------------------------------------------------------------
// Credit, passport, health
// ---------------------------------------------------------------------------

/** On-chain agent credit, read back from the ASC. */
export type AgentCredit = {
  totalPayments: bigint;
  totalVolume: bigint;
  firstPaymentAt: bigint;
  lastPaymentAt: bigint;
  withinTermsPayments: bigint;
  termsCheckedPayments: bigint;
};

/** One cross-chain-verified payment, read back from the ASC. */
export type VerifiedPayment = {
  cardId: Hex;
  payer: Address;
  merchant: Address;
  amount: bigint;
  sourceChainId: bigint;
  sourceTxHash: Hex;
  paidAt: bigint;
  anchorHeight: bigint;
  verifiedAt: bigint;
  memo: string;
};

/** The composed record from `CreditPassport.passportOf`. */
export type Passport = {
  account: Address;
  verifiedPayments: bigint;
  verifiedVolume: bigint;
  firstPaymentAt: bigint;
  lastPaymentAt: bigint;
  withinTermsPayments: bigint;
  termsCheckedPayments: bigint;
  linesOpened: bigint;
  linesRepaid: bigint;
  linesDefaulted: bigint;
  totalDrawn: bigint;
  totalRepaid: bigint;
  disputesOpened: bigint;
  disputesUpheld: bigint;
  disputesRejected: bigint;
  disputedVolume: bigint;
  guaranteeBonded: bigint;
  score: bigint;
  grade: string;
  asOf: bigint;
};

/** Attestcoin protocol health, for the `cross_chain_status` tool and dashboard. */
export type AttestcoinHealth = {
  /** Whether the integration is configured at all. */
  configured: boolean;
  chainKey: number | null;
  /** Whether the chain key came from the env var or was selected from the live registry. */
  chainKeySource: "env" | "registry" | null;
  /** The registry, as read from the ChainInfo precompile at the last discovery. */
  supportedChains: SupportedChain[] | null;
  /** The EVM chain AttestPay's payments settle on (Base). */
  paymentChainId: number | null;
  /** Whether the payment chain itself is attested. When true, payments can be proven
   * directly and the "anchor written by the server" caveat disappears. */
  paymentChainAttested: boolean | null;
  /** Latest source-chain height the attestors have covered. */
  latestAttestedHeight: number | null;
  /** Current source-chain head. */
  sourceHead: number | null;
  /** sourceHead - latestAttestedHeight: how far behind attestation is running. */
  attestationLagBlocks: number | null;
  /** Counts of proof rows by status — the local pipeline's queue depth. */
  queue: Record<ProofStatus, number>;
  /** Counts of fact rows by status. */
  factQueue: Record<ProofStatus, number>;
  creditcoinChainId: number | null;
  ascAddress: string | null;
  anchorAddress: string | null;
  /** Which optional contracts are wired. */
  features: { credit: boolean; disputes: boolean; guarantee: boolean; passport: boolean };
  contracts: {
    factAnchor: string | null;
    creditLine: string | null;
    ledger: string | null;
    guarantee: string | null;
    passport: string | null;
  };
  /** Populated when a health probe failed, so callers can distinguish
   * "lag is 0" from "we could not find out". */
  error?: string;
};
