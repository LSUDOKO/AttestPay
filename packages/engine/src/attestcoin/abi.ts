// Contract ABIs for the Attestcoin integration, as ethers human-readable fragments.
//
// ethers (not viem) is used on this seam deliberately: `@gluwa/usc-sdk` takes an
// ethers `JsonRpcApiProvider` and returns its proof structs as ethers-shaped objects,
// so keeping the Creditcoin/source-chain leg in ethers avoids converting proof structs
// between two ABI encoders — a conversion that would be pure risk for no benefit. The
// rest of AttestPay stays on viem; these two worlds only meet here.

/** `PaymentAnchor` on the source chain (Ethereum Sepolia). */
export const PAYMENT_ANCHOR_ABI = [
  "function anchorPayment(bytes32 cardId, address payer, address merchant, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint256 paidAt, string memo)",
  "function anchorCount(bytes32 cardId) view returns (uint256)",
  "function isAnchored(uint256 sourceChainId, bytes32 sourceTxHash) view returns (bool)",
  "function sourceKey(uint256 sourceChainId, bytes32 sourceTxHash) pure returns (bytes32)",
  "event PaymentAnchored(bytes32 indexed cardId, address indexed payer, address indexed merchant, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint256 paidAt, address anchoredBy, string memo)",
  "error AlreadyAnchored(uint256 sourceChainId, bytes32 sourceTxHash)",
  "error ZeroAmount()",
  "error ZeroSourceTxHash()",
] as const;

/** `AttestPayASC` on Creditcoin.
 *
 * Note `verifyPayment` takes ONLY the proof. There is deliberately no overload that
 * accepts payment fields alongside it: the contract decodes them from the proven
 * transaction bytes, because facts passed next to a proof are not proven by it. */
export const ATTESTPAY_ASC_ABI = [
  // --- verification ---
  "function verifyPayment(uint64 height, bytes encodedTransaction, (bytes32 root, (bytes32 hash, bool isLeft)[] siblings) merkleProof, (bytes32 lowerEndpointDigest, bytes32[] roots) continuityProof) returns (uint256 recorded)",

  // --- config (immutables) ---
  "function sourceChainKey() view returns (uint64)",
  "function paymentAnchor() view returns (address)",
  "function trustedAnchorer() view returns (address)",
  "function blockProver() view returns (address)",
  "function PAYMENT_ANCHORED_TOPIC() view returns (bytes32)",

  // --- reads ---
  "function getCardPaymentCount(bytes32 cardId) view returns (uint256)",
  "function totalVerifiedSpend(bytes32 cardId) view returns (uint256)",
  "function getCardPayment(bytes32 cardId, uint256 index) view returns ((bytes32 cardId, address payer, address merchant, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint256 paidAt, uint64 anchorHeight, uint256 verifiedAt, string memo))",
  "function getCardPayments(bytes32 cardId, uint256 offset, uint256 limit) view returns ((bytes32 cardId, address payer, address merchant, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint256 paidAt, uint64 anchorHeight, uint256 verifiedAt, string memo)[])",
  "function getAgentCredit(address payer) view returns ((uint256 totalPayments, uint256 totalVolume, uint256 firstPaymentAt, uint256 lastPaymentAt, uint256 withinTermsPayments, uint256 termsCheckedPayments))",
  "function getCardTerms(bytes32 cardId) view returns ((bytes32 termsHash, uint256 periodBudget, uint256 periodSeconds, uint256 perTxMax, uint256 expiresAt, uint256 registeredAt, bool active, bool exists))",
  "function isEventVerified(uint64 height, uint64 txIndex, uint256 logIndex) view returns (bool)",
  "function cardTermsOwner(bytes32 cardId) view returns (address)",

  // --- terms registry ---
  "function registerCardTerms(bytes32 cardId, bytes32 termsHash, uint256 periodBudget, uint256 periodSeconds, uint256 perTxMax, uint256 expiresAt)",
  "function revokeCardTerms(bytes32 cardId)",

  // --- events ---
  "event PaymentVerified(bytes32 indexed cardId, address indexed payer, bytes32 indexed sourceTxHash, uint256 amount, uint64 anchorHeight, bool withinTerms, bool termsChecked)",
  "event CreditScoreUpdated(address indexed payer, uint256 totalPayments, uint256 totalVolume)",
  "event CardTermsRegistered(bytes32 indexed cardId, address indexed owner, bytes32 termsHash)",
  "event CardTermsRevoked(bytes32 indexed cardId, address indexed owner)",

  // --- errors (named so failures read as reasons, not raw selectors) ---
  "error ProofRejected()",
  "error AnchorLogNotFound(address expectedAnchor)",
  "error UntrustedAnchorer(address actual, address expected)",
  "error AlreadyVerified(bytes32 eventKey)",
  "error NotTermsOwner(bytes32 cardId, address owner)",
  "error ZeroAddress()",
] as const;

