// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvenTxDecoder} from "../src/ProvenTxDecoder.sol";

/// @notice Builds `FactAnchor` logs in the exact shape the anchor emits them, for
/// proving into the fact-consuming contracts under test. Topic layouts mirror the
/// events' `indexed` declarations; the tests pin each against a real emission.
library FactEncoding {
    bytes32 constant CREDIT_DRAWN =
        keccak256("CreditDrawn(bytes32,address,address,uint256,uint256,bytes32,uint256,address)");
    bytes32 constant CREDIT_REPAID =
        keccak256("CreditRepaid(bytes32,address,address,uint256,uint256,bytes32,uint256,address)");
    bytes32 constant DISPUTE_OPENED =
        keccak256("DisputeOpened(bytes32,bytes32,address,address,uint256,bytes32,uint256,uint256,address,string)");
    bytes32 constant DISPUTE_RESOLVED = keccak256("DisputeResolved(bytes32,bytes32,address,uint8,uint256,address)");
    bytes32 constant CARD_REVOKED = keccak256("CardRevoked(bytes32,address,uint256,address)");

    function transferLog(
        bytes32 topic0,
        address emitter,
        bytes32 lineId,
        address borrower,
        address lender,
        uint256 amount,
        bytes32 sourceTxHash,
        uint256 at,
        address anchoredBy
    ) internal pure returns (ProvenTxDecoder.Log memory log) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = topic0;
        topics[1] = lineId;
        topics[2] = bytes32(uint256(uint160(borrower)));
        topics[3] = bytes32(uint256(uint160(lender)));
        log = ProvenTxDecoder.Log({
            emitter: emitter, topics: topics, data: abi.encode(amount, uint256(8453), sourceTxHash, at, anchoredBy)
        });
    }

    function disputeOpenedLog(
        address emitter,
        bytes32 disputeId,
        bytes32 cardId,
        address payer,
        address merchant,
        bytes32 sourceTxHash,
        uint256 amount,
        uint256 at,
        address anchoredBy,
        string memory reason
    ) internal pure returns (ProvenTxDecoder.Log memory log) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = DISPUTE_OPENED;
        topics[1] = disputeId;
        topics[2] = cardId;
        topics[3] = bytes32(uint256(uint160(payer)));
        log = ProvenTxDecoder.Log({
            emitter: emitter,
            topics: topics,
            data: abi.encode(merchant, uint256(8453), sourceTxHash, amount, at, anchoredBy, reason)
        });
    }

    function disputeResolvedLog(
        address emitter,
        bytes32 disputeId,
        bytes32 cardId,
        address payer,
        uint8 outcome,
        uint256 at,
        address anchoredBy
    ) internal pure returns (ProvenTxDecoder.Log memory log) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = DISPUTE_RESOLVED;
        topics[1] = disputeId;
        topics[2] = cardId;
        topics[3] = bytes32(uint256(uint160(payer)));
        log = ProvenTxDecoder.Log({emitter: emitter, topics: topics, data: abi.encode(outcome, at, anchoredBy)});
    }

    function cardRevokedLog(address emitter, bytes32 cardId, address payer, uint256 revokedAt, address anchoredBy)
        internal
        pure
        returns (ProvenTxDecoder.Log memory log)
    {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = CARD_REVOKED;
        topics[1] = cardId;
        topics[2] = bytes32(uint256(uint160(payer)));
        log = ProvenTxDecoder.Log({emitter: emitter, topics: topics, data: abi.encode(revokedAt, anchoredBy)});
    }

    /// @notice Wraps logs in a type-2 transaction blob (receipt last), status 1.
    function encode(ProvenTxDecoder.Log[] memory logs) internal pure returns (bytes memory) {
        bytes[] memory chunks = new bytes[](3);
        chunks[0] =
            abi.encode(uint64(7), uint64(500000), address(0xBEEF), false, address(0xCAFE), uint256(0), hex"1234");
        chunks[1] = abi.encode(uint64(11155111), uint128(1), uint128(2));
        chunks[2] = abi.encode(uint8(1), uint64(21000), logs, new bytes(256));
        return abi.encode(uint8(2), chunks);
    }

    function one(ProvenTxDecoder.Log memory a) internal pure returns (ProvenTxDecoder.Log[] memory l) {
        l = new ProvenTxDecoder.Log[](1);
        l[0] = a;
    }
}
