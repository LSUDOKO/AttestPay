// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AttestPayASC} from "../src/AttestPayASC.sol";
import {PaymentAnchor} from "../src/PaymentAnchor.sol";
import {IBlockProver} from "../src/IBlockProver.sol";
import {ProvenTxDecoder} from "../src/ProvenTxDecoder.sol";
import {MockBlockProver} from "./MockBlockProver.sol";
import {AttestcoinEncoding} from "./AttestcoinEncoding.sol";

contract AttestPayASCTest is Test {
    AttestPayASC asc;
    MockBlockProver prover;

    uint64 constant CHAIN_KEY = 1; // Ethereum Sepolia on CC3 testnet
    address constant ANCHOR = address(0xA0C0);
    address constant ANCHORER = address(0x5E2E);
    address constant PAYER = address(0x9A1D);
    address constant MERCHANT = address(0x4E12);

    bytes32 constant CARD = keccak256("card_abc");
    uint64 constant HEIGHT = 11687948;

    function setUp() public {
        prover = new MockBlockProver();
        asc = new AttestPayASC(CHAIN_KEY, ANCHOR, ANCHORER, address(prover));
        // Give block.timestamp a realistic value; terms checks compare against it.
        vm.warp(1_757_000_000);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _logs(ProvenTxDecoder.Log memory a) internal pure returns (ProvenTxDecoder.Log[] memory l) {
        l = new ProvenTxDecoder.Log[](1);
        l[0] = a;
    }

    function _anchored(uint256 amount, uint256 paidAt, address anchoredBy)
        internal
        view
        returns (ProvenTxDecoder.Log memory)
    {
        return AttestcoinEncoding.anchoredLog(
            ANCHOR,
            asc.PAYMENT_ANCHORED_TOPIC(),
            CARD,
            PAYER,
            MERCHANT,
            amount,
            8453,
            keccak256("base_tx"),
            paidAt,
            anchoredBy,
            "coffee"
        );
    }

    function _emptyMerkle() internal pure returns (IBlockProver.TransactionMerkleProof memory p) {
        p = IBlockProver.TransactionMerkleProof({
            root: keccak256("root"),
            siblings: new IBlockProver.MerkleProofEntry[](0)
        });
    }

    function _emptyContinuity() internal pure returns (IBlockProver.ContinuityProof memory p) {
        p = IBlockProver.ContinuityProof({
            lowerEndpointDigest: keccak256("lower"),
            roots: new bytes32[](0)
        });
    }

    function _verify(bytes memory encoded) internal returns (uint256) {
        return asc.verifyPayment(HEIGHT, encoded, _emptyMerkle(), _emptyContinuity());
    }

    // -----------------------------------------------------------------------
    // The PaymentAnchored topic must match the anchor contract exactly
    // -----------------------------------------------------------------------

    /// The ASC matches logs by `topics[0]`. If the anchor's event signature and the
    /// ASC's hardcoded topic ever drift apart, every proof would silently find no
    /// anchor log — so pin them together rather than trusting two copies of a string.
    function test_anchoredTopicMatchesAnchorEvent() public view {
        bytes32 fromAnchor = keccak256(
            "PaymentAnchored(bytes32,address,address,uint256,uint256,bytes32,uint256,address,string)"
        );
        assertEq(asc.PAYMENT_ANCHORED_TOPIC(), fromAnchor);
    }

    /// Guards the same invariant from the other direction: emit a real event from a real
    /// `PaymentAnchor` and confirm its topic0 is what the ASC looks for.
    function test_realAnchorEmitsExpectedTopic() public {
        PaymentAnchor anchor = new PaymentAnchor();
        vm.recordLogs();
        anchor.anchorPayment(CARD, PAYER, MERCHANT, 2_000_000, 8453, keccak256("base_tx"), 1_757_000_000, "coffee");
        Vm.Log[] memory entries = vm.getRecordedLogs();
        assertEq(entries.length, 1);
        assertEq(entries[0].topics[0], asc.PAYMENT_ANCHORED_TOPIC());
        assertEq(entries[0].topics[1], CARD);
        assertEq(address(uint160(uint256(entries[0].topics[2]))), PAYER);
        assertEq(address(uint160(uint256(entries[0].topics[3]))), MERCHANT);
    }

    // -----------------------------------------------------------------------
    // Happy path
    // -----------------------------------------------------------------------

    function test_verifiesAndRecordsPayment() public {
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(2_000_000, 1_756_900_000, ANCHORER)));

        assertEq(_verify(encoded), 1);

        assertEq(asc.getCardPaymentCount(CARD), 1);
        assertEq(asc.totalVerifiedSpend(CARD), 2_000_000);

        AttestPayASC.VerifiedPayment memory p = asc.getCardPayment(CARD, 0);
        assertEq(p.cardId, CARD);
        assertEq(p.payer, PAYER);
        assertEq(p.merchant, MERCHANT);
        assertEq(p.amount, 2_000_000);
        assertEq(p.sourceChainId, 8453);
        assertEq(p.sourceTxHash, keccak256("base_tx"));
        assertEq(p.paidAt, 1_756_900_000);
        assertEq(p.anchorHeight, HEIGHT);
        assertEq(p.verifiedAt, block.timestamp);
        assertEq(p.memo, "coffee");

        AttestPayASC.AgentCredit memory c = asc.getAgentCredit(PAYER);
        assertEq(c.totalPayments, 1);
        assertEq(c.totalVolume, 2_000_000);
        assertEq(c.firstPaymentAt, 1_756_900_000);
        assertEq(c.lastPaymentAt, 1_756_900_000);
    }

    /// The decoder's "receipt is the last chunk" rule must hold for a 4-chunk type-4
    /// transaction too, not just the 3-chunk type-2 shape.
    function test_decodesType4FourChunkTransaction() public {
        bytes memory encoded =
            AttestcoinEncoding.encodeType4(1, _logs(_anchored(1_500_000, 1_756_900_000, ANCHORER)));
        assertEq(_verify(encoded), 1);
        assertEq(asc.getCardPayment(CARD, 0).amount, 1_500_000);
    }

    /// Logs from other contracts in the same transaction must be ignored, not
    /// mistaken for anchors.
    function test_ignoresUnrelatedLogs() public {
        ProvenTxDecoder.Log[] memory logs = new ProvenTxDecoder.Log[](3);
        logs[0] = AttestcoinEncoding.unrelatedLog(address(0xDEAD));
        logs[1] = _anchored(3_000_000, 1_756_900_000, ANCHORER);
        logs[2] = AttestcoinEncoding.unrelatedLog(address(0xFEED));

        assertEq(_verify(AttestcoinEncoding.encodeType2(1, logs)), 1);
        assertEq(asc.getCardPaymentCount(CARD), 1);
        assertEq(asc.totalVerifiedSpend(CARD), 3_000_000);
    }

    /// One anchoring transaction may batch several payments; each must be recorded once.
    function test_recordsEveryAnchoredEventInOneTransaction() public {
        ProvenTxDecoder.Log[] memory logs = new ProvenTxDecoder.Log[](2);
        logs[0] = _anchored(1_000_000, 1_756_900_000, ANCHORER);
        logs[1] = _anchored(2_500_000, 1_756_900_500, ANCHORER);

        assertEq(_verify(AttestcoinEncoding.encodeType2(1, logs)), 2);
        assertEq(asc.getCardPaymentCount(CARD), 2);
        assertEq(asc.totalVerifiedSpend(CARD), 3_500_000);
        assertEq(asc.getAgentCredit(PAYER).totalPayments, 2);
    }

    // -----------------------------------------------------------------------
    // Security properties — these are the point of the design
    // -----------------------------------------------------------------------

    /// A rejected proof must not record anything. The live precompile reverts, so the
    /// revert must propagate rather than be swallowed into a no-op success.
    function test_rejectedProofRevertsAndRecordsNothing() public {
        prover.setShouldVerify(false);
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(2_000_000, 1_756_900_000, ANCHORER)));
        vm.expectRevert(MockBlockProver.MockProofRejected.selector);
        _verify(encoded);
        assertEq(asc.getCardPaymentCount(CARD), 0);
    }

    /// Defence in depth: if a future precompile returns false instead of reverting,
    /// the ASC must still refuse.
    function test_proofReturningFalseIsRejected() public {
        prover.setShouldVerify(false);
        prover.setReturnFalseInsteadOfReverting(true);
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(2_000_000, 1_756_900_000, ANCHORER)));
        vm.expectRevert(AttestPayASC.ProofRejected.selector);
        _verify(encoded);
        assertEq(asc.getCardPaymentCount(CARD), 0);
    }

    /// A look-alike anchor deployed by an attacker must not be able to write history,
    /// even with a perfectly valid proof of its own transaction.
    function test_rejectsLogFromImpostorAnchor() public {
        ProvenTxDecoder.Log memory fake = AttestcoinEncoding.anchoredLog(
            address(0xBAD1), // not `paymentAnchor`
            asc.PAYMENT_ANCHORED_TOPIC(),
            CARD,
            PAYER,
            MERCHANT,
            99_000_000,
            8453,
            keccak256("fake"),
            1_756_900_000,
            ANCHORER,
            "stolen"
        );
        vm.expectRevert(abi.encodeWithSelector(AttestPayASC.AnchorLogNotFound.selector, ANCHOR));
        _verify(AttestcoinEncoding.encodeType2(1, _logs(fake)));
        assertEq(asc.getCardPaymentCount(CARD), 0);
    }

    /// The anchor is permissionless, so anyone may write a `PaymentAnchored` event.
    /// The ASC must only credit the anchorer it trusts.
    function test_rejectsAnchorFromUntrustedAnchorer() public {
        address impostor = address(0xDEAD);
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(50_000_000, 1_756_900_000, impostor)));
        vm.expectRevert(
            abi.encodeWithSelector(AttestPayASC.UntrustedAnchorer.selector, impostor, ANCHORER)
        );
        _verify(encoded);
        assertEq(asc.getCardPaymentCount(CARD), 0);
    }

    /// Proving a transaction that never touched the anchor is a caller error and must
    /// surface, not pass silently.
    function test_revertsWhenNoAnchorLogPresent() public {
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(1, _logs(AttestcoinEncoding.unrelatedLog(address(0xDEAD))));
        vm.expectRevert(abi.encodeWithSelector(AttestPayASC.AnchorLogNotFound.selector, ANCHOR));
        _verify(encoded);
    }

    /// A source transaction that REVERTED emits no real payment; recording it would
    /// turn a failed payment into credit history.
    function test_rejectsRevertedSourceTransaction() public {
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(0, _logs(_anchored(2_000_000, 1_756_900_000, ANCHORER)));
        vm.expectRevert(ProvenTxDecoder.TransactionReverted.selector);
        _verify(encoded);
        assertEq(asc.getCardPaymentCount(CARD), 0);
    }

    /// Replaying the same proof must not inflate the record. The second call is a
    /// no-op returning 0, not a revert: relayers legitimately retry.
    function test_replayOfSameProofRecordsNothingNewly() public {
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(2_000_000, 1_756_900_000, ANCHORER)));

        assertEq(_verify(encoded), 1);
        assertEq(_verify(encoded), 0);

        assertEq(asc.getCardPaymentCount(CARD), 1);
        assertEq(asc.totalVerifiedSpend(CARD), 2_000_000);
        assertEq(asc.getAgentCredit(PAYER).totalPayments, 1);
    }

    /// The replay key includes txIndex, which the PRECOMPILE derives. Two distinct
    /// transactions at the same height must both record.
    function test_sameHeightDifferentTxIndexBothRecord() public {
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(1_000_000, 1_756_900_000, ANCHORER)));

        prover.setTxIndex(0);
        assertEq(_verify(encoded), 1);
        prover.setTxIndex(7);
        assertEq(_verify(encoded), 1);

        assertEq(asc.getCardPaymentCount(CARD), 2);
    }

    // -----------------------------------------------------------------------
    // Credit accounting
    // -----------------------------------------------------------------------

    /// Anchors can be proven out of order; firstPaymentAt must stay the true earliest.
    function test_outOfOrderProofsKeepTrueFirstAndLast() public {
        bytes memory later =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(1_000_000, 1_757_000_000, ANCHORER)));
        bytes memory earlier =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(1_000_000, 1_756_000_000, ANCHORER)));

        prover.setTxIndex(0);
        _verify(later);
        prover.setTxIndex(1);
        _verify(earlier);

        AttestPayASC.AgentCredit memory c = asc.getAgentCredit(PAYER);
        assertEq(c.firstPaymentAt, 1_756_000_000, "earliest payment must win");
        assertEq(c.lastPaymentAt, 1_757_000_000, "latest payment must win");
        assertEq(c.totalPayments, 2);
    }

    /// An unregistered card must NOT score a free 100% compliance rate: with no terms
    /// on file there is nothing to comply with, so the payment is not counted either way.
    function test_unregisteredCardIsNotCountedAsWithinTerms() public {
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(2_000_000, 1_756_900_000, ANCHORER)));
        _verify(encoded);

        AttestPayASC.AgentCredit memory c = asc.getAgentCredit(PAYER);
        assertEq(c.termsCheckedPayments, 0, "no terms registered: nothing to check");
        assertEq(c.withinTermsPayments, 0);
    }

    function test_paymentWithinRegisteredTermsCounts() public {
        asc.registerCardTerms(CARD, keccak256("terms"), 10_000_000, 604800, 5_000_000, 0);
        uint256 paidAt = block.timestamp + 10;
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(2_000_000, paidAt, ANCHORER)));
        _verify(encoded);

        AttestPayASC.AgentCredit memory c = asc.getAgentCredit(PAYER);
        assertEq(c.termsCheckedPayments, 1);
        assertEq(c.withinTermsPayments, 1);
    }

    function test_paymentOverPerTxMaxIsCheckedAndFails() public {
        asc.registerCardTerms(CARD, keccak256("terms"), 10_000_000, 604800, 1_000_000, 0);
        uint256 paidAt = block.timestamp + 10;
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(9_000_000, paidAt, ANCHORER)));
        _verify(encoded);

        AttestPayASC.AgentCredit memory c = asc.getAgentCredit(PAYER);
        assertEq(c.termsCheckedPayments, 1, "over-cap payment IS checkable");
        assertEq(c.withinTermsPayments, 0, "and must not count as compliant");
        // It is still recorded as a verified payment: it demonstrably happened.
        assertEq(asc.getCardPaymentCount(CARD), 1);
    }

    function test_paymentAfterExpiryIsCheckedAndFails() public {
        uint256 expiry = block.timestamp + 100;
        asc.registerCardTerms(CARD, keccak256("terms"), 0, 0, 0, expiry);
        bytes memory encoded =
            AttestcoinEncoding.encodeType2(1, _logs(_anchored(1_000_000, expiry + 1, ANCHORER)));
        _verify(encoded);

        AttestPayASC.AgentCredit memory c = asc.getAgentCredit(PAYER);
        assertEq(c.termsCheckedPayments, 1);
        assertEq(c.withinTermsPayments, 0);
    }

    /// Terms registered after a payment say nothing about whether that payment complied.
    function test_termsRegisteredAfterPaymentAreNotRetroactive() public {
        asc.registerCardTerms(CARD, keccak256("terms"), 0, 0, 1, 0); // perTxMax of 1 atom
        uint256 paidAtBeforeRegistration = block.timestamp - 1000;
        bytes memory encoded = AttestcoinEncoding.encodeType2(
            1, _logs(_anchored(9_000_000, paidAtBeforeRegistration, ANCHORER))
        );
        _verify(encoded);

        AttestPayASC.AgentCredit memory c = asc.getAgentCredit(PAYER);
        assertEq(c.termsCheckedPayments, 0, "pre-registration payment is not judged");
        assertEq(c.withinTermsPayments, 0);
    }

    // -----------------------------------------------------------------------
    // Card terms registry ownership
    // -----------------------------------------------------------------------

    function test_firstRegistrantClaimsCardAndCanUpdate() public {
        address owner = address(0x111);
        vm.prank(owner);
        asc.registerCardTerms(CARD, keccak256("v1"), 1, 1, 1, 1);
        assertEq(asc.cardTermsOwner(CARD), owner);

        vm.prank(owner);
        asc.registerCardTerms(CARD, keccak256("v2"), 2, 2, 2, 2);
        assertEq(asc.getCardTerms(CARD).termsHash, keccak256("v2"));
    }

    function test_strangerCannotOverwriteRegisteredTerms() public {
        address owner = address(0x111);
        vm.prank(owner);
        asc.registerCardTerms(CARD, keccak256("v1"), 1, 1, 1, 1);

        vm.prank(address(0x222));
        vm.expectRevert(abi.encodeWithSelector(AttestPayASC.NotTermsOwner.selector, CARD, owner));
        asc.registerCardTerms(CARD, keccak256("evil"), 0, 0, 0, 0);

        assertEq(asc.getCardTerms(CARD).termsHash, keccak256("v1"));
    }

    function test_ownerCanRevokeTermsAndStrangerCannot() public {
        address owner = address(0x111);
        vm.prank(owner);
        asc.registerCardTerms(CARD, keccak256("v1"), 1, 1, 1, 1);

        vm.prank(address(0x222));
        vm.expectRevert(abi.encodeWithSelector(AttestPayASC.NotTermsOwner.selector, CARD, owner));
        asc.revokeCardTerms(CARD);
        assertTrue(asc.getCardTerms(CARD).active);

        vm.prank(owner);
        asc.revokeCardTerms(CARD);
        assertFalse(asc.getCardTerms(CARD).active);
        // exists stays true: the terms are revoked, not forgotten.
        assertTrue(asc.getCardTerms(CARD).exists);
    }

    // -----------------------------------------------------------------------
    // Paged reads
    // -----------------------------------------------------------------------

    function test_pagedPaymentsReadClampsToLength() public {
        for (uint64 i = 0; i < 5; i++) {
            prover.setTxIndex(i);
            _verify(AttestcoinEncoding.encodeType2(
                1, _logs(_anchored(1_000_000 + i, 1_756_900_000 + i, ANCHORER))
            ));
        }
        assertEq(asc.getCardPaymentCount(CARD), 5);
        assertEq(asc.getCardPayments(CARD, 0, 2).length, 2);
        assertEq(asc.getCardPayments(CARD, 3, 10).length, 2, "limit must clamp to length");
        assertEq(asc.getCardPayments(CARD, 99, 10).length, 0, "offset past end is empty, not a revert");
        assertEq(asc.getCardPayments(CARD, 1, 3)[0].amount, 1_000_001);
    }

    // -----------------------------------------------------------------------
    // Construction invariants
    // -----------------------------------------------------------------------

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(AttestPayASC.ZeroAddress.selector);
        new AttestPayASC(CHAIN_KEY, address(0), ANCHORER, address(prover));

        vm.expectRevert(AttestPayASC.ZeroAddress.selector);
        new AttestPayASC(CHAIN_KEY, ANCHOR, address(0), address(prover));
    }

    /// Passing address(0) for the prover must bind the canonical precompile, so a
    /// production deploy cannot accidentally point at nothing.
    function test_zeroProverBindsCanonicalPrecompile() public {
        AttestPayASC a = new AttestPayASC(CHAIN_KEY, ANCHOR, ANCHORER, address(0));
        assertEq(address(a.blockProver()), 0x0000000000000000000000000000000000000FD2);
    }
}
