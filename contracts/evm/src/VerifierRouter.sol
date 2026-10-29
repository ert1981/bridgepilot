// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {BridgeMessage, TestnetOnly} from "./BridgeTypes.sol";
import {IMessageVerifier} from "./IMessageVerifier.sol";

/// @notice Per-route verifier selection with a ONE-WAY upgrade path from signer sets to proofs.
/// @dev BridgeVault / BridgeExecutor hold this router as their immutable verifier. For each source
///      chain (route) it delegates to exactly one active IMessageVerifier. Upgrade rules — none of
///      which governance can bypass:
///        1. No downgrade: a proposed verifier's security level must be >= the active verifier's
///           level and >= the route's minimum level. The minimum only ever rises (ratchet).
///        2. No silent swap: every change is a public proposal (event) that can only take effect
///           after `upgradeDelay` (>= MIN_UPGRADE_DELAY = 7 days); the active verifier can never be
///           set directly after a route's initialization.
///        3. Emergency stop: the GUARDIAN (pauser) can veto any pending proposal at any time and pause
///           the route on the bridge contracts; it can never propose or activate anything.
///        4. Traceability: every activation is appended to an on-chain per-route history.
///        5. No emergency downgrade either: if an active verifier is found broken, the route is
///           paused and migrated (new deployment), never silently weakened.
///      Limitation (documented): the level is declared by the verifier itself. A malicious governance
///      could deploy a verifier that lies about its level; the 7-day public delay, the guardian veto
///      and the readiness gate's code-hash allowlist (audited verifiers only) are the defences.
contract VerifierRouter is IMessageVerifier, AccessControl, TestnetOnly {
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    uint64 public constant MIN_UPGRADE_DELAY = 7 days;
    bytes32 public constant KIND = keccak256("VERIFIER_ROUTER_V1");

    struct Proposal {
        IMessageVerifier verifier;
        uint8 level;
        bytes32 codehash;
        uint64 eta;
    }

    struct Route {
        IMessageVerifier active;
        uint8 minLevel;
        Proposal pending;
    }

    struct Activation {
        address verifier;
        uint8 level;
        bytes32 codehash;
        uint64 at;
    }

    uint64 public immutable upgradeDelay;
    mapping(uint256 => Route) private _routes;
    mapping(uint256 => Activation[]) private _history;

    error RouteNotInitialized(uint256 sourceChainId);
    error RouteAlreadyInitialized(uint256 sourceChainId);
    error InvalidVerifier(string reason);
    error Downgrade(uint8 proposed, uint8 required);
    error NoPendingProposal(uint256 sourceChainId);
    error UpgradeNotReady(uint64 eta);
    error VerifierChanged(string reason);
    error MinLevelCanOnlyIncrease(uint8 current, uint8 requested);
    error DelayTooShort(uint64 delay);

    event RouteInitialized(uint256 indexed sourceChainId, address indexed verifier, uint8 level, bytes32 codehash);
    event VerifierUpgradeProposed(uint256 indexed sourceChainId, address indexed verifier, uint8 level, bytes32 codehash, uint64 eta);
    event VerifierUpgradeCancelled(uint256 indexed sourceChainId, address indexed verifier, address indexed by);
    event VerifierActivated(uint256 indexed sourceChainId, address indexed previous, address indexed verifier, uint8 level, bytes32 codehash);
    event MinLevelRaised(uint256 indexed sourceChainId, uint8 from, uint8 to);

    constructor(address admin, address guardian, uint64 upgradeDelay_) {
        if (upgradeDelay_ < MIN_UPGRADE_DELAY) revert DelayTooShort(upgradeDelay_);
        upgradeDelay = upgradeDelay_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
    }

    // ------------------------------------------------------------------ verification

    function verify(BridgeMessage calldata m, bytes[] calldata proof) external view {
        Route storage r = _routes[m.sourceChainId];
        if (address(r.active) == address(0)) revert RouteNotInitialized(m.sourceChainId);
        // Defensive: a verifier whose declared level changed after activation is refused.
        if (r.active.securityLevel() < r.minLevel) revert VerifierChanged("level below route minimum");
        r.active.verify(m, proof);
    }

    /// @notice The router itself is not a verification method; see `levelOf(route)`.
    function securityLevel() external pure returns (uint8) {
        return 0;
    }

    function verifierKind() external pure returns (bytes32) {
        return KIND;
    }

    // ------------------------------------------------------------------ views

    function activeVerifier(uint256 sourceChainId) external view returns (address) {
        return address(_routes[sourceChainId].active);
    }

    function levelOf(uint256 sourceChainId) external view returns (uint8) {
        IMessageVerifier v = _routes[sourceChainId].active;
        return address(v) == address(0) ? 0 : v.securityLevel();
    }

    function minLevel(uint256 sourceChainId) external view returns (uint8) {
        return _routes[sourceChainId].minLevel;
    }

    function pendingUpgrade(uint256 sourceChainId) external view returns (address verifier, uint8 level, bytes32 codehash, uint64 eta) {
        Proposal storage p = _routes[sourceChainId].pending;
        return (address(p.verifier), p.level, p.codehash, p.eta);
    }

    function historyLength(uint256 sourceChainId) external view returns (uint256) {
        return _history[sourceChainId].length;
    }

    function historyAt(uint256 sourceChainId, uint256 i) external view returns (Activation memory) {
        return _history[sourceChainId][i];
    }

    // ------------------------------------------------------------------ governance

    /// @notice One-time setup of a route. After this, the active verifier changes only via
    ///         propose -> delay -> activate.
    function initRoute(uint256 sourceChainId, IMessageVerifier verifier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Route storage r = _routes[sourceChainId];
        if (address(r.active) != address(0)) revert RouteAlreadyInitialized(sourceChainId);
        (uint8 level, bytes32 ch) = _inspect(verifier);
        r.active = verifier;
        r.minLevel = level;
        _record(sourceChainId, verifier, level, ch);
        emit RouteInitialized(sourceChainId, address(verifier), level, ch);
    }

    function proposeUpgrade(uint256 sourceChainId, IMessageVerifier verifier) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Route storage r = _routes[sourceChainId];
        if (address(r.active) == address(0)) revert RouteNotInitialized(sourceChainId);
        if (address(verifier) == address(r.active)) revert InvalidVerifier("already active");
        (uint8 level, bytes32 ch) = _inspect(verifier);
        uint8 required = _required(r);
        if (level < required) revert Downgrade(level, required);
        uint64 eta = uint64(block.timestamp) + upgradeDelay;
        r.pending = Proposal({verifier: verifier, level: level, codehash: ch, eta: eta});
        emit VerifierUpgradeProposed(sourceChainId, address(verifier), level, ch, eta);
    }

    /// @notice Admin withdraws, or the guardian VETOES, a pending upgrade.
    function cancelUpgrade(uint256 sourceChainId) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        Route storage r = _routes[sourceChainId];
        address v = address(r.pending.verifier);
        if (v == address(0)) revert NoPendingProposal(sourceChainId);
        delete r.pending;
        emit VerifierUpgradeCancelled(sourceChainId, v, msg.sender);
    }

    /// @notice Anyone may activate a proposal once its delay passed. Everything is re-checked:
    ///         the verifier's code and declared level must be exactly what was proposed.
    function activateUpgrade(uint256 sourceChainId) external {
        Route storage r = _routes[sourceChainId];
        Proposal memory p = r.pending;
        if (address(p.verifier) == address(0)) revert NoPendingProposal(sourceChainId);
        if (block.timestamp < p.eta) revert UpgradeNotReady(p.eta);
        (uint8 level, bytes32 ch) = _inspect(p.verifier);
        if (ch != p.codehash) revert VerifierChanged("code changed since proposal");
        if (level != p.level) revert VerifierChanged("declared level changed since proposal");
        uint8 required = _required(r);
        if (level < required) revert Downgrade(level, required);
        address previous = address(r.active);
        r.active = p.verifier;
        if (level > r.minLevel) {
            emit MinLevelRaised(sourceChainId, r.minLevel, level);
            r.minLevel = level; // ratchet: the route can never go back below this
        }
        delete r.pending;
        _record(sourceChainId, p.verifier, level, ch);
        emit VerifierActivated(sourceChainId, previous, address(p.verifier), level, ch);
    }

    /// @notice Raise (never lower) a route's minimum level.
    function raiseMinLevel(uint256 sourceChainId, uint8 level) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Route storage r = _routes[sourceChainId];
        if (address(r.active) == address(0)) revert RouteNotInitialized(sourceChainId);
        if (level <= r.minLevel) revert MinLevelCanOnlyIncrease(r.minLevel, level);
        uint8 active = r.active.securityLevel();
        if (level > active) revert Downgrade(active, level); // the active verifier must already satisfy it
        emit MinLevelRaised(sourceChainId, r.minLevel, level);
        r.minLevel = level;
        // A pending proposal below the new minimum can no longer activate (re-checked in activate).
    }

    // ------------------------------------------------------------------ internals

    function _required(Route storage r) private view returns (uint8) {
        uint8 activeLevel = r.active.securityLevel();
        return activeLevel > r.minLevel ? activeLevel : r.minLevel;
    }

    function _inspect(IMessageVerifier v) private view returns (uint8 level, bytes32 ch) {
        if (address(v).code.length == 0) revert InvalidVerifier("no code");
        if (address(v) == address(this)) revert InvalidVerifier("router cannot route to itself");
        level = v.securityLevel();
        if (level == 0 || level > 3) revert InvalidVerifier("invalid security level");
        if (v.verifierKind() == bytes32(0)) revert InvalidVerifier("no verifier kind");
        ch = address(v).codehash;
    }

    function _record(uint256 sourceChainId, IMessageVerifier v, uint8 level, bytes32 ch) private {
        _history[sourceChainId].push(Activation({verifier: address(v), level: level, codehash: ch, at: uint64(block.timestamp)}));
    }
}
