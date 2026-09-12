// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AttestPayASC} from "./AttestPayASC.sol";
import {AttestPayCreditLine} from "./AttestPayCreditLine.sol";
import {AttestPayLedger} from "./AttestPayLedger.sol";
import {AttestPayGuarantee} from "./AttestPayGuarantee.sol";

/// @title CreditPassport — one read for everything Creditcoin knows about an agent
/// @notice The four AttestPay contracts each hold one slice of an agent's record:
/// verified payments and terms compliance (`AttestPayASC`), credit lines drawn,
/// repaid and defaulted (`AttestPayCreditLine`), disputes (`AttestPayLedger`) and
/// the CTC bonded behind it (`AttestPayGuarantee`). A dApp that wants to underwrite
/// an agent should not need to know all four; it calls `passportOf` and gets one
/// struct with a stable ABI.
///
/// The score is the same published formula the AttestPay dashboard shows, computed
/// on-chain so nobody has to trust the dashboard's arithmetic. It is a readable
/// summary of public facts, not a risk model, and it says so in `formula()`.
contract CreditPassport {
    AttestPayASC public immutable asc;
    AttestPayCreditLine public immutable creditLine;
    AttestPayLedger public immutable ledger;
    AttestPayGuarantee public immutable guarantee;

    string public constant VERSION = "1";

    struct Passport {
        address account;
        // payments
        uint256 verifiedPayments;
        uint256 verifiedVolume;
        uint256 firstPaymentAt;
        uint256 lastPaymentAt;
        uint256 withinTermsPayments;
        uint256 termsCheckedPayments;
        // credit
        uint256 linesOpened;
        uint256 linesRepaid;
        uint256 linesDefaulted;
        uint256 totalDrawn;
        uint256 totalRepaid;
        // disputes
        uint256 disputesOpened;
        uint256 disputesUpheld;
        uint256 disputesRejected;
        uint256 disputedVolume;
        // guarantee
        uint256 guaranteeBonded;
        // summary
        uint256 score;
        string grade;
        uint256 asOf;
    }

    error ZeroAddress();

    constructor(address _asc, address _creditLine, address _ledger, address _guarantee) {
        if (_asc == address(0) || _creditLine == address(0) || _ledger == address(0) || _guarantee == address(0)) {
            revert ZeroAddress();
        }
        asc = AttestPayASC(_asc);
        creditLine = AttestPayCreditLine(_creditLine);
        ledger = AttestPayLedger(_ledger);
        guarantee = AttestPayGuarantee(_guarantee);
    }

    /// @notice The composed record for one funding account.
    function passportOf(address account) external view returns (Passport memory p) {
        AttestPayASC.AgentCredit memory c = asc.getAgentCredit(account);
        AttestPayCreditLine.BorrowerRecord memory b = creditLine.getBorrowerRecord(account);
        AttestPayLedger.DisputeRecord memory d = ledger.getDisputeRecord(account);

        p.account = account;
        p.verifiedPayments = c.totalPayments;
        p.verifiedVolume = c.totalVolume;
        p.firstPaymentAt = c.firstPaymentAt;
        p.lastPaymentAt = c.lastPaymentAt;
        p.withinTermsPayments = c.withinTermsPayments;
        p.termsCheckedPayments = c.termsCheckedPayments;
        p.linesOpened = b.linesOpened;
        p.linesRepaid = b.linesRepaid;
        p.linesDefaulted = b.linesDefaulted;
        p.totalDrawn = b.totalDrawn;
        p.totalRepaid = b.totalRepaid;
        p.disputesOpened = d.opened;
        p.disputesUpheld = d.upheld;
        p.disputesRejected = d.rejected;
        p.disputedVolume = d.disputedVolume;
        p.guaranteeBonded = guarantee.guaranteeOf(account);
        (p.score, p.grade) = _score(c, b, d);
        p.asOf = block.timestamp;
    }

    /// @notice The score alone, for callers that only want the number.
    function scoreOf(address account) external view returns (uint256 score, string memory grade) {
        return
            _score(asc.getAgentCredit(account), creditLine.getBorrowerRecord(account), ledger.getDisputeRecord(account));
    }

    /// @notice The formula, stated so nobody has to reverse-engineer it.
    function formula() external pure returns (string memory) {
        return "payment count x4 (max 40) + verified USDC x3 (max 30) + history days (max 30), "
            "scaled by the within-terms rate where terms were registered; then +10 per repaid line (max 20), "
            "-25 per defaulted line, -10 per upheld dispute; clamped to 0..100. "
            "A: 80+, B: 60+, C: 40+, D: 20+, F: below. A summary of public facts, not a risk model.";
    }

    function _score(
        AttestPayASC.AgentCredit memory c,
        AttestPayCreditLine.BorrowerRecord memory b,
        AttestPayLedger.DisputeRecord memory d
    ) private pure returns (uint256 score, string memory grade) {
        if (c.totalPayments == 0 && b.linesOpened == 0) return (0, "F");

        // Same three capped inputs as the dashboard's `creditGrade`, in integer math.
        uint256 countScore = _min(40, c.totalPayments * 4);
        uint256 volumeScore = _min(30, (c.totalVolume / 1e6) * 3);
        uint256 ageDays = c.firstPaymentAt > 0 && c.lastPaymentAt > c.firstPaymentAt
            ? (c.lastPaymentAt - c.firstPaymentAt) / 86_400
            : 0;
        uint256 ageScore = _min(30, ageDays);
        uint256 base = countScore + volumeScore + ageScore;
        if (c.termsCheckedPayments > 0) {
            base = base * c.withinTermsPayments / c.termsCheckedPayments;
        }

        // Credit behaviour moves the score in both directions.
        int256 adjusted = int256(base);
        adjusted += int256(_min(20, b.linesRepaid * 10));
        adjusted -= int256(b.linesDefaulted * 25);
        adjusted -= int256(d.upheld * 10);
        if (adjusted < 0) adjusted = 0;
        if (adjusted > 100) adjusted = 100;
        score = uint256(adjusted);

        grade = score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : score >= 20 ? "D" : "F";
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
