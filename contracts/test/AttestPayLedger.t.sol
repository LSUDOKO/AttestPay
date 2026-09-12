// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AttestPayLedger} from "../src/AttestPayLedger.sol";
import {ProvenFacts} from "../src/ProvenFacts.sol";
import {IBlockProver} from "../src/IBlockProver.sol";
import {ProvenTxDecoder} from "../src/ProvenTxDecoder.sol";
import {MockBlockProver} from "./MockBlockProver.sol";
import {FactEncoding} from "./FactEncoding.sol";

contract AttestPayLedgerTest is Test {
    AttestPayLedger ledger;
    MockBlockProver prover;

    uint64 constant CHAIN_KEY = 1;
    address constant ANCHOR = address(0xFAC7);
    address constant ANCHORER = address(0x5E2E);
    uint64 constant HEIGHT = 11_700_000;

    bytes32 constant CARD = keccak256("card_abc");
    bytes32 constant DISPUTE = keccak256("dispute_1");
    address constant PAYER = address(0x9A1D);
    address constant MERCHANT = address(0x4E12);
    bytes32 constant TX1 = keccak256("base_tx");

    function setUp() public {
        prover = new MockBlockProver();
        ledger = new AttestPayLedger(CHAIN_KEY, ANCHOR, ANCHORER, address(prover));
        vm.warp(1_757_000_000);
    }

    function _emptyMerkle() internal pure returns (IBlockProver.TransactionMerkleProof memory p) {
        p = IBlockProver.TransactionMerkleProof({
            root: keccak256("root"), siblings: new IBlockProver.MerkleProofEntry[](0)
        });
    }

    function _emptyContinuity() internal pure returns (IBlockProver.ContinuityProof memory p) {
        p = IBlockProver.ContinuityProof({lowerEndpointDigest: keccak256("lower"), roots: new bytes32[](0)});
    }

    function _prove(ProvenTxDecoder.Log memory l) internal returns (uint256) {
        return ledger.verifyFacts(HEIGHT, FactEncoding.encode(FactEncoding.one(l)), _emptyMerkle(), _emptyContinuity());
    }

    function _opened(address by) internal pure returns (ProvenTxDecoder.Log memory) {
        return FactEncoding.disputeOpenedLog(
            ANCHOR, DISPUTE, CARD, PAYER, MERCHANT, TX1, 2_000_000, 1_756_900_000, by, "never delivered"
        );
    }

    function _resolved(uint8 outcome, address by) internal pure returns (ProvenTxDecoder.Log memory) {
        return FactEncoding.disputeResolvedLog(ANCHOR, DISPUTE, CARD, PAYER, outcome, 1_756_950_000, by);
    }

    // -----------------------------------------------------------------------
    // Disputes
    // -----------------------------------------------------------------------

    function test_recordsOpenedDispute() public {
        assertEq(_prove(_opened(ANCHORER)), 1);
        AttestPayLedger.Dispute memory d = ledger.getDispute(DISPUTE);
        assertEq(uint8(d.status), uint8(AttestPayLedger.DisputeStatus.Open));
        assertEq(d.cardId, CARD);
        assertEq(d.payer, PAYER);
        assertEq(d.merchant, MERCHANT);
        assertEq(d.sourceTxHash, TX1);
        assertEq(d.amount, 2_000_000);
        assertEq(d.openedAt, 1_756_900_000);
        assertEq(d.reason, "never delivered");

        AttestPayLedger.DisputeRecord memory r = ledger.getDisputeRecord(PAYER);
        assertEq(r.opened, 1);
        assertEq(r.disputedVolume, 2_000_000);
        assertEq(ledger.payerDisputes(PAYER).length, 1);
        assertEq(ledger.merchantDisputesReceived(MERCHANT), 1);
    }

    function test_resolvesUpheld() public {
        _prove(_opened(ANCHORER));
        prover.setTxIndex(1);
        _prove(_resolved(1, ANCHORER));
        AttestPayLedger.Dispute memory d = ledger.getDispute(DISPUTE);
        assertEq(uint8(d.status), uint8(AttestPayLedger.DisputeStatus.Upheld));
        assertEq(d.resolvedAt, 1_756_950_000);
        assertEq(ledger.getDisputeRecord(PAYER).upheld, 1);
    }

    function test_resolvesRejectedAndWithdrawn() public {
        _prove(_opened(ANCHORER));
        prover.setTxIndex(1);
        _prove(_resolved(2, ANCHORER));
        assertEq(ledger.getDisputeRecord(PAYER).rejected, 1);

        // A second dispute, withdrawn.
        bytes32 d2 = keccak256("dispute_2");
        prover.setTxIndex(2);
        _prove(FactEncoding.disputeOpenedLog(ANCHOR, d2, CARD, PAYER, MERCHANT, keccak256("tx2"), 1, 1, ANCHORER, "x"));
        prover.setTxIndex(3);
        _prove(FactEncoding.disputeResolvedLog(ANCHOR, d2, CARD, PAYER, 3, 2, ANCHORER));
        assertEq(ledger.getDisputeRecord(PAYER).withdrawn, 1);
        assertEq(ledger.getDisputeRecord(PAYER).opened, 2);
    }

    function test_cannotResolveUnopenedDispute() public {
        vm.expectRevert(abi.encodeWithSelector(AttestPayLedger.DisputeNotOpen.selector, DISPUTE));
        _prove(_resolved(1, ANCHORER));
    }

    function test_cannotOpenTwice() public {
        _prove(_opened(ANCHORER));
        prover.setTxIndex(1);
        vm.expectRevert(abi.encodeWithSelector(AttestPayLedger.DisputeExists.selector, DISPUTE));
        _prove(_opened(ANCHORER));
    }

    function test_unknownOutcomeReverts() public {
        _prove(_opened(ANCHORER));
        prover.setTxIndex(1);
        vm.expectRevert(abi.encodeWithSelector(AttestPayLedger.UnknownOutcome.selector, 9));
        _prove(_resolved(9, ANCHORER));
    }

    function test_untrustedAnchorerRejected() public {
        vm.expectRevert(abi.encodeWithSelector(ProvenFacts.UntrustedAnchorer.selector, address(0xDEAD), ANCHORER));
        _prove(_opened(address(0xDEAD)));
    }

    function test_replayIsANoop() public {
        assertEq(_prove(_opened(ANCHORER)), 1);
        assertEq(_prove(_opened(ANCHORER)), 0);
        assertEq(ledger.getDisputeRecord(PAYER).opened, 1);
    }

    // -----------------------------------------------------------------------
    // Revocations
    // -----------------------------------------------------------------------

    function test_recordsRevocationAndAnswersLivenessQuestion() public {
        assertEq(ledger.cardRevokedAt(CARD), 0);
        assertFalse(ledger.wasRevokedAt(CARD, 1_756_900_000), "no proven revocation: not known revoked");

        _prove(FactEncoding.cardRevokedLog(ANCHOR, CARD, PAYER, 1_756_950_000, ANCHORER));
        assertEq(ledger.cardRevokedAt(CARD), 1_756_950_000);
        assertEq(ledger.cardRevokedPayer(CARD), PAYER);
        assertFalse(ledger.wasRevokedAt(CARD, 1_756_949_999), "paid before revocation: live");
        assertTrue(ledger.wasRevokedAt(CARD, 1_756_950_000), "paid at revocation: revoked");
        assertTrue(ledger.wasRevokedAt(CARD, 1_757_000_000), "paid after: revoked");
    }

    function test_revocationRecordedOnce() public {
        _prove(FactEncoding.cardRevokedLog(ANCHOR, CARD, PAYER, 1_756_950_000, ANCHORER));
        prover.setTxIndex(1);
        vm.expectRevert(abi.encodeWithSelector(AttestPayLedger.AlreadyRevoked.selector, CARD));
        _prove(FactEncoding.cardRevokedLog(ANCHOR, CARD, PAYER, 1_756_960_000, ANCHORER));
        assertEq(ledger.cardRevokedAt(CARD), 1_756_950_000, "first proven timestamp stands");
    }

    /// A credit-line fact proven into the ledger is a caller mistake.
    function test_foreignFactReverts() public {
        ProvenTxDecoder.Log memory l = FactEncoding.transferLog(
            FactEncoding.CREDIT_DRAWN, ANCHOR, keccak256("l"), PAYER, MERCHANT, 1, keccak256("t"), 1, ANCHORER
        );
        vm.expectRevert(abi.encodeWithSelector(ProvenFacts.NoRelevantFact.selector, ANCHOR));
        _prove(l);
    }

    /// Mixed transaction: a revocation and a dispute in one anchoring transaction both
    /// apply, and a foreign fact in the same transaction is simply skipped.
    function test_mixedTransactionConsumesOnlyKnownFacts() public {
        ProvenTxDecoder.Log[] memory logs = new ProvenTxDecoder.Log[](3);
        logs[0] = FactEncoding.cardRevokedLog(ANCHOR, CARD, PAYER, 1_756_950_000, ANCHORER);
        logs[1] = FactEncoding.transferLog(
            FactEncoding.CREDIT_DRAWN, ANCHOR, keccak256("l"), PAYER, MERCHANT, 1, keccak256("t"), 1, ANCHORER
        );
        logs[2] = _opened(ANCHORER);
        uint256 n = ledger.verifyFacts(HEIGHT, FactEncoding.encode(logs), _emptyMerkle(), _emptyContinuity());
        assertEq(n, 2);
        assertTrue(ledger.isEventProven(HEIGHT, 0, 0));
        assertFalse(ledger.isEventProven(HEIGHT, 0, 1), "foreign fact not marked here");
        assertTrue(ledger.isEventProven(HEIGHT, 0, 2));
    }
}
