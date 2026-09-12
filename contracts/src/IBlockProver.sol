// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Attestcoin Block Prover precompile interface
/// @notice The REAL interface of the Creditcoin Block Prover precompile, transcribed
/// from the gluwa/usc-sdk npm package at 0.18.0 (`dist/block-prover/block_prover.json`). Two things
/// differ from most write-ups of this precompile and both matter:
///
///  1. `verify` returns a BARE `bool` — it does NOT hand back the proven transaction's
///     bytes. A consumer that wants the transaction's contents must supply them and
///     have the precompile confirm they are the proven ones (which is exactly what
///     passing `encodedTransaction` does: the precompile re-derives the Merkle leaf
///     from these bytes, so bytes that don't match the attested block fail the proof).
///  2. The precompile REVERTS on a failed verification rather than returning false.
///     Callers must treat a revert as "not proven", not as an infrastructure fault.
///
/// Because of (1), the ONLY trustworthy way to learn what a proven transaction did is
/// to decode `encodedTransaction` yourself after the proof passes. Accepting the facts
/// as separate arguments alongside a proof would let any caller attach true-looking
/// data to a valid proof of an unrelated transaction.
interface IBlockProver {
    /// @param hash Sibling node hash.
    /// @param isLeft True when the sibling sits on the left of the path.
    struct MerkleProofEntry {
        bytes32 hash;
        bool isLeft;
    }

    /// @param root Merkle root of the source block's transactions.
    /// @param siblings Path from the transaction leaf up to `root`.
    struct TransactionMerkleProof {
        bytes32 root;
        MerkleProofEntry[] siblings;
    }

    /// @param lowerEndpointDigest Digest of the block before the continuity chain starts.
    /// @param roots Merkle roots forming the continuity chain up to an attested block.
    struct ContinuityProof {
        bytes32 lowerEndpointDigest;
        bytes32[] roots;
    }

    /// @notice Verifies that `encodedTransaction` was included at `height` on the
    /// source chain identified by `chainKey`. Reverts if the proof does not hold.
    function verify(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        TransactionMerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external view returns (bool);

    /// @notice Recovers the transaction's index within its block from the Merkle path.
    /// Used as part of the replay key: (chainKey, height, txIndex) names a transaction
    /// uniquely without trusting anything the caller asserts.
    function calculateTxIndex(TransactionMerkleProof calldata merkleProof) external view returns (uint64);
}

/// @title Attestcoin ChainInfo precompile interface
/// @notice Transcribed from the gluwa/usc-sdk npm package at 0.18.0 (`dist/chain-info/chain_info.json`).
/// Note the snake_case names — they are not the camelCase the SDK's TypeScript wrapper
/// presents, and calling the camelCase spellings reverts with "Unknown selector".
interface IChainInfo {
    struct HeightHashResult {
        uint64 height;
        bytes32 hash;
        bool isAttestation;
        bool exists;
    }

    function is_height_attested(uint64 chainKey, uint64 height) external view returns (bool);

    function get_latest_attestation_height_and_hash(uint64 chainKey) external view returns (HeightHashResult memory);
}

/// @dev Canonical precompile addresses on Creditcoin.
library AttestcoinPrecompiles {
    address internal constant BLOCK_PROVER = 0x0000000000000000000000000000000000000FD2;
    address internal constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;
}
