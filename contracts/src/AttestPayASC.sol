// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBlockProver, AttestcoinPrecompiles} from "./IBlockProver.sol";
import {ProvenTxDecoder} from "./ProvenTxDecoder.sol";

/// @title AttestPayASC — AttestPay's Attestcoin Smart Contract
/// @notice Turns AttestPay card payments into cross-chain-verified, on-chain credit
/// history on Creditcoin. Proofs are checked synchronously by the Attestcoin Block
/// Prover precompile in the same transaction that records the result; no oracle, no
/// bridge, no off-chain signer is trusted.
///
/// THE ONE DESIGN RULE THAT MATTERS
///
/// `verifyPayment` takes the proof and NOTHING ELSE about the payment. Every recorded
/// field — card, payer, merchant, amount, memo, timestamps — is decoded out of the
/// transaction bytes the precompile just proved. The obvious-looking alternative,
/// accepting `(proof, cardId, amount, ...)` as parallel arguments, is unsound: a valid
/// proof of ANY attested transaction would let a caller staple arbitrary payment data
/// to it and mint credit history from nothing. Here the proof and the facts cannot be
/// separated, because the facts ARE the proven bytes.
///
/// REPLAY PROTECTION
///
/// Keyed on `(chainKey, height, txIndex, logIndex)`, all four derived from proven data
/// — `txIndex` comes from the precompile's own `calculateTxIndex`, never from the
/// caller. A single anchoring transaction carrying several `PaymentAnchored` events
/// therefore records each event exactly once.
contract AttestPayASC {
    using ProvenTxDecoder for ProvenTxDecoder.Log[];

    // -----------------------------------------------------------------------
    // Configuration (immutable: the trust anchors must not be swappable)
    // -----------------------------------------------------------------------

    /// @notice Attestcoin source-chain key this ASC accepts proofs for.
    /// 1 = Ethereum Sepolia, 3 = Ethereum mainnet on CC3 testnet.
    uint64 public immutable sourceChainKey;

    /// @notice The `PaymentAnchor` deployment on the source chain. A log from any
    /// other address is ignored even inside a perfectly valid proof, so an attacker
    /// cannot deploy a look-alike anchor and prove its events into this registry.
    address public immutable paymentAnchor;

    /// @notice The only anchorer whose claims this ASC credits. The proof establishes
    /// what the anchor recorded, not that the underlying Base payment happened, so the
    /// party making that off-chain claim is pinned here rather than left open.
    address public immutable trustedAnchorer;

    /// @notice The Block Prover precompile. Configurable solely so tests can install a
    /// mock; production deployments leave it at the canonical precompile address.
    IBlockProver public immutable blockProver;

    /// @dev `keccak256("PaymentAnchored(bytes32,address,address,uint256,uint256,bytes32,uint256,address,string)")`
    /// Must match `PaymentAnchor.PaymentAnchored` exactly, including argument order.
    bytes32 public constant PAYMENT_ANCHORED_TOPIC =
        keccak256("PaymentAnchored(bytes32,address,address,uint256,uint256,bytes32,uint256,address,string)");

    // -----------------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------------

    /// @param cardId AttestPay card id as `keccak256(bytes(card.id))`.
    /// @param payer Funding account the USDC left on the source chain.
    /// @param merchant Payment recipient.
    /// @param amount USDC atoms (6 decimals).
    /// @param sourceChainId EVM chain id the USDC moved on.
    /// @param sourceTxHash Payment transaction hash on `sourceChainId`.
    /// @param paidAt Source-chain confirmation time (unix seconds).
    /// @param anchorHeight Attested source-chain height of the anchoring transaction.
    /// @param verifiedAt Creditcoin block timestamp at which the proof was accepted.
    /// @param memo Note carried from the card's charge record.
    struct VerifiedPayment {
        bytes32 cardId;
        address payer;
        address merchant;
        uint256 amount;
        uint256 sourceChainId;
        bytes32 sourceTxHash;
        uint256 paidAt;
        uint64 anchorHeight;
        uint256 verifiedAt;
        string memo;
    }

    /// @param totalPayments Count of distinct verified payments.
    /// @param totalVolume Sum of verified amounts, USDC atoms.
    /// @param firstPaymentAt Earliest `paidAt` seen (history length — the thing that
    /// makes a credit record worth anything).
    /// @param lastPaymentAt Most recent `paidAt` seen.
    /// @param withinTermsPayments Payments that satisfied the card's registered terms
    /// at verification time. Counted only for cards whose terms were registered, so it
    /// is a real signal rather than an automatic 100%.
    /// @param termsCheckedPayments Payments where a terms check was actually possible.
    /// The honest denominator for `withinTermsPayments`.
    struct AgentCredit {
        uint256 totalPayments;
        uint256 totalVolume;
        uint256 firstPaymentAt;
        uint256 lastPaymentAt;
        uint256 withinTermsPayments;
        uint256 termsCheckedPayments;
    }

    /// @param termsHash Hash of the card's full terms JSON, for off-chain audit.
    /// @param periodBudget Per-period spend cap, USDC atoms (0 = unset).
    /// @param periodSeconds Length of a budget period (0 = unset).
    /// @param perTxMax Per-payment cap, USDC atoms (0 = unset).
    /// @param expiresAt Card expiry, unix seconds (0 = never).
    /// @param registeredAt When these terms were registered on Creditcoin.
    /// @param active False once revoked.
    /// @param exists Distinguishes "registered with zero values" from "never registered".
    struct CardTermsRecord {
        bytes32 termsHash;
        uint256 periodBudget;
        uint256 periodSeconds;
        uint256 perTxMax;
        uint256 expiresAt;
        uint256 registeredAt;
        bool active;
        bool exists;
    }

    mapping(bytes32 => VerifiedPayment[]) private _cardPayments;
    mapping(bytes32 => uint256) public totalVerifiedSpend;
    mapping(address => AgentCredit) private _agentCredits;
    mapping(bytes32 => CardTermsRecord) private _cardTerms;

    /// @notice Replay guard over `(chainKey, height, txIndex, logIndex)`.
    mapping(bytes32 => bool) public provenEvents;

    /// @notice Who may register or revoke terms for a card. First registration claims
    /// the card; only that owner may change it afterwards, so one card owner cannot
    /// overwrite another's declared terms.
    mapping(bytes32 => address) public cardTermsOwner;

    // -----------------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------------

    event PaymentVerified(
        bytes32 indexed cardId,
        address indexed payer,
        bytes32 indexed sourceTxHash,
        uint256 amount,
        uint64 anchorHeight,
        bool withinTerms,
        bool termsChecked
    );

    event CreditScoreUpdated(address indexed payer, uint256 totalPayments, uint256 totalVolume);

    event CardTermsRegistered(bytes32 indexed cardId, address indexed owner, bytes32 termsHash);
    event CardTermsRevoked(bytes32 indexed cardId, address indexed owner);

    // -----------------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------------

    error ProofRejected();
    error AnchorLogNotFound(address expectedAnchor);
    error UntrustedAnchorer(address actual, address expected);
    error AlreadyVerified(bytes32 eventKey);
    error NotTermsOwner(bytes32 cardId, address owner);
    error ZeroAddress();

    // -----------------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------------

    /// @param _sourceChainKey Attestcoin chain key of the anchor's chain.
    /// @param _paymentAnchor `PaymentAnchor` address on that chain.
    /// @param _trustedAnchorer The anchorer whose claims this ASC credits.
    /// @param _blockProver Block Prover precompile, or a mock in tests. Pass
    /// `address(0)` to bind the canonical precompile address.
    constructor(uint64 _sourceChainKey, address _paymentAnchor, address _trustedAnchorer, address _blockProver) {
        if (_paymentAnchor == address(0) || _trustedAnchorer == address(0)) revert ZeroAddress();
        sourceChainKey = _sourceChainKey;
        paymentAnchor = _paymentAnchor;
        trustedAnchorer = _trustedAnchorer;
        blockProver = IBlockProver(_blockProver == address(0) ? AttestcoinPrecompiles.BLOCK_PROVER : _blockProver);
    }

    // -----------------------------------------------------------------------
    // Cross-chain verification — the core entry point
    // -----------------------------------------------------------------------

    /// @notice Proves a source-chain anchoring transaction and records every
    /// `PaymentAnchored` event it contains as verified cross-chain payment history.
    /// @dev Permissionless: anyone may relay a proof, because a valid proof is
    /// self-authenticating and the facts come from the proven bytes. Relaying someone
    /// else's proof can only ever record what the anchor truly said.
    /// @param height Attested source-chain block height of the anchoring transaction.
    /// @param encodedTransaction Attestcoin-encoded transaction + receipt
    /// (`txBytes` from the prover API).
    /// @param merkleProof Transaction-inclusion proof within `height`.
    /// @param continuityProof Continuity proof linking `height` to an attested block.
    /// @return recorded How many payments this call newly recorded. Zero means every
    /// event in the transaction had already been verified.
    function verifyPayment(
        uint64 height,
        bytes calldata encodedTransaction,
        IBlockProver.TransactionMerkleProof calldata merkleProof,
        IBlockProver.ContinuityProof calldata continuityProof
    ) external returns (uint256 recorded) {
        // 1. Prove inclusion. The precompile reverts on a bad proof; a `false` return
        //    is handled too rather than assumed impossible.
        bool proven = blockProver.verify(sourceChainKey, height, encodedTransaction, merkleProof, continuityProof);
        if (!proven) revert ProofRejected();

        // 2. Establish WHERE in the attested chain this transaction sits. txIndex is
        //    derived by the precompile from the proven Merkle path, so the replay key
        //    cannot be forged by a caller replaying one proof under a fresh label.
        uint64 txIndex = blockProver.calculateTxIndex(merkleProof);

        // 3. Read the payment facts out of the PROVEN bytes.
        ProvenTxDecoder.Log[] memory logs = ProvenTxDecoder.receiptLogs(encodedTransaction);

        bool sawAnchorLog;
        for (uint256 i = 0; i < logs.length; i++) {
            ProvenTxDecoder.Log memory log = logs[i];
            if (log.emitter != paymentAnchor) continue;
            if (log.topics.length != 4 || log.topics[0] != PAYMENT_ANCHORED_TOPIC) continue;
            sawAnchorLog = true;

            if (_recordFromLog(log, height, txIndex, i)) recorded += 1;
        }

        // A proof of a transaction that never touched the anchor is a caller mistake
        // worth surfacing loudly, not silently accepting as a no-op.
        if (!sawAnchorLog) revert AnchorLogNotFound(paymentAnchor);
    }

    /// @dev One decoded `PaymentAnchored` event. Kept as a struct rather than a pile of
    /// locals because `_recordFromLog` otherwise exceeds the EVM's addressable stack
    /// slots ("Stack too deep") — the same reason the decode is split out of the record.
    struct AnchoredEvent {
        bytes32 cardId;
        address payer;
        address merchant;
        uint256 amount;
        uint256 sourceChainId;
        bytes32 sourceTxHash;
        uint256 paidAt;
        address anchoredBy;
        string memo;
    }

    /// @dev Decodes a `PaymentAnchored` log into its fields. Caller must have already
    /// confirmed the emitter and `topics[0]`, and that `topics.length == 4`.
    function _decodeAnchoredLog(ProvenTxDecoder.Log memory log) private pure returns (AnchoredEvent memory ev) {
        // Indexed arguments live in topics 1..3, in declaration order.
        ev.cardId = log.topics[1];
        ev.payer = ProvenTxDecoder.topicToAddress(log.topics[2]);
        ev.merchant = ProvenTxDecoder.topicToAddress(log.topics[3]);

        // Non-indexed arguments, in declaration order.
        (ev.amount, ev.sourceChainId, ev.sourceTxHash, ev.paidAt, ev.anchoredBy, ev.memo) =
            abi.decode(log.data, (uint256, uint256, bytes32, uint256, address, string));
    }

    /// @dev Decodes one `PaymentAnchored` log and records it. Returns false when this
    /// exact event was already verified (idempotent replay, not an error).
    function _recordFromLog(ProvenTxDecoder.Log memory log, uint64 height, uint64 txIndex, uint256 logIndex)
        private
        returns (bool)
    {
        bytes32 eventKey = eventKeyOf(sourceChainKey, height, txIndex, logIndex);
        if (provenEvents[eventKey]) return false;

        AnchoredEvent memory ev = _decodeAnchoredLog(log);

        // The proof says the anchor recorded this; it does not say the Base payment
        // occurred. Only the configured anchorer's claims become credit history.
        if (ev.anchoredBy != trustedAnchorer) revert UntrustedAnchorer(ev.anchoredBy, trustedAnchorer);

        provenEvents[eventKey] = true;

        (bool withinTerms, bool termsChecked) = _checkTerms(ev.cardId, ev.amount, ev.paidAt);

        _cardPayments[ev.cardId]
        .push(
            VerifiedPayment({
                cardId: ev.cardId,
                payer: ev.payer,
                merchant: ev.merchant,
                amount: ev.amount,
                sourceChainId: ev.sourceChainId,
                sourceTxHash: ev.sourceTxHash,
                paidAt: ev.paidAt,
                anchorHeight: height,
                verifiedAt: block.timestamp,
                memo: ev.memo
            })
        );
        totalVerifiedSpend[ev.cardId] += ev.amount;

        _bumpCredit(ev, withinTerms, termsChecked);

        emit PaymentVerified(ev.cardId, ev.payer, ev.sourceTxHash, ev.amount, height, withinTerms, termsChecked);
        return true;
    }

    /// @dev Folds one verified payment into the payer's running credit record.
    function _bumpCredit(AnchoredEvent memory ev, bool withinTerms, bool termsChecked) private {
        AgentCredit storage credit = _agentCredits[ev.payer];
        credit.totalPayments += 1;
        credit.totalVolume += ev.amount;
        // Anchors can be proven out of order, so track the true extremes rather than
        // assuming this payment is the newest one seen.
        if (credit.firstPaymentAt == 0 || ev.paidAt < credit.firstPaymentAt) {
            credit.firstPaymentAt = ev.paidAt;
        }
        if (ev.paidAt > credit.lastPaymentAt) credit.lastPaymentAt = ev.paidAt;
        if (termsChecked) {
            credit.termsCheckedPayments += 1;
            if (withinTerms) credit.withinTermsPayments += 1;
        }
        emit CreditScoreUpdated(ev.payer, credit.totalPayments, credit.totalVolume);
    }

    /// @dev Checks a verified payment against the card's registered terms, where they
    /// exist. `termsChecked == false` means no terms were registered, so the payment
    /// is neither credited nor penalised — an unregistered card should not score a
    /// free 100% compliance rate.
    function _checkTerms(bytes32 cardId, uint256 amount, uint256 paidAt)
        private
        view
        returns (bool withinTerms, bool termsChecked)
    {
        CardTermsRecord storage terms = _cardTerms[cardId];
        if (!terms.exists) return (false, false);

        // Terms registered AFTER the payment say nothing about whether that payment
        // complied, so they are not retroactively applied.
        if (paidAt < terms.registeredAt) return (false, false);

        if (terms.perTxMax != 0 && amount > terms.perTxMax) return (false, true);
        if (terms.expiresAt != 0 && paidAt > terms.expiresAt) return (false, true);
        // Period budgets are deliberately NOT enforced here: doing it honestly needs
        // the card's period anchor and the spend total inside that window, and a
        // half-checked budget reported as a pass would be worse than an explicit
        // per-payment-only check. perTxMax and expiry are fully checkable, so those
        // are what this contract claims.
        return (true, true);
    }

    /// @notice The replay key for one anchored event.
    function eventKeyOf(uint64 chainKey, uint64 height, uint64 txIndex, uint256 logIndex)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainKey, height, txIndex, logIndex));
    }

    // -----------------------------------------------------------------------
    // Card terms registry
    // -----------------------------------------------------------------------

    /// @notice Registers (or updates) a card's terms so verified payments can be
    /// checked against them. The first registrant claims the card.
    function registerCardTerms(
        bytes32 cardId,
        bytes32 termsHash,
        uint256 periodBudget,
        uint256 periodSeconds,
        uint256 perTxMax,
        uint256 expiresAt
    ) external {
        address owner = cardTermsOwner[cardId];
        if (owner == address(0)) {
            cardTermsOwner[cardId] = msg.sender;
        } else if (owner != msg.sender) {
            revert NotTermsOwner(cardId, owner);
        }

        _cardTerms[cardId] = CardTermsRecord({
            termsHash: termsHash,
            periodBudget: periodBudget,
            periodSeconds: periodSeconds,
            perTxMax: perTxMax,
            expiresAt: expiresAt,
            registeredAt: block.timestamp,
            active: true,
            exists: true
        });
        emit CardTermsRegistered(cardId, msg.sender, termsHash);
    }

    /// @notice Marks a card's terms inactive (the card was revoked upstream).
    function revokeCardTerms(bytes32 cardId) external {
        address owner = cardTermsOwner[cardId];
        if (owner != msg.sender) revert NotTermsOwner(cardId, owner);
        _cardTerms[cardId].active = false;
        emit CardTermsRevoked(cardId, msg.sender);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getCardPaymentCount(bytes32 cardId) external view returns (uint256) {
        return _cardPayments[cardId].length;
    }

    function getCardPayment(bytes32 cardId, uint256 index) external view returns (VerifiedPayment memory) {
        return _cardPayments[cardId][index];
    }

    /// @notice A page of a card's verified payments, newest last.
    /// @dev Paged because an unbounded getter on a long history eventually exceeds the
    /// RPC response limit and stops working exactly when the history is most useful.
    function getCardPayments(bytes32 cardId, uint256 offset, uint256 limit)
        external
        view
        returns (VerifiedPayment[] memory page)
    {
        VerifiedPayment[] storage all = _cardPayments[cardId];
        if (offset >= all.length) return new VerifiedPayment[](0);
        uint256 end = offset + limit;
        if (end > all.length) end = all.length;
        page = new VerifiedPayment[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = all[i];
        }
    }

    function getAgentCredit(address payer) external view returns (AgentCredit memory) {
        return _agentCredits[payer];
    }

    function getCardTerms(bytes32 cardId) external view returns (CardTermsRecord memory) {
        return _cardTerms[cardId];
    }

    /// @notice Whether a specific anchored event has already been verified here.
    function isEventVerified(uint64 height, uint64 txIndex, uint256 logIndex) external view returns (bool) {
        return provenEvents[eventKeyOf(sourceChainKey, height, txIndex, logIndex)];
    }
}
