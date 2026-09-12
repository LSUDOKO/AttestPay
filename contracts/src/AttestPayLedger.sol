// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvenFacts} from "./ProvenFacts.sol";
import {ProvenTxDecoder} from "./ProvenTxDecoder.sol";

/// @title AttestPayLedger — proven disputes and card revocations on Creditcoin
/// @notice Two kinds of fact that a payment history is dishonest without:
///
///   DISPUTES. Payments are irreversible, so the only recourse is a record. A dispute
///   is opened against one payment and resolved to upheld / rejected / withdrawn.
///   The counts feed the passport: an agent with many upheld disputes against it is
///   a different credit risk from one with none, however large its volume.
///
///   REVOCATIONS. `AttestPayASC.revokeCardTerms` flips a flag when the terms owner
///   asks; that records that a card was revoked, not WHEN in a way a counterparty
///   can check against a payment. Proving the revocation with its timestamp gives
///   every merchant a checkable answer to "was this card live when it paid me?":
///   `paidAt < revokedAt`.
///
/// Both come through `FactAnchor` and are consumed here from proven bytes, with the
/// trusted-anchorer rule inherited from `ProvenFacts`.
contract AttestPayLedger is ProvenFacts {
    enum DisputeStatus {
        None,
        Open,
        Upheld,
        Rejected,
        Withdrawn
    }

    struct Dispute {
        bytes32 cardId;
        address payer;
        address merchant;
        uint256 sourceChainId;
        bytes32 sourceTxHash;
        uint256 amount;
        uint256 openedAt;
        uint256 resolvedAt;
        DisputeStatus status;
        string reason;
    }

    /// @notice A payer's aggregate dispute record.
    struct DisputeRecord {
        uint256 opened;
        uint256 upheld;
        uint256 rejected;
        uint256 withdrawn;
        uint256 disputedVolume;
    }

    /// @dev `keccak256("DisputeOpened(bytes32,bytes32,address,address,uint256,bytes32,uint256,uint256,address,string)")`
    bytes32 public constant DISPUTE_OPENED_TOPIC =
        keccak256("DisputeOpened(bytes32,bytes32,address,address,uint256,bytes32,uint256,uint256,address,string)");
    /// @dev `keccak256("DisputeResolved(bytes32,bytes32,address,uint8,uint256,address)")`
    bytes32 public constant DISPUTE_RESOLVED_TOPIC =
        keccak256("DisputeResolved(bytes32,bytes32,address,uint8,uint256,address)");
    /// @dev `keccak256("CardRevoked(bytes32,address,uint256,address)")`
    bytes32 public constant CARD_REVOKED_TOPIC = keccak256("CardRevoked(bytes32,address,uint256,address)");

    mapping(bytes32 => Dispute) private _disputes;
    mapping(address => DisputeRecord) private _payerDisputes;
    mapping(address => bytes32[]) private _payerDisputeIds;
    mapping(address => uint256) public merchantDisputesReceived;

    /// @notice When a card was revoked (unix seconds), 0 if never proven revoked.
    mapping(bytes32 => uint256) public cardRevokedAt;
    /// @notice The funding account a revoked card belonged to.
    mapping(bytes32 => address) public cardRevokedPayer;

    event DisputeRecorded(bytes32 indexed disputeId, bytes32 indexed cardId, address indexed payer, uint256 amount);
    event DisputeOutcome(bytes32 indexed disputeId, address indexed payer, DisputeStatus status);
    event RevocationRecorded(bytes32 indexed cardId, address indexed payer, uint256 revokedAt);

    error MalformedLog();
    error DisputeExists(bytes32 disputeId);
    error DisputeNotOpen(bytes32 disputeId);
    error UnknownOutcome(uint8 outcome);
    error AlreadyRevoked(bytes32 cardId);

    constructor(uint64 _sourceChainKey, address _factAnchor, address _trustedAnchorer, address _blockProver)
        ProvenFacts(_sourceChainKey, _factAnchor, _trustedAnchorer, _blockProver)
    {}

    function _understands(bytes32 topic0) internal pure override returns (bool) {
        return topic0 == DISPUTE_OPENED_TOPIC || topic0 == DISPUTE_RESOLVED_TOPIC || topic0 == CARD_REVOKED_TOPIC;
    }

    function _consumeLog(ProvenTxDecoder.Log memory log, uint64) internal override {
        bytes32 topic0 = log.topics[0];
        if (topic0 == DISPUTE_OPENED_TOPIC) _opened(log);
        else if (topic0 == DISPUTE_RESOLVED_TOPIC) _resolved(log);
        else _revoked(log);
    }

    /// @dev Decoded `DisputeOpened`, as a struct for stack headroom.
    struct Opened {
        bytes32 disputeId;
        bytes32 cardId;
        address payer;
        address merchant;
        uint256 sourceChainId;
        bytes32 sourceTxHash;
        uint256 amount;
        uint256 at;
        address anchoredBy;
        string reason;
    }

    function _decodeOpened(ProvenTxDecoder.Log memory log) private pure returns (Opened memory ev) {
        ev.disputeId = log.topics[1];
        ev.cardId = log.topics[2];
        ev.payer = ProvenTxDecoder.topicToAddress(log.topics[3]);
        (ev.merchant, ev.sourceChainId, ev.sourceTxHash, ev.amount, ev.at, ev.anchoredBy, ev.reason) =
            abi.decode(log.data, (address, uint256, bytes32, uint256, uint256, address, string));
    }

    function _opened(ProvenTxDecoder.Log memory log) private {
        if (log.topics.length != 4) revert MalformedLog();
        Opened memory ev = _decodeOpened(log);
        _requireTrusted(ev.anchoredBy);
        if (_disputes[ev.disputeId].status != DisputeStatus.None) revert DisputeExists(ev.disputeId);

        _disputes[ev.disputeId] = Dispute({
            cardId: ev.cardId,
            payer: ev.payer,
            merchant: ev.merchant,
            sourceChainId: ev.sourceChainId,
            sourceTxHash: ev.sourceTxHash,
            amount: ev.amount,
            openedAt: ev.at,
            resolvedAt: 0,
            status: DisputeStatus.Open,
            reason: ev.reason
        });
        DisputeRecord storage rec = _payerDisputes[ev.payer];
        rec.opened += 1;
        rec.disputedVolume += ev.amount;
        _payerDisputeIds[ev.payer].push(ev.disputeId);
        merchantDisputesReceived[ev.merchant] += 1;
        emit DisputeRecorded(ev.disputeId, ev.cardId, ev.payer, ev.amount);
    }

    function _resolved(ProvenTxDecoder.Log memory log) private {
        if (log.topics.length != 4) revert MalformedLog();
        bytes32 disputeId = log.topics[1];
        address payer = ProvenTxDecoder.topicToAddress(log.topics[3]);
        (uint8 outcome, uint256 at, address anchoredBy) = abi.decode(log.data, (uint8, uint256, address));
        _requireTrusted(anchoredBy);

        Dispute storage d = _disputes[disputeId];
        if (d.status != DisputeStatus.Open) revert DisputeNotOpen(disputeId);

        DisputeRecord storage rec = _payerDisputes[payer];
        if (outcome == 1) {
            d.status = DisputeStatus.Upheld;
            rec.upheld += 1;
        } else if (outcome == 2) {
            d.status = DisputeStatus.Rejected;
            rec.rejected += 1;
        } else if (outcome == 3) {
            d.status = DisputeStatus.Withdrawn;
            rec.withdrawn += 1;
        } else {
            revert UnknownOutcome(outcome);
        }
        d.resolvedAt = at;
        emit DisputeOutcome(disputeId, payer, d.status);
    }

    function _revoked(ProvenTxDecoder.Log memory log) private {
        if (log.topics.length != 3) revert MalformedLog();
        bytes32 cardId = log.topics[1];
        address payer = ProvenTxDecoder.topicToAddress(log.topics[2]);
        (uint256 revokedAt, address anchoredBy) = abi.decode(log.data, (uint256, address));
        _requireTrusted(anchoredBy);
        if (cardRevokedAt[cardId] != 0) revert AlreadyRevoked(cardId);
        cardRevokedAt[cardId] = revokedAt;
        cardRevokedPayer[cardId] = payer;
        emit RevocationRecorded(cardId, payer, revokedAt);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getDispute(bytes32 disputeId) external view returns (Dispute memory) {
        return _disputes[disputeId];
    }

    function getDisputeRecord(address payer) external view returns (DisputeRecord memory) {
        return _payerDisputes[payer];
    }

    function payerDisputes(address payer) external view returns (bytes32[] memory) {
        return _payerDisputeIds[payer];
    }

    /// @notice Whether a card had already been revoked at `at`. False for a card with
    /// no proven revocation — which is "not known to be revoked", not "known live";
    /// pair with `AttestPayASC.getCardTerms` for the registration side.
    function wasRevokedAt(bytes32 cardId, uint256 at) external view returns (bool) {
        uint256 r = cardRevokedAt[cardId];
        return r != 0 && at >= r;
    }
}
