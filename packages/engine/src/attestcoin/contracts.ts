// Typed views over the ethers `Contract` instances used by the Attestcoin client.
//
// ethers v6 resolves contract methods through a Proxy, so under `strict` TypeScript
// every `contract.someMethod(...)` is typed as possibly undefined. Scattering `!` over
// each call site would silence that without documenting anything. Declaring the exact
// surface each contract is used through instead gives real parameter and return types,
// and makes an ABI/call-site mismatch a compile error rather than a runtime surprise.

import type { Contract, ContractTransactionResponse, DeferredTopicFilter, Overrides } from "ethers";

/** A struct-returning view result also carries positional fields; only the named
 * fields are read, so these types describe just those. */

export type MerkleProofArg = {
  root: string;
  siblings: Array<[string, boolean]>;
};

export type ContinuityProofArg = {
  lowerEndpointDigest: string;
  roots: string[];
};

export type AnchorEventArgs = {
  cardId: string;
  payer: string;
  merchant: string;
  amount: bigint;
  sourceChainId: bigint;
  sourceTxHash: string;
  paidAt: bigint;
  anchoredBy: string;
  memo: string;
};

/** `PaymentAnchor` on the source chain.
 *
 * `filters` is declared because the existing-anchor log scan filters on the indexed
 * cardId/payer/merchant triple; ethers types the Proxy-resolved filter accessors as
 * possibly undefined, same as the method accessors. */
export type PaymentAnchorContract = Contract & {
  filters: {
    PaymentAnchored(
      cardId?: string | null,
      payer?: string | null,
      merchant?: string | null,
    ): DeferredTopicFilter;
  };
  anchorPayment(
    cardId: string,
    payer: string,
    merchant: string,
    amount: bigint,
    sourceChainId: bigint,
    sourceTxHash: string,
    paidAt: bigint,
    memo: string,
    overrides?: Overrides,
  ): Promise<ContractTransactionResponse>;
  anchorCount(cardId: string): Promise<bigint>;
  isAnchored(sourceChainId: bigint, sourceTxHash: string): Promise<boolean>;
  sourceKey(sourceChainId: bigint, sourceTxHash: string): Promise<string>;
};

export type VerifiedPaymentResult = {
  cardId: string;
  payer: string;
  merchant: string;
  amount: bigint;
  sourceChainId: bigint;
  sourceTxHash: string;
  paidAt: bigint;
  anchorHeight: bigint;
  verifiedAt: bigint;
  memo: string;
};

export type AgentCreditResult = {
  totalPayments: bigint;
  totalVolume: bigint;
  firstPaymentAt: bigint;
  lastPaymentAt: bigint;
  withinTermsPayments: bigint;
  termsCheckedPayments: bigint;
};

export type CardTermsResult = {
  termsHash: string;
  periodBudget: bigint;
  periodSeconds: bigint;
  perTxMax: bigint;
  expiresAt: bigint;
  registeredAt: bigint;
  active: boolean;
  exists: boolean;
};

/** `verifyPayment` is both sent and simulated, so its `staticCall` form is part of
 * the surface rather than an afterthought — simulating first is how a rejected proof
 * surfaces its named custom error instead of a bare "transaction reverted". */
type VerifyPaymentFn = {
  (
    height: bigint,
    encodedTransaction: string,
    merkleProof: MerkleProofArg,
    continuityProof: ContinuityProofArg,
    overrides?: Overrides,
  ): Promise<ContractTransactionResponse>;
  staticCall(
    height: bigint,
    encodedTransaction: string,
    merkleProof: MerkleProofArg,
    continuityProof: ContinuityProofArg,
  ): Promise<bigint>;
};

/** `AttestPayASC` on Creditcoin. */
export type AttestPayASCContract = Contract & {
  verifyPayment: VerifyPaymentFn;

  sourceChainKey(): Promise<bigint>;
  paymentAnchor(): Promise<string>;
  trustedAnchorer(): Promise<string>;
  blockProver(): Promise<string>;

  getCardPaymentCount(cardId: string): Promise<bigint>;
  totalVerifiedSpend(cardId: string): Promise<bigint>;
  getCardPayment(cardId: string, index: bigint): Promise<VerifiedPaymentResult>;
  getCardPayments(cardId: string, offset: bigint, limit: bigint): Promise<VerifiedPaymentResult[]>;
  getAgentCredit(payer: string): Promise<AgentCreditResult>;
  getCardTerms(cardId: string): Promise<CardTermsResult>;
  isEventVerified(height: bigint, txIndex: bigint, logIndex: bigint): Promise<boolean>;
  cardTermsOwner(cardId: string): Promise<string>;

  registerCardTerms(
    cardId: string,
    termsHash: string,
    periodBudget: bigint,
    periodSeconds: bigint,
    perTxMax: bigint,
    expiresAt: bigint,
    overrides?: Overrides,
  ): Promise<ContractTransactionResponse>;
  revokeCardTerms(cardId: string, overrides?: Overrides): Promise<ContractTransactionResponse>;
};

export type HeightHashResult = {
  height: bigint;
  hash: string;
  isAttestation: boolean;
  exists: boolean;
};

export type SupportedChainResult = {
  chainKey: bigint;
  chainId: bigint;
  chainName: string;
  chainEncoding: bigint;
};

/** The Attestcoin ChainInfo precompile (snake_case on purpose — see abi.ts). */
export type ChainInfoContract = Contract & {
  is_height_attested(chainKey: bigint, height: bigint): Promise<boolean>;
  get_latest_attestation_height_and_hash(chainKey: bigint): Promise<HeightHashResult>;
  get_supported_chains(): Promise<SupportedChainResult[]>;
};
