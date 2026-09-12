// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBlockProver, AttestcoinPrecompiles} from "./IBlockProver.sol";
import {ProvenTxDecoder} from "./ProvenTxDecoder.sol";

/// @title ProvenFacts — the shared proof-consuming core of AttestPay's Creditcoin contracts
/// @notice `AttestPayASC` proves payments. The contracts built on this base prove
/// the other facts `FactAnchor` records: credit-line events, disputes, revocations.
/// The proving discipline is identical and lives here exactly once:
///
///   1. the Block Prover precompile proves the transaction bytes were included in an
///      attested source-chain block (revert or `false` both mean "not proven"),
///   2. the transaction index comes from the precompile's own Merkle-path derivation,
///      never from the caller, so the replay key cannot be forged,
///   3. every fact is decoded out of the PROVEN bytes — `verifyFacts` takes the proof
///      and nothing else, for the same reason `verifyPayment` does: facts passed next
///      to a proof are not proven by it,
///   4. only logs emitted by the configured `factAnchor` are considered, and only
///      those whose `anchoredBy` is the configured `trustedAnchorer` are credited.
///
/// A subclass implements `_consumeLog` for the topics it understands and returns
/// false for the rest, so one anchoring transaction carrying several kinds of fact
/// can be proven into each consumer independently.
abstract contract ProvenFacts {
    /// @notice Attestcoin source-chain key this contract accepts proofs for.
    uint64 public immutable sourceChainKey;

    /// @notice The `FactAnchor` deployment on the source chain. Logs from any other
    /// address are ignored even inside a valid proof.
    address public immutable factAnchor;

    /// @notice The only anchorer whose claims are credited.
    address public immutable trustedAnchorer;

    /// @notice The Block Prover precompile (or a mock, in tests).
    IBlockProver public immutable blockProver;

    /// @notice Replay guard over `(chainKey, height, txIndex, logIndex)`.
    mapping(bytes32 => bool) public provenEvents;

    error ProofRejected();
    error NoRelevantFact(address expectedAnchor);
    error UntrustedAnchorer(address actual, address expected);
    error ZeroAddress();

    constructor(uint64 _sourceChainKey, address _factAnchor, address _trustedAnchorer, address _blockProver) {
        if (_factAnchor == address(0) || _trustedAnchorer == address(0)) revert ZeroAddress();
        sourceChainKey = _sourceChainKey;
        factAnchor = _factAnchor;
        trustedAnchorer = _trustedAnchorer;
        blockProver = IBlockProver(_blockProver == address(0) ? AttestcoinPrecompiles.BLOCK_PROVER : _blockProver);
    }

    /// @notice Proves a source-chain anchoring transaction and consumes every
    /// relevant `FactAnchor` event in it.
    /// @dev Permissionless, like `verifyPayment`: a valid proof is self-authenticating.
    /// @return recorded How many facts this call newly consumed. Zero means every
    /// relevant event had already been proven.
    function verifyFacts(
        uint64 height,
        bytes calldata encodedTransaction,
        IBlockProver.TransactionMerkleProof calldata merkleProof,
        IBlockProver.ContinuityProof calldata continuityProof
    ) external returns (uint256 recorded) {
        bool proven = blockProver.verify(sourceChainKey, height, encodedTransaction, merkleProof, continuityProof);
        if (!proven) revert ProofRejected();

        uint64 txIndex = blockProver.calculateTxIndex(merkleProof);
        ProvenTxDecoder.Log[] memory logs = ProvenTxDecoder.receiptLogs(encodedTransaction);

        bool sawRelevant;
        for (uint256 i = 0; i < logs.length; i++) {
            ProvenTxDecoder.Log memory log = logs[i];
            if (log.emitter != factAnchor || log.topics.length == 0) continue;
            if (!_understands(log.topics[0])) continue;
            sawRelevant = true;

            bytes32 key = eventKeyOf(sourceChainKey, height, txIndex, i);
            if (provenEvents[key]) continue;
            provenEvents[key] = true;

            _consumeLog(log, height);
            recorded += 1;
        }

        // A proof of a transaction with no fact this contract understands is a caller
        // mistake (wrong consumer, wrong transaction) worth surfacing loudly.
        if (!sawRelevant) revert NoRelevantFact(factAnchor);
    }

    /// @notice The replay key for one anchored event.
    function eventKeyOf(uint64 chainKey, uint64 height, uint64 txIndex, uint256 logIndex)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(chainKey, height, txIndex, logIndex));
    }

    /// @notice Whether a specific anchored event has already been consumed here.
    function isEventProven(uint64 height, uint64 txIndex, uint256 logIndex) external view returns (bool) {
        return provenEvents[eventKeyOf(sourceChainKey, height, txIndex, logIndex)];
    }

    /// @dev Reverts unless the anchorer named in a proven log is the trusted one.
    function _requireTrusted(address anchoredBy) internal view {
        if (anchoredBy != trustedAnchorer) revert UntrustedAnchorer(anchoredBy, trustedAnchorer);
    }

    /// @dev Whether this consumer handles logs with this `topics[0]`.
    function _understands(bytes32 topic0) internal pure virtual returns (bool);

    /// @dev Consumes one log this contract understands. Must revert on any fact that
    /// contradicts recorded state; the replay key is marked before the call so a
    /// revert leaves the whole transaction unrecorded.
    function _consumeLog(ProvenTxDecoder.Log memory log, uint64 height) internal virtual;
}
