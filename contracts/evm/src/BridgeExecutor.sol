// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BridgeMessage, BridgeTypes, TestnetOnly} from "./BridgeTypes.sol";
import {BridgeToken} from "./BridgeToken.sol";
import {EmergencyController} from "./EmergencyController.sol";
import {IMessageVerifier} from "./IMessageVerifier.sol";
import {RateLimiter} from "./RateLimiter.sol";
import {ReplayProtection} from "./ReplayProtection.sol";

/// @notice Remote-chain executor: mints BridgeTokens for attested locks, burns them to start a
///         release on the home chain, cancels locks that cannot be minted, and re-mints burns that
///         were cancelled on the home chain.
/// @dev Invariant: BridgeToken supply only increases through a verified, unique, rate-limited
///      LOCK_MINT message from a known home vault, or a verified REFUND of a burn started here.
contract BridgeExecutor is EmergencyController, ReentrancyGuard, ReplayProtection, RateLimiter, TestnetOnly {
    /// @dev A MessageVerifier (fixed forever) or a VerifierRouter (one-way, time-delayed upgrades).
    IMessageVerifier public immutable verifier;
    uint256 public immutable homeChainId;
    /// @dev Vault lifecycle (same semantics as BridgeVault peers): Active vault receives new burns;
    ///      Draining vaults' in-flight locks are still minted/cancelled; Revoked vaults are cut off.
    enum VaultStatus { None, Active, Draining, Revoked }

    address public homeVault; // the Active vault
    mapping(address => VaultStatus) public vaultStatus;
    /// @dev Damage bound on this chain: wrapped supply per canonical token never exceeds this.
    ///      Unset (0) = no mints (fail closed). Refund re-mints of real burns are exempt (they only
    ///      restore supply that existed) and are bounded by the recovery rate limit instead.
    mapping(address => uint256) public supplyCap;
    uint256 public outboundNonce;
    mapping(address => BridgeToken) public wrapped; // canonical token => wrapped token
    mapping(address => uint256) public minBurn; // canonical token => minimum burn amount
    mapping(bytes32 => bool) public initiated; // burns started here, not yet refunded
    mapping(bytes32 => bool) public cancelled; // locks cancelled here

    error InvalidMessage(string reason);
    error TokenNotRegistered(address canonical);
    error TokenAlreadyRegistered(address canonical);
    error InvalidAmount();
    error InvalidRecipient();
    error NotAuthorizedToCancel();
    error SupplyCapExceeded(address canonical, uint256 cap);
    error CannotRevokeActiveVault();

    event TransferCompleted(bytes32 indexed messageId, address indexed recipient, address indexed canonicalToken, uint256 amount);
    event TransferInitiated(bytes32 indexed messageId, BridgeMessage message, uint256 fee);
    event MessageCancelled(bytes32 indexed messageId, BridgeMessage message, address indexed by);
    event TransferRefunded(bytes32 indexed originalId, address indexed sender, address indexed canonicalToken, uint256 amount);
    event TokenRegistered(address indexed canonical, address wrapped);
    event HomeVaultSet(address vault);
    event VaultStatusChanged(address indexed vault, VaultStatus status);
    event SupplyCapSet(address indexed canonical, uint256 cap);

    constructor(address admin, address pauser, IMessageVerifier verifier_, uint256 homeChainId_)
        EmergencyController(admin, pauser)
    {
        if (homeChainId_ == 0 || homeChainId_ == block.chainid) revert InvalidMessage("home chain");
        if (address(verifier_).code.length == 0) revert InvalidMessage("verifier has no code");
        verifier = verifier_;
        homeChainId = homeChainId_;
    }

    function execute(BridgeMessage calldata m, bytes[] calldata sigs)
        external
        nonReentrant
        whenNotPaused
        whenRouteActive(m.sourceChainId)
    {
        _checkInboundLock(m);
        if (m.recipient == address(0) || m.amount == 0) revert InvalidMessage("payload");
        BridgeToken token = wrapped[m.canonicalToken];
        if (address(token) == address(0)) revert TokenNotRegistered(m.canonicalToken);

        verifier.verify(m, sigs);

        bytes32 id = BridgeTypes.messageId(m);
        _markProcessed(id);
        _consumeRateLimit(m.canonicalToken, m.amount);
        if (token.totalSupply() + m.amount > supplyCap[m.canonicalToken]) revert SupplyCapExceeded(m.canonicalToken, supplyCap[m.canonicalToken]);
        token.mint(m.recipient, m.amount);
        emit TransferCompleted(id, m.recipient, m.canonicalToken, m.amount);
    }

    /// @notice Cancel an attested lock that cannot or should not be minted (e.g. token not
    ///         registered here). It can then never be executed, and the vault may refund the sender.
    /// @dev Only the recipient (who gives up the funds) or the admin (timelock) may cancel.
    function cancel(BridgeMessage calldata m, bytes[] calldata sigs) external nonReentrant whenNotPaused {
        _checkInboundLock(m);
        if (msg.sender != m.recipient && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAuthorizedToCancel();
        verifier.verify(m, sigs);
        bytes32 id = BridgeTypes.messageId(m);
        _markProcessed(id);
        cancelled[id] = true;
        emit MessageCancelled(id, m, msg.sender);
    }

    /// @notice Burn wrapped tokens to release the canonical tokens on the home chain.
    function burn(address canonicalToken, uint256 amount, address recipient)
        external
        nonReentrant
        whenNotPaused
        whenRouteActive(homeChainId)
        returns (bytes32 messageId)
    {
        BridgeToken token = wrapped[canonicalToken];
        if (address(token) == address(0)) revert TokenNotRegistered(canonicalToken);
        if (homeVault == address(0)) revert InvalidMessage("vault"); // never burn into a void
        if (amount == 0 || amount < minBurn[canonicalToken]) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();
        token.burn(msg.sender, amount);
        BridgeMessage memory m = BridgeMessage({
            version: BridgeTypes.VERSION,
            kind: BridgeTypes.KIND_BURN_RELEASE,
            sourceChainId: block.chainid,
            sourceContract: address(this),
            destChainId: homeChainId,
            destContract: homeVault,
            nonce: ++outboundNonce,
            canonicalToken: canonicalToken,
            sender: msg.sender,
            recipient: recipient,
            amount: amount
        });
        messageId = BridgeTypes.messageId(m);
        initiated[messageId] = true;
        emit TransferInitiated(messageId, m, 0);
    }

    /// @notice Re-mint a burn to its sender after the burn was cancelled on the home chain.
    /// @dev Same refund policy as the vault: recovery rate limit, not stopped by a route pause.
    function refund(BridgeMessage calldata original, bytes[] calldata sigs) external nonReentrant whenNotPaused {
        if (original.version != BridgeTypes.VERSION || original.kind != BridgeTypes.KIND_BURN_RELEASE) revert InvalidMessage("kind");
        if (original.sourceChainId != block.chainid || original.sourceContract != address(this)) revert InvalidMessage("source");
        if (original.destChainId != homeChainId || !knownVault(original.destContract)) revert InvalidMessage("destination");
        bytes32 originalId = BridgeTypes.messageId(original);
        if (!initiated[originalId]) revert InvalidMessage("unknown or already refunded");
        BridgeToken token = wrapped[original.canonicalToken];
        if (address(token) == address(0)) revert TokenNotRegistered(original.canonicalToken);

        BridgeMessage memory r = BridgeTypes.refundOf(original);
        verifier.verify(r, sigs);

        initiated[originalId] = false;
        _markProcessed(BridgeTypes.messageId(r));
        _consumeRefundLimit(original.canonicalToken, original.amount);
        token.mint(original.sender, original.amount);
        emit TransferRefunded(originalId, original.sender, original.canonicalToken, original.amount);
    }

    function _checkInboundLock(BridgeMessage calldata m) private view {
        if (m.version != BridgeTypes.VERSION) revert InvalidMessage("version");
        if (m.kind != BridgeTypes.KIND_LOCK_MINT) revert InvalidMessage("kind");
        if (m.destChainId != block.chainid || m.destContract != address(this)) revert InvalidMessage("destination");
        if (m.sourceChainId != homeChainId || !knownVault(m.sourceContract)) revert InvalidMessage("source");
    }

    // ------------------------------------------------------------------ admin (TimelockController)

    function registerToken(address canonical, string calldata name, string calldata symbol, uint8 decimals, uint256 minBurnAmount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (address)
    {
        if (canonical == address(0)) revert InvalidMessage("token");
        if (address(wrapped[canonical]) != address(0)) revert TokenAlreadyRegistered(canonical);
        BridgeToken t = new BridgeToken(name, symbol, decimals, canonical, homeChainId);
        wrapped[canonical] = t;
        minBurn[canonical] = minBurnAmount;
        emit TokenRegistered(canonical, address(t));
        return address(t);
    }

    function knownVault(address vault) public view returns (bool) {
        VaultStatus s = vaultStatus[vault];
        return s == VaultStatus.Active || s == VaultStatus.Draining;
    }

    /// @notice Make `vault` the Active vault; the previous one becomes Draining (still accepted).
    function setHomeVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (vault == address(0)) revert InvalidMessage("vault");
        if (vaultStatus[vault] == VaultStatus.Revoked) revert InvalidMessage("vault was revoked");
        address old = homeVault;
        if (old != address(0) && old != vault) {
            vaultStatus[old] = VaultStatus.Draining;
            emit VaultStatusChanged(old, VaultStatus.Draining);
        }
        homeVault = vault;
        vaultStatus[vault] = VaultStatus.Active;
        emit VaultStatusChanged(vault, VaultStatus.Active);
        emit HomeVaultSet(vault);
    }

    function revokeVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (vaultStatus[vault] != VaultStatus.Draining) revert CannotRevokeActiveVault();
        vaultStatus[vault] = VaultStatus.Revoked;
        emit VaultStatusChanged(vault, VaultStatus.Revoked);
    }

    function setSupplyCap(address canonicalToken, uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        supplyCap[canonicalToken] = cap;
        emit SupplyCapSet(canonicalToken, cap);
    }

    function setRefundLimit(address canonicalToken, uint128 capacity, uint64 window) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setRefundLimit(canonicalToken, capacity, window);
    }

    function setRateLimit(address canonicalToken, uint128 capacity, uint64 window) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setRateLimit(canonicalToken, capacity, window);
    }
}
