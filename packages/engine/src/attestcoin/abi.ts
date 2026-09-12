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
