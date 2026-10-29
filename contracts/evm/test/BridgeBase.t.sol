// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {BridgeMessage, BridgeTypes} from "../src/BridgeTypes.sol";
import {BridgeExecutor} from "../src/BridgeExecutor.sol";
import {BridgeToken} from "../src/BridgeToken.sol";
import {BridgeVault} from "../src/BridgeVault.sol";
import {MessageVerifier} from "../src/MessageVerifier.sol";
import {MockToken} from "./mocks/Tokens.sol";

/// @dev Simulates two chains in one EVM by switching block.chainid. Every contract checks
///      block.chainid at call time, so this exercises the real domain/destination checks.
abstract contract BridgeBase is Test {
    uint256 internal constant HOME = 11155111; // Sepolia
    uint256 internal constant REMOTE = 84532; // Base Sepolia
    uint64 internal constant ROTATION_DELAY = 2 days;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256[] internal attesterKeys; // sorted by address
    address[] internal attesters;

    MessageVerifier internal homeVerifier;
    MessageVerifier internal remoteVerifier;
    BridgeVault internal vault;
    BridgeExecutor internal executor;
    MockToken internal usdc;
    BridgeToken internal wUsdc;

    uint256 internal constant RATE_CAP = 1_000_000e6;
    uint256 internal constant REFUND_CAP = 250_000e6;
    uint256 internal constant CHAIN_CAP = 100_000_000e6;

    function setUp() public virtual {
        // 2-of-3 attesters, sorted ascending by address.
        uint256[3] memory pks = [uint256(0xA11CE), uint256(0xB0B), uint256(0xC4A1)];
        for (uint256 i = 0; i < 3; i++) {
            attesterKeys.push(pks[i]);
            attesters.push(vm.addr(pks[i]));
        }
        _sortAttesters();

        vm.chainId(HOME);
        homeVerifier = new MessageVerifier(admin, attesters, 2, ROTATION_DELAY);
        vault = new BridgeVault(admin, pauser, homeVerifier, 10, feeRecipient); // 0.10% fee
        usdc = new MockToken("USD Coin", "USDC", 6);

        vm.chainId(REMOTE);
        remoteVerifier = new MessageVerifier(admin, attesters, 2, ROTATION_DELAY);
        executor = new BridgeExecutor(admin, pauser, remoteVerifier, HOME);
        vm.startPrank(admin);
        wUsdc = BridgeToken(executor.registerToken(address(usdc), "Bridged USDC", "bpUSDC", 6, 1));
        executor.setHomeVault(address(vault));
        executor.setRateLimit(address(usdc), uint128(RATE_CAP), 1 days);
        executor.setRefundLimit(address(usdc), uint128(REFUND_CAP), 1 days);
        executor.setSupplyCap(address(usdc), CHAIN_CAP);
        vm.stopPrank();

        vm.chainId(HOME);
        vm.startPrank(admin);
        vault.configureToken(address(usdc), true, 1e6, 500_000e6);
        vault.setPeer(REMOTE, address(executor));
        vault.setRateLimit(address(usdc), uint128(RATE_CAP), 1 days);
        vault.setRefundLimit(address(usdc), uint128(REFUND_CAP), 1 days);
        vault.setChainCap(address(usdc), REMOTE, CHAIN_CAP);
        vm.stopPrank();

        usdc.mint(alice, 10_000_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _sortAttesters() internal {
        for (uint256 i = 0; i < attesters.length; i++) {
            for (uint256 j = i + 1; j < attesters.length; j++) {
                if (attesters[j] < attesters[i]) {
                    (attesters[i], attesters[j]) = (attesters[j], attesters[i]);
                    (attesterKeys[i], attesterKeys[j]) = (attesterKeys[j], attesterKeys[i]);
                }
            }
        }
    }

    /// @dev Signs with the given attester indexes (must be ascending to produce sorted sigs).
    function _sign(MessageVerifier v, uint256 chainId, BridgeMessage memory m, uint256[] memory idx)
        internal
        returns (bytes[] memory sigs)
    {
        uint256 prev = block.chainid;
        vm.chainId(chainId);
        bytes32 d = v.digest(m);
        vm.chainId(prev);
        sigs = new bytes[](idx.length);
        for (uint256 i = 0; i < idx.length; i++) {
            (uint8 vv, bytes32 r, bytes32 s) = vm.sign(attesterKeys[idx[i]], d);
            sigs[i] = abi.encodePacked(r, s, vv);
        }
    }

    function _idx(uint256 a, uint256 b) internal pure returns (uint256[] memory x) {
        x = new uint256[](2);
        x[0] = a;
        x[1] = b;
    }

    function _signHome(BridgeMessage memory m) internal returns (bytes[] memory) {
        return _sign(homeVerifier, HOME, m, _idx(0, 1));
    }

    function _signRemote(BridgeMessage memory m) internal returns (bytes[] memory) {
        return _sign(remoteVerifier, REMOTE, m, _idx(0, 1));
    }

    /// @dev Reads the last TransferInitiated(bytes32,BridgeMessage,uint256) event.
    function _lastMessage(Vm.Log[] memory logs) internal pure returns (BridgeMessage memory m) {
        bytes32 topic = keccak256(
            "TransferInitiated(bytes32,(uint8,uint8,uint256,address,uint256,address,uint256,address,address,address,uint256),uint256)"
        );
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics[0] == topic) {
                (m,) = abi.decode(logs[i - 1].data, (BridgeMessage, uint256));
                return m;
            }
        }
        revert("no TransferInitiated");
    }

    function _lock(address from, uint256 amount, address to) internal returns (BridgeMessage memory) {
        vm.chainId(HOME);
        vm.recordLogs();
        vm.prank(from);
        vault.lock(address(usdc), amount, REMOTE, to);
        return _lastMessage(vm.getRecordedLogs());
    }

    function _mint(BridgeMessage memory m) internal {
        bytes[] memory sigs = _signRemote(m);
        vm.chainId(REMOTE);
        executor.execute(m, sigs);
    }

    function _burn(address from, uint256 amount, address to) internal returns (BridgeMessage memory) {
        vm.chainId(REMOTE);
        vm.recordLogs();
        vm.prank(from);
        executor.burn(address(usdc), amount, to);
        return _lastMessage(vm.getRecordedLogs());
    }

    function _release(BridgeMessage memory m) internal {
        bytes[] memory sigs = _signHome(m);
        vm.chainId(HOME);
        vault.release(m, sigs);
    }
}