/** The Attestcoin ChainInfo precompile (0x…0fD3).
 *
 * The function names are snake_case. This is worth stating because the SDK's
 * TypeScript wrapper exposes camelCase equivalents, and calling the camelCase
 * spellings against the precompile reverts with "Unknown selector". */
export const CHAIN_INFO_ABI = [
  "function is_height_attested(uint64 chainKey, uint64 height) view returns (bool)",
  "function get_latest_attestation_height_and_hash(uint64 chainKey) view returns ((uint64 height, bytes32 hash, bool isAttestation, bool exists))",
  "function get_supported_chains() view returns ((uint64 chainKey, uint64 chainId, bytes chainName, uint8 chainEncoding)[])",
] as const;

// ---------------------------------------------------------------------------
// Facts: credit lines, disputes, revocations, guarantees, passport
// ---------------------------------------------------------------------------

/** `FactAnchor` on the source chain. */
export const FACT_ANCHOR_ABI = [
  "function anchorDraw(bytes32 lineId, address borrower, address lender, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint256 at)",
  "function anchorRepayment(bytes32 lineId, address borrower, address lender, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint256 at)",
  "function anchorDisputeOpened(bytes32 disputeId, bytes32 cardId, address payer, address merchant, uint256 sourceChainId, bytes32 sourceTxHash, uint256 amount, uint256 at, string reason)",
  "function anchorDisputeResolved(bytes32 disputeId, bytes32 cardId, address payer, uint8 outcome, uint256 at)",
  "function anchorCardRevoked(bytes32 cardId, address payer, uint256 revokedAt)",
  "function isTransferAnchored(uint8 kind, uint256 sourceChainId, bytes32 sourceTxHash) view returns (bool)",
  "function disputeOpened(bytes32 disputeId) view returns (bool)",
  "function disputeResolved(bytes32 disputeId) view returns (bool)",
  "function cardRevoked(bytes32 cardId) view returns (bool)",
  "event CreditDrawn(bytes32 indexed lineId, address indexed borrower, address indexed lender, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint256 at, address anchoredBy)",
  "event CreditRepaid(bytes32 indexed lineId, address indexed borrower, address indexed lender, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash, uint256 at, address anchoredBy)",
  "event DisputeOpened(bytes32 indexed disputeId, bytes32 indexed cardId, address indexed payer, address merchant, uint256 sourceChainId, bytes32 sourceTxHash, uint256 amount, uint256 at, address anchoredBy, string reason)",
  "event DisputeResolved(bytes32 indexed disputeId, bytes32 indexed cardId, address indexed payer, uint8 outcome, uint256 at, address anchoredBy)",
  "event CardRevoked(bytes32 indexed cardId, address indexed payer, uint256 revokedAt, address anchoredBy)",
  "error AlreadyAnchored(uint8 kind, uint256 sourceChainId, bytes32 sourceTxHash)",
  "error DisputeAlreadyOpened(bytes32 disputeId)",
  "error DisputeNotOpened(bytes32 disputeId)",
  "error DisputeAlreadyResolved(bytes32 disputeId)",
  "error CardAlreadyRevoked(bytes32 cardId)",
  "error ZeroAmount()",
  "error ZeroSourceTxHash()",
  "error InvalidOutcome(uint8 outcome)",
] as const;

