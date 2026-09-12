// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvenTxDecoder} from "../src/ProvenTxDecoder.sol";

/// @notice Builds `encodedTransaction` blobs in the exact shape the Attestcoin prover
/// API returns, so tests exercise the real wire format instead of a convenient fiction.
/// @dev Mirrors `abiEncode` from the gluwa/usc-sdk npm package at 0.18.0
/// (`dist/encoding/abi/v1.js`): the outer value is `abi.encode(uint8 txType, bytes[]
/// chunks)` and the LAST chunk is always
/// `abi.encode(uint8 status, uint64 gasUsed, (address,bytes32[],bytes)[] logs, bytes logsBloom)`.
library AttestcoinEncoding {
    /// @notice Encodes a receipt chunk.
    function receiptChunk(uint8 status, ProvenTxDecoder.Log[] memory logs)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(status, uint64(21000), logs, new bytes(256));
    }

    /// @notice Encodes a full type-2 (EIP-1559) transaction blob: 3 chunks, receipt last.
    function encodeType2(uint8 status, ProvenTxDecoder.Log[] memory logs)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory chunks = new bytes[](3);
        chunks[0] = abi.encode(
            uint64(7), uint64(500000), address(0xBEEF), false, address(0xCAFE), uint256(0), hex"1234"
        );
        chunks[1] = abi.encode(uint64(11155111), uint128(1), uint128(2));
        chunks[2] = receiptChunk(status, logs);
        return abi.encode(uint8(2), chunks);
    }

    /// @notice Encodes a full type-4 (EIP-7702) transaction blob: 4 chunks, receipt last.
    /// @dev Exists so the decoder's "last chunk, whatever the type" rule is actually
    /// tested against a differing chunk count, not just asserted in a comment.
    function encodeType4(uint8 status, ProvenTxDecoder.Log[] memory logs)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory chunks = new bytes[](4);
        chunks[0] = abi.encode(
            uint64(7), uint64(500000), address(0xBEEF), false, address(0xCAFE), uint256(0), hex"1234"
        );
        chunks[1] = abi.encode(uint64(11155111), uint128(1), uint128(2));
        chunks[2] = abi.encode(uint8(0), bytes32(0), bytes32(0));
        chunks[3] = receiptChunk(status, logs);
        return abi.encode(uint8(4), chunks);
    }

    /// @notice Builds a `PaymentAnchored` log as `PaymentAnchor` would emit it.
    function anchoredLog(
        address emitter,
        bytes32 topic0,
        bytes32 cardId,
        address payer,
        address merchant,
        uint256 amount,
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 paidAt,
        address anchoredBy,
        string memory memo
    ) internal pure returns (ProvenTxDecoder.Log memory log) {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = topic0;
        topics[1] = cardId;
        topics[2] = bytes32(uint256(uint160(payer)));
        topics[3] = bytes32(uint256(uint160(merchant)));
        log = ProvenTxDecoder.Log({
            emitter: emitter,
            topics: topics,
            data: abi.encode(amount, sourceChainId, sourceTxHash, paidAt, anchoredBy, memo)
        });
    }

    /// @notice A log from some other contract, to prove the ASC ignores noise.
    function unrelatedLog(address emitter) internal pure returns (ProvenTxDecoder.Log memory log) {
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = keccak256("Transfer(address,address,uint256)");
        log = ProvenTxDecoder.Log({emitter: emitter, topics: topics, data: abi.encode(uint256(1))});
    }
}
