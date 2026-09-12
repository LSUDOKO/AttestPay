// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IBlockProver} from "../src/IBlockProver.sol";

/// @notice Stand-in for the Attestcoin Block Prover precompile.
/// @dev Mirrors the real precompile's two behaviours that the ASC depends on: it
/// REVERTS on a rejected proof (it does not return false), and `calculateTxIndex`
/// derives the index from the Merkle path rather than from anything the caller says.
/// A test double that returned false instead of reverting would let the ASC pass tests
/// while mishandling the real precompile.
contract MockBlockProver is IBlockProver {
    error MockProofRejected();

    bool public shouldVerify = true;
    /// @dev Makes `verify` return false rather than revert, so the ASC's explicit
    /// `if (!proven)` branch is reachable in tests even though the live precompile
    /// is not expected to take it.
    bool public returnFalseInsteadOfReverting;
    uint64 public txIndexToReturn;

    function setShouldVerify(bool v) external {
        shouldVerify = v;
    }

    function setReturnFalseInsteadOfReverting(bool v) external {
        returnFalseInsteadOfReverting = v;
    }

    function setTxIndex(uint64 i) external {
        txIndexToReturn = i;
    }

    function verify(uint64, uint64, bytes calldata, TransactionMerkleProof calldata, ContinuityProof calldata)
        external
        view
        returns (bool)
    {
        if (!shouldVerify) {
            if (returnFalseInsteadOfReverting) return false;
            revert MockProofRejected();
        }
        return true;
    }

    function calculateTxIndex(TransactionMerkleProof calldata) external view returns (uint64) {
        return txIndexToReturn;
    }
}
