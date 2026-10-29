// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BridgeMessage, BridgeTypes, TestnetOnly} from "./BridgeTypes.sol";
import {EmergencyController} from "./EmergencyController.sol";
import {FeeController} from "./FeeController.sol";
import {IMessageVerifier} from "./IMessageVerifier.sol";
import {RateLimiter} from "./RateLimiter.sol";
import {ReplayProtection} from "./ReplayProtection.sol";

/// @notice Home-chain vault: locks canonical tokens (LOCK_MINT), releases them against attested
///         burns (BURN_RELEASE), and refunds locks that were cancelled on the destination (REFUND).
/// @dev Invariants:
///      - lockedFor[token][chain] only decreases through a verified, unique, rate-limited release
///        or refund, and never below zero (no unbacked, no cross-chain release).
///      - balanceOf(vault) >= totalLocked + accruedFees after every state change (solvency); a
///        negative rebase or hidden transfer fee halts the token instead of mis-accounting.
///      - A lock is either executed OR cancelled on the destination (same processed[] slot),
///        and refundable at most once, only if it was really initiated here.
///      - No admin function can move locked funds; only accrued protocol fees are withdrawable.
///      - DEFAULT_ADMIN_ROLE is meant to be a TimelockController owned by a multisig; the
///        deployment verifier (protocol/verify-deployment.ts) refuses anything else.
contract BridgeVault is EmergencyController, ReentrancyGuard, ReplayProtection, RateLimiter, FeeController, TestnetOnly {
    using SafeERC20 for IERC20;

    struct TokenConfig {
        bool enabled;
        uint128 minAmount;
        uint128 maxAmount;
    }

    /// @dev A MessageVerifier (fixed forever) or a VerifierRouter (one-way, time-delayed upgrades).
    IMessageVerifier public immutable verifier;
    uint256 public outboundNonce;
    mapping(address => TokenConfig) public tokenConfig;
    /// @dev Peer lifecycle for migrations:
    ///      Active   — the current peer: new locks go to it; its messages are accepted.
    ///      Draining — a former peer: no new locks, but its in-flight messages (burns, cancels) are
    ///                 still accepted so nothing is stranded during the transition.
    ///      Revoked  — cut off (e.g. compromised): nothing from it is accepted any more. Only a
    ///                 Draining peer can be revoked, and only through governance (timelock).
    enum PeerStatus { None, Active, Draining, Revoked }

    mapping(uint256 => address) public peers; // remote chain id => current (Active) BridgeExecutor
    mapping(uint256 => mapping(address => PeerStatus)) public peerStatus;
    /// @dev Damage bound: the most that may ever be locked towards one remote chain per token.
    ///      Unset (0) = no locks to that chain (fail closed).
    mapping(address => mapping(uint256 => uint256)) public chainCap;
    /// @dev Backing is tracked PER REMOTE CHAIN: a compromised remote chain can at most release
    ///      what was locked towards that chain, never the backing of other chains.
    mapping(address => mapping(uint256 => uint256)) public lockedFor; // token => remote chain => amount
    mapping(address => uint256) public totalLocked; // sum over remote chains
    mapping(address => uint256) public accruedFees;
    /// @dev messageId of every lock started here that has not been refunded.
    mapping(bytes32 => bool) public initiated;
    /// @dev Burn messages cancelled here (recipient gave up the release; sender is re-minted remotely).
    mapping(bytes32 => bool) public cancelled;

    error TokenNotSupported(address token);
    error AmountOutOfBounds(uint256 amount);
    error InvalidRecipient();
    error UnknownPeer(uint256 chainId);
    error UnsupportedTransferToken(); // fee-on-transfer behaviour detected
    error InvalidMessage(string reason);
    error InsufficientBacking(uint256 requested, uint256 locked);
    error BackingShortfall(address token, uint256 balance, uint256 required);
    error NotAuthorizedToCancel();
    error InvalidConfig(string reason);
    error ChainCapExceeded(address token, uint256 chainId, uint256 cap);
    error CannotRevokeActivePeer();

    event TransferInitiated(bytes32 indexed messageId, BridgeMessage message, uint256 fee);
    event TransferReleased(bytes32 indexed messageId, address indexed recipient, address indexed token, uint256 amount);
    event MessageCancelled(bytes32 indexed messageId, BridgeMessage message, address indexed by);
    event TransferRefunded(bytes32 indexed originalId, address indexed sender, address indexed token, uint256 amount);
    event TokenConfigured(address indexed token, bool enabled, uint128 minAmount, uint128 maxAmount);
    event PeerSet(uint256 indexed chainId, address peer);
    event PeerStatusChanged(uint256 indexed chainId, address indexed peer, PeerStatus status);
    event ChainCapSet(address indexed token, uint256 indexed chainId, uint256 cap);
    event FeesWithdrawn(address indexed token, address indexed to, uint256 amount);

    constructor(address admin, address pauser, IMessageVerifier verifier_, uint16 feeBps_, address feeRecipient_)
        EmergencyController(admin, pauser)
    {
        if (address(verifier_).code.length == 0) revert InvalidConfig("verifier has no code");
        verifier = verifier_;
        _setFee(feeBps_, feeRecipient_);
    }

    // ------------------------------------------------------------------ user flow

    function lock(address token, uint256 amount, uint256 destChainId, address recipient)
        external
        nonReentrant
        whenNotPaused
        whenRouteActive(destChainId)
        returns (bytes32 messageId)
    {
        TokenConfig memory cfg = tokenConfig[token];
        if (!cfg.enabled) revert TokenNotSupported(token);
        if (amount < cfg.minAmount || amount > cfg.maxAmount) revert AmountOutOfBounds(amount);
        if (recipient == address(0)) revert InvalidRecipient();
        address peer = peers[destChainId];
        if (peer == address(0)) revert UnknownPeer(destChainId);

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert UnsupportedTransferToken();

        (uint256 fee, uint256 net) = quoteFee(amount);
        uint256 newLocked = lockedFor[token][destChainId] + net;
        if (newLocked > chainCap[token][destChainId]) revert ChainCapExceeded(token, destChainId, chainCap[token][destChainId]);
        accruedFees[token] += fee;
        lockedFor[token][destChainId] = newLocked;
        totalLocked[token] += net;

        BridgeMessage memory m = BridgeMessage({
            version: BridgeTypes.VERSION,
            kind: BridgeTypes.KIND_LOCK_MINT,
            sourceChainId: block.chainid,
            sourceContract: address(this),
            destChainId: destChainId,
            destContract: peer,
            nonce: ++outboundNonce,
            canonicalToken: token,
            sender: msg.sender,
            recipient: recipient,
            amount: net
        });
        messageId = BridgeTypes.messageId(m);
        initiated[messageId] = true;
        _assertSolvent(token);
        emit TransferInitiated(messageId, m, fee);
    }

    function release(BridgeMessage calldata m, bytes[] calldata sigs)
        external
        nonReentrant
        whenNotPaused
        whenRouteActive(m.sourceChainId)
    {
        _checkInboundBurn(m);
        if (m.recipient == address(0) || m.amount == 0) revert InvalidMessage("payload");

        verifier.verify(m, sigs);

        bytes32 id = BridgeTypes.messageId(m);
        _markProcessed(id);
        _consumeRateLimit(m.canonicalToken, m.amount);
        _debitBacking(m.canonicalToken, m.sourceChainId, m.amount);

        IERC20(m.canonicalToken).safeTransfer(m.recipient, m.amount);
        _assertSolvent(m.canonicalToken);
        emit TransferReleased(id, m.recipient, m.canonicalToken, m.amount);
    }

    /// @notice Cancel an attested burn that cannot or should not be released here. After this the
    ///         burn can NEVER be released (same processed[] slot as release), and attesters may sign
    ///         a REFUND that re-mints the burned amount to the original sender on the remote chain.
    /// @dev Only the recipient (who gives up the funds) or the admin (timelock) may cancel. The
    ///      signatures prove the burn is genuine.
    function cancel(BridgeMessage calldata m, bytes[] calldata sigs) external nonReentrant whenNotPaused {
        _checkInboundBurn(m);
        if (msg.sender != m.recipient && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAuthorizedToCancel();
        verifier.verify(m, sigs);
        bytes32 id = BridgeTypes.messageId(m);
        _markProcessed(id);
        cancelled[id] = true;
        emit MessageCancelled(id, m, msg.sender);
    }

    /// @notice Return a lock to its sender after it was cancelled on the destination chain.
    /// @dev Refund policy: uses the separate RECOVERY rate limit (never blocked by normal traffic),
    ///      and is NOT stopped by a route pause — pausing a route stops value moving forward, while
    ///      unwinding back to the original sender stays possible. A global pause stops refunds too.
    /// @param original the LOCK_MINT message emitted by this vault
    /// @param sigs attestations of refundOf(original), signed only after the attesters observed a
    ///        final MessageCancelled for `original` on the destination chain.
    function refund(BridgeMessage calldata original, bytes[] calldata sigs) external nonReentrant whenNotPaused {
        if (original.version != BridgeTypes.VERSION || original.kind != BridgeTypes.KIND_LOCK_MINT) revert InvalidMessage("kind");
        if (original.sourceChainId != block.chainid || original.sourceContract != address(this)) revert InvalidMessage("source");
        if (!knownPeer(original.destChainId, original.destContract)) revert InvalidMessage("destination");
        bytes32 originalId = BridgeTypes.messageId(original);
        if (!initiated[originalId]) revert InvalidMessage("unknown or already refunded");

        BridgeMessage memory r = BridgeTypes.refundOf(original);
        verifier.verify(r, sigs);

        initiated[originalId] = false;
        _markProcessed(BridgeTypes.messageId(r));
        _consumeRefundLimit(original.canonicalToken, original.amount);
        _debitBacking(original.canonicalToken, original.destChainId, original.amount);

        IERC20(original.canonicalToken).safeTransfer(original.sender, original.amount);
        _assertSolvent(original.canonicalToken);
        emit TransferRefunded(originalId, original.sender, original.canonicalToken, original.amount);
    }

    // ------------------------------------------------------------------ internals

    function _checkInboundBurn(BridgeMessage calldata m) private view {
        if (m.version != BridgeTypes.VERSION) revert InvalidMessage("version");
        if (m.kind != BridgeTypes.KIND_BURN_RELEASE) revert InvalidMessage("kind");
        if (m.destChainId != block.chainid || m.destContract != address(this)) revert InvalidMessage("destination");
        if (!knownPeer(m.sourceChainId, m.sourceContract)) revert InvalidMessage("source");
        // `enabled` only gates new locks; disabling a token must never freeze funds already bridged.
        if (tokenConfig[m.canonicalToken].minAmount == 0) revert TokenNotSupported(m.canonicalToken);
    }

    function _debitBacking(address token, uint256 chainId, uint256 amount) private {
        uint256 locked = lockedFor[token][chainId];
        if (amount > locked) revert InsufficientBacking(amount, locked);
        lockedFor[token][chainId] = locked - amount;
        totalLocked[token] -= amount;
    }

    function _assertSolvent(address token) private view {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 required = totalLocked[token] + accruedFees[token];
        if (bal < required) revert BackingShortfall(token, bal, required);
    }

    // ------------------------------------------------------------------ admin (TimelockController)

    function configureToken(address token, bool enabled, uint128 minAmount, uint128 maxAmount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (token == address(0) || token.code.length == 0 || minAmount == 0 || maxAmount < minAmount) {
            revert InvalidMessage("token config");
        }
        tokenConfig[token] = TokenConfig(enabled, minAmount, maxAmount);
        emit TokenConfigured(token, enabled, minAmount, maxAmount);
    }

    /// @notice Inbound messages are accepted from Active and Draining peers only.
    function knownPeer(uint256 chainId, address peer) public view returns (bool) {
        PeerStatus s = peerStatus[chainId][peer];
        return s == PeerStatus.Active || s == PeerStatus.Draining;
    }

    /// @notice Make `peer` the Active peer; the previous one becomes Draining (still accepted).
    function setPeer(uint256 chainId, address peer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (chainId == block.chainid || peer == address(0)) revert UnknownPeer(chainId);
        if (peerStatus[chainId][peer] == PeerStatus.Revoked) revert InvalidConfig("peer was revoked");
        address old = peers[chainId];
        if (old != address(0) && old != peer) {
            peerStatus[chainId][old] = PeerStatus.Draining;
            emit PeerStatusChanged(chainId, old, PeerStatus.Draining);
        }
        peers[chainId] = peer;
        peerStatus[chainId][peer] = PeerStatus.Active;
        emit PeerStatusChanged(chainId, peer, PeerStatus.Active);
        emit PeerSet(chainId, peer);
    }

    /// @notice Stop accepting anything from a former peer. Its un-released burns can no longer be
    ///         released or cancelled here, so drain in-flight transfers first (docs/operations.md).
    function revokePeer(uint256 chainId, address peer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (peerStatus[chainId][peer] != PeerStatus.Draining) revert CannotRevokeActivePeer();
        peerStatus[chainId][peer] = PeerStatus.Revoked;
        emit PeerStatusChanged(chainId, peer, PeerStatus.Revoked);
    }

    function setChainCap(address token, uint256 chainId, uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        chainCap[token][chainId] = cap; // lowering below lockedFor only blocks new locks
        emit ChainCapSet(token, chainId, cap);
    }

    function setRefundLimit(address token, uint128 capacity, uint64 window) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setRefundLimit(token, capacity, window);
    }

    function setRateLimit(address token, uint128 capacity, uint64 window) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setRateLimit(token, capacity, window);
    }

    function setFee(uint16 bps, address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setFee(bps, recipient);
    }

    /// @notice Withdraws only accrued protocol fees, never locked user funds.
    function withdrawFees(address token) external nonReentrant {
        if (msg.sender != feeRecipient && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert InvalidRecipient();
        uint256 amount = accruedFees[token];
        accruedFees[token] = 0;
        IERC20(token).safeTransfer(feeRecipient, amount);
        _assertSolvent(token);
        emit FeesWithdrawn(token, feeRecipient, amount);
    }
}
