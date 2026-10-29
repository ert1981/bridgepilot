// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Vm} from "forge-std/Test.sol";
import {BridgeMessage, BridgeTypes} from "../src/BridgeTypes.sol";
import {BridgeExecutor} from "../src/BridgeExecutor.sol";
import {BridgeToken} from "../src/BridgeToken.sol";
import {CompositeVerifier} from "../src/CompositeVerifier.sol";
import {IMessageVerifier} from "../src/IMessageVerifier.sol";
import {MessageVerifier} from "../src/MessageVerifier.sol";
import {VerifierRouter} from "../src/VerifierRouter.sol";
import {BridgeBase} from "./BridgeBase.t.sol";
import {MockProofVerifier, MutableLevelVerifier} from "./mocks/MockVerifiers.sol";

/// @notice Upgrade path signer set -> proofs: one-way, delayed, vetoable, traceable.
contract VerifierRouterTest is BridgeBase {
    VerifierRouter internal router;
    BridgeExecutor internal exec2;
    MockProofVerifier internal proofV;
    CompositeVerifier internal both;
    address internal mallory = makeAddr("mallory");
    uint64 internal constant DELAY = 7 days;

    function setUp() public override {
        super.setUp();
        vm.chainId(REMOTE);
        router = new VerifierRouter(admin, pauser, DELAY);
        vm.prank(admin);
        router.initRoute(HOME, remoteVerifier);
        exec2 = new BridgeExecutor(admin, pauser, router, HOME);
        proofV = new MockProofVerifier();
        IMessageVerifier[] memory parts = new IMessageVerifier[](2);
        parts[0] = remoteVerifier;
        parts[1] = proofV;
        both = new CompositeVerifier(parts);
        vm.startPrank(admin);
        exec2.registerToken(address(usdc), "Bridged USDC", "bpUSDC", 6, 1);
        exec2.setHomeVault(address(vault));
        exec2.setRateLimit(address(usdc), uint128(RATE_CAP), 1 days);
        exec2.setRefundLimit(address(usdc), uint128(REFUND_CAP), 1 days);
        exec2.setSupplyCap(address(usdc), CHAIN_CAP);
        vm.stopPrank();
        vm.chainId(HOME);
        vm.prank(admin);
        vault.setPeer(REMOTE, address(exec2));
    }

    function _lock(uint256 amount) internal returns (BridgeMessage memory m) {
        vm.chainId(HOME);
        vm.recordLogs();
        vm.prank(alice);
        vault.lock(address(usdc), amount, REMOTE, alice);
        m = _lastMessage(vm.getRecordedLogs());
        vm.chainId(REMOTE);
    }

    function _upgradeTo(IMessageVerifier v) internal {
        vm.prank(admin);
        router.proposeUpgrade(HOME, v);
        vm.warp(block.timestamp + DELAY);
        router.activateUpgrade(HOME); // anyone may activate
    }

    function _compositeProof(BridgeMessage memory m) internal returns (bytes[] memory p) {
        bytes[] memory zk = new bytes[](1);
        zk[0] = abi.encode(BridgeTypes.messageId(m));
        p = new bytes[](2);
        p[0] = abi.encode(_signRemote(m));
        p[1] = abi.encode(zk);
    }

    function test_executesThroughRouterWithSignerSet() public {
        BridgeMessage memory m = _lock(10e6);
        exec2.execute(m, _signRemote(m));
        assertGt(BridgeToken(exec2.wrapped(address(usdc))).balanceOf(alice), 0);
        assertEq(router.levelOf(HOME), 1);
    }

    function test_constructorRefusesShortDelay() public {
        vm.expectRevert(abi.encodeWithSelector(VerifierRouter.DelayTooShort.selector, uint64(1 days)));
        new VerifierRouter(admin, pauser, 1 days);
    }

    function test_routeInitializedOnlyOnceAndOnlyByAdmin() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(VerifierRouter.RouteAlreadyInitialized.selector, HOME));
        router.initRoute(HOME, proofV);
        vm.prank(mallory);
        vm.expectRevert();
        router.initRoute(1234, proofV);
    }

    function test_upgradeNeedsDelayThenAnyoneActivates() public {
        vm.prank(admin);
        router.proposeUpgrade(HOME, both);
        (, , , uint64 eta) = router.pendingUpgrade(HOME);
        vm.warp(eta - 1);
        vm.expectRevert(abi.encodeWithSelector(VerifierRouter.UpgradeNotReady.selector, eta));
        router.activateUpgrade(HOME);
        vm.warp(eta);
        vm.prank(mallory);
        router.activateUpgrade(HOME);
        assertEq(router.activeVerifier(HOME), address(both));
        assertEq(router.minLevel(HOME), 3);
        assertEq(router.historyLength(HOME), 2);
        assertEq(router.historyAt(HOME, 1).verifier, address(both));
    }

    function test_noDowngradeEver() public {
        _upgradeTo(both); // level 3, minimum ratchets to 3
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(VerifierRouter.Downgrade.selector, uint8(1), uint8(3)));
        router.proposeUpgrade(HOME, remoteVerifier); // back to signers only: refused
        MutableLevelVerifier weak = new MutableLevelVerifier(2);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(VerifierRouter.Downgrade.selector, uint8(2), uint8(3)));
        router.proposeUpgrade(HOME, weak);
        // An equal-level replacement is allowed (e.g. a fixed proof verifier).
        MockProofVerifier proof2 = new MockProofVerifier();
        _upgradeTo(proof2);
        assertEq(router.activeVerifier(HOME), address(proof2));
    }

    function test_afterUpgradeSignaturesAloneNoLongerSuffice() public {
        _upgradeTo(both);
        BridgeMessage memory m = _lock(10e6);
        bytes[] memory sigsOnly = _signRemote(m);
        vm.expectRevert(); // signer-only proof is not a composite proof
        exec2.execute(m, sigsOnly);
        bytes[] memory p = _compositeProof(m);
        bytes[] memory badZk = new bytes[](1);
        badZk[0] = abi.encode(bytes32(uint256(1)));
        bytes[] memory forged = new bytes[](2);
        forged[0] = p[0];
        forged[1] = abi.encode(badZk);
        vm.expectRevert(MockProofVerifier.BadProof.selector);
        exec2.execute(m, forged); // valid signatures but invalid proof: refused (AND)
        exec2.execute(m, p);
        assertTrue(exec2.processed(BridgeTypes.messageId(m)));
    }

    function test_guardianCanVetoButNeverPropose() public {
        vm.prank(admin);
        router.proposeUpgrade(HOME, both);
        vm.prank(pauser);
        vm.expectRevert();
        router.proposeUpgrade(HOME, proofV);
        vm.prank(mallory);
        vm.expectRevert();
        router.cancelUpgrade(HOME);
        vm.prank(pauser);
        router.cancelUpgrade(HOME); // emergency veto
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(VerifierRouter.NoPendingProposal.selector, HOME));
        router.activateUpgrade(HOME);
        assertEq(router.activeVerifier(HOME), address(remoteVerifier));
    }

    function test_verifierThatChangesItsLevelIsRefused() public {
        MutableLevelVerifier v = new MutableLevelVerifier(2);
        vm.prank(admin);
        router.proposeUpgrade(HOME, v);
        v.setLevel(3);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(VerifierRouter.VerifierChanged.selector, "declared level changed since proposal"));
        router.activateUpgrade(HOME);
        v.setLevel(2);
        router.activateUpgrade(HOME);
        v.setLevel(1); // lies after activation
        BridgeMessage memory m = _lock(5e6);
        vm.expectRevert(abi.encodeWithSelector(VerifierRouter.VerifierChanged.selector, "level below route minimum"));
        exec2.execute(m, new bytes[](0));
    }

    function test_minLevelOnlyRises() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(VerifierRouter.MinLevelCanOnlyIncrease.selector, uint8(1), uint8(1)));
        router.raiseMinLevel(HOME, 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(VerifierRouter.Downgrade.selector, uint8(1), uint8(3)));
        router.raiseMinLevel(HOME, 3); // active (signers, level 1) does not satisfy it
    }

    function test_unknownRouteRefused() public {
        BridgeMessage memory m;
        m.sourceChainId = 999;
        vm.expectRevert(abi.encodeWithSelector(VerifierRouter.RouteNotInitialized.selector, uint256(999)));
        router.verify(m, new bytes[](0));
    }

    function test_compositeRejectsBadParts() public {
        IMessageVerifier[] memory one = new IMessageVerifier[](1);
        one[0] = proofV;
        vm.expectRevert(CompositeVerifier.InvalidParts.selector);
        new CompositeVerifier(one);
        IMessageVerifier[] memory dup = new IMessageVerifier[](2);
        dup[0] = proofV;
        dup[1] = proofV;
        vm.expectRevert(CompositeVerifier.InvalidParts.selector);
        new CompositeVerifier(dup);
        assertEq(both.securityLevel(), 3); // max of parts: never weaker than any part
    }

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_levelNeverDecreases(uint8[8] memory levels, bool[8] memory veto) public {
        uint8 high = router.levelOf(HOME);
        for (uint256 i = 0; i < 8; i++) {
            uint8 l = uint8(bound(levels[i], 1, 3));
            MutableLevelVerifier v = new MutableLevelVerifier(l);
            vm.prank(admin);
            try router.proposeUpgrade(HOME, v) {
                assertGe(l, high);
                if (veto[i]) {
                    vm.prank(pauser);
                    router.cancelUpgrade(HOME);
                } else {
                    vm.warp(block.timestamp + DELAY);
                    router.activateUpgrade(HOME);
                }
            } catch {
                assertLt(l, high); // refused only if it would be a downgrade
            }
            assertGe(router.levelOf(HOME), high);
            assertGe(router.minLevel(HOME), high);
            high = router.levelOf(HOME);
        }
    }
}
