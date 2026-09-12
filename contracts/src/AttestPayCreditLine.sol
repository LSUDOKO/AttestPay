// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ProvenFacts} from "./ProvenFacts.sol";
import {ProvenTxDecoder} from "./ProvenTxDecoder.sol";

/// @title AttestPayCreditLine — agent credit lines, tracked cross-chain on Creditcoin
/// @notice Turns an agent's verified payment history into something it can borrow
/// against. A lender and a borrower both sign the line's terms (EIP-712); draws and
/// repayments happen as ordinary USDC transfers on Base; `FactAnchor` records them on
/// an attested chain; this contract proves those records and advances the line:
///
///   Open ──draw──▶ Active ──repaid in full──▶ Repaid
///                    │
///                    └──past expiry with a balance──▶ Defaulted ──repaid──▶ Repaid
///   Open ──past expiry, never drawn──▶ Closed
///
/// Modelled on the Attestcoin protocol's `ASCLoanManager` example, with two changes
/// that matter for a product rather than a tutorial:
///
///   - Terms are signed under an EIP-712 domain (chain id + this contract's address)
///     with a per-lender nonce. The example hashes terms with `abi.encodePacked` and
///     no domain, so one signature is valid on every deployment of the manager and
///     can be re-registered at will. Here a signature binds one line, on one chain,
///     on one contract, once.
///   - Registration is permissionless rather than `onlyOwner`. Both parties' signatures
///     are required, so it does not matter who submits them; there is no operator key
///     whose compromise lets lines appear.
///
/// The `trustedAnchorer` requirement is inherited: a draw or repayment is credited
/// only when the anchorer AttestPay was deployed with vouched for it. That is the
/// same honest hop as payments — the proof establishes the anchor, the anchorer
/// asserts the Base transfer, and `sourceTxHash` lets anyone check.
contract AttestPayCreditLine is ProvenFacts {
    enum LineStatus {
        None,
        Open,
        Active,
        Repaid,
        Defaulted,
        Closed
    }

    /// @param lender The account funds are drawn from and repaid to.
    /// @param borrower The account funds are drawn to (the card tree's funding account).
    /// @param limit Maximum total draw, USDC atoms.
    /// @param interestBps Simple interest on the drawn amount, basis points.
    /// @param expiresAt Unix seconds after which a balance is a default.
    /// @param nonce Per-lender nonce; each may be used once.
    struct LineTerms {
        address lender;
        address borrower;
        uint256 limit;
        uint256 interestBps;
        uint256 expiresAt;
        uint256 nonce;
    }

    struct Line {
        LineTerms terms;
        LineStatus status;
        uint256 drawn;
        uint256 repaid;
        uint256 openedAt;
        uint256 lastEventAt;
        uint256 defaultedAt;
        uint256 repaidAt;
    }

    /// @notice A borrower's aggregate record across every line, for the passport.
    struct BorrowerRecord {
        uint256 linesOpened;
        uint256 linesRepaid;
        uint256 linesDefaulted;
        uint256 totalDrawn;
        uint256 totalRepaid;
    }

    bytes32 public constant LINE_TYPEHASH = keccak256(
        "CreditLine(address lender,address borrower,uint256 limit,uint256 interestBps,uint256 expiresAt,uint256 nonce)"
    );

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev `keccak256("CreditDrawn(bytes32,address,address,uint256,uint256,bytes32,uint256,address)")`
    bytes32 public constant CREDIT_DRAWN_TOPIC =
        keccak256("CreditDrawn(bytes32,address,address,uint256,uint256,bytes32,uint256,address)");
    /// @dev `keccak256("CreditRepaid(bytes32,address,address,uint256,uint256,bytes32,uint256,address)")`
    bytes32 public constant CREDIT_REPAID_TOPIC =
        keccak256("CreditRepaid(bytes32,address,address,uint256,uint256,bytes32,uint256,address)");

    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(bytes32 => Line) private _lines;
    mapping(address => BorrowerRecord) private _borrowers;
    mapping(address => bytes32[]) private _borrowerLines;
    mapping(address => bytes32[]) private _lenderLines;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    event LineOpened(
        bytes32 indexed lineId, address indexed lender, address indexed borrower, uint256 limit, uint256 expiresAt
    );
    event LineDrawn(bytes32 indexed lineId, uint256 amount, uint256 drawn, bytes32 sourceTxHash);
    event LineRepaid(bytes32 indexed lineId, uint256 amount, uint256 repaid, bytes32 sourceTxHash);
    event LineFullyRepaid(bytes32 indexed lineId);
    event LineDefaulted(bytes32 indexed lineId, uint256 outstanding);
    event LineClosed(bytes32 indexed lineId);

    error InvalidTerms(string reason);
    error InvalidSignature(string which);
    error NonceUsed(address lender, uint256 nonce);
    error LineExists(bytes32 lineId);
    error UnknownLine(bytes32 lineId);
    error WrongStatus(bytes32 lineId, LineStatus status);
    error PartyMismatch(bytes32 lineId);
    error DrawExceedsLimit(bytes32 lineId, uint256 drawn, uint256 amount, uint256 limit);
    error LineExpired(bytes32 lineId, uint256 at, uint256 expiresAt);
    error NotExpired(bytes32 lineId);
    error NothingOutstanding(bytes32 lineId);

    constructor(uint64 _sourceChainKey, address _factAnchor, address _trustedAnchorer, address _blockProver)
        ProvenFacts(_sourceChainKey, _factAnchor, _trustedAnchorer, _blockProver)
    {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("AttestPayCreditLine"), keccak256("1"), block.chainid, address(this))
        );
    }

    // -----------------------------------------------------------------------
    // Opening a line: both parties sign, anyone submits
    // -----------------------------------------------------------------------

    /// @notice The EIP-712 struct hash of a set of terms. Doubles as the line id, so
    /// a line is named by what was agreed, not by a counter.
    function lineIdOf(LineTerms memory t) public pure returns (bytes32) {
        return keccak256(abi.encode(LINE_TYPEHASH, t.lender, t.borrower, t.limit, t.interestBps, t.expiresAt, t.nonce));
    }

    /// @notice The digest both parties sign.
    function digestOf(LineTerms memory t) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, lineIdOf(t)));
    }

    /// @notice Registers a line both parties have signed.
    function openLine(LineTerms calldata t, bytes calldata lenderSig, bytes calldata borrowerSig)
        external
        returns (bytes32 lineId)
    {
        if (t.lender == address(0) || t.borrower == address(0)) revert InvalidTerms("zero party");
        if (t.lender == t.borrower) revert InvalidTerms("lender is borrower");
        if (t.limit == 0) revert InvalidTerms("zero limit");
        if (t.expiresAt <= block.timestamp) revert InvalidTerms("already expired");
        if (t.interestBps > 10_000) revert InvalidTerms("interest over 100%");
        if (nonceUsed[t.lender][t.nonce]) revert NonceUsed(t.lender, t.nonce);

        bytes32 digest = digestOf(t);
        if (_recover(digest, lenderSig) != t.lender) revert InvalidSignature("lender");
        if (_recover(digest, borrowerSig) != t.borrower) revert InvalidSignature("borrower");

        lineId = lineIdOf(t);
        if (_lines[lineId].status != LineStatus.None) revert LineExists(lineId);

        nonceUsed[t.lender][t.nonce] = true;
        Line storage line = _lines[lineId];
        line.terms = t;
        line.status = LineStatus.Open;
        line.openedAt = block.timestamp;
        line.lastEventAt = block.timestamp;

        _borrowers[t.borrower].linesOpened += 1;
        _borrowerLines[t.borrower].push(lineId);
        _lenderLines[t.lender].push(lineId);

        emit LineOpened(lineId, t.lender, t.borrower, t.limit, t.expiresAt);
    }

    // -----------------------------------------------------------------------
    // Proven draws and repayments
    // -----------------------------------------------------------------------

    function _understands(bytes32 topic0) internal pure override returns (bool) {
        return topic0 == CREDIT_DRAWN_TOPIC || topic0 == CREDIT_REPAID_TOPIC;
    }

    /// @dev One decoded transfer event, as a struct to keep `_consumeLog` inside the
    /// EVM's stack budget.
    struct Transfer {
        bytes32 lineId;
        address borrower;
        address lender;
        uint256 amount;
        uint256 sourceChainId;
        bytes32 sourceTxHash;
        uint256 at;
        address anchoredBy;
    }

    function _decode(ProvenTxDecoder.Log memory log) private pure returns (Transfer memory ev) {
        ev.lineId = log.topics[1];
        ev.borrower = ProvenTxDecoder.topicToAddress(log.topics[2]);
        ev.lender = ProvenTxDecoder.topicToAddress(log.topics[3]);
        (ev.amount, ev.sourceChainId, ev.sourceTxHash, ev.at, ev.anchoredBy) =
            abi.decode(log.data, (uint256, uint256, bytes32, uint256, address));
    }

    function _consumeLog(ProvenTxDecoder.Log memory log, uint64) internal override {
        if (log.topics.length != 4) revert InvalidTerms("malformed log");
        Transfer memory ev = _decode(log);
        _requireTrusted(ev.anchoredBy);

        Line storage line = _lines[ev.lineId];
        if (line.status == LineStatus.None) revert UnknownLine(ev.lineId);
        if (ev.borrower != line.terms.borrower || ev.lender != line.terms.lender) revert PartyMismatch(ev.lineId);

        if (log.topics[0] == CREDIT_DRAWN_TOPIC) _draw(line, ev);
        else _repay(line, ev);

        line.lastEventAt = ev.at;
    }

    function _draw(Line storage line, Transfer memory ev) private {
        if (line.status != LineStatus.Open && line.status != LineStatus.Active) {
            revert WrongStatus(ev.lineId, line.status);
        }
        // A draw after expiry is an anchorer error, not a fact to record: the lender's
        // own card delegation should already have refused it.
        if (ev.at > line.terms.expiresAt) revert LineExpired(ev.lineId, ev.at, line.terms.expiresAt);
        if (line.drawn + ev.amount > line.terms.limit) {
            revert DrawExceedsLimit(ev.lineId, line.drawn, ev.amount, line.terms.limit);
        }
        line.drawn += ev.amount;
        line.status = LineStatus.Active;
        _borrowers[line.terms.borrower].totalDrawn += ev.amount;
        emit LineDrawn(ev.lineId, ev.amount, line.drawn, ev.sourceTxHash);
    }

    function _repay(Line storage line, Transfer memory ev) private {
        // Repayment is recorded whenever there is a balance, including after a default:
        // money that came back is a fact, and a late repayment is a better history than
        // an unpaid one. The `defaultedAt` timestamp stays as the record of lateness.
        if (line.status != LineStatus.Active && line.status != LineStatus.Defaulted) {
            revert WrongStatus(ev.lineId, line.status);
        }
        line.repaid += ev.amount;
        _borrowers[line.terms.borrower].totalRepaid += ev.amount;
        emit LineRepaid(ev.lineId, ev.amount, line.repaid, ev.sourceTxHash);

        if (line.repaid >= _owed(line)) {
            line.status = LineStatus.Repaid;
            line.repaidAt = ev.at;
            _borrowers[line.terms.borrower].linesRepaid += 1;
            emit LineFullyRepaid(ev.lineId);
        }
    }

    // -----------------------------------------------------------------------
    // Time-based transitions: permissionless, anyone may advance a stale line
    // -----------------------------------------------------------------------

    /// @notice Marks an active line past its expiry with a balance as defaulted.
    function markDefaulted(bytes32 lineId) external {
        Line storage line = _lines[lineId];
        if (line.status != LineStatus.Active) revert WrongStatus(lineId, line.status);
        if (block.timestamp <= line.terms.expiresAt) revert NotExpired(lineId);
        uint256 out = _outstanding(line);
        if (out == 0) revert NothingOutstanding(lineId);
        line.status = LineStatus.Defaulted;
        line.defaultedAt = block.timestamp;
        _borrowers[line.terms.borrower].linesDefaulted += 1;
        emit LineDefaulted(lineId, out);
    }

    /// @notice Closes an open line that expired without ever being drawn.
    function closeUnused(bytes32 lineId) external {
        Line storage line = _lines[lineId];
        if (line.status != LineStatus.Open) revert WrongStatus(lineId, line.status);
        if (block.timestamp <= line.terms.expiresAt) revert NotExpired(lineId);
        line.status = LineStatus.Closed;
        emit LineClosed(lineId);
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    function getLine(bytes32 lineId) external view returns (Line memory) {
        return _lines[lineId];
    }

    /// @notice Total owed on a line: drawn plus simple interest.
    function owed(bytes32 lineId) external view returns (uint256) {
        return _owed(_lines[lineId]);
    }

    /// @notice What is still due: owed minus repaid, floored at zero.
    function outstanding(bytes32 lineId) external view returns (uint256) {
        return _outstanding(_lines[lineId]);
    }

    /// @notice What may still be drawn.
    function available(bytes32 lineId) external view returns (uint256) {
        Line storage line = _lines[lineId];
        if (line.status != LineStatus.Open && line.status != LineStatus.Active) return 0;
        if (block.timestamp > line.terms.expiresAt) return 0;
        return line.terms.limit - line.drawn;
    }

    function getBorrowerRecord(address borrower) external view returns (BorrowerRecord memory) {
        return _borrowers[borrower];
    }

    function borrowerLines(address borrower) external view returns (bytes32[] memory) {
        return _borrowerLines[borrower];
    }

    function lenderLines(address lender) external view returns (bytes32[] memory) {
        return _lenderLines[lender];
    }

    function _owed(Line storage line) private view returns (uint256) {
        return line.drawn * (10_000 + line.terms.interestBps) / 10_000;
    }

    function _outstanding(Line storage line) private view returns (uint256) {
        uint256 total = _owed(line);
        return total > line.repaid ? total - line.repaid : 0;
    }

    // -----------------------------------------------------------------------
    // ECDSA, with the malleability check a bare `ecrecover` lacks
    // -----------------------------------------------------------------------

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        // Reject the upper half of the curve order: each signature has exactly one
        // canonical form, so a replayed-but-tweaked signature cannot pass as new.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
