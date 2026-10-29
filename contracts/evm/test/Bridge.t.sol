// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {BridgeMessage, BridgeTypes, TestnetOnly} from "../src/BridgeTypes.sol";
import {BridgeExecutor} from "../src/BridgeExecutor.sol";
import {BridgeToken} from "../src/BridgeToken.sol";
import {BridgeVault} from "../src/BridgeVault.sol";
import {EmergencyController} from "../src/EmergencyController.sol";
import {FeeController} from "../src/FeeController.sol";
import {MessageVerifier} from "../src/MessageVerifier.sol";
import {RateLimiter} from "../src/RateLimiter.sol";
import {ReplayProtection} from "../src/ReplayProtection.sol";
import {BridgeBase} from "./BridgeBase.t.sol";
import {FeeOnTransferToken, MockToken} from "./mocks/Tokens.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract BridgeTest is BridgeBase {
    // ------------------------------------------------------------------ happy paths

    function test_lockThenMint() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        assertEq(m.amount, 999e6, "net after 0.10% fee");
        assertEq(m.kind, BridgeTypes.KIND_LOCK_MINT);
        assertEq(m.destContract, address(executor));
        assertEq(vault.totalLocked(address(usdc)), 999e6);
        assertEq(vault.accruedFees(address(usdc)), 1e6);
        assertEq(usdc.balanceOf(address(vault)), 1000e6);

        _mint(m);
        assertEq(wUsdc.balanceOf(bob), 999e6);
        assertEq(wUsdc.totalSupply(), vault.totalLocked(address(usdc)));
    }

    function test_burnThenRelease() public {
        _mint(_lock(alice, 1000e6, bob));
        BridgeMessage memory b = _burn(bob, 400e6, alice);
        assertEq(b.kind, BridgeTypes.KIND_BURN_RELEASE);
        assertEq(wUsdc.balanceOf(bob), 599e6);
        uint256 before = usdc.balanceOf(alice);
        _release(b);
        assertEq(usdc.balanceOf(alice) - before, 400e6);
        assertEq(vault.totalLocked(address(usdc)), 599e6);
        assertEq(wUsdc.totalSupply(), 599e6);
    }

    // ------------------------------------------------------------------ replay

    function test_replayMintReverts() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        _mint(m);
        bytes[] memory sigs = _signRemote(m);
        vm.expectRevert(abi.encodeWithSelector(ReplayProtection.MessageAlreadyProcessed.selector, BridgeTypes.messageId(m)));
        executor.execute(m, sigs);
    }

    function test_replayReleaseReverts() public {
        _mint(_lock(alice, 1000e6, bob));
        BridgeMessage memory b = _burn(bob, 100e6, alice);
        _release(b);
        bytes[] memory sigs = _signHome(b);
        vm.expectRevert(abi.encodeWithSelector(ReplayProtection.MessageAlreadyProcessed.selector, BridgeTypes.messageId(b)));
        vault.release(b, sigs);
    }

    // ------------------------------------------------------------------ signatures

    function test_belowThresholdReverts() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        uint256[] memory one = new uint256[](1);
        one[0] = 0;
        bytes[] memory sigs = _sign(remoteVerifier, REMOTE, m, one);
        vm.chainId(REMOTE);
        vm.expectRevert(abi.encodeWithSelector(MessageVerifier.NotEnoughSignatures.selector, 1, 2));
        executor.execute(m, sigs);
    }

    function test_duplicateSignerReverts() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        bytes[] memory sigs = _sign(remoteVerifier, REMOTE, m, _idx(0, 0));
        vm.chainId(REMOTE);
        vm.expectRevert(abi.encodeWithSelector(MessageVerifier.SignersNotSorted.selector, 1));
        executor.execute(m, sigs);
    }

    function test_unsortedSignaturesRevert() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        bytes[] memory sigs = _sign(remoteVerifier, REMOTE, m, _idx(1, 0));
        vm.chainId(REMOTE);
        vm.expectRevert(abi.encodeWithSelector(MessageVerifier.SignersNotSorted.selector, 1));
        executor.execute(m, sigs);
    }

    function test_unknownSignerReverts() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        vm.chainId(REMOTE);
        bytes32 d = remoteVerifier.digest(m);
        bytes[] memory sigs = new bytes[](2);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(attesterKeys[0], d);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(uint256(0xBAD), d);
        address bad = vm.addr(0xBAD);
        if (bad > attesters[0]) {
            sigs[0] = abi.encodePacked(r1, s1, v1);
            sigs[1] = abi.encodePacked(r2, s2, v2);
        } else {
            sigs[0] = abi.encodePacked(r2, s2, v2);
            sigs[1] = abi.encodePacked(r1, s1, v1);
        }
        vm.expectRevert(abi.encodeWithSelector(MessageVerifier.UnknownSigner.selector, bad));
        executor.execute(m, sigs);
    }

    function test_malformedSignatureReverts() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        bytes[] memory sigs = _signRemote(m);
        sigs[0] = hex"deadbeef";
        vm.chainId(REMOTE);
        vm.expectRevert(abi.encodeWithSelector(MessageVerifier.InvalidSignature.selector, 0));
        executor.execute(m, sigs);
    }

    function test_tamperedAmountReverts() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        bytes[] memory sigs = _signRemote(m);
        m.amount = 1_000_000e6;
        vm.chainId(REMOTE);
        vm.expectRevert(); // recovers to unknown signers
        executor.execute(m, sigs);
    }

    function test_signaturesAreDomainSeparatedPerChainAndVerifier() public {
        _mint(_lock(alice, 1000e6, bob));
        BridgeMessage memory b = _burn(bob, 100e6, alice);
        // Signed for the REMOTE verifier's domain, submitted to the HOME vault.
        bytes[] memory wrongDomain = _sign(remoteVerifier, REMOTE, b, _idx(0, 1));
        vm.chainId(HOME);
        vm.expectRevert();
        vault.release(b, wrongDomain);
    }

    function test_kindConfusionReverts() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        // Re-target the LOCK message at the vault's release() with a valid home signature.
        m.destChainId = HOME;
        m.destContract = address(vault);
        bytes[] memory sigs = _signHome(m);
        vm.chainId(HOME);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.InvalidMessage.selector, "kind"));
        vault.release(m, sigs);
    }

    function test_wrongDestinationAndSourceRevert() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        BridgeMessage memory wrongDest = m;
        bytes[] memory s1 = _signRemote(wrongDest);
        vm.chainId(HOME); // executed on the wrong chain
        vm.expectRevert(abi.encodeWithSelector(BridgeExecutor.InvalidMessage.selector, "destination"));
        executor.execute(wrongDest, s1);

        m.sourceContract = address(0xBEEF);
        bytes[] memory s2 = _signRemote(m);
        vm.chainId(REMOTE);
        vm.expectRevert(abi.encodeWithSelector(BridgeExecutor.InvalidMessage.selector, "source"));
        executor.execute(m, s2);
    }

    // ------------------------------------------------------------------ backing & custody

    function test_releaseCannotExceedBackingEvenIfAttestersSign() public {
        _mint(_lock(alice, 1000e6, bob));
        // A colluding/compromised signer set attests a bogus burn larger than what is locked.
        BridgeMessage memory forged = BridgeMessage({
            version: 1, kind: 1, sourceChainId: REMOTE, sourceContract: address(executor), destChainId: HOME,
            destContract: address(vault), nonce: 999, canonicalToken: address(usdc), sender: bob, recipient: bob, amount: 5000e6
        });
        bytes[] memory sigs = _signHome(forged);
        vm.chainId(HOME);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.InsufficientBacking.selector, 5000e6, 999e6));
        vault.release(forged, sigs);
    }

    function test_adminCannotWithdrawLockedFunds() public {
        _lock(alice, 1000e6, bob);
        uint256 locked = vault.totalLocked(address(usdc));
        vm.prank(admin);
        vault.withdrawFees(address(usdc));
        assertEq(usdc.balanceOf(feeRecipient), 1e6);
        assertEq(usdc.balanceOf(address(vault)), locked);
        vm.prank(admin);
        vault.withdrawFees(address(usdc)); // second call moves nothing
        assertEq(usdc.balanceOf(address(vault)), locked);
        vm.prank(alice);
        vm.expectRevert(BridgeVault.InvalidRecipient.selector);
        vault.withdrawFees(address(usdc));
    }

    function test_onlyExecutorCanMintWrapped() public {
        vm.expectRevert(BridgeToken.OnlyBridge.selector);
        wUsdc.mint(alice, 1);
        vm.expectRevert(BridgeToken.OnlyBridge.selector);
        wUsdc.burn(bob, 1);
    }

    // ------------------------------------------------------------------ token policy

    function test_rejectsFeeOnTransferToken() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        vm.prank(admin);
        vault.configureToken(address(fot), true, 1, type(uint128).max);
        fot.mint(alice, 1e18);
        vm.startPrank(alice);
        fot.approve(address(vault), 1e18);
        vm.expectRevert(BridgeVault.UnsupportedTransferToken.selector);
        vault.lock(address(fot), 1e18, REMOTE, bob);
        vm.stopPrank();
    }

    function test_rejectsUnsupportedTokenAndBounds() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.TokenNotSupported.selector, address(0x1234)));
        vault.lock(address(0x1234), 1e6, REMOTE, bob);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.AmountOutOfBounds.selector, 1));
        vault.lock(address(usdc), 1, REMOTE, bob);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.AmountOutOfBounds.selector, 600_000e6));
        vault.lock(address(usdc), 600_000e6, REMOTE, bob);
        vm.expectRevert(BridgeVault.InvalidRecipient.selector);
        vault.lock(address(usdc), 1e6, REMOTE, address(0));
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.UnknownPeer.selector, 999));
        vault.lock(address(usdc), 1e6, 999, bob);
        vm.stopPrank();
    }

    function test_feeHasHardCap() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FeeController.FeeTooHigh.selector, 101));
        vault.setFee(101, feeRecipient);
    }

    // ------------------------------------------------------------------ rate limits

    function test_rateLimitBlocksAndRefills() public {
        vm.startPrank(admin);
        vm.chainId(REMOTE);
        executor.setRateLimit(address(usdc), 1500e6, 1 days);
        vm.stopPrank();
        BridgeMessage memory a = _lock(alice, 1000e6, bob);
        BridgeMessage memory b = _lock(alice, 1000e6, bob);
        _mint(a);
        bytes[] memory sigs = _signRemote(b);
        vm.chainId(REMOTE);
        vm.expectRevert(abi.encodeWithSelector(RateLimiter.RateLimitExceeded.selector, address(usdc), 999e6, 501e6));
        executor.execute(b, sigs);
        vm.warp(block.timestamp + 12 hours);
        executor.execute(b, sigs); // refilled; message still valid
        assertEq(wUsdc.balanceOf(bob), 1998e6);
    }

    function test_unconfiguredRateLimitFailsClosed() public {
        vm.chainId(REMOTE);
        vm.prank(admin);
        address other = address(new FeeOnTransferToken());
        vm.prank(admin);
        executor.registerToken(other, "x", "x", 18, 1);
        BridgeMessage memory m = BridgeMessage({
            version: 1, kind: 0, sourceChainId: HOME, sourceContract: address(vault), destChainId: REMOTE,
            destContract: address(executor), nonce: 77, canonicalToken: other, sender: alice, recipient: bob, amount: 1
        });
        bytes[] memory sigs = _signRemote(m);
        vm.chainId(REMOTE);
        vm.expectRevert(abi.encodeWithSelector(RateLimiter.RateLimitNotConfigured.selector, other));
        executor.execute(m, sigs);
    }

    // ------------------------------------------------------------------ emergency

    function test_pauseStopsEverythingAndOnlyAdminUnpauses() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        vm.chainId(REMOTE);
        vm.prank(pauser);
        executor.pause();
        bytes[] memory sigs = _signRemote(m);
        vm.chainId(REMOTE);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        executor.execute(m, sigs);

        vm.prank(pauser);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, pauser, bytes32(0)));
        executor.unpause();

        vm.prank(admin);
        executor.unpause();
        executor.execute(m, sigs); // pending message still executes after recovery
        assertEq(wUsdc.balanceOf(bob), 999e6);

        vm.chainId(HOME);
        vm.prank(pauser);
        vault.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.lock(address(usdc), 1e6, REMOTE, bob);
    }

    function test_routePause() public {
        vm.chainId(HOME);
        vm.prank(pauser);
        vault.pauseRoute(REMOTE);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(EmergencyController.RoutePaused.selector, REMOTE));
        vault.lock(address(usdc), 1e6, REMOTE, bob);
        vm.prank(admin);
        vault.unpauseRoute(REMOTE);
        vm.prank(alice);
        vault.lock(address(usdc), 1e6, REMOTE, bob);
    }

    function test_strangerCannotPause() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.pause();
    }

    // ------------------------------------------------------------------ signer rotation

    function test_signerRotationIsDelayedAndInvalidatesOldSignatures() public {
        BridgeMessage memory m = _lock(alice, 1000e6, bob);
        bytes[] memory oldSigs = _signRemote(m);

        uint256[3] memory newPks = [uint256(0xD00D), uint256(0xE11E), uint256(0xF00F)];
        address[] memory ns = new address[](3);
        for (uint256 i = 0; i < 3; i++) ns[i] = vm.addr(newPks[i]);
        // sort
        for (uint256 i = 0; i < 3; i++) for (uint256 j = i + 1; j < 3; j++) if (ns[j] < ns[i]) { (ns[i], ns[j]) = (ns[j], ns[i]); (newPks[i], newPks[j]) = (newPks[j], newPks[i]); }

        vm.chainId(REMOTE);
        vm.prank(admin);
        remoteVerifier.proposeSignerSet(ns, 2);
        vm.expectRevert();
        remoteVerifier.executeSignerSet();
        vm.warp(block.timestamp + ROTATION_DELAY);
        remoteVerifier.executeSignerSet();
        assertEq(remoteVerifier.signerSetVersion(), 2);

        vm.expectRevert(); // old set no longer valid
        executor.execute(m, oldSigs);

        attesterKeys[0] = newPks[0];
        attesterKeys[1] = newPks[1];
        attesterKeys[2] = newPks[2];
        _mint(m);
        assertEq(wUsdc.balanceOf(bob), 999e6);
    }

    function test_signerSetRequiresStrictMajorityAndSortedUnique() public {
        address[] memory four = new address[](4);
        for (uint256 i = 0; i < 4; i++) four[i] = address(uint160(i + 1));
        vm.startPrank(admin);
        vm.expectRevert(MessageVerifier.InvalidSignerSet.selector);
        homeVerifier.proposeSignerSet(four, 2); // 2-of-4 is not a majority
        homeVerifier.proposeSignerSet(four, 3);
        address[] memory dup = new address[](2);
        dup[0] = address(1);
        dup[1] = address(1);
        vm.expectRevert(MessageVerifier.InvalidSignerSet.selector);
        homeVerifier.proposeSignerSet(dup, 2);
        vm.stopPrank();
        vm.prank(alice);
        vm.expectRevert();
        homeVerifier.proposeSignerSet(four, 3);
    }

    function test_backingIsIsolatedPerRemoteChain() public {
        // A second remote chain whose executor is compromised/colluding.
        uint256 REMOTE2 = 421614;
        address evilExecutor = makeAddr("remote2Executor");
        vm.chainId(HOME);
        vm.prank(admin);
        vault.setPeer(REMOTE2, evilExecutor);
        _lock(alice, 1000e6, bob); // 999e6 backing belongs to REMOTE only
        BridgeMessage memory drain = BridgeMessage({
            version: 1, kind: 1, sourceChainId: REMOTE2, sourceContract: evilExecutor, destChainId: HOME,
            destContract: address(vault), nonce: 1, canonicalToken: address(usdc), sender: bob, recipient: bob, amount: 500e6
        });
        bytes[] memory sigs = _signHome(drain);
        vm.chainId(HOME);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.InsufficientBacking.selector, 500e6, 0));
        vault.release(drain, sigs);
        assertEq(vault.lockedFor(address(usdc), REMOTE), 999e6);
    }

    function test_disablingTokenOrChangingPeerNeverFreezesPendingReleases() public {
        _mint(_lock(alice, 1000e6, bob));
        BridgeMessage memory b = _burn(bob, 300e6, alice);
        vm.chainId(HOME);
        vm.startPrank(admin);
        vault.configureToken(address(usdc), false, 1e6, 500_000e6);
        vault.setPeer(REMOTE, makeAddr("newExecutor"));
        vm.stopPrank();
        uint256 before = usdc.balanceOf(alice);
        _release(b); // still redeemable
        assertEq(usdc.balanceOf(alice) - before, 300e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.TokenNotSupported.selector, address(usdc)));
        vault.lock(address(usdc), 1e6, REMOTE, bob); // new locks are blocked
    }

    function test_burnRequiresHomeVault() public {
        vm.chainId(REMOTE);
        BridgeExecutor fresh = new BridgeExecutor(admin, pauser, remoteVerifier, HOME);
        vm.prank(admin);
        fresh.registerToken(address(usdc), "x", "x", 6, 1);
        vm.expectRevert(abi.encodeWithSelector(BridgeExecutor.InvalidMessage.selector, "vault"));
        fresh.burn(address(usdc), 1, bob);
    }

    function test_rotationDelayHasFloor() public {
        vm.expectRevert(MessageVerifier.InvalidSignerSet.selector);
        new MessageVerifier(admin, attesters, 2, 1 hours);
    }

    function test_mainnetDeploymentBlocked() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.NotAnAllowedTestnet.selector, 1));
        new MessageVerifier(admin, attesters, 2, 1 days);
        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(TestnetOnly.NotAnAllowedTestnet.selector, 8453));
        new BridgeVault(admin, pauser, homeVerifier, 10, feeRecipient);
    }

    /// Any chain id outside the explicit testnet allowlist is refused (covers future mainnets).
    function testFuzz_onlyAllowlistedTestnetsDeploy(uint64 id) public {
        vm.assume(id != 0);
        bool allowed = id == 11155111 || id == 17000 || id == 560048 || id == 84532 || id == 421614 || id == 11155420
            || id == 80002 || (id >= 31337 && id <= 31339);
        vm.chainId(id);
        if (!allowed) vm.expectRevert(abi.encodeWithSelector(TestnetOnly.NotAnAllowedTestnet.selector, uint256(id)));
        new MessageVerifier(admin, attesters, 2, 1 days);
    }

    function test_constructorsRejectMissingVerifier() public {
        vm.chainId(HOME);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.InvalidConfig.selector, "verifier has no code"));
        new BridgeVault(admin, pauser, MessageVerifier(address(0x1234)), 10, feeRecipient);
        vm.chainId(REMOTE);
        vm.expectRevert(abi.encodeWithSelector(BridgeExecutor.InvalidMessage.selector, "verifier has no code"));
        new BridgeExecutor(admin, pauser, MessageVerifier(address(0x1234)), HOME);
    }
}

