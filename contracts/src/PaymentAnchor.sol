// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PaymentAnchor — the AttestPay source-chain anchor
/// @notice Records that an AttestPay card paid someone, as an event on a chain the
/// Attestcoin attestor network actually watches. `AttestPayASC` on Creditcoin then
/// proves these events cross-chain and turns them into verifiable credit history.
///
/// WHY THIS CONTRACT EXISTS AND WHERE IT LIVES
///
/// AttestPay's USDC payments execute on Base, via ERC-7710 delegations through the
/// 1Shot relayer. The Attestcoin protocol on Creditcoin CC3 testnet attests exactly
/// two source chains — Ethereum mainnet (chainKey 3) and Ethereum Sepolia (chainKey 1)
/// — which you can confirm yourself with `get_supported_chains()` on the ChainInfo
/// precompile. Base is not among them. So a Base transaction cannot be proven into
/// Creditcoin directly, and this contract is deployed on ETHEREUM SEPOLIA instead: it
/// anchors the facts of a Base payment onto an attested chain, and that anchoring
/// transaction is what gets proven.
///
/// WHAT THE RESULTING PROOF DOES AND DOES NOT ESTABLISH
///
/// Be precise about this, because the distinction is the whole trust model:
///
///   PROVEN cryptographically, no oracle trusted: that this `PaymentAnchored` event,
///   with exactly these field values, was included in an attested Sepolia block.
///   `AttestPayASC` decodes the fields from the proven transaction bytes, so nobody
///   — including whoever submits the proof — can alter them in flight.
///
///   NOT proven: that the Base payment described by the anchor actually happened.
///   The AttestPay server writes the anchor, so the Base -> Sepolia hop is the
///   server's attestation, not Attestcoin's. `sourceTxHash` is recorded so any
///   verifier can independently check the Base transaction and hold the anchor
///   to account; `anchoredBy` records who made the claim.
///
/// Anchoring is permissionless on purpose — any address may anchor, and the anchorer
/// is recorded in the event. Consumers decide which anchorers they trust rather than
/// this contract maintaining a privileged writer set. `AttestPayASC` takes the
/// stricter line and only credits anchors from an anchorer it was configured with.
contract PaymentAnchor {
    /// @notice A card payment, anchored for cross-chain proving.
    /// @param cardId AttestPay card id, as `keccak256(bytes(card.id))`.
    /// @param payer Account the USDC actually left on the source chain (the card
    /// tree's root delegator — the card's funding account).
    /// @param merchant Recipient of the payment.
    /// @param amount Amount in USDC atoms (6 decimals).
    /// @param sourceChainId EVM chain id where the USDC moved (8453 Base, 84532 Base Sepolia).
    /// @param sourceTxHash Transaction hash of the payment on `sourceChainId`.
    /// @param paidAt Unix seconds at which the payment confirmed on the source chain.
    /// @param anchoredBy Whoever submitted this anchor (`msg.sender`).
    /// @param memo Free-text note carried from the card's charge record.
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

    /// @notice Number of anchors written, per card. Convenience for source-chain
    /// readers; the authoritative cross-chain tally lives in `AttestPayASC`.
    mapping(bytes32 => uint256) public anchorCount;

    /// @notice Guards against the same source payment being anchored twice, which
    /// would otherwise let one Base payment inflate a credit score by repetition.
    /// Keyed by `keccak256(sourceChainId, sourceTxHash)` so the same hash on two
    /// different chains stays distinct.
    mapping(bytes32 => bool) public anchored;

    error AlreadyAnchored(uint256 sourceChainId, bytes32 sourceTxHash);
    error ZeroAmount();
    error ZeroSourceTxHash();

    /// @notice Anchors one source-chain payment.
    /// @dev Rejects zero amounts and zero tx hashes: both are signs of a caller
    /// writing a placeholder, and an anchor nobody can check back against its source
    /// transaction is worse than no anchor.
    function anchorPayment(
        bytes32 cardId,
        address payer,
        address merchant,
        uint256 amount,
        uint256 sourceChainId,
        bytes32 sourceTxHash,
        uint256 paidAt,
        string calldata memo
    ) external {
        if (amount == 0) revert ZeroAmount();
        if (sourceTxHash == bytes32(0)) revert ZeroSourceTxHash();

        bytes32 key = sourceKey(sourceChainId, sourceTxHash);
        if (anchored[key]) revert AlreadyAnchored(sourceChainId, sourceTxHash);
        anchored[key] = true;
        anchorCount[cardId] += 1;

        emit PaymentAnchored(
            cardId, payer, merchant, amount, sourceChainId, sourceTxHash, paidAt, msg.sender, memo
        );
    }

    /// @notice The replay key for a source payment.
    function sourceKey(uint256 sourceChainId, bytes32 sourceTxHash) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChainId, sourceTxHash));
    }

    /// @notice Whether a given source payment has already been anchored here.
    function isAnchored(uint256 sourceChainId, bytes32 sourceTxHash) external view returns (bool) {
        return anchored[sourceKey(sourceChainId, sourceTxHash)];
    }
}
