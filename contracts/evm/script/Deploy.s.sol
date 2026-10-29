// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {BridgeExecutor} from "../src/BridgeExecutor.sol";
import {BridgeVault} from "../src/BridgeVault.sol";
import {MessageVerifier} from "../src/MessageVerifier.sol";
import {IMessageVerifier} from "../src/IMessageVerifier.sol";
import {VerifierRouter} from "../src/VerifierRouter.sol";

/// @notice Testnet deployment. Contracts refuse any chain outside the testnet allowlist.
///
/// Governance: DEFAULT_ADMIN_ROLE of every contract is a TimelockController whose ONLY proposer
/// and executor is MULTISIG (e.g. a Safe). Nobody, including the deployer, keeps admin rights.
/// The pauser is a separate key/bot that can stop the bridge but never restart or reconfigure it.
///
/// Usage (home chain):
///   ROLE=home MULTISIG=0x.. PAUSER=0x.. FEE_RECIPIENT=0x.. FEE_BPS=10 THRESHOLD=2 \
///   SIGNERS=0xA,0xB,0xC TIMELOCK_DELAY=172800 ROTATION_DELAY=172800 \
///   forge script script/Deploy.s.sol --rpc-url $HOME_RPC --broadcast
/// Usage (remote chain): ROLE=remote HOME_CHAIN_ID=11155111 ... (same governance/signer vars)
///
/// USE_VERIFIER_ROUTER (default true): the bridge contract verifies through a VerifierRouter
/// (admin = timelock, guardian = pauser, VERIFIER_UPGRADE_DELAY >= 7 days), so the signer set can
/// later be upgraded ONE-WAY to proof-based verification without migrating funds. The router's
/// routes (`initRoute(sourceChainId, MessageVerifier)`) are wired through the timelock like the rest.
///
/// Wiring (setPeer, setHomeVault, configureToken, setRateLimit, registerToken) is then scheduled
/// through the timelock by the multisig. Before accepting transfers, run
///   npx tsx protocol/verify-deployment.ts <config.json>
/// which refuses to mark the deployment ready unless every check passes.
contract Deploy is Script {
    function run() external {
        address multisig = vm.envAddress("MULTISIG");
        address pauser = vm.envAddress("PAUSER");
        require(multisig.code.length > 0, "MULTISIG must be a contract (e.g. Safe), not an EOA");
        require(pauser != multisig, "pauser must be separate from governance");
        address[] memory signers = vm.envAddress("SIGNERS", ",");
        uint8 threshold = uint8(vm.envUint("THRESHOLD"));
        uint256 tlDelay = vm.envOr("TIMELOCK_DELAY", uint256(2 days));
        uint64 rotation = uint64(vm.envOr("ROTATION_DELAY", uint256(2 days)));
        string memory role = vm.envString("ROLE");

        vm.startBroadcast();
        address[] memory gov = new address[](1);
        gov[0] = multisig;
        TimelockController timelock = new TimelockController(tlDelay, gov, gov, address(0));
        console2.log("TimelockController", address(timelock));

        MessageVerifier verifier = new MessageVerifier(address(timelock), signers, threshold, rotation);
        console2.log("MessageVerifier", address(verifier));
        IMessageVerifier bridgeVerifier = verifier;
        if (vm.envOr("USE_VERIFIER_ROUTER", true)) {
            VerifierRouter router = new VerifierRouter(address(timelock), pauser, uint64(vm.envOr("VERIFIER_UPGRADE_DELAY", uint256(7 days))));
            console2.log("VerifierRouter", address(router));
            bridgeVerifier = router;
        }
        if (keccak256(bytes(role)) == keccak256("home")) {
            BridgeVault vault = new BridgeVault(
                address(timelock), pauser, bridgeVerifier, uint16(vm.envUint("FEE_BPS")), vm.envAddress("FEE_RECIPIENT")
            );
            console2.log("BridgeVault", address(vault));
        } else {
            BridgeExecutor exec = new BridgeExecutor(address(timelock), pauser, bridgeVerifier, vm.envUint("HOME_CHAIN_ID"));
            console2.log("BridgeExecutor", address(exec));
        }
        vm.stopBroadcast();
    }
}