contract RefundAndGovernanceTest is BridgeBase {
    // ------------------------------------------------------------------ refunds: lock side

    function _registerOtherUsdcOnVaultOnly() internal returns (MockToken t) {
        // A token the vault accepts but the executor never registered => mint is impossible.
        vm.chainId(HOME);
        t = new MockToken("Other", "OTH", 6);
        vm.startPrank(admin);
        vault.configureToken(address(t), true, 1e6, 500_000e6);
        vault.setRateLimit(address(t), uint128(RATE_CAP), 1 days);
        vault.setRefundLimit(address(t), uint128(REFUND_CAP), 1 days);
        vault.setChainCap(address(t), REMOTE, CHAIN_CAP);
        vm.stopPrank();
        t.mint(alice, 1_000e6);
        vm.prank(alice);
        t.approve(address(vault), type(uint256).max);
    }

    function test_stuckLockIsCancelledThenRefundedOnce() public {
        MockToken t = _registerOtherUsdcOnVaultOnly();
        vm.chainId(HOME);
        vm.recordLogs();
        vm.prank(alice);
        vault.lock(address(t), 100e6, REMOTE, bob);
        BridgeMessage memory m = _lastMessage(vm.getRecordedLogs());

        bytes[] memory sigs = _signRemote(m);
        vm.chainId(REMOTE);
        vm.expectRevert(abi.encodeWithSelector(BridgeExecutor.TokenNotRegistered.selector, address(t)));
        executor.execute(m, sigs); // stuck

        vm.prank(alice); // the sender may NOT cancel (would let senders claw back payments)
        vm.expectRevert(BridgeExecutor.NotAuthorizedToCancel.selector);
        executor.cancel(m, sigs);
        vm.prank(bob); // the recipient gives it up
        executor.cancel(m, sigs);
        assertTrue(executor.cancelled(BridgeTypes.messageId(m)));

        // Attesters sign the derived refund message for the HOME verifier.
        bytes[] memory rs = _sign(homeVerifier, HOME, BridgeTypes.refundOf(m), _idx(0, 1));
        vm.chainId(HOME);
        uint256 before = t.balanceOf(alice);
        vault.refund(m, rs);
        assertEq(t.balanceOf(alice) - before, m.amount, "net amount refunded to sender");
        assertEq(vault.lockedFor(address(t), REMOTE), 0);
        assertEq(vault.totalLocked(address(t)), 0);

        vm.expectRevert(abi.encodeWithSelector(BridgeVault.InvalidMessage.selector, "unknown or already refunded"));
        vault.refund(m, rs);
    }

    function test_noDoublePay_cancelAfterExecuteAndExecuteAfterCancel() public {
        BridgeMessage memory a = _lock(alice, 100e6, bob);
        _mint(a);
        bytes[] memory sa = _signRemote(a);
        vm.chainId(REMOTE);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ReplayProtection.MessageAlreadyProcessed.selector, BridgeTypes.messageId(a)));
        executor.cancel(a, sa); // executed => cannot be cancelled => can never be refunded

        BridgeMessage memory b = _lock(alice, 100e6, bob);
        bytes[] memory sb = _signRemote(b);
        vm.chainId(REMOTE);
        vm.prank(bob);
        executor.cancel(b, sb);
        vm.expectRevert(abi.encodeWithSelector(ReplayProtection.MessageAlreadyProcessed.selector, BridgeTypes.messageId(b)));
        executor.execute(b, sb); // cancelled => can never be minted
    }

    function test_refundRequiresAttestedRefundNotOriginalSignatures() public {
        BridgeMessage memory m = _lock(alice, 100e6, bob);
        bytes[] memory originalSigs = _signHome(m); // signatures over the ORIGINAL, not the refund
        vm.chainId(HOME);
        vm.expectRevert();
        vault.refund(m, originalSigs);
    }

    function test_refundCannotTargetAForeignOrFakeLock() public {
        BridgeMessage memory m = _lock(alice, 100e6, bob);
        m.amount = 1_000e6; // never initiated with this content
        bytes[] memory rs = _sign(homeVerifier, HOME, BridgeTypes.refundOf(m), _idx(0, 1));
        vm.chainId(HOME);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.InvalidMessage.selector, "unknown or already refunded"));
        vault.refund(m, rs);
    }

    // ------------------------------------------------------------------ refunds: burn side

    function test_cancelledBurnIsReMintedToSender() public {
        _mint(_lock(alice, 1000e6, bob));
        BridgeMessage memory b = _burn(bob, 300e6, alice);
        bytes[] memory s = _signHome(b);
        vm.chainId(HOME);
        vm.prank(alice); // recipient of the release gives it up
        vault.cancel(b, s);
        vm.expectRevert(abi.encodeWithSelector(ReplayProtection.MessageAlreadyProcessed.selector, BridgeTypes.messageId(b)));
        vault.release(b, s);

        bytes[] memory rs = _sign(remoteVerifier, REMOTE, BridgeTypes.refundOf(b), _idx(0, 1));
        vm.chainId(REMOTE);
        executor.refund(b, rs);
        assertEq(wUsdc.balanceOf(bob), 999e6, "burned amount re-minted to sender");
        assertEq(wUsdc.totalSupply(), vault.lockedFor(address(usdc), REMOTE), "still fully backed");
        vm.expectRevert(abi.encodeWithSelector(BridgeExecutor.InvalidMessage.selector, "unknown or already refunded"));
        executor.refund(b, rs);
    }

    // ------------------------------------------------------------------ migration & tokens

    function test_inFlightLocksSurviveHomeVaultMigration() public {
        BridgeMessage memory oldMsg = _lock(alice, 100e6, bob);
        vm.chainId(REMOTE);
        vm.prank(admin);
        executor.setHomeVault(makeAddr("newVault"));
        _mint(oldMsg); // still executes
        assertEq(wUsdc.balanceOf(bob), oldMsg.amount);
        assertEq(executor.homeVault(), makeAddr("newVault"));
    }

    function test_negativeRebaseHaltsTokenInsteadOfMisAccounting() public {
        RebasingToken r = new RebasingToken();
        vm.chainId(HOME);
        vm.startPrank(admin);
        vault.configureToken(address(r), true, 1, type(uint128).max);
        vault.setRateLimit(address(r), type(uint128).max, 1 days);
        vault.setChainCap(address(r), REMOTE, type(uint256).max);
        vm.stopPrank();
        r.mint(alice, 1000e18);
        vm.startPrank(alice);
        r.approve(address(vault), type(uint256).max);
        vault.lock(address(r), 100e18, REMOTE, bob);
        vm.stopPrank();
        r.rebase(address(vault), 90e18); // vault silently loses 10%
        vm.prank(alice);
        vm.expectRevert();
        vault.lock(address(r), 1e18, REMOTE, bob);
    }

    // ------------------------------------------------------------------ governance via timelock + multisig

    function test_adminActionsGoThroughTimelock() public {
        address multisig = makeAddr("safeMultisig");
        address[] memory ps = new address[](1);
        ps[0] = multisig;
        vm.chainId(HOME);
        TimelockController tl = new TimelockController(2 days, ps, ps, address(0));
        MessageVerifier v = new MessageVerifier(address(tl), attesters, 2, 2 days);
        BridgeVault gv = new BridgeVault(address(tl), pauser, v, 10, feeRecipient);

        // The multisig cannot act directly, and nobody can bypass the delay.
        vm.prank(multisig);
        vm.expectRevert();
        gv.setPeer(REMOTE, address(executor));

        bytes memory call_ = abi.encodeCall(BridgeVault.setPeer, (REMOTE, address(executor)));
        vm.prank(multisig);
        tl.schedule(address(gv), 0, call_, bytes32(0), bytes32("peer"), 2 days);
        vm.prank(multisig);
        vm.expectRevert();
        tl.execute(address(gv), 0, call_, bytes32(0), bytes32("peer"));
        vm.warp(block.timestamp + 2 days);
        vm.prank(alice); // a random account cannot execute either
        vm.expectRevert();
        tl.execute(address(gv), 0, call_, bytes32(0), bytes32("peer"));
        vm.prank(multisig);
        tl.execute(address(gv), 0, call_, bytes32(0), bytes32("peer"));
        assertEq(gv.peers(REMOTE), address(executor));

        // Pausing stays fast and separate from admin.
        vm.prank(pauser);
        gv.pause();
        assertTrue(gv.paused());
    }
}

