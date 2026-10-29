// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Fast stop, slow restart.
/// - PAUSER_ROLE (monitoring bots, guardians) can pause the whole contract or a single remote route.
/// - Only DEFAULT_ADMIN_ROLE (intended: multisig behind a timelock) can unpause.
/// Pausing never moves funds; pending messages stay valid and execute after unpause.
abstract contract EmergencyController is AccessControl, Pausable {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    mapping(uint256 => bool) public routePaused; // remote chain id => paused

    error RoutePaused(uint256 remoteChainId);

    event RoutePauseSet(uint256 indexed remoteChainId, bool paused, address indexed by);

    constructor(address admin, address pauser) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function pauseRoute(uint256 remoteChainId) external onlyRole(PAUSER_ROLE) {
        routePaused[remoteChainId] = true;
        emit RoutePauseSet(remoteChainId, true, msg.sender);
    }

    function unpauseRoute(uint256 remoteChainId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        routePaused[remoteChainId] = false;
        emit RoutePauseSet(remoteChainId, false, msg.sender);
    }

    modifier whenRouteActive(uint256 remoteChainId) {
        if (routePaused[remoteChainId]) revert RoutePaused(remoteChainId);
        _;
    }
}
