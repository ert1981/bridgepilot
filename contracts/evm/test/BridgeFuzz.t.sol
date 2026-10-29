// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BridgeMessage} from "../src/BridgeTypes.sol";
import {BridgeBase} from "./BridgeBase.t.sol";

contract BridgeFuzzTest is BridgeBase {
    /// Fee + net always equals the input; mint equals net; full round trip returns net.
    function testFuzz_roundTripConservesValue(uint256 amount, uint16 feeBps) public {
        amount = bound(amount, 1e6, 500_000e6);
        feeBps = uint16(bound(feeBps, 0, 100));
        vm.chainId(HOME);
        vm.prank(admin);
        vault.setFee(feeBps, feeRecipient);

        uint256 aliceBefore = usdc.balanceOf(alice);
        BridgeMessage memory m = _lock(alice, amount, bob);
        uint256 fee = vault.accruedFees(address(usdc));
        assertEq(m.amount + fee, amount);
        assertLe(fee, amount / 100);

        _mint(m);
        assertEq(wUsdc.balanceOf(bob), m.amount);
        _release(_burn(bob, m.amount, alice));
        assertEq(usdc.balanceOf(alice), aliceBefore - fee);
        assertEq(wUsdc.totalSupply(), 0);
        assertEq(vault.totalLocked(address(usdc)), 0);
        assertEq(usdc.balanceOf(address(vault)), fee);
    }

    /// Changing ANY signed field after signing must make execution fail.
    function testFuzz_anyFieldTamperIsRejected(uint8 field, uint256 delta) public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        bytes[] memory sigs = _signRemote(m);
        delta = bound(delta, 1, type(uint64).max);
        field = uint8(bound(field, 0, 10));
        if (field == 0) m.version += 1;
        else if (field == 1) m.kind = 1;
        else if (field == 2) m.sourceChainId += delta;
        else if (field == 3) m.sourceContract = address(uint160(m.sourceContract) ^ uint160(delta));
        else if (field == 4) m.destChainId += delta;
        else if (field == 5) m.destContract = address(uint160(m.destContract) ^ uint160(delta));
        else if (field == 6) m.nonce += delta;
        else if (field == 7) m.canonicalToken = address(uint160(m.canonicalToken) ^ uint160(delta));
        else if (field == 8) m.sender = address(uint160(m.sender) ^ uint160(delta));
        else if (field == 9) m.recipient = address(uint160(m.recipient) ^ uint160(delta));
        else m.amount += delta;
        vm.chainId(REMOTE);
        vm.expectRevert();
        executor.execute(m, sigs);
    }

    /// Random bytes are never accepted as signatures.
    function testFuzz_randomSignaturesRejected(bytes memory s1, bytes memory s2) public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = s1;
        sigs[1] = s2;
        vm.chainId(REMOTE);
        vm.expectRevert();
        executor.execute(m, sigs);
    }

    /// The rate limiter never lets more than capacity + refill through.
    function testFuzz_rateLimitBound(uint256 cap, uint256 a, uint256 b, uint256 dt) public {
        cap = bound(cap, 10e6, 400_000e6);
        a = bound(a, 1e6, 400_000e6);
        b = bound(b, 1e6, 400_000e6);
        dt = bound(dt, 0, 2 days);
        vm.chainId(REMOTE);
        vm.prank(admin);
        executor.setRateLimit(address(usdc), uint128(cap), 1 days);
        BridgeMessage memory m1 = _lock(alice, a, bob);
        BridgeMessage memory m2 = _lock(alice, b, bob);
        uint256 minted;
        bytes[] memory s1 = _signRemote(m1);
        bytes[] memory s2 = _signRemote(m2);
        vm.chainId(REMOTE);
        try executor.execute(m1, s1) { minted += m1.amount; } catch {}
        vm.warp(block.timestamp + dt);
        try executor.execute(m2, s2) { minted += m2.amount; } catch {}
        uint256 refill = (cap * dt) / 1 days;
        assertLe(minted, cap + refill);
    }
}
