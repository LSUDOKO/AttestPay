// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {FactAnchor} from "../src/FactAnchor.sol";
import {FactEncoding} from "./FactEncoding.sol";

contract FactAnchorTest is Test {
    FactAnchor anchor;

    bytes32 constant LINE = keccak256("line");
    bytes32 constant CARD = keccak256("card_abc");
    bytes32 constant DISPUTE = keccak256("dispute_1");
    address constant BORROWER = address(0xB0B);
    address constant LENDER = address(0xA11CE);
    address constant MERCHANT = address(0x4E12);
    bytes32 constant TX1 = keccak256("tx1");

    function setUp() public {
        anchor = new FactAnchor();
        vm.warp(1_757_000_000);
    }

    // -----------------------------------------------------------------------
    // Topic pinning: the consumers hardcode these hashes, so a real emission must
    // produce exactly them
    // -----------------------------------------------------------------------

    function test_realEmissionsMatchConsumerTopics() public {
        vm.recordLogs();
        anchor.anchorDraw(LINE, BORROWER, LENDER, 1_000_000, 8453, TX1, 1_756_900_000);
        anchor.anchorRepayment(LINE, BORROWER, LENDER, 1_000_000, 8453, keccak256("tx2"), 1_756_900_100);
        anchor.anchorDisputeOpened(DISPUTE, CARD, BORROWER, MERCHANT, 8453, TX1, 1_000_000, 1_756_900_200, "wrong");
        anchor.anchorDisputeResolved(DISPUTE, CARD, BORROWER, 1, 1_756_900_300);
        anchor.anchorCardRevoked(CARD, BORROWER, 1_756_900_400);
        Vm.Log[] memory e = vm.getRecordedLogs();
        assertEq(e.length, 5);
        assertEq(e[0].topics[0], FactEncoding.CREDIT_DRAWN);
        assertEq(e[1].topics[0], FactEncoding.CREDIT_REPAID);
        assertEq(e[2].topics[0], FactEncoding.DISPUTE_OPENED);
        assertEq(e[3].topics[0], FactEncoding.DISPUTE_RESOLVED);
        assertEq(e[4].topics[0], FactEncoding.CARD_REVOKED);

        // Indexed layout: lineId / borrower / lender for transfers.
        assertEq(e[0].topics[1], LINE);
        assertEq(address(uint160(uint256(e[0].topics[2]))), BORROWER);
        assertEq(address(uint160(uint256(e[0].topics[3]))), LENDER);
        // The anchorer rides in the data, as msg.sender.
        (,,,, address anchoredBy) = abi.decode(e[0].data, (uint256, uint256, bytes32, uint256, address));
        assertEq(anchoredBy, address(this));
        // Revocation: cardId / payer indexed, revokedAt + anchorer in data.
        assertEq(e[4].topics.length, 3);
        assertEq(e[4].topics[1], CARD);
    }

    /// The test-side encoder must produce the same data layout the anchor emits, or
    /// the consumer tests would pass against a fiction.
    function test_encoderMatchesRealDrawLog() public {
        vm.recordLogs();
        anchor.anchorDraw(LINE, BORROWER, LENDER, 1_000_000, 8453, TX1, 1_756_900_000);
        Vm.Log[] memory e = vm.getRecordedLogs();
        bytes memory expected =
            FactEncoding.transferLog(
            FactEncoding.CREDIT_DRAWN,
            address(anchor),
            LINE,
            BORROWER,
            LENDER,
            1_000_000,
            TX1,
            1_756_900_000,
            address(this)
        ).data;
        assertEq(keccak256(e[0].data), keccak256(expected));
    }

    function test_encoderMatchesRealDisputeOpenedLog() public {
        vm.recordLogs();
        anchor.anchorDisputeOpened(DISPUTE, CARD, BORROWER, MERCHANT, 8453, TX1, 1_000_000, 1_756_900_200, "wrong item");
        Vm.Log[] memory e = vm.getRecordedLogs();
        bytes memory expected =
            FactEncoding.disputeOpenedLog(
            address(anchor),
            DISPUTE,
            CARD,
            BORROWER,
            MERCHANT,
            TX1,
            1_000_000,
            1_756_900_200,
            address(this),
            "wrong item"
        ).data;
        assertEq(keccak256(e[0].data), keccak256(expected));
    }

    // -----------------------------------------------------------------------
    // Replay guards
    // -----------------------------------------------------------------------

    function test_sameTransferCannotBeAnchoredTwiceAsSameKind() public {
        anchor.anchorDraw(LINE, BORROWER, LENDER, 1_000_000, 8453, TX1, 1_756_900_000);
        vm.expectRevert(abi.encodeWithSelector(FactAnchor.AlreadyAnchored.selector, 1, 8453, TX1));
        anchor.anchorDraw(LINE, BORROWER, LENDER, 1_000_000, 8453, TX1, 1_756_900_000);
    }

    /// A draw and a repayment are different claims about the same transaction hash;
    /// the guard is per kind so a mistaken kind can be corrected by the other kind
    /// never silently colliding.
    function test_drawAndRepaymentKeysAreDistinct() public {
        anchor.anchorDraw(LINE, BORROWER, LENDER, 1_000_000, 8453, TX1, 1_756_900_000);
        assertTrue(anchor.isTransferAnchored(1, 8453, TX1));
        assertFalse(anchor.isTransferAnchored(2, 8453, TX1));
    }

    function test_rejectsZeroAmountAndZeroTxHash() public {
        vm.expectRevert(FactAnchor.ZeroAmount.selector);
        anchor.anchorDraw(LINE, BORROWER, LENDER, 0, 8453, TX1, 1);
        vm.expectRevert(FactAnchor.ZeroSourceTxHash.selector);
        anchor.anchorRepayment(LINE, BORROWER, LENDER, 1, 8453, bytes32(0), 1);
    }

    function test_disputeOpensOnceAndResolvesOnce() public {
        anchor.anchorDisputeOpened(DISPUTE, CARD, BORROWER, MERCHANT, 8453, TX1, 1_000_000, 1, "r");
        vm.expectRevert(abi.encodeWithSelector(FactAnchor.DisputeAlreadyOpened.selector, DISPUTE));
        anchor.anchorDisputeOpened(DISPUTE, CARD, BORROWER, MERCHANT, 8453, TX1, 1_000_000, 1, "r");

        anchor.anchorDisputeResolved(DISPUTE, CARD, BORROWER, 2, 2);
        vm.expectRevert(abi.encodeWithSelector(FactAnchor.DisputeAlreadyResolved.selector, DISPUTE));
        anchor.anchorDisputeResolved(DISPUTE, CARD, BORROWER, 2, 2);
    }

    function test_cannotResolveUnopenedDispute() public {
        vm.expectRevert(abi.encodeWithSelector(FactAnchor.DisputeNotOpened.selector, DISPUTE));
        anchor.anchorDisputeResolved(DISPUTE, CARD, BORROWER, 1, 2);
    }

    function test_rejectsUnknownOutcome() public {
        anchor.anchorDisputeOpened(DISPUTE, CARD, BORROWER, MERCHANT, 8453, TX1, 1_000_000, 1, "r");
        vm.expectRevert(abi.encodeWithSelector(FactAnchor.InvalidOutcome.selector, 9));
        anchor.anchorDisputeResolved(DISPUTE, CARD, BORROWER, 9, 2);
    }

    function test_cardRevokesOnce() public {
        anchor.anchorCardRevoked(CARD, BORROWER, 1);
        vm.expectRevert(abi.encodeWithSelector(FactAnchor.CardAlreadyRevoked.selector, CARD));
        anchor.anchorCardRevoked(CARD, BORROWER, 2);
    }
}
