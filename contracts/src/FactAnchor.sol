// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FactAnchor — the AttestPay source-chain anchor for everything that is not a payment
/// @notice `PaymentAnchor` records payments. This contract records the OTHER facts
/// AttestPay proves into Creditcoin: credit-line draws and repayments, payment
/// disputes and their resolutions, and card revocations. Each is an event on a chain
/// the Attestcoin attestor network watches, so a Creditcoin contract can prove it
/// happened and decode its fields out of the proven bytes.
///
/// Same trust model as `PaymentAnchor`, stated once here and not softened elsewhere:
///
///   PROVEN, no oracle trusted: that an event with exactly these values was included
///   in an attested block. The consuming ASC decodes the values from the proven
///   transaction, so nobody can alter them in flight.
///
///   NOT proven: that the underlying Base transfer (a draw, a repayment) happened.
///   The anchorer asserts it, `sourceTxHash` lets anyone check it, and `anchoredBy`
///   names who made the claim. Consumers credit only anchorers they trust.
///
/// One contract for several fact kinds, rather than one contract per kind, so a single
/// address is what every consumer has to trust and a single deployment is what an
/// operator has to fund. Each kind keeps its own replay guard, because "this draw was
/// already anchored" and "this dispute was already opened" are different questions.
contract FactAnchor {
    // -----------------------------------------------------------------------
    // Credit lines
    // -----------------------------------------------------------------------

    /// @notice A lender's USDC reached a borrower under a credit line.
    /// @param lineId The line's id on `AttestPayCreditLine` (its EIP-712 struct hash).
    /// @param borrower The account that received the funds.
    /// @param lender The account the funds left.
    /// @param amount USDC atoms (6 decimals).
    /// @param sourceChainId EVM chain id the USDC moved on.
    /// @param sourceTxHash The transfer's transaction hash on `sourceChainId`.
    /// @param at Unix seconds the transfer confirmed.
    /// @param anchoredBy Whoever submitted this anchor (`msg.sender`).
    event CreditDrawn(
        bytes32 indexed lineId,
        address indexed borrower,
        address indexed lender,
        uint256 amount,
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 at,
        address anchoredBy
    );

    /// @notice A borrower repaid part or all of a credit line.
    event CreditRepaid(
        bytes32 indexed lineId,
        address indexed borrower,
        address indexed lender,
        uint256 amount,
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 at,
        address anchoredBy
    );

    // -----------------------------------------------------------------------
    // Disputes
    // -----------------------------------------------------------------------

    /// @notice A payment was disputed.
    /// @param disputeId Caller-chosen id (AttestPay uses `keccak256(dispute row id)`).
    /// @param cardId The paying card, as `keccak256(bytes(card.id))`.
    /// @param payer The card tree's funding account.
    /// @param merchant Recipient of the disputed payment.
    /// @param sourceChainId Chain the disputed payment moved on.
    /// @param sourceTxHash The disputed payment's transaction hash.
    /// @param amount The disputed amount, USDC atoms.
    /// @param at Unix seconds the dispute was opened.
    /// @param reason Free-text reason.
    event DisputeOpened(
        bytes32 indexed disputeId,
        bytes32 indexed cardId,
        address indexed payer,
        address merchant,
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 amount,
        uint256 at,
        address anchoredBy,
        string reason
    );

    /// @notice A dispute reached an outcome.
    /// @param outcome 1 = upheld (the payer's complaint stood), 2 = rejected, 3 = withdrawn.
    event DisputeResolved(
        bytes32 indexed disputeId,
        bytes32 indexed cardId,
        address indexed payer,
        uint8 outcome,
        uint256 at,
        address anchoredBy
    );

    // -----------------------------------------------------------------------
    // Revocations
    // -----------------------------------------------------------------------

    /// @notice A card was revoked. Proving this gives every counterparty a checkable
    /// answer to "was this card live when it paid me?" — the payment's `paidAt`
    /// against the card's `revokedAt`.
    event CardRevoked(bytes32 indexed cardId, address indexed payer, uint256 revokedAt, address anchoredBy);

    // -----------------------------------------------------------------------
    // Replay guards
    // -----------------------------------------------------------------------

    /// @notice Draws and repayments, keyed by `keccak256(kind, sourceChainId, sourceTxHash)`:
    /// one Base transfer must not be anchored twice, or a single repayment would
    /// clear a line twice over.
    mapping(bytes32 => bool) public transferAnchored;
    /// @notice Disputes opened, by id.
    mapping(bytes32 => bool) public disputeOpened;
    /// @notice Disputes resolved, by id.
    mapping(bytes32 => bool) public disputeResolved;
    /// @notice Cards revoked, by id.
    mapping(bytes32 => bool) public cardRevoked;

    uint8 public constant KIND_DRAW = 1;
    uint8 public constant KIND_REPAYMENT = 2;

    uint8 public constant OUTCOME_UPHELD = 1;
    uint8 public constant OUTCOME_REJECTED = 2;
    uint8 public constant OUTCOME_WITHDRAWN = 3;

    error AlreadyAnchored(uint8 kind, uint256 sourceChainId, bytes32 sourceTxHash);
    error DisputeAlreadyOpened(bytes32 disputeId);
    error DisputeNotOpened(bytes32 disputeId);
    error DisputeAlreadyResolved(bytes32 disputeId);
    error CardAlreadyRevoked(bytes32 cardId);
    error ZeroAmount();
    error ZeroSourceTxHash();
    error InvalidOutcome(uint8 outcome);

    // -----------------------------------------------------------------------
    // Anchoring
    // -----------------------------------------------------------------------

    /// @notice Anchors one credit-line draw.
    function anchorDraw(
        bytes32 lineId,
        address borrower,
        address lender,
        uint256 amount,
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 at
    ) external {
        _claimTransfer(KIND_DRAW, amount, sourceChainId, sourceTxHash);
        emit CreditDrawn(lineId, borrower, lender, amount, sourceChainId, sourceTxHash, at, msg.sender);
    }

    /// @notice Anchors one credit-line repayment.
    function anchorRepayment(
        bytes32 lineId,
        address borrower,
        address lender,
        uint256 amount,
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 at
    ) external {
        _claimTransfer(KIND_REPAYMENT, amount, sourceChainId, sourceTxHash);
        emit CreditRepaid(lineId, borrower, lender, amount, sourceChainId, sourceTxHash, at, msg.sender);
    }

    /// @notice Anchors the opening of a dispute.
    function anchorDisputeOpened(
        bytes32 disputeId,
        bytes32 cardId,
        address payer,
        address merchant,
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 amount,
        uint256 at,
        string calldata reason
    ) external {
        if (disputeOpened[disputeId]) revert DisputeAlreadyOpened(disputeId);
        if (sourceTxHash == bytes32(0)) revert ZeroSourceTxHash();
        disputeOpened[disputeId] = true;
        emit DisputeOpened(
            disputeId, cardId, payer, merchant, sourceChainId, sourceTxHash, amount, at, msg.sender, reason
        );
    }

    /// @notice Anchors a dispute's resolution. A dispute can be resolved once, and
    /// only after it was opened here — a resolution with no opening is meaningless.
    function anchorDisputeResolved(bytes32 disputeId, bytes32 cardId, address payer, uint8 outcome, uint256 at)
        external
    {
        if (!disputeOpened[disputeId]) revert DisputeNotOpened(disputeId);
        if (disputeResolved[disputeId]) revert DisputeAlreadyResolved(disputeId);
        if (outcome != OUTCOME_UPHELD && outcome != OUTCOME_REJECTED && outcome != OUTCOME_WITHDRAWN) {
            revert InvalidOutcome(outcome);
        }
        disputeResolved[disputeId] = true;
        emit DisputeResolved(disputeId, cardId, payer, outcome, at, msg.sender);
    }

    /// @notice Anchors a card's revocation. Once: a card dies exactly one time.
    function anchorCardRevoked(bytes32 cardId, address payer, uint256 revokedAt) external {
        if (cardRevoked[cardId]) revert CardAlreadyRevoked(cardId);
        cardRevoked[cardId] = true;
        emit CardRevoked(cardId, payer, revokedAt, msg.sender);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice The replay key for a draw or repayment.
    function transferKey(uint8 kind, uint256 sourceChainId, bytes32 sourceTxHash) public pure returns (bytes32) {
        return keccak256(abi.encode(kind, sourceChainId, sourceTxHash));
    }

    function isTransferAnchored(uint8 kind, uint256 sourceChainId, bytes32 sourceTxHash) external view returns (bool) {
        return transferAnchored[transferKey(kind, sourceChainId, sourceTxHash)];
    }

    function _claimTransfer(uint8 kind, uint256 amount, uint256 sourceChainId, bytes32 sourceTxHash) private {
        if (amount == 0) revert ZeroAmount();
        if (sourceTxHash == bytes32(0)) revert ZeroSourceTxHash();
        bytes32 key = transferKey(kind, sourceChainId, sourceTxHash);
        if (transferAnchored[key]) revert AlreadyAnchored(kind, sourceChainId, sourceTxHash);
        transferAnchored[key] = true;
    }
}
