// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AttestPayCreditLine} from "../src/AttestPayCreditLine.sol";
import {ProvenFacts} from "../src/ProvenFacts.sol";
import {IBlockProver} from "../src/IBlockProver.sol";
import {ProvenTxDecoder} from "../src/ProvenTxDecoder.sol";
import {MockBlockProver} from "./MockBlockProver.sol";
import {FactEncoding} from "./FactEncoding.sol";

contract AttestPayCreditLineTest is Test {
    AttestPayCreditLine line;
    MockBlockProver prover;

    uint64 constant CHAIN_KEY = 1;
    address constant ANCHOR = address(0xFAC7);
    address constant ANCHORER = address(0x5E2E);
    uint64 constant HEIGHT = 11_700_000;

    uint256 constant LENDER_PK = 0xA11CE;
    uint256 constant BORROWER_PK = 0xB0B;
    address lender;
    address borrower;

    function setUp() public {
        prover = new MockBlockProver();
        line = new AttestPayCreditLine(CHAIN_KEY, ANCHOR, ANCHORER, address(prover));
        lender = vm.addr(LENDER_PK);
        borrower = vm.addr(BORROWER_PK);
        vm.warp(1_757_000_000);
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _terms(uint256 nonce) internal view returns (AttestPayCreditLine.LineTerms memory t) {
        t = AttestPayCreditLine.LineTerms({
            lender: lender,
            borrower: borrower,
            limit: 10_000_000, // 10 USDC
            interestBps: 500, // 5%
            expiresAt: block.timestamp + 30 days,
            nonce: nonce
        });
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _open(uint256 nonce) internal returns (bytes32 id, AttestPayCreditLine.LineTerms memory t) {
        t = _terms(nonce);
        bytes32 digest = line.digestOf(t);
        id = line.openLine(t, _sign(LENDER_PK, digest), _sign(BORROWER_PK, digest));
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
        return line.verifyFacts(HEIGHT, FactEncoding.encode(FactEncoding.one(l)), _emptyMerkle(), _emptyContinuity());
    }

    function _draw(bytes32 id, uint256 amount, bytes32 txh, uint256 at, address by)
        internal
        pure
        returns (ProvenTxDecoder.Log memory)
    {
        return FactEncoding.transferLog(
            FactEncoding.CREDIT_DRAWN, ANCHOR, id, vm.addr(BORROWER_PK), vm.addr(LENDER_PK), amount, txh, at, by
        );
    }

    function _repay(bytes32 id, uint256 amount, bytes32 txh, uint256 at, address by)
        internal
        pure
        returns (ProvenTxDecoder.Log memory)
    {
        return FactEncoding.transferLog(
            FactEncoding.CREDIT_REPAID, ANCHOR, id, vm.addr(BORROWER_PK), vm.addr(LENDER_PK), amount, txh, at, by
        );
    }

    // -----------------------------------------------------------------------
    // Opening: EIP-712, both parties, nonce, domain
    // -----------------------------------------------------------------------

    function test_opensWithBothSignatures() public {
        (bytes32 id, AttestPayCreditLine.LineTerms memory t) = _open(1);
        assertEq(id, line.lineIdOf(t), "line id is the struct hash");
        AttestPayCreditLine.Line memory l = line.getLine(id);
        assertEq(uint8(l.status), uint8(AttestPayCreditLine.LineStatus.Open));
        assertEq(l.terms.limit, 10_000_000);
        assertEq(line.available(id), 10_000_000);
        assertEq(line.getBorrowerRecord(borrower).linesOpened, 1);
        assertEq(line.borrowerLines(borrower).length, 1);
        assertEq(line.lenderLines(lender).length, 1);
    }

    function test_rejectsWrongLenderSignature() public {
        AttestPayCreditLine.LineTerms memory t = _terms(1);
        bytes32 digest = line.digestOf(t);
        vm.expectRevert(abi.encodeWithSelector(AttestPayCreditLine.InvalidSignature.selector, "lender"));
        line.openLine(t, _sign(0xDEAD, digest), _sign(BORROWER_PK, digest));
    }

    function test_rejectsWrongBorrowerSignature() public {
        AttestPayCreditLine.LineTerms memory t = _terms(1);
        bytes32 digest = line.digestOf(t);
        vm.expectRevert(abi.encodeWithSelector(AttestPayCreditLine.InvalidSignature.selector, "borrower"));
        line.openLine(t, _sign(LENDER_PK, digest), _sign(LENDER_PK, digest));
    }

    /// Signatures over one set of terms must not be reusable: after the line opens,
    /// the nonce is spent even if the terms were otherwise identical.
    function test_nonceCannotBeReused() public {
        (, AttestPayCreditLine.LineTerms memory t) = _open(1);
        bytes32 digest = line.digestOf(t);
        vm.expectRevert(abi.encodeWithSelector(AttestPayCreditLine.NonceUsed.selector, lender, 1));
        line.openLine(t, _sign(LENDER_PK, digest), _sign(BORROWER_PK, digest));
    }

    /// The improvement over the protocol's loan example: a signature is bound to
    /// THIS deployment. The same signed terms must be worthless on another one.
    function test_signatureIsBoundToDeployment() public {
        AttestPayCreditLine other = new AttestPayCreditLine(CHAIN_KEY, ANCHOR, ANCHORER, address(prover));
        AttestPayCreditLine.LineTerms memory t = _terms(1);
        bytes32 digestHere = line.digestOf(t);
        assertTrue(digestHere != other.digestOf(t), "domains differ per contract");
        vm.expectRevert(abi.encodeWithSelector(AttestPayCreditLine.InvalidSignature.selector, "lender"));
        other.openLine(t, _sign(LENDER_PK, digestHere), _sign(BORROWER_PK, digestHere));
    }

    function test_rejectsBadTerms() public {
        AttestPayCreditLine.LineTerms memory t = _terms(1);
        bytes32 digest;

        t.limit = 0;
        digest = line.digestOf(t);
        vm.expectRevert(abi.encodeWithSelector(AttestPayCreditLine.InvalidTerms.selector, "zero limit"));
        line.openLine(t, _sign(LENDER_PK, digest), _sign(BORROWER_PK, digest));

        t = _terms(1);
        t.expiresAt = block.timestamp;
        digest = line.digestOf(t);
        vm.expectRevert(abi.encodeWithSelector(AttestPayCreditLine.InvalidTerms.selector, "already expired"));
        line.openLine(t, _sign(LENDER_PK, digest), _sign(BORROWER_PK, digest));

        t = _terms(1);
        t.borrower = lender;
        digest = line.digestOf(t);
        vm.expectRevert(abi.encodeWithSelector(AttestPayCreditLine.InvalidTerms.selector, "lender is borrower"));
        line.openLine(t, _sign(LENDER_PK, digest), _sign(LENDER_PK, digest));
    }

    /// Anyone may submit: it is the signatures, not the submitter, that authorise.
    function test_strangerMaySubmitSignedTerms() public {
        AttestPayCreditLine.LineTerms memory t = _terms(7);
        bytes32 digest = line.digestOf(t);
        vm.prank(address(0x5714));
        bytes32 id = line.openLine(t, _sign(LENDER_PK, digest), _sign(BORROWER_PK, digest));
        assertEq(uint8(line.getLine(id).status), uint8(AttestPayCreditLine.LineStatus.Open));
    }

    // -----------------------------------------------------------------------
    // Draws and repayments, proven
    // -----------------------------------------------------------------------

    function test_provenDrawActivatesLine() public {
        (bytes32 id,) = _open(1);
        assertEq(_prove(_draw(id, 4_000_000, keccak256("d1"), block.timestamp, ANCHORER)), 1);
        AttestPayCreditLine.Line memory l = line.getLine(id);
        assertEq(uint8(l.status), uint8(AttestPayCreditLine.LineStatus.Active));
        assertEq(l.drawn, 4_000_000);
        assertEq(line.available(id), 6_000_000);
        assertEq(line.owed(id), 4_200_000, "5% simple interest");
        assertEq(line.outstanding(id), 4_200_000);
        assertEq(line.getBorrowerRecord(borrower).totalDrawn, 4_000_000);
    }

    function test_partialThenFullRepayment() public {
        (bytes32 id,) = _open(1);
        _prove(_draw(id, 4_000_000, keccak256("d1"), block.timestamp, ANCHORER));

        prover.setTxIndex(1);
        _prove(_repay(id, 2_000_000, keccak256("r1"), block.timestamp + 1, ANCHORER));
        AttestPayCreditLine.Line memory l = line.getLine(id);
        assertEq(uint8(l.status), uint8(AttestPayCreditLine.LineStatus.Active), "still active");
        assertEq(line.outstanding(id), 2_200_000);

        prover.setTxIndex(2);
        _prove(_repay(id, 2_200_000, keccak256("r2"), block.timestamp + 2, ANCHORER));
        l = line.getLine(id);
        assertEq(uint8(l.status), uint8(AttestPayCreditLine.LineStatus.Repaid));
        assertEq(line.outstanding(id), 0);
        assertEq(l.repaidAt, block.timestamp + 2);
        assertEq(line.getBorrowerRecord(borrower).linesRepaid, 1);
        assertEq(line.getBorrowerRecord(borrower).totalRepaid, 4_200_000);
    }

    function test_drawOverLimitReverts() public {
        (bytes32 id,) = _open(1);
        vm.expectRevert(
            abi.encodeWithSelector(AttestPayCreditLine.DrawExceedsLimit.selector, id, 0, 11_000_000, 10_000_000)
        );
        _prove(_draw(id, 11_000_000, keccak256("d1"), block.timestamp, ANCHORER));
        assertEq(line.getLine(id).drawn, 0);
    }

    function test_drawAfterExpiryReverts() public {
        (bytes32 id, AttestPayCreditLine.LineTerms memory t) = _open(1);
        vm.expectRevert(
            abi.encodeWithSelector(AttestPayCreditLine.LineExpired.selector, id, t.expiresAt + 1, t.expiresAt)
        );
        _prove(_draw(id, 1_000_000, keccak256("d1"), t.expiresAt + 1, ANCHORER));
    }

    function test_repaymentBeforeAnyDrawReverts() public {
        (bytes32 id,) = _open(1);
        vm.expectRevert(
            abi.encodeWithSelector(AttestPayCreditLine.WrongStatus.selector, id, AttestPayCreditLine.LineStatus.Open)
        );
        _prove(_repay(id, 1_000_000, keccak256("r1"), block.timestamp, ANCHORER));
    }

    function test_unknownLineReverts() public {
        bytes32 ghost = keccak256("ghost");
        vm.expectRevert(abi.encodeWithSelector(AttestPayCreditLine.UnknownLine.selector, ghost));
        _prove(_draw(ghost, 1_000_000, keccak256("d1"), block.timestamp, ANCHORER));
    }

    /// The event names parties too; a draw that names other parties for a real line
    /// id is a malformed anchor and must not move the line.
    function test_partyMismatchReverts() public {
        (bytes32 id,) = _open(1);
        ProvenTxDecoder.Log memory l = FactEncoding.transferLog(
            FactEncoding.CREDIT_DRAWN, ANCHOR, id, address(0xDEAD), lender, 1_000_000, keccak256("d"), 1, ANCHORER
        );
        vm.expectRevert(abi.encodeWithSelector(AttestPayCreditLine.PartyMismatch.selector, id));
        _prove(l);
    }

    // -----------------------------------------------------------------------
    // Inherited proving discipline
    // -----------------------------------------------------------------------

    function test_untrustedAnchorerRejected() public {
        (bytes32 id,) = _open(1);
        vm.expectRevert(abi.encodeWithSelector(ProvenFacts.UntrustedAnchorer.selector, address(0xDEAD), ANCHORER));
        _prove(_draw(id, 1_000_000, keccak256("d1"), block.timestamp, address(0xDEAD)));
    }

    function test_impostorAnchorIgnored() public {
        (bytes32 id,) = _open(1);
        ProvenTxDecoder.Log memory l = FactEncoding.transferLog(
            FactEncoding.CREDIT_DRAWN, address(0xBAD1), id, borrower, lender, 1_000_000, keccak256("d"), 1, ANCHORER
        );
        vm.expectRevert(abi.encodeWithSelector(ProvenFacts.NoRelevantFact.selector, ANCHOR));
        _prove(l);
    }

    function test_rejectedProofRecordsNothing() public {
        (bytes32 id,) = _open(1);
        prover.setShouldVerify(false);
        vm.expectRevert(MockBlockProver.MockProofRejected.selector);
        _prove(_draw(id, 1_000_000, keccak256("d1"), block.timestamp, ANCHORER));
        assertEq(line.getLine(id).drawn, 0);
    }

    function test_replayIsANoop() public {
        (bytes32 id,) = _open(1);
        ProvenTxDecoder.Log memory l = _draw(id, 1_000_000, keccak256("d1"), block.timestamp, ANCHORER);
        assertEq(_prove(l), 1);
        assertEq(_prove(l), 0, "second submission records nothing");
        assertEq(line.getLine(id).drawn, 1_000_000);
    }

    /// A ledger-only fact (a dispute) proven into the credit-line contract is a caller
    /// mistake and must surface, not pass as a silent no-op.
    function test_foreignFactReverts() public {
        ProvenTxDecoder.Log memory l = FactEncoding.cardRevokedLog(ANCHOR, keccak256("c"), borrower, 1, ANCHORER);
        vm.expectRevert(abi.encodeWithSelector(ProvenFacts.NoRelevantFact.selector, ANCHOR));
        _prove(l);
    }

    /// One anchoring transaction may carry a draw and a repayment; both must apply.
    function test_multipleFactsInOneTransaction() public {
        (bytes32 id,) = _open(1);
        ProvenTxDecoder.Log[] memory logs = new ProvenTxDecoder.Log[](2);
        logs[0] = _draw(id, 2_000_000, keccak256("d1"), block.timestamp, ANCHORER);
        logs[1] = _repay(id, 1_000_000, keccak256("r1"), block.timestamp + 1, ANCHORER);
        uint256 n = line.verifyFacts(HEIGHT, FactEncoding.encode(logs), _emptyMerkle(), _emptyContinuity());
        assertEq(n, 2);
        assertEq(line.getLine(id).drawn, 2_000_000);
        assertEq(line.getLine(id).repaid, 1_000_000);
    }

    // -----------------------------------------------------------------------
    // Defaults and closure
    // -----------------------------------------------------------------------

    function test_markDefaultedAfterExpiryWithBalance() public {
        (bytes32 id, AttestPayCreditLine.LineTerms memory t) = _open(1);
        _prove(_draw(id, 4_000_000, keccak256("d1"), block.timestamp, ANCHORER));

        vm.expectRevert(abi.encodeWithSelector(AttestPayCreditLine.NotExpired.selector, id));
        line.markDefaulted(id);

        vm.warp(t.expiresAt + 1);
        line.markDefaulted(id);
        AttestPayCreditLine.Line memory l = line.getLine(id);
        assertEq(uint8(l.status), uint8(AttestPayCreditLine.LineStatus.Defaulted));
        assertEq(l.defaultedAt, block.timestamp);
        assertEq(line.getBorrowerRecord(borrower).linesDefaulted, 1);
        assertEq(line.available(id), 0);
    }

    function test_lateRepaymentClearsDefaultButKeepsRecord() public {
        (bytes32 id, AttestPayCreditLine.LineTerms memory t) = _open(1);
        _prove(_draw(id, 4_000_000, keccak256("d1"), block.timestamp, ANCHORER));
        vm.warp(t.expiresAt + 1);
        line.markDefaulted(id);

        prover.setTxIndex(1);
        _prove(_repay(id, 4_200_000, keccak256("r1"), block.timestamp, ANCHORER));
        AttestPayCreditLine.Line memory l = line.getLine(id);
        assertEq(uint8(l.status), uint8(AttestPayCreditLine.LineStatus.Repaid));
        assertTrue(l.defaultedAt != 0, "the default stays on the record");
        assertEq(line.getBorrowerRecord(borrower).linesDefaulted, 1);
        assertEq(line.getBorrowerRecord(borrower).linesRepaid, 1);
    }

    function test_cannotDefaultARepaidLine() public {
        (bytes32 id, AttestPayCreditLine.LineTerms memory t) = _open(1);
        _prove(_draw(id, 1_000_000, keccak256("d1"), block.timestamp, ANCHORER));
        prover.setTxIndex(1);
        _prove(_repay(id, 1_050_000, keccak256("r1"), block.timestamp, ANCHORER));
        vm.warp(t.expiresAt + 1);
        vm.expectRevert(
            abi.encodeWithSelector(AttestPayCreditLine.WrongStatus.selector, id, AttestPayCreditLine.LineStatus.Repaid)
        );
        line.markDefaulted(id);
    }

    function test_closeUnusedAfterExpiry() public {
        (bytes32 id, AttestPayCreditLine.LineTerms memory t) = _open(1);
        vm.warp(t.expiresAt + 1);
        line.closeUnused(id);
        assertEq(uint8(line.getLine(id).status), uint8(AttestPayCreditLine.LineStatus.Closed));
        // A closed line accepts no draws.
        vm.expectRevert(
            abi.encodeWithSelector(AttestPayCreditLine.WrongStatus.selector, id, AttestPayCreditLine.LineStatus.Closed)
        );
        _prove(_draw(id, 1, keccak256("d"), t.expiresAt - 1, ANCHORER));
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(ProvenFacts.ZeroAddress.selector);
        new AttestPayCreditLine(CHAIN_KEY, address(0), ANCHORER, address(prover));
        vm.expectRevert(ProvenFacts.ZeroAddress.selector);
        new AttestPayCreditLine(CHAIN_KEY, ANCHOR, address(0), address(prover));
    }
}
