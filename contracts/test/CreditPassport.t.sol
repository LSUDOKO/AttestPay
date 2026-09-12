// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AttestPayASC} from "../src/AttestPayASC.sol";
import {AttestPayCreditLine} from "../src/AttestPayCreditLine.sol";
import {AttestPayLedger} from "../src/AttestPayLedger.sol";
import {AttestPayGuarantee} from "../src/AttestPayGuarantee.sol";
import {CreditPassport} from "../src/CreditPassport.sol";
import {IBlockProver} from "../src/IBlockProver.sol";
import {ProvenTxDecoder} from "../src/ProvenTxDecoder.sol";
import {MockBlockProver} from "./MockBlockProver.sol";
import {AttestcoinEncoding} from "./AttestcoinEncoding.sol";
import {FactEncoding} from "./FactEncoding.sol";

/// The passport composes four contracts; these tests drive real state into each and
/// check the composed view and the on-chain score against the published formula.
contract CreditPassportTest is Test {
    AttestPayASC asc;
    AttestPayCreditLine line;
    AttestPayLedger ledger;
    AttestPayGuarantee guarantee;
    CreditPassport passport;
    MockBlockProver prover;

    address constant PAY_ANCHOR = address(0xA0C0);
    address constant FACT_ANCHOR = address(0xFAC7);
    address constant ANCHORER = address(0x5E2E);
    address constant MERCHANT = address(0x4E12);
    bytes32 constant CARD = keccak256("card_abc");
    uint64 constant HEIGHT = 11_700_000;

    uint256 constant LENDER_PK = 0xA11CE;
    uint256 constant BORROWER_PK = 0xB0B;
    address lender;
    address agent;

    function setUp() public {
        prover = new MockBlockProver();
        asc = new AttestPayASC(1, PAY_ANCHOR, ANCHORER, address(prover));
        line = new AttestPayCreditLine(1, FACT_ANCHOR, ANCHORER, address(prover));
        ledger = new AttestPayLedger(1, FACT_ANCHOR, ANCHORER, address(prover));
        guarantee = new AttestPayGuarantee(address(line));
        passport = new CreditPassport(address(asc), address(line), address(ledger), address(guarantee));
        lender = vm.addr(LENDER_PK);
        agent = vm.addr(BORROWER_PK);
        vm.warp(1_757_000_000);
    }

    function _merkle() internal pure returns (IBlockProver.TransactionMerkleProof memory p) {
        p = IBlockProver.TransactionMerkleProof({root: 0, siblings: new IBlockProver.MerkleProofEntry[](0)});
    }

    function _cont() internal pure returns (IBlockProver.ContinuityProof memory p) {
        p = IBlockProver.ContinuityProof({lowerEndpointDigest: 0, roots: new bytes32[](0)});
    }

    uint64 txi;

    function _nextTx() internal {
        txi += 1;
        prover.setTxIndex(txi);
    }

    function _payment(uint256 amount, uint256 paidAt) internal {
        _nextTx();
        ProvenTxDecoder.Log memory l = AttestcoinEncoding.anchoredLog(
            PAY_ANCHOR,
            asc.PAYMENT_ANCHORED_TOPIC(),
            CARD,
            agent,
            MERCHANT,
            amount,
            8453,
            keccak256(abi.encode("tx", txi)),
            paidAt,
            ANCHORER,
            "m"
        );
        ProvenTxDecoder.Log[] memory ls = new ProvenTxDecoder.Log[](1);
        ls[0] = l;
        asc.verifyPayment(HEIGHT, AttestcoinEncoding.encodeType2(1, ls), _merkle(), _cont());
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _openLine(uint256 nonce, uint256 expiresAt) internal returns (bytes32 id) {
        AttestPayCreditLine.LineTerms memory t = AttestPayCreditLine.LineTerms({
            lender: lender, borrower: agent, limit: 10_000_000, interestBps: 0, expiresAt: expiresAt, nonce: nonce
        });
        bytes32 digest = line.digestOf(t);
        id = line.openLine(t, _sign(LENDER_PK, digest), _sign(BORROWER_PK, digest));
    }

    function _fact(ProvenTxDecoder.Log memory l, bool toLedger) internal {
        _nextTx();
        bytes memory enc = FactEncoding.encode(FactEncoding.one(l));
        if (toLedger) ledger.verifyFacts(HEIGHT, enc, _merkle(), _cont());
        else line.verifyFacts(HEIGHT, enc, _merkle(), _cont());
    }

    function _draw(bytes32 id, uint256 amount) internal {
        _fact(
            FactEncoding.transferLog(
                FactEncoding.CREDIT_DRAWN,
                FACT_ANCHOR,
                id,
                agent,
                lender,
                amount,
                keccak256(abi.encode("d", txi)),
                block.timestamp,
                ANCHORER
            ),
            false
        );
    }

    function _repay(bytes32 id, uint256 amount) internal {
        _fact(
            FactEncoding.transferLog(
                FactEncoding.CREDIT_REPAID,
                FACT_ANCHOR,
                id,
                agent,
                lender,
                amount,
                keccak256(abi.encode("r", txi)),
                block.timestamp,
                ANCHORER
            ),
            false
        );
    }

    // -----------------------------------------------------------------------

    function test_emptyPassportScoresF() public view {
        CreditPassport.Passport memory p = passport.passportOf(agent);
        assertEq(p.account, agent);
        assertEq(p.verifiedPayments, 0);
        assertEq(p.score, 0);
        assertEq(p.grade, "F");
        assertEq(p.asOf, block.timestamp);
    }

    /// 10 payments of 1 USDC over 30 days: 40 + 30 + 30 = 100 -> A.
    function test_paymentsAloneReachA() public {
        for (uint256 i = 0; i < 10; i++) {
            _payment(1_000_000, 1_756_000_000 + i * (30 days / 9));
        }
        CreditPassport.Passport memory p = passport.passportOf(agent);
        assertEq(p.verifiedPayments, 10);
        assertEq(p.verifiedVolume, 10_000_000);
        assertEq(p.score, 100);
        assertEq(p.grade, "A");
    }

    /// Two payments, same day: count 8 + volume 6 + age 0 = 14 -> F; a repaid line
    /// adds 10 -> 24 -> D. Credit behaviour moves the score.
    function test_repaidLineLiftsScore() public {
        _payment(1_000_000, 1_756_000_000);
        _payment(1_000_000, 1_756_000_000);
        (uint256 s0,) = passport.scoreOf(agent);
        assertEq(s0, 14);

        bytes32 id = _openLine(1, block.timestamp + 30 days);
        _draw(id, 5_000_000);
        _repay(id, 5_000_000);

        CreditPassport.Passport memory p = passport.passportOf(agent);
        assertEq(p.linesOpened, 1);
        assertEq(p.linesRepaid, 1);
        assertEq(p.totalDrawn, 5_000_000);
        assertEq(p.totalRepaid, 5_000_000);
        assertEq(p.score, 24);
        assertEq(p.grade, "D");
    }

    function test_defaultAndUpheldDisputePullScoreDown() public {
        for (uint256 i = 0; i < 10; i++) {
            _payment(1_000_000, 1_756_000_000 + i * (30 days / 9));
        }
        (uint256 s0,) = passport.scoreOf(agent);
        assertEq(s0, 100);

        // A default: -25.
        bytes32 id = _openLine(1, block.timestamp + 1 days);
        _draw(id, 5_000_000);
        vm.warp(block.timestamp + 2 days);
        line.markDefaulted(id);
        (uint256 s1,) = passport.scoreOf(agent);
        assertEq(s1, 75);

        // An upheld dispute: -10 more.
        bytes32 d = keccak256("dispute");
        _fact(
            FactEncoding.disputeOpenedLog(
                FACT_ANCHOR, d, CARD, agent, MERCHANT, keccak256("t"), 1_000_000, block.timestamp, ANCHORER, "bad"
            ),
            true
        );
        _fact(FactEncoding.disputeResolvedLog(FACT_ANCHOR, d, CARD, agent, 1, block.timestamp, ANCHORER), true);

        CreditPassport.Passport memory p = passport.passportOf(agent);
        assertEq(p.linesDefaulted, 1);
        assertEq(p.disputesOpened, 1);
        assertEq(p.disputesUpheld, 1);
        assertEq(p.disputedVolume, 1_000_000);
        assertEq(p.score, 65);
        assertEq(p.grade, "B");
    }

    /// A rejected dispute is recorded but does not move the score: the complaint did
    /// not stand.
    function test_rejectedDisputeDoesNotPenalise() public {
        _payment(1_000_000, 1_756_000_000);
        (uint256 s0,) = passport.scoreOf(agent);
        bytes32 d = keccak256("dispute");
        _fact(
            FactEncoding.disputeOpenedLog(
                FACT_ANCHOR, d, CARD, agent, MERCHANT, keccak256("t"), 1_000_000, block.timestamp, ANCHORER, "bad"
            ),
            true
        );
        _fact(FactEncoding.disputeResolvedLog(FACT_ANCHOR, d, CARD, agent, 2, block.timestamp, ANCHORER), true);
        (uint256 s1,) = passport.scoreOf(agent);
        assertEq(s1, s0);
        assertEq(passport.passportOf(agent).disputesRejected, 1);
    }

    function test_scoreClampsAtZero() public {
        _payment(1_000_000, 1_756_000_000); // 4 + 3 = 7
        bytes32 id = _openLine(1, block.timestamp + 1 days);
        _draw(id, 5_000_000);
        vm.warp(block.timestamp + 2 days);
        line.markDefaulted(id); // -25
        (uint256 s, string memory g) = passport.scoreOf(agent);
        assertEq(s, 0);
        assertEq(g, "F");
    }

    function test_guaranteeAppearsOnPassport() public {
        vm.deal(address(0x6A), 5 ether);
        vm.prank(address(0x6A));
        guarantee.bond{value: 5 ether}(agent);
        assertEq(passport.passportOf(agent).guaranteeBonded, 5 ether);
    }

    /// The compliance scaling from the ASC carries through unchanged.
    function test_termsComplianceScalesBase() public {
        asc.registerCardTerms(CARD, keccak256("terms"), 0, 0, 1_000_000, 0);
        _payment(1_000_000, block.timestamp + 10); // within terms
        _payment(9_000_000, block.timestamp + 20); // over perTxMax
        // count 8 + volume 30 (10 USDC) + age 0 = 38, x 1/2 = 19.
        (uint256 s,) = passport.scoreOf(agent);
        assertEq(s, 19);
    }

    function test_formulaIsPublished() public view {
        assertTrue(bytes(passport.formula()).length > 100);
        assertEq(passport.VERSION(), "1");
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(CreditPassport.ZeroAddress.selector);
        new CreditPassport(address(0), address(line), address(ledger), address(guarantee));
    }
}
