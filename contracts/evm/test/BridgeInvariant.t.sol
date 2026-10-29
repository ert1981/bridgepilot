// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BridgeMessage, BridgeTypes} from "../src/BridgeTypes.sol";
import {BridgeBase} from "./BridgeBase.t.sol";
import {BridgeVault} from "../src/BridgeVault.sol";
import {BridgeToken} from "../src/BridgeToken.sol";
import {BridgeExecutor} from "../src/BridgeExecutor.sol";
import {MockToken} from "./mocks/Tokens.sol";

/// @dev Random actor that locks, relays, burns, releases, replays and forges.
contract Handler is BridgeBase {
    BridgeMessage[] public pendingMints;
    BridgeMessage[] public pendingReleases;
    BridgeMessage[] public executed;

    uint256 public pendingMintSum;
    uint256 public pendingReleaseSum;
    BridgeMessage[] public cancelledLocks; // cancelled on REMOTE, awaiting vault refund
    BridgeMessage[] public cancelledBurns; // cancelled on HOME, awaiting re-mint
    BridgeMessage[] public refunded;
    uint256 public cancelledLockSum;
    uint256 public cancelledBurnSum;
    uint256 public doublePays;
    uint256 public replaysSucceeded;
    uint256 public forgeriesSucceeded;
    uint256 public calls;

    address[] internal users;

    constructor() {
        setUp();
        users.push(alice);
        users.push(bob);
        users.push(makeAddr("carol"));
        for (uint256 i = 1; i < users.length; i++) {
            usdc.mint(users[i], 10_000_000e6);
            vm.prank(users[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function lock(uint256 who, uint256 amount, uint256 to) external {
        calls++;
        amount = bound(amount, 1e6, 200_000e6);
        BridgeMessage memory m = _lock(users[who % users.length], amount, users[to % users.length]);
        pendingMints.push(m);
        pendingMintSum += m.amount;
    }

    function relayMint(uint256 i) external {
        calls++;
        if (pendingMints.length == 0) return;
        i = i % pendingMints.length;
        BridgeMessage memory m = pendingMints[i];
        bytes[] memory sigs = _signRemote(m);
        vm.chainId(REMOTE);
        try executor.execute(m, sigs) {
            pendingMintSum -= m.amount;
            executed.push(m);
            pendingMints[i] = pendingMints[pendingMints.length - 1];
            pendingMints.pop();
        } catch {
            vm.warp(block.timestamp + 1 days); // rate limited: let it refill
        }
    }

    function burn(uint256 who, uint256 amount, uint256 to) external {
        calls++;
        address from = users[who % users.length];
        vm.chainId(REMOTE);
        uint256 bal = wUsdc.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        BridgeMessage memory m = _burn(from, amount, users[to % users.length]);
        pendingReleases.push(m);
        pendingReleaseSum += m.amount;
    }

    function relayRelease(uint256 i) external {
        calls++;
        if (pendingReleases.length == 0) return;
        i = i % pendingReleases.length;
        BridgeMessage memory m = pendingReleases[i];
        bytes[] memory sigs = _signHome(m);
        vm.chainId(HOME);
        try vault.release(m, sigs) {
            pendingReleaseSum -= m.amount;
            executed.push(m);
            pendingReleases[i] = pendingReleases[pendingReleases.length - 1];
            pendingReleases.pop();
        } catch {
            vm.warp(block.timestamp + 1 days);
        }
    }

    function replay(uint256 i) external {
        calls++;
        if (executed.length == 0) return;
        BridgeMessage memory m = executed[i % executed.length];
        if (m.kind == BridgeTypes.KIND_LOCK_MINT) {
            bytes[] memory sigs = _signRemote(m);
            vm.chainId(REMOTE);
            try executor.execute(m, sigs) { replaysSucceeded++; } catch {}
        } else {
            bytes[] memory sigs = _signHome(m);
            vm.chainId(HOME);
            try vault.release(m, sigs) { replaysSucceeded++; } catch {}
        }
    }

    /// Forge a mint with one valid attester + one outsider key.
    function forge(uint256 amount, uint256 outsiderKey) external {
        calls++;
        outsiderKey = bound(outsiderKey, 1, 1e30);
        amount = bound(amount, 1, 1_000_000e6);
        BridgeMessage memory m = BridgeMessage({
            version: 1, kind: 0, sourceChainId: HOME, sourceContract: address(vault), destChainId: REMOTE,
            destContract: address(executor), nonce: 1e9 + calls, canonicalToken: address(usdc), sender: alice, recipient: alice, amount: amount
        });
        vm.chainId(REMOTE);
        bytes32 d = remoteVerifier.digest(m);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(attesterKeys[0], d);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(outsiderKey, d);
        bytes[] memory sigs = new bytes[](2);
        bool order = vm.addr(outsiderKey) > attesters[0];
        sigs[0] = order ? abi.encodePacked(r1, s1, v1) : abi.encodePacked(r2, s2, v2);
        sigs[1] = order ? abi.encodePacked(r2, s2, v2) : abi.encodePacked(r1, s1, v1);
        if (vm.addr(outsiderKey) == attesters[1] || vm.addr(outsiderKey) == attesters[2]) return;
        try executor.execute(m, sigs) { forgeriesSucceeded++; } catch {}
    }

    function vaultC() external view returns (BridgeVault) { return vault; }
    function usdcC() external view returns (MockToken) { return usdc; }
    function wrappedC() external view returns (BridgeToken) { return wUsdc; }
    function executorC() external view returns (BridgeExecutor) { return executor; }

    function executedCount() external view returns (uint256) { return executed.length; }
    function refundedCount() external view returns (uint256) { return refunded.length; }

    /// Recipient gives up a pending lock; it must then be refundable exactly once.
    function cancelMint(uint256 i) external {
        calls++;
        if (pendingMints.length == 0) return;
        i = i % pendingMints.length;
        BridgeMessage memory m = pendingMints[i];
        bytes[] memory sigs = _signRemote(m);
        vm.chainId(REMOTE);
        vm.prank(m.recipient);
        executor.cancel(m, sigs);
        pendingMintSum -= m.amount;
        cancelledLockSum += m.amount;
        cancelledLocks.push(m);
        pendingMints[i] = pendingMints[pendingMints.length - 1];
        pendingMints.pop();
    }

    function refundLock(uint256 i) external {
        calls++;
        if (cancelledLocks.length == 0) return;
        i = i % cancelledLocks.length;
        BridgeMessage memory m = cancelledLocks[i];
        bytes[] memory rs = _sign(homeVerifier, HOME, BridgeTypes.refundOf(m), _idx(0, 1));
        vm.chainId(HOME);
        try vault.refund(m, rs) {
            cancelledLockSum -= m.amount;
            refunded.push(m);
            cancelledLocks[i] = cancelledLocks[cancelledLocks.length - 1];
            cancelledLocks.pop();
        } catch {
            vm.warp(block.timestamp + 1 days);
        }
    }

    function cancelRelease(uint256 i) external {
        calls++;
        if (pendingReleases.length == 0) return;
        i = i % pendingReleases.length;
        BridgeMessage memory m = pendingReleases[i];
        bytes[] memory sigs = _signHome(m);
        vm.chainId(HOME);
        vm.prank(m.recipient);
        vault.cancel(m, sigs);
        pendingReleaseSum -= m.amount;
        cancelledBurnSum += m.amount;
        cancelledBurns.push(m);
        pendingReleases[i] = pendingReleases[pendingReleases.length - 1];
        pendingReleases.pop();
    }

    function refundBurn(uint256 i) external {
        calls++;
        if (cancelledBurns.length == 0) return;
        i = i % cancelledBurns.length;
        BridgeMessage memory m = cancelledBurns[i];
        bytes[] memory rs = _sign(remoteVerifier, REMOTE, BridgeTypes.refundOf(m), _idx(0, 1));
        vm.chainId(REMOTE);
        try executor.refund(m, rs) {
            cancelledBurnSum -= m.amount;
            refunded.push(m);
            cancelledBurns[i] = cancelledBurns[cancelledBurns.length - 1];
            cancelledBurns.pop();
        } catch {
            vm.warp(block.timestamp + 1 days);
        }
    }

    /// Try every way of getting paid twice for something already refunded.
    function attemptDoublePay(uint256 i) external {
        calls++;
        if (refunded.length == 0) return;
        BridgeMessage memory m = refunded[i % refunded.length];
        if (m.kind == BridgeTypes.KIND_LOCK_MINT) {
            bytes[] memory s = _signRemote(m);
            vm.chainId(REMOTE);
            try executor.execute(m, s) { doublePays++; } catch {}
            bytes[] memory rs = _sign(homeVerifier, HOME, BridgeTypes.refundOf(m), _idx(0, 1));
            vm.chainId(HOME);
            try vault.refund(m, rs) { doublePays++; } catch {}
        } else {
            bytes[] memory s = _signHome(m);
            vm.chainId(HOME);
            try vault.release(m, s) { doublePays++; } catch {}
            bytes[] memory rs = _sign(remoteVerifier, REMOTE, BridgeTypes.refundOf(m), _idx(0, 1));
            vm.chainId(REMOTE);
            try executor.refund(m, rs) { doublePays++; } catch {}
        }
    }

    function pendingMintCount() external view returns (uint256) {
        return pendingMints.length;
    }
}

contract BridgeInvariantTest is Test {
    Handler internal h;

    function setUp() public {
        h = new Handler();
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](12);
        sel[0] = Handler.lock.selector;
        sel[1] = Handler.relayMint.selector;
        sel[2] = Handler.burn.selector;
        sel[3] = Handler.relayRelease.selector;
        sel[4] = Handler.replay.selector;
        sel[5] = Handler.forge.selector;
        sel[6] = Handler.lock.selector;
        sel[7] = Handler.cancelMint.selector;
        sel[8] = Handler.refundLock.selector;
        sel[9] = Handler.cancelRelease.selector;
        sel[10] = Handler.refundBurn.selector;
        sel[11] = Handler.attemptDoublePay.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// Exact accounting: vault holds exactly locked backing + accrued fees.
    function invariant_vaultAccountingIsExact() public view {
        assertEq(h.usdcC().balanceOf(address(h.vaultC())), h.vaultC().totalLocked(address(h.usdcC())) + h.vaultC().accruedFees(address(h.usdcC())));
    }

    /// No unbacked supply: wrapped supply never exceeds locked backing.
    function invariant_wrappedSupplyIsBacked() public view {
        assertLe(h.wrappedC().totalSupply(), h.vaultC().totalLocked(address(h.usdcC())));
    }

    /// Conservation across chains, including in-flight messages.
    function invariant_conservationWithInFlight() public view {
        assertEq(
            h.vaultC().totalLocked(address(h.usdcC())),
            h.wrappedC().totalSupply() + h.pendingMintSum() + h.pendingReleaseSum() + h.cancelledLockSum() + h.cancelledBurnSum()
        );
    }

    function invariant_perChainBackingMatchesTotal() public view {
        assertEq(h.vaultC().lockedFor(address(h.usdcC()), 84532), h.vaultC().totalLocked(address(h.usdcC())));
    }

    function invariant_capsAreNeverExceeded() public view {
        assertLe(h.wrappedC().totalSupply(), h.executorC().supplyCap(address(h.usdcC())));
        assertLe(h.vaultC().lockedFor(address(h.usdcC()), 84532), h.vaultC().chainCap(address(h.usdcC()), 84532));
    }

    function invariant_noDoublePayEver() public view {
        assertEq(h.doublePays(), 0);
    }

    function invariant_noReplayEverSucceeds() public view {
        assertEq(h.replaysSucceeded(), 0);
    }

    /// Guard against a vacuous invariant run: the handler must really move value.
    function test_handlerExercisesEveryFlow() public {
        h.lock(0, 5_000e6, 1);
        h.relayMint(0);
        h.burn(1, 1_000e6, 0);
        h.relayRelease(0);
        h.replay(0);
        h.replay(1);
        h.forge(1e6, 12345);
        h.lock(1, 3_000e6, 2);
        h.cancelMint(0);
        h.refundLock(0);
        h.attemptDoublePay(0);
        assertEq(h.refundedCount(), 1);
        assertEq(h.doublePays(), 0);
        assertEq(h.executedCount(), 2);
        assertEq(h.replaysSucceeded(), 0);
        assertEq(h.forgeriesSucceeded(), 0);
        assertGt(h.wrappedC().totalSupply(), 0);
        invariant_conservationWithInFlight();
        invariant_vaultAccountingIsExact();
    }

    function invariant_noForgeryEverSucceeds() public view {
        assertEq(h.forgeriesSucceeded(), 0);
    }
}
