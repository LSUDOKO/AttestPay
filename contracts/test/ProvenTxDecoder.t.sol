// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProvenTxDecoder} from "../src/ProvenTxDecoder.sol";
import {AttestPayASC} from "../src/AttestPayASC.sol";
import {IBlockProver} from "../src/IBlockProver.sol";
import {MockBlockProver} from "./MockBlockProver.sol";
import {AttestcoinEncoding} from "./AttestcoinEncoding.sol";
import {RealProofFixtures} from "./RealProofFixtures.sol";

/// @notice Decoder tests against REAL prover-API output.
/// @dev `ProvenTxDecoder` reads an encoding defined by the gluwa USC SDK, not by this
/// repo. Testing it only against blobs this repo encodes would prove self-consistency
/// and nothing more — it would pass just as happily if the encoding had been misread.
/// These tests decode the exact bytes the live proof generator returned for real
/// Sepolia transactions, which is what establishes the on-chain decoder actually works
/// against the live protocol. See RealProofFixtures.sol for provenance.
contract ProvenTxDecoderTest is Test {
    // -----------------------------------------------------------------------
    // Real wire data
    // -----------------------------------------------------------------------

    /// A real EIP-1559 (type 2) transaction: 3 chunks, receipt last.
    function test_decodesRealType2TransactionLogs() public pure {
        ProvenTxDecoder.Log[] memory logs = ProvenTxDecoder.receiptLogs(RealProofFixtures.type2Tx());

        // The count must match what the Sepolia receipt actually had.
        assertEq(logs.length, RealProofFixtures.type2TxLogs(), "log count from real receipt");

        // And each decoded log must be structurally sane, not merely present: a
        // mis-parsed blob tends to yield plausible-looking counts with junk inside.
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].emitter != address(0), "emitter must be a real address");
            assertGt(logs[i].topics.length, 0, "an EVM log carries at least topic0");
            assertLe(logs[i].topics.length, 4, "at most topic0 + 3 indexed args");
        }
    }

    /// A real legacy (type 0) transaction. The chunk layout differs by type, so the
    /// decoder's "receipt is always the last chunk" rule is verified on both.
    function test_decodesRealType0TransactionLogs() public pure {
        ProvenTxDecoder.Log[] memory logs = ProvenTxDecoder.receiptLogs(RealProofFixtures.type0Tx());

        assertEq(logs.length, RealProofFixtures.type0TxLogs(), "log count from real receipt");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].emitter != address(0));
            assertGt(logs[i].topics.length, 0);
            assertLe(logs[i].topics.length, 4);
        }
    }

    /// The outer envelope really is `abi.encode(uint8 txType, bytes[] chunks)`, and the
    /// captured transactions really are the types claimed.
    function test_realEnvelopeShapeMatchesDocumentedEncoding() public pure {
        (uint8 t2, bytes[] memory c2) = abi.decode(RealProofFixtures.type2Tx(), (uint8, bytes[]));
        assertEq(t2, 2, "captured fixture is an EIP-1559 transaction");
        assertEq(c2.length, 3, "type 2 encodes as 3 chunks");

        (uint8 t0, bytes[] memory c0) = abi.decode(RealProofFixtures.type0Tx(), (uint8, bytes[]));
        assertEq(t0, 0, "captured fixture is a legacy transaction");
        assertEq(c0.length, 3, "type 0 encodes as 3 chunks");
    }

    /// The last chunk decodes as a receipt with a success status — which is what lets
    /// the decoder find logs without branching on transaction type.
    function test_realLastChunkIsTheReceipt() public pure {
        (, bytes[] memory chunks) = abi.decode(RealProofFixtures.type2Tx(), (uint8, bytes[]));
        (uint8 status, uint64 gasUsed, ProvenTxDecoder.Log[] memory logs, bytes memory bloom) =
            abi.decode(chunks[chunks.length - 1], (uint8, uint64, ProvenTxDecoder.Log[], bytes));

        assertEq(status, 1, "the captured transaction succeeded on Sepolia");
        assertGt(gasUsed, 0);
        assertEq(logs.length, RealProofFixtures.type2TxLogs());
        // EVM logs blooms are 256 bytes.
        assertEq(bloom.length, 256, "receipt logsBloom is 256 bytes");
    }

    /// Finding a specific log by emitter + topic0 is how the ASC locates its anchor, so
    /// the search must work over real log sets too, and must reject what is not there.
    function test_findLogOverRealLogs() public pure {
        ProvenTxDecoder.Log[] memory logs = ProvenTxDecoder.receiptLogs(RealProofFixtures.type2Tx());

        // A log that IS present must be found at its true index.
        (bool found, uint256 index) = ProvenTxDecoder.findLog(logs, logs[1].emitter, logs[1].topics[0]);
        assertTrue(found);
        // Either index 1, or an earlier identical (emitter, topic0) pair — findLog
        // returns the FIRST match by contract, so assert that property rather than a
        // literal index that real data need not honour.
        assertLe(index, 1);
        assertEq(logs[index].emitter, logs[1].emitter);
        assertEq(logs[index].topics[0], logs[1].topics[0]);

        // Right topic, wrong emitter: must NOT match. This is the property that stops
        // an impostor contract's look-alike event being mistaken for the anchor's.
        (bool spoofed,) = ProvenTxDecoder.findLog(logs, address(0xBAD1), logs[1].topics[0]);
        assertFalse(spoofed, "a matching topic from the wrong contract is not a match");

        // Right emitter, wrong topic: must NOT match.
        (bool wrongTopic,) = ProvenTxDecoder.findLog(logs, logs[1].emitter, keccak256("NotAnEventWeWant()"));
        assertFalse(wrongTopic);
    }

    // -----------------------------------------------------------------------
    // The ASC against real wire data
    // -----------------------------------------------------------------------

    /// End-to-end over REAL bytes: the ASC must reject a genuinely attested transaction
    /// that simply has nothing to do with AttestPay. This is the realistic negative
    /// case — a valid proof of an unrelated transaction — and it must not record
    /// anything rather than, say, mis-decoding an ERC-20 Transfer into a payment.
    function test_ascRejectsRealUnrelatedTransaction() public {
        MockBlockProver prover = new MockBlockProver();
        AttestPayASC asc = new AttestPayASC(1, address(0xA0C0), address(0x5E2E), address(prover));

        vm.expectRevert(abi.encodeWithSelector(AttestPayASC.AnchorLogNotFound.selector, address(0xA0C0)));
        asc.verifyPayment(
            11_688_140,
            RealProofFixtures.type2Tx(),
            IBlockProver.TransactionMerkleProof({
                root: keccak256("root"), siblings: new IBlockProver.MerkleProofEntry[](0)
            }),
            IBlockProver.ContinuityProof({lowerEndpointDigest: keccak256("lower"), roots: new bytes32[](0)})
        );

        assertEq(asc.getCardPaymentCount(keccak256("any")), 0);
    }

    /// Guards the fixture generator itself: the synthetic encoder used by the other
    /// test suite must produce the same envelope shape as the real prover does, or
    /// those suites are testing a format that does not exist.
    function test_syntheticEncoderMatchesRealEnvelopeShape() public pure {
        ProvenTxDecoder.Log[] memory one = new ProvenTxDecoder.Log[](1);
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = keccak256("X()");
        one[0] = ProvenTxDecoder.Log({emitter: address(0x1234), topics: topics, data: hex""});

        (uint8 synthType, bytes[] memory synthChunks) =
            abi.decode(AttestcoinEncoding.encodeType2(1, one), (uint8, bytes[]));
        (uint8 realType, bytes[] memory realChunks) = abi.decode(RealProofFixtures.type2Tx(), (uint8, bytes[]));

        assertEq(synthType, realType, "same transaction type tag");
        assertEq(synthChunks.length, realChunks.length, "same chunk count");
    }
}
