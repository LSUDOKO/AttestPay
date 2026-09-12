// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PaymentAnchor} from "../src/PaymentAnchor.sol";
import {AttestPayASC} from "../src/AttestPayASC.sol";
import {FactAnchor} from "../src/FactAnchor.sol";
import {AttestPayCreditLine} from "../src/AttestPayCreditLine.sol";
import {AttestPayLedger} from "../src/AttestPayLedger.sol";
import {AttestPayGuarantee} from "../src/AttestPayGuarantee.sol";
import {CreditPassport} from "../src/CreditPassport.sol";

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

// ---------------------------------------------------------------------------
// Credit, disputes, revocations, guarantees, passport
// ---------------------------------------------------------------------------

/// @notice Deploys `FactAnchor` to the source chain (Ethereum Sepolia).
///
///   forge script script/Deploy.s.sol:DeployFactAnchor \
///     --rpc-url "$ATTESTPAY_SEPOLIA_RPC" --broadcast
contract DeployFactAnchor is Script {
    function run() external returns (FactAnchor anchor) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        anchor = new FactAnchor();
        vm.stopBroadcast();
        console.log("FactAnchor deployed to:", address(anchor));
        console.log("Set in .env:");
        console.log("  ATTESTPAY_FACT_ANCHOR_ADDRESS=%s", address(anchor));
    }
}

/// @notice Deploys the Creditcoin side: `AttestPayCreditLine`, `AttestPayLedger`,
/// `AttestPayGuarantee`, `CreditPassport`.
/// @dev `forge script` cannot simulate against the CC3 RPC (no prevrandao in block
/// headers); see docs/attestcoin-integration.md for the `cast send --create`
/// sequence that performs the same four deployments. This script is the reference
/// for the constructor wiring and works on any chain forge can simulate.
///
/// Environment:
///   PRIVATE_KEY                        deployer key
///   ATTESTPAY_FACT_ANCHOR_ADDRESS      FactAnchor on the source chain
///   ATTESTPAY_ASC_ADDRESS              the deployed AttestPayASC (for the passport)
///   ATTESTPAY_ANCHORER_ADDRESS         defaults to the deployer
///   ATTESTPAY_ATTESTCOIN_CHAIN_KEY     default 1 (Ethereum Sepolia)
contract DeployCredit is Script {
    function run()
        external
        returns (
            AttestPayCreditLine line,
            AttestPayLedger ledger,
            AttestPayGuarantee guarantee,
            CreditPassport passport
        )
    {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address factAnchor = vm.envAddress("ATTESTPAY_FACT_ANCHOR_ADDRESS");
        address asc = vm.envAddress("ATTESTPAY_ASC_ADDRESS");
        address anchorer = vm.envOr("ATTESTPAY_ANCHORER_ADDRESS", deployer);
        uint64 chainKey = uint64(vm.envOr("ATTESTPAY_ATTESTCOIN_CHAIN_KEY", uint256(1)));

        vm.startBroadcast(pk);
        line = new AttestPayCreditLine(chainKey, factAnchor, anchorer, address(0));
        ledger = new AttestPayLedger(chainKey, factAnchor, anchorer, address(0));
        guarantee = new AttestPayGuarantee(address(line));
        passport = new CreditPassport(asc, address(line), address(ledger), address(guarantee));
        vm.stopBroadcast();

        console.log("Set in .env:");
        console.log("  ATTESTPAY_CREDIT_LINE_ADDRESS=%s", address(line));
        console.log("  ATTESTPAY_LEDGER_ADDRESS=%s", address(ledger));
        console.log("  ATTESTPAY_GUARANTEE_ADDRESS=%s", address(guarantee));
        console.log("  ATTESTPAY_PASSPORT_ADDRESS=%s", address(passport));
    }
}
