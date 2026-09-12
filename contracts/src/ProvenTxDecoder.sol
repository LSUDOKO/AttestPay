// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Decoder for Attestcoin-encoded source transactions
/// @notice Pulls receipt logs back out of the `encodedTransaction` bytes that the
/// Attestcoin Block Prover verifies, so a contract can learn what a proven
/// transaction actually did instead of taking a caller's word for it.
///
/// ENCODING (from the gluwa/usc-sdk npm package at 0.18.0, `dist/encoding/abi/v1.js::abiEncode`):
///
///     encodedTransaction = abi.encode(uint8 txType, bytes[] chunks)
///
/// The chunk layout depends on `txType`, but the RECEIPT is always the LAST chunk:
///
///     txType 0,1,2 -> 3 chunks: [common, typeSpecific, receipt]
///     txType 3,4   -> 4 chunks: [common, typeSpecific1, typeSpecific2, receipt]
///
/// and the receipt chunk is always
///
///     abi.encode(uint8 status, uint64 gasUsed, Log[] logs, bytes logsBloom)
///     where Log = (address emitter, bytes32[] topics, bytes data)
///
/// Taking `chunks[chunks.length - 1]` therefore works for every transaction type
/// without branching on `txType`, which is why this decoder does exactly that.
library ProvenTxDecoder {
    /// @param emitter Contract that emitted the log.
    /// @param topics Indexed topics; `topics[0]` is the event signature hash.
    /// @param data ABI-encoded non-indexed event arguments.
    struct Log {
        address emitter;
        bytes32[] topics;
        bytes data;
    }

    error EmptyChunks();
    error TransactionReverted();

    /// @notice Decodes the receipt logs out of an Attestcoin-encoded transaction.
    /// @dev Reverts when the proven transaction itself REVERTED on the source chain
    /// (`status == 0`). A reverted transaction emits no meaningful logs, and treating
    /// one as a payment record would let a failed payment be recorded as a real one.
    /// @param encodedTransaction The exact bytes handed to `IBlockProver.verify`.
    /// @return logs Every log in the proven transaction's receipt, in emission order.
    function receiptLogs(bytes memory encodedTransaction) internal pure returns (Log[] memory logs) {
        (, bytes[] memory chunks) = abi.decode(encodedTransaction, (uint8, bytes[]));
        if (chunks.length == 0) revert EmptyChunks();

        // The receipt is the last chunk for every supported transaction type.
        bytes memory receiptChunk = chunks[chunks.length - 1];
        (uint8 status,, Log[] memory decoded,) = abi.decode(receiptChunk, (uint8, uint64, Log[], bytes));

        // EIP-658: status 1 = success, 0 = reverted.
        if (status == 0) revert TransactionReverted();
        return decoded;
    }

    /// @notice Finds the first log emitted by `emitter` whose `topics[0]` is `topic0`.
    /// @return found True when such a log exists.
    /// @return index Position of the match within `logs` (meaningless when !found).
    function findLog(Log[] memory logs, address emitter, bytes32 topic0)
        internal
        pure
        returns (bool found, uint256 index)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            Log memory log = logs[i];
            if (log.emitter == emitter && log.topics.length > 0 && log.topics[0] == topic0) {
                return (true, i);
            }
        }
        return (false, 0);
    }

    /// @dev Reads an indexed `address` topic. Topics are left-padded to 32 bytes.
    function topicToAddress(bytes32 topic) internal pure returns (address) {
        return address(uint160(uint256(topic)));
    }
}
