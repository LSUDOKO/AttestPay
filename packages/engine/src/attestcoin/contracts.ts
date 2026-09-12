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

// ---------------------------------------------------------------------------
// Facts: credit lines, disputes, revocations, guarantees, passport
// ---------------------------------------------------------------------------

/** `FactAnchor` on the source chain. */
export type FactAnchorContract = Contract & {
  filters: {
    CreditDrawn(lineId?: string | null, borrower?: string | null, lender?: string | null): DeferredTopicFilter;
    CreditRepaid(lineId?: string | null, borrower?: string | null, lender?: string | null): DeferredTopicFilter;
    DisputeOpened(disputeId?: string | null): DeferredTopicFilter;
    DisputeResolved(disputeId?: string | null): DeferredTopicFilter;
    CardRevoked(cardId?: string | null): DeferredTopicFilter;
  };
  anchorDraw(
    lineId: string,
    borrower: string,
    lender: string,
    amount: bigint,
    sourceChainId: bigint,
    sourceTxHash: string,
    at: bigint,
    overrides?: Overrides,
  ): Promise<ContractTransactionResponse>;
  anchorRepayment(
    lineId: string,
    borrower: string,
    lender: string,
    amount: bigint,
    sourceChainId: bigint,
    sourceTxHash: string,
    at: bigint,
    overrides?: Overrides,
  ): Promise<ContractTransactionResponse>;
  anchorDisputeOpened(
    disputeId: string,
    cardId: string,
    payer: string,
    merchant: string,
    sourceChainId: bigint,
    sourceTxHash: string,
    amount: bigint,
    at: bigint,
    reason: string,
    overrides?: Overrides,
  ): Promise<ContractTransactionResponse>;
  anchorDisputeResolved(
    disputeId: string,
    cardId: string,
    payer: string,
    outcome: number,
    at: bigint,
    overrides?: Overrides,
  ): Promise<ContractTransactionResponse>;
  anchorCardRevoked(cardId: string, payer: string, revokedAt: bigint, overrides?: Overrides): Promise<ContractTransactionResponse>;
  isTransferAnchored(kind: number, sourceChainId: bigint, sourceTxHash: string): Promise<boolean>;
  disputeOpened(disputeId: string): Promise<boolean>;
  disputeResolved(disputeId: string): Promise<boolean>;
  cardRevoked(cardId: string): Promise<boolean>;
};

type VerifyFactsFn = {
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

/** The surface every `ProvenFacts` consumer shares. */
export type ProvenFactsContract = Contract & {
  verifyFacts: VerifyFactsFn;
  sourceChainKey(): Promise<bigint>;
  factAnchor(): Promise<string>;
  trustedAnchorer(): Promise<string>;
  isEventProven(height: bigint, txIndex: bigint, logIndex: bigint): Promise<boolean>;
};

export type LineTermsArg = {
  lender: string;
  borrower: string;
  limit: bigint;
  interestBps: bigint;
  expiresAt: bigint;
  nonce: bigint;
};

export type LineResult = {
  terms: LineTermsArg;
  status: bigint;
  drawn: bigint;
  repaid: bigint;
  openedAt: bigint;
  lastEventAt: bigint;
  defaultedAt: bigint;
  repaidAt: bigint;
};

export type BorrowerRecordResult = {
  linesOpened: bigint;
  linesRepaid: bigint;
  linesDefaulted: bigint;
  totalDrawn: bigint;
  totalRepaid: bigint;
};

/** `AttestPayCreditLine` on Creditcoin. */
export type CreditLineContract = ProvenFactsContract & {
  openLine: {
    (t: LineTermsArg, lenderSig: string, borrowerSig: string, overrides?: Overrides): Promise<ContractTransactionResponse>;
    staticCall(t: LineTermsArg, lenderSig: string, borrowerSig: string): Promise<string>;
  };
  lineIdOf(t: LineTermsArg): Promise<string>;
  digestOf(t: LineTermsArg): Promise<string>;
  DOMAIN_SEPARATOR(): Promise<string>;
  markDefaulted(lineId: string, overrides?: Overrides): Promise<ContractTransactionResponse>;
  closeUnused(lineId: string, overrides?: Overrides): Promise<ContractTransactionResponse>;
  getLine(lineId: string): Promise<LineResult>;
  owed(lineId: string): Promise<bigint>;
  outstanding(lineId: string): Promise<bigint>;
  available(lineId: string): Promise<bigint>;
  getBorrowerRecord(borrower: string): Promise<BorrowerRecordResult>;
  borrowerLines(borrower: string): Promise<string[]>;
  lenderLines(lender: string): Promise<string[]>;
  nonceUsed(lender: string, nonce: bigint): Promise<boolean>;
};

export type DisputeResult = {
  cardId: string;
  payer: string;
  merchant: string;
  sourceChainId: bigint;
  sourceTxHash: string;
  amount: bigint;
  openedAt: bigint;
  resolvedAt: bigint;
  status: bigint;
  reason: string;
};

export type DisputeRecordResult = {
  opened: bigint;
  upheld: bigint;
  rejected: bigint;
  withdrawn: bigint;
  disputedVolume: bigint;
};

/** `AttestPayLedger` on Creditcoin. */
export type LedgerContract = ProvenFactsContract & {
  getDispute(disputeId: string): Promise<DisputeResult>;
  getDisputeRecord(payer: string): Promise<DisputeRecordResult>;
  payerDisputes(payer: string): Promise<string[]>;
  merchantDisputesReceived(merchant: string): Promise<bigint>;
  cardRevokedAt(cardId: string): Promise<bigint>;
  cardRevokedPayer(cardId: string): Promise<string>;
  wasRevokedAt(cardId: string, at: bigint): Promise<boolean>;
};

/** `AttestPayGuarantee` on Creditcoin. */
export type GuaranteeContract = Contract & {
  bond(borrower: string, overrides?: Overrides & { value: bigint }): Promise<ContractTransactionResponse>;
  requestUnbond(borrower: string, overrides?: Overrides): Promise<ContractTransactionResponse>;
  unbond(borrower: string, overrides?: Overrides): Promise<ContractTransactionResponse>;
  slash: {
    (lineId: string, overrides?: Overrides): Promise<ContractTransactionResponse>;
    staticCall(lineId: string): Promise<bigint>;
  };
  guaranteeOf(borrower: string): Promise<bigint>;
  bondOf(borrower: string, guarantor: string): Promise<{ amount: bigint; unbondRequestedAt: bigint }>;
  guarantorsOf(borrower: string): Promise<string[]>;
  slashedForLine(lineId: string): Promise<bigint>;
  UNBOND_DELAY(): Promise<bigint>;
};

export type PassportResult = {
  account: string;
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

/** `CreditPassport` on Creditcoin. */
export type PassportContract = Contract & {
  passportOf(account: string): Promise<PassportResult>;
  scoreOf(account: string): Promise<[bigint, string]>;
  formula(): Promise<string>;
  VERSION(): Promise<string>;
};
