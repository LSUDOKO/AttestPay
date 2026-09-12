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
 * anchors to Ethereum Sepolia rather than proving Base transactions directly. */
export const ATTESTCOIN_CHAIN_KEYS = {
  ethereumSepolia: 1,
  ethereumMainnet: 3,
} as const;

/** EVM chain id for each supported Attestcoin source chain key. */
export const CHAIN_KEY_TO_EVM_CHAIN_ID: Record<number, number> = {
  1: 11155111,
  3: 1,
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

/** Attestcoin protocol health, for the `cross_chain_status` tool and dashboard. */
export type AttestcoinHealth = {
  /** Whether the integration is configured at all. */
  configured: boolean;
  chainKey: number | null;
  /** Latest source-chain height the attestors have covered. */
  latestAttestedHeight: number | null;
  /** Current source-chain head. */
  sourceHead: number | null;
  /** sourceHead - latestAttestedHeight: how far behind attestation is running. */
  attestationLagBlocks: number | null;
  /** Counts of proof rows by status — the local pipeline's queue depth. */
  queue: Record<ProofStatus, number>;
  creditcoinChainId: number | null;
  ascAddress: string | null;
  anchorAddress: string | null;
  /** Populated when a health probe failed, so callers can distinguish
   * "lag is 0" from "we could not find out". */
  error?: string;
};
