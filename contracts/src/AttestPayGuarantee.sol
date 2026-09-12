// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AttestPayCreditLine} from "./AttestPayCreditLine.sol";

/// @title AttestPayGuarantee — CTC bonds that stand behind an agent's credit
/// @notice Creditcoin is a staking chain: validators bond CTC and are slashed for
/// misbehaviour. This contract applies the same primitive to agent credit. A
/// guarantor bonds native CTC behind a borrower; a lender opening a line can read
/// `guaranteeOf(borrower)` and price accordingly; and when a line is proven to
/// have defaulted, anyone may slash the bond in the lender's favour.
///
/// It is the only way a line makes sense for an agent with NO history yet: the
/// operator who deploys the agent puts its money where the agent's reputation will
/// eventually be.
///
/// Slashing is permissionless and mechanical: the default is a state on
/// `AttestPayCreditLine` reached only through proven facts and a passed expiry, so
/// there is no judgement call and no privileged slasher. Unbonding takes a delay
/// long enough that a guarantor cannot watch a line go bad and pull the bond first.
contract AttestPayGuarantee {
    AttestPayCreditLine public immutable creditLine;

    /// @notice Unbond delay. Longer than any realistic gap between a line's expiry
    /// and its `markDefaulted` call.
    uint256 public constant UNBOND_DELAY = 7 days;

    struct Bond {
        uint256 amount;
        uint256 unbondRequestedAt;
    }

    /// @dev borrower => guarantor => bond
    mapping(address => mapping(address => Bond)) private _bonds;
    /// @dev borrower => guarantors that have ever bonded (kept for slashing order)
    mapping(address => address[]) private _guarantors;
    mapping(address => mapping(address => bool)) private _known;
    /// @notice Total CTC currently bonded behind a borrower.
    mapping(address => uint256) public totalBonded;
    /// @notice CTC already slashed towards a line, so a default is paid at most once.
    mapping(bytes32 => uint256) public slashedForLine;

    event Bonded(address indexed borrower, address indexed guarantor, uint256 amount, uint256 total);
    event UnbondRequested(address indexed borrower, address indexed guarantor, uint256 availableAt);
    event Unbonded(address indexed borrower, address indexed guarantor, uint256 amount);
    event Slashed(bytes32 indexed lineId, address indexed borrower, address indexed lender, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NoBond();
    error UnbondNotRequested();
    error UnbondTooEarly(uint256 availableAt);
    error LineNotDefaulted(bytes32 lineId);
    error NothingToSlash(bytes32 lineId);
    error TransferFailed();

    constructor(address _creditLine) {
        if (_creditLine == address(0)) revert ZeroAddress();
        creditLine = AttestPayCreditLine(_creditLine);
    }

    // -----------------------------------------------------------------------
    // Bonding
    // -----------------------------------------------------------------------

    /// @notice Bonds `msg.value` of CTC behind `borrower`. Topping up an existing bond
    /// cancels any pending unbond request: adding money is a renewed commitment.
    function bond(address borrower) external payable {
        if (borrower == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        Bond storage b = _bonds[borrower][msg.sender];
        b.amount += msg.value;
        b.unbondRequestedAt = 0;
        totalBonded[borrower] += msg.value;
        if (!_known[borrower][msg.sender]) {
            _known[borrower][msg.sender] = true;
            _guarantors[borrower].push(msg.sender);
        }
        emit Bonded(borrower, msg.sender, msg.value, totalBonded[borrower]);
    }

    /// @notice Starts the unbond clock.
    function requestUnbond(address borrower) external {
        Bond storage b = _bonds[borrower][msg.sender];
        if (b.amount == 0) revert NoBond();
        b.unbondRequestedAt = block.timestamp;
        emit UnbondRequested(borrower, msg.sender, block.timestamp + UNBOND_DELAY);
    }

    /// @notice Withdraws the bond once the delay has passed. Whatever was slashed in
    /// the meantime is gone; the remainder comes back.
    function unbond(address borrower) external {
        Bond storage b = _bonds[borrower][msg.sender];
        if (b.amount == 0) revert NoBond();
        if (b.unbondRequestedAt == 0) revert UnbondNotRequested();
        uint256 availableAt = b.unbondRequestedAt + UNBOND_DELAY;
        if (block.timestamp < availableAt) revert UnbondTooEarly(availableAt);

        uint256 amount = b.amount;
        b.amount = 0;
        b.unbondRequestedAt = 0;
        totalBonded[borrower] -= amount;
        emit Unbonded(borrower, msg.sender, amount);

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // -----------------------------------------------------------------------
    // Slashing
    // -----------------------------------------------------------------------

    /// @notice Pays a defaulted line's lender out of the borrower's bonds, up to what
    /// is outstanding and not already slashed. Guarantors are drawn in bonding order.
    /// @return paid CTC transferred to the lender this call.
    function slash(bytes32 lineId) external returns (uint256 paid) {
        AttestPayCreditLine.Line memory line = creditLine.getLine(lineId);
        if (line.status != AttestPayCreditLine.LineStatus.Defaulted) revert LineNotDefaulted(lineId);

        // Outstanding is in USDC atoms (6dp); the bond is CTC wei (18dp). The
        // guarantee is denominated in CTC and pays out 1 CTC per 1 USDC outstanding,
        // which is what a guarantor signed up for by bonding behind this borrower.
        // A price-aware conversion would need an oracle this design deliberately avoids.
        uint256 outstandingAtoms = creditLine.outstanding(lineId);
        uint256 due = outstandingAtoms * 1e12;
        uint256 already = slashedForLine[lineId];
        if (due <= already) revert NothingToSlash(lineId);
        uint256 remaining = due - already;

        address borrower = line.terms.borrower;
        address[] storage gs = _guarantors[borrower];
        for (uint256 i = 0; i < gs.length && remaining > 0; i++) {
            Bond storage b = _bonds[borrower][gs[i]];
            if (b.amount == 0) continue;
            uint256 take = b.amount < remaining ? b.amount : remaining;
            b.amount -= take;
            remaining -= take;
            paid += take;
        }
        if (paid == 0) revert NothingToSlash(lineId);

        totalBonded[borrower] -= paid;
        slashedForLine[lineId] += paid;
        emit Slashed(lineId, borrower, line.terms.lender, paid);

        (bool ok,) = line.terms.lender.call{value: paid}("");
        if (!ok) revert TransferFailed();
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    /// @notice CTC currently standing behind a borrower.
    function guaranteeOf(address borrower) external view returns (uint256) {
        return totalBonded[borrower];
    }

    function bondOf(address borrower, address guarantor) external view returns (Bond memory) {
        return _bonds[borrower][guarantor];
    }

    function guarantorsOf(address borrower) external view returns (address[] memory) {
        return _guarantors[borrower];
    }
}
