// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AttestPayCreditLine} from "../src/AttestPayCreditLine.sol";
import {AttestPayGuarantee} from "../src/AttestPayGuarantee.sol";
import {IBlockProver} from "../src/IBlockProver.sol";
import {ProvenTxDecoder} from "../src/ProvenTxDecoder.sol";
import {MockBlockProver} from "./MockBlockProver.sol";
import {FactEncoding} from "./FactEncoding.sol";

contract AttestPayGuaranteeTest is Test {
    AttestPayCreditLine line;
    AttestPayGuarantee guarantee;
    MockBlockProver prover;

    address constant ANCHOR = address(0xFAC7);
    address constant ANCHORER = address(0x5E2E);
    uint64 constant HEIGHT = 11_700_000;

    uint256 constant LENDER_PK = 0xA11CE;
    uint256 constant BORROWER_PK = 0xB0B;
    address lender;
    address borrower;
    address guarantor = address(0x6A);
    address guarantor2 = address(0x6B);

    function setUp() public {
        prover = new MockBlockProver();
        line = new AttestPayCreditLine(1, ANCHOR, ANCHORER, address(prover));
        guarantee = new AttestPayGuarantee(address(line));
        lender = vm.addr(LENDER_PK);
        borrower = vm.addr(BORROWER_PK);
        vm.deal(guarantor, 100 ether);
        vm.deal(guarantor2, 100 ether);
        vm.warp(1_757_000_000);
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Opens a 10 USDC line, draws `drawAtoms`, and lets it default.
    function _defaultedLine(uint256 drawAtoms) internal returns (bytes32 id) {
        AttestPayCreditLine.LineTerms memory t = AttestPayCreditLine.LineTerms({
            lender: lender,
            borrower: borrower,
            limit: 10_000_000,
            interestBps: 0,
            expiresAt: block.timestamp + 1 days,
            nonce: 1
        });
        bytes32 digest = line.digestOf(t);
        id = line.openLine(t, _sign(LENDER_PK, digest), _sign(BORROWER_PK, digest));
        ProvenTxDecoder.Log memory l = FactEncoding.transferLog(
            FactEncoding.CREDIT_DRAWN,
            ANCHOR,
            id,
            borrower,
            lender,
            drawAtoms,
            keccak256("d"),
            block.timestamp,
            ANCHORER
        );
        line.verifyFacts(
            HEIGHT,
            FactEncoding.encode(FactEncoding.one(l)),
            IBlockProver.TransactionMerkleProof({root: 0, siblings: new IBlockProver.MerkleProofEntry[](0)}),
            IBlockProver.ContinuityProof({lowerEndpointDigest: 0, roots: new bytes32[](0)})
        );
        vm.warp(t.expiresAt + 1);
        line.markDefaulted(id);
    }

    // -----------------------------------------------------------------------
    // Bonding
    // -----------------------------------------------------------------------

    function test_bondAccumulatesAndIsReadable() public {
        vm.prank(guarantor);
        guarantee.bond{value: 3 ether}(borrower);
        vm.prank(guarantor);
        guarantee.bond{value: 2 ether}(borrower);
        assertEq(guarantee.guaranteeOf(borrower), 5 ether);
        assertEq(guarantee.bondOf(borrower, guarantor).amount, 5 ether);
        assertEq(guarantee.guarantorsOf(borrower).length, 1, "same guarantor listed once");
    }

    function test_rejectsZeroBond() public {
        vm.prank(guarantor);
        vm.expectRevert(AttestPayGuarantee.ZeroAmount.selector);
        guarantee.bond{value: 0}(borrower);
    }

    function test_unbondNeedsRequestAndDelay() public {
        vm.startPrank(guarantor);
        guarantee.bond{value: 1 ether}(borrower);

        vm.expectRevert(AttestPayGuarantee.UnbondNotRequested.selector);
        guarantee.unbond(borrower);

        guarantee.requestUnbond(borrower);
        vm.expectRevert(abi.encodeWithSelector(AttestPayGuarantee.UnbondTooEarly.selector, block.timestamp + 7 days));
        guarantee.unbond(borrower);

        vm.warp(block.timestamp + 7 days);
        uint256 before = guarantor.balance;
        guarantee.unbond(borrower);
        vm.stopPrank();
        assertEq(guarantor.balance, before + 1 ether);
        assertEq(guarantee.guaranteeOf(borrower), 0);
    }

    /// Topping up is a renewed commitment: it must reset a pending unbond so a
    /// guarantor cannot keep a running clock while appearing fully committed.
    function test_topUpCancelsPendingUnbond() public {
        vm.startPrank(guarantor);
        guarantee.bond{value: 1 ether}(borrower);
        guarantee.requestUnbond(borrower);
        guarantee.bond{value: 1 ether}(borrower);
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(AttestPayGuarantee.UnbondNotRequested.selector);
        guarantee.unbond(borrower);
        vm.stopPrank();
    }

    // -----------------------------------------------------------------------
    // Slashing
    // -----------------------------------------------------------------------

    function test_slashPaysLenderUpToOutstanding() public {
        vm.prank(guarantor);
        guarantee.bond{value: 10 ether}(borrower);
        bytes32 id = _defaultedLine(4_000_000); // 4 USDC outstanding -> 4 CTC due

        uint256 before = lender.balance;
        uint256 paid = guarantee.slash(id);
        assertEq(paid, 4 ether);
        assertEq(lender.balance, before + 4 ether);
        assertEq(guarantee.guaranteeOf(borrower), 6 ether, "the rest stays bonded");
        assertEq(guarantee.slashedForLine(id), 4 ether);
    }

    function test_slashIsCappedByBondAndDrawsGuarantorsInOrder() public {
        vm.prank(guarantor);
        guarantee.bond{value: 1 ether}(borrower);
        vm.prank(guarantor2);
        guarantee.bond{value: 2 ether}(borrower);
        bytes32 id = _defaultedLine(5_000_000); // 5 due, only 3 bonded

        uint256 paid = guarantee.slash(id);
        assertEq(paid, 3 ether);
        assertEq(guarantee.bondOf(borrower, guarantor).amount, 0, "first guarantor drained first");
        assertEq(guarantee.bondOf(borrower, guarantor2).amount, 0);
        assertEq(guarantee.guaranteeOf(borrower), 0);
    }

    function test_cannotSlashTwiceForTheSameDefault() public {
        vm.prank(guarantor);
        guarantee.bond{value: 10 ether}(borrower);
        bytes32 id = _defaultedLine(4_000_000);
        guarantee.slash(id);
        vm.expectRevert(abi.encodeWithSelector(AttestPayGuarantee.NothingToSlash.selector, id));
        guarantee.slash(id);
        assertEq(guarantee.guaranteeOf(borrower), 6 ether);
    }

    /// A partial slash (bond too small) followed by a top-up lets the remainder be
    /// collected — but never more than the outstanding total.
    function test_secondSlashCollectsOnlyTheRemainder() public {
        vm.prank(guarantor);
        guarantee.bond{value: 1 ether}(borrower);
        bytes32 id = _defaultedLine(4_000_000);
        assertEq(guarantee.slash(id), 1 ether);

        vm.prank(guarantor2);
        guarantee.bond{value: 10 ether}(borrower);
        assertEq(guarantee.slash(id), 3 ether);
        assertEq(guarantee.guaranteeOf(borrower), 7 ether);
    }

    function test_cannotSlashALiveLine() public {
        vm.prank(guarantor);
        guarantee.bond{value: 1 ether}(borrower);
        AttestPayCreditLine.LineTerms memory t = AttestPayCreditLine.LineTerms({
            lender: lender,
            borrower: borrower,
            limit: 10_000_000,
            interestBps: 0,
            expiresAt: block.timestamp + 1 days,
            nonce: 2
        });
        bytes32 digest = line.digestOf(t);
        bytes32 id = line.openLine(t, _sign(LENDER_PK, digest), _sign(BORROWER_PK, digest));
        vm.expectRevert(abi.encodeWithSelector(AttestPayGuarantee.LineNotDefaulted.selector, id));
        guarantee.slash(id);
    }

    function test_slashWithNoBondReverts() public {
        bytes32 id = _defaultedLine(1_000_000);
        vm.expectRevert(abi.encodeWithSelector(AttestPayGuarantee.NothingToSlash.selector, id));
        guarantee.slash(id);
    }

    /// A guarantor who requested unbond before the default still pays: the delay
    /// exists exactly so the bond cannot leave ahead of the slash.
    function test_pendingUnbondDoesNotEscapeSlash() public {
        vm.startPrank(guarantor);
        guarantee.bond{value: 5 ether}(borrower);
        guarantee.requestUnbond(borrower);
        vm.stopPrank();
        bytes32 id = _defaultedLine(2_000_000);
        assertEq(guarantee.slash(id), 2 ether);
        assertEq(guarantee.bondOf(borrower, guarantor).amount, 3 ether);
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(AttestPayGuarantee.ZeroAddress.selector);
        new AttestPayGuarantee(address(0));
    }
}
