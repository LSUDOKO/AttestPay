// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PaymentAnchor} from "../src/PaymentAnchor.sol";
import {AttestPayASC} from "../src/AttestPayASC.sol";

/// @notice Deploys `PaymentAnchor` to the source chain (Ethereum Sepolia).
/// @dev Run FIRST — the ASC needs this address.
///
///   forge script script/Deploy.s.sol:DeployAnchor \
///     --rpc-url "$ATTESTPAY_SEPOLIA_RPC" --broadcast
///
/// Reads PRIVATE_KEY from the environment.
contract DeployAnchor is Script {
    function run() external returns (PaymentAnchor anchor) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        anchor = new PaymentAnchor();
        vm.stopBroadcast();

        console.log("PaymentAnchor deployed to:", address(anchor));
        console.log("chain id:", block.chainid);
        console.log("");
        console.log("Set in .env:");
        console.log("  ATTESTPAY_PAYMENT_ANCHOR_ADDRESS=%s", address(anchor));
    }
}

/// @notice Deploys `AttestPayASC` to Creditcoin CC3 testnet.
/// @dev Run SECOND, after DeployAnchor.
///
///   forge script script/Deploy.s.sol:DeployASC \
///     --rpc-url "$ATTESTPAY_CREDITCOIN_HTTP_RPC" --broadcast
///
/// Environment:
///   PRIVATE_KEY                        deployer key (needs tCTC for gas)
///   ATTESTPAY_PAYMENT_ANCHOR_ADDRESS   the anchor from DeployAnchor
///   ATTESTPAY_ANCHORER_ADDRESS         the address your server anchors from; the ASC
///                                      credits only this anchorer's claims. Defaults
///                                      to the deployer, which is right when the same
///                                      key both deploys and anchors.
///   ATTESTPAY_ATTESTCOIN_CHAIN_KEY     source chain key (default 1 = Ethereum Sepolia)
contract DeployASC is Script {
    function run() external returns (AttestPayASC asc) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        address anchor = vm.envAddress("ATTESTPAY_PAYMENT_ANCHOR_ADDRESS");
        address anchorer = vm.envOr("ATTESTPAY_ANCHORER_ADDRESS", deployer);
        uint64 chainKey = uint64(vm.envOr("ATTESTPAY_ATTESTCOIN_CHAIN_KEY", uint256(1)));

        // address(0) binds the canonical Block Prover precompile (0x…0FD2).
        vm.startBroadcast(pk);
        asc = new AttestPayASC(chainKey, anchor, anchorer, address(0));
        vm.stopBroadcast();

        console.log("AttestPayASC deployed to:", address(asc));
        console.log("  sourceChainKey: %s", chainKey);
        console.log("  paymentAnchor:  %s", anchor);
        console.log("  trustedAnchorer:%s", anchorer);
        console.log("  blockProver:    %s", address(asc.blockProver()));
        console.log("");
        console.log("Set in .env:");
        console.log("  ATTESTPAY_ASC_ADDRESS=%s", address(asc));
    }
}
