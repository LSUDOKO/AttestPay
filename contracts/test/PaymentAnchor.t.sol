// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentAnchor} from "../src/PaymentAnchor.sol";

contract PaymentAnchorTest is Test {
    PaymentAnchor anchor;

    bytes32 constant CARD = keccak256("card_abc");
    address constant PAYER = address(0x9A1D);
    address constant MERCHANT = address(0x4E12);
    bytes32 constant BASE_TX = keccak256("base_tx");

    event PaymentAnchored(
        bytes32 indexed cardId,
        address indexed payer,
        address indexed merchant,
        uint256 amount,
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 paidAt,
        address anchoredBy,
        string memo
    );

    function setUp() public {
        anchor = new PaymentAnchor();
        vm.warp(1_757_000_000);
    }

    function _anchor(uint256 amount, bytes32 txHash) internal {
        anchor.anchorPayment(CARD, PAYER, MERCHANT, amount, 8453, txHash, 1_756_900_000, "coffee");
    }

    function test_emitsAnchoredEventWithSenderRecorded() public {
        address sender = address(0xABCD);
        vm.expectEmit(true, true, true, true);
        emit PaymentAnchored(
            CARD, PAYER, MERCHANT, 2_000_000, 8453, BASE_TX, 1_756_900_000, sender, "coffee"
        );
        vm.prank(sender);
        _anchor(2_000_000, BASE_TX);
    }

    function test_tracksAnchorCountPerCard() public {
        _anchor(1_000_000, keccak256("tx1"));
        _anchor(2_000_000, keccak256("tx2"));
        assertEq(anchor.anchorCount(CARD), 2);
        assertEq(anchor.anchorCount(keccak256("other_card")), 0);
    }

    /// One Base payment must not be anchorable twice: repetition would otherwise inflate
    /// a credit score without any new money moving.
    function test_rejectsDuplicateSourcePayment() public {
        _anchor(2_000_000, BASE_TX);
        vm.expectRevert(abi.encodeWithSelector(PaymentAnchor.AlreadyAnchored.selector, 8453, BASE_TX));
        _anchor(2_000_000, BASE_TX);
        assertEq(anchor.anchorCount(CARD), 1);
    }

    /// The same transaction hash on a different chain is a genuinely different payment.
    function test_sameTxHashOnDifferentChainIsAllowed() public {
        _anchor(2_000_000, BASE_TX);
        anchor.anchorPayment(CARD, PAYER, MERCHANT, 2_000_000, 84532, BASE_TX, 1_756_900_000, "coffee");
        assertEq(anchor.anchorCount(CARD), 2);
    }

    /// Duplicate detection must survive a different caller: the guard is on the payment,
    /// not on who reports it.
    function test_duplicateRejectedEvenFromDifferentSender() public {
        vm.prank(address(0x1111));
        _anchor(2_000_000, BASE_TX);
        vm.prank(address(0x2222));
        vm.expectRevert(abi.encodeWithSelector(PaymentAnchor.AlreadyAnchored.selector, 8453, BASE_TX));
        _anchor(2_000_000, BASE_TX);
    }

    function test_rejectsZeroAmount() public {
        vm.expectRevert(PaymentAnchor.ZeroAmount.selector);
        _anchor(0, BASE_TX);
    }

    /// An anchor nobody can check back against a source transaction is worse than none.
    function test_rejectsZeroSourceTxHash() public {
        vm.expectRevert(PaymentAnchor.ZeroSourceTxHash.selector);
        _anchor(2_000_000, bytes32(0));
    }

    function test_isAnchoredReflectsState() public {
        assertFalse(anchor.isAnchored(8453, BASE_TX));
        _anchor(2_000_000, BASE_TX);
        assertTrue(anchor.isAnchored(8453, BASE_TX));
        assertFalse(anchor.isAnchored(84532, BASE_TX));
    }

    function test_sourceKeyIsChainScoped() public view {
        assertTrue(anchor.sourceKey(8453, BASE_TX) != anchor.sourceKey(84532, BASE_TX));
        assertEq(anchor.sourceKey(8453, BASE_TX), keccak256(abi.encode(uint256(8453), BASE_TX)));
    }
}