/** Shared by every `ProvenFacts` consumer. */
const PROVEN_FACTS_ABI = [
  "function verifyFacts(uint64 height, bytes encodedTransaction, (bytes32 root, (bytes32 hash, bool isLeft)[] siblings) merkleProof, (bytes32 lowerEndpointDigest, bytes32[] roots) continuityProof) returns (uint256 recorded)",
  "function sourceChainKey() view returns (uint64)",
  "function factAnchor() view returns (address)",
  "function trustedAnchorer() view returns (address)",
  "function isEventProven(uint64 height, uint64 txIndex, uint256 logIndex) view returns (bool)",
  "error ProofRejected()",
  "error NoRelevantFact(address expectedAnchor)",
  "error UntrustedAnchorer(address actual, address expected)",
  "error ZeroAddress()",
] as const;

const LINE_TUPLE =
  "((address lender, address borrower, uint256 limit, uint256 interestBps, uint256 expiresAt, uint256 nonce) terms, uint8 status, uint256 drawn, uint256 repaid, uint256 openedAt, uint256 lastEventAt, uint256 defaultedAt, uint256 repaidAt)";

/** `AttestPayCreditLine` on Creditcoin. */
export const CREDIT_LINE_ABI = [
  ...PROVEN_FACTS_ABI,
  "function openLine((address lender, address borrower, uint256 limit, uint256 interestBps, uint256 expiresAt, uint256 nonce) t, bytes lenderSig, bytes borrowerSig) returns (bytes32 lineId)",
  "function lineIdOf((address lender, address borrower, uint256 limit, uint256 interestBps, uint256 expiresAt, uint256 nonce) t) pure returns (bytes32)",
  "function digestOf((address lender, address borrower, uint256 limit, uint256 interestBps, uint256 expiresAt, uint256 nonce) t) view returns (bytes32)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function markDefaulted(bytes32 lineId)",
  "function closeUnused(bytes32 lineId)",
  `function getLine(bytes32 lineId) view returns (${LINE_TUPLE})`,
  "function owed(bytes32 lineId) view returns (uint256)",
  "function outstanding(bytes32 lineId) view returns (uint256)",
  "function available(bytes32 lineId) view returns (uint256)",
  "function getBorrowerRecord(address borrower) view returns ((uint256 linesOpened, uint256 linesRepaid, uint256 linesDefaulted, uint256 totalDrawn, uint256 totalRepaid))",
  "function borrowerLines(address borrower) view returns (bytes32[])",
  "function lenderLines(address lender) view returns (bytes32[])",
  "function nonceUsed(address lender, uint256 nonce) view returns (bool)",
  "event LineOpened(bytes32 indexed lineId, address indexed lender, address indexed borrower, uint256 limit, uint256 expiresAt)",
  "event LineDrawn(bytes32 indexed lineId, uint256 amount, uint256 drawn, bytes32 sourceTxHash)",
  "event LineRepaid(bytes32 indexed lineId, uint256 amount, uint256 repaid, bytes32 sourceTxHash)",
  "event LineFullyRepaid(bytes32 indexed lineId)",
  "event LineDefaulted(bytes32 indexed lineId, uint256 outstanding)",
  "event LineClosed(bytes32 indexed lineId)",
  "error InvalidTerms(string reason)",
  "error InvalidSignature(string which)",
  "error NonceUsed(address lender, uint256 nonce)",
  "error LineExists(bytes32 lineId)",
  "error UnknownLine(bytes32 lineId)",
  "error WrongStatus(bytes32 lineId, uint8 status)",
  "error PartyMismatch(bytes32 lineId)",
  "error DrawExceedsLimit(bytes32 lineId, uint256 drawn, uint256 amount, uint256 limit)",
  "error LineExpired(bytes32 lineId, uint256 at, uint256 expiresAt)",
  "error NotExpired(bytes32 lineId)",
  "error NothingOutstanding(bytes32 lineId)",
] as const;