contract RebasingToken is MockToken {
    constructor() MockToken("Rebase", "RB", 18) {}

    function rebase(address who, uint256 newBalance) external {
        uint256 cur = balanceOf(who);
        if (newBalance < cur) _burn(who, cur - newBalance);
        else _mint(who, newBalance - cur);
    }
}

contract RecoveryPolicyTest is BridgeBase {
    function _stuckLock(uint256 amount) internal returns (BridgeMessage memory m) {
        m = _lock(alice, amount, bob);
        bytes[] memory s = _signRemote(m);
        vm.chainId(REMOTE);
        vm.prank(bob);
        executor.cancel(m, s);
    }

    function _refundSigs(BridgeMessage memory m) internal returns (bytes[] memory) {
        return _sign(homeVerifier, HOME, BridgeTypes.refundOf(m), _idx(0, 1));
    }

    // ---- reviewer #2: rate limit must not block refunds

    function test_refundWorksWhenTransferBucketIsExhausted() public {
        BridgeMessage memory m = _stuckLock(100e6);
        // Drain the NORMAL bucket completely with legitimate releases.
        vm.chainId(HOME);
        vm.prank(admin);
        vault.setRateLimit(address(usdc), 1e6, 1 days);
        _mint(_lock(alice, 2e6, bob));
        _release(_burn(bob, 1e6, alice)); // uses the last 1e6 of the transfer bucket
        assertEq(vault.availableToTransfer(address(usdc)), 0);

        vm.chainId(HOME);
        uint256 before = usdc.balanceOf(alice);
        vault.refund(m, _refundSigs(m)); // still possible
        assertEq(usdc.balanceOf(alice) - before, m.amount);
    }

    function test_refundsAreStillBoundedByTheRecoveryLimit() public {
        vm.chainId(HOME);
        vm.prank(admin);
        vault.setRefundLimit(address(usdc), 150e6, 1 days);
        BridgeMessage memory a = _stuckLock(100e6);
        BridgeMessage memory b = _stuckLock(100e6);
        bytes[] memory sa = _refundSigs(a);
        bytes[] memory sb = _refundSigs(b);
        vm.chainId(HOME);
        vault.refund(a, sa);
        vm.expectRevert(abi.encodeWithSelector(RateLimiter.RefundLimitExceeded.selector, address(usdc), b.amount, 150e6 - a.amount));
        vault.refund(b, sb);
        vm.warp(block.timestamp + 1 days);
        vault.refund(b, sb); // refilled; the refund was delayed, never lost
    }

    // ---- reviewer: route pause keeps refunds, global pause stops them

    function test_routePausePreservesCancelAndRefund_globalPauseStopsThem() public {
        BridgeMessage memory m = _lock(alice, 100e6, bob);
        bytes[] memory s = _signRemote(m);
        vm.chainId(REMOTE);
        vm.prank(pauser);
        executor.pauseRoute(HOME);
        vm.expectRevert(abi.encodeWithSelector(EmergencyController.RoutePaused.selector, HOME));
        executor.execute(m, s); // forward movement stopped
        vm.prank(bob);
        executor.cancel(m, s); // unwinding allowed

        vm.chainId(HOME);
        vm.prank(pauser);
        vault.pauseRoute(REMOTE);
        bytes[] memory rs = _refundSigs(m);
        vm.chainId(HOME);
        vm.prank(pauser);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.refund(m, rs); // emergency stop halts everything
        vm.prank(admin);
        vault.unpause();
        vault.refund(m, rs); // route still paused, refund goes through
        assertEq(vault.lockedFor(address(usdc), REMOTE), 0);
    }

    // ---- reviewer #3: bounded damage per chain

    function test_chainCapBoundsLocksTowardsOneChain() public {
        vm.chainId(HOME);
        vm.prank(admin);
        vault.setChainCap(address(usdc), REMOTE, 1000e6);
        _lock(alice, 900e6, bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.ChainCapExceeded.selector, address(usdc), REMOTE, 1000e6));
        vault.lock(address(usdc), 200e6, REMOTE, bob);
    }

    function test_supplyCapBoundsForgedMintsEvenWithValidSignatures() public {
        vm.chainId(REMOTE);
        vm.prank(admin);
        executor.setSupplyCap(address(usdc), 1000e6);
        // Colluding signers attest a mint that never happened.
        BridgeMessage memory forged = BridgeMessage({
            version: 1, kind: 0, sourceChainId: HOME, sourceContract: address(vault), destChainId: REMOTE,
            destContract: address(executor), nonce: 424242, canonicalToken: address(usdc), sender: bob, recipient: bob, amount: 5000e6
        });
        bytes[] memory s = _signRemote(forged);
        vm.chainId(REMOTE);
        vm.expectRevert(abi.encodeWithSelector(BridgeExecutor.SupplyCapExceeded.selector, address(usdc), 1000e6));
        executor.execute(forged, s);
    }

    // ---- reviewer #5: peer migration lifecycle

    function test_peerMigrationDrainThenRevoke() public {
        // In flight from the OLD executor before migration.
        _mint(_lock(alice, 1000e6, bob));
        BridgeMessage memory oldBurn = _burn(bob, 300e6, alice);

        address newExec = makeAddr("newExecutor");
        vm.chainId(HOME);
        vm.prank(admin);
        vault.setPeer(REMOTE, newExec);
        assertEq(uint8(vault.peerStatus(REMOTE, address(executor))), uint8(BridgeVault.PeerStatus.Draining));
        assertEq(uint8(vault.peerStatus(REMOTE, newExec)), uint8(BridgeVault.PeerStatus.Active));

        // Both peers accepted during the transition; new locks address the new peer.
        BridgeMessage memory newLock = _lock(alice, 10e6, bob);
        assertEq(newLock.destContract, newExec);
        _release(oldBurn); // old peer's in-flight burn still completes

        vm.chainId(HOME);
        vm.startPrank(admin);
        vm.expectRevert(BridgeVault.CannotRevokeActivePeer.selector);
        vault.revokePeer(REMOTE, newExec);
        vault.revokePeer(REMOTE, address(executor));
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.InvalidConfig.selector, "peer was revoked"));
        vault.setPeer(REMOTE, address(executor)); // a revoked peer can never come back
        vm.stopPrank();

        BridgeMessage memory lateBurn = _burn(bob, 100e6, alice);
        bytes[] memory s = _signHome(lateBurn);
        vm.chainId(HOME);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.InvalidMessage.selector, "source"));
        vault.release(lateBurn, s); // revoked: nothing from it is accepted
    }

    function test_vaultMigrationDrainThenRevokeOnExecutor() public {
        BridgeMessage memory inflight = _lock(alice, 100e6, bob);
        vm.chainId(REMOTE);
        vm.startPrank(admin);
        executor.setHomeVault(makeAddr("vault2"));
        vm.expectRevert(BridgeExecutor.CannotRevokeActiveVault.selector);
        executor.revokeVault(makeAddr("vault2"));
        vm.stopPrank();
        _mint(inflight); // draining vault's lock still mints

        BridgeMessage memory late = _lock(alice, 100e6, bob);
        vm.chainId(REMOTE);
        vm.prank(admin);
        executor.revokeVault(address(vault));
        bytes[] memory s = _signRemote(late);
        vm.chainId(REMOTE);
        vm.expectRevert(abi.encodeWithSelector(BridgeExecutor.InvalidMessage.selector, "source"));
        executor.execute(late, s);
    }

    // ---- reviewer: signer removed mid-flight

    function test_signaturesFromRemovedSignerAreRejectedAndRemainingSetWorks() public {
        BridgeMessage memory m = _lock(alice, 100e6, bob);
        bytes[] memory oldSigs = _sign(remoteVerifier, REMOTE, m, _idx(0, 2)); // uses signer #2
        address[] memory reduced = new address[](2);
        reduced[0] = attesters[0];
        reduced[1] = attesters[1];
        vm.chainId(REMOTE);
        vm.prank(admin);
        remoteVerifier.proposeSignerSet(reduced, 2);
        vm.warp(block.timestamp + ROTATION_DELAY);
        remoteVerifier.executeSignerSet();
        vm.expectRevert(); // old signatures (version 1, includes removed signer) no longer valid
        executor.execute(m, oldSigs);
        _mint(m); // fresh signatures from the remaining two
        assertEq(wUsdc.balanceOf(bob), m.amount);
    }
}