/** `AttestPayLedger` on Creditcoin. */
export const LEDGER_ABI = [
  ...PROVEN_FACTS_ABI,
  "function getDispute(bytes32 disputeId) view returns ((bytes32 cardId, address payer, address merchant, uint256 sourceChainId, bytes32 sourceTxHash, uint256 amount, uint256 openedAt, uint256 resolvedAt, uint8 status, string reason))",
  "function getDisputeRecord(address payer) view returns ((uint256 opened, uint256 upheld, uint256 rejected, uint256 withdrawn, uint256 disputedVolume))",
  "function payerDisputes(address payer) view returns (bytes32[])",
  "function merchantDisputesReceived(address merchant) view returns (uint256)",
  "function cardRevokedAt(bytes32 cardId) view returns (uint256)",
  "function cardRevokedPayer(bytes32 cardId) view returns (address)",
  "function wasRevokedAt(bytes32 cardId, uint256 at) view returns (bool)",
  "event DisputeRecorded(bytes32 indexed disputeId, bytes32 indexed cardId, address indexed payer, uint256 amount)",
  "event DisputeOutcome(bytes32 indexed disputeId, address indexed payer, uint8 status)",
  "event RevocationRecorded(bytes32 indexed cardId, address indexed payer, uint256 revokedAt)",
  "error MalformedLog()",
  "error DisputeExists(bytes32 disputeId)",
  "error DisputeNotOpen(bytes32 disputeId)",
  "error UnknownOutcome(uint8 outcome)",
  "error AlreadyRevoked(bytes32 cardId)",
] as const;

/** `AttestPayGuarantee` on Creditcoin. */
export const GUARANTEE_ABI = [
  "function bond(address borrower) payable",
  "function requestUnbond(address borrower)",
  "function unbond(address borrower)",
  "function slash(bytes32 lineId) returns (uint256 paid)",
  "function guaranteeOf(address borrower) view returns (uint256)",
  "function bondOf(address borrower, address guarantor) view returns ((uint256 amount, uint256 unbondRequestedAt))",
  "function guarantorsOf(address borrower) view returns (address[])",
  "function slashedForLine(bytes32 lineId) view returns (uint256)",
  "function UNBOND_DELAY() view returns (uint256)",
  "event Bonded(address indexed borrower, address indexed guarantor, uint256 amount, uint256 total)",
  "event Slashed(bytes32 indexed lineId, address indexed borrower, address indexed lender, uint256 amount)",
  "error NoBond()",
  "error UnbondNotRequested()",
  "error UnbondTooEarly(uint256 availableAt)",
  "error LineNotDefaulted(bytes32 lineId)",
  "error NothingToSlash(bytes32 lineId)",
] as const;

/** `CreditPassport` on Creditcoin. */
export const PASSPORT_ABI = [
  "function passportOf(address account) view returns ((address account, uint256 verifiedPayments, uint256 verifiedVolume, uint256 firstPaymentAt, uint256 lastPaymentAt, uint256 withinTermsPayments, uint256 termsCheckedPayments, uint256 linesOpened, uint256 linesRepaid, uint256 linesDefaulted, uint256 totalDrawn, uint256 totalRepaid, uint256 disputesOpened, uint256 disputesUpheld, uint256 disputesRejected, uint256 disputedVolume, uint256 guaranteeBonded, uint256 score, string grade, uint256 asOf))",
  "function scoreOf(address account) view returns (uint256 score, string grade)",
  "function formula() pure returns (string)",
  "function VERSION() view returns (string)",
] as const;
