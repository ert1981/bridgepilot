// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Each message id can be executed exactly once, valid or not.
abstract contract ReplayProtection {
    mapping(bytes32 => bool) public processed;

    error MessageAlreadyProcessed(bytes32 messageId);

    event MessageProcessed(bytes32 indexed messageId);

    /// @dev Must be called BEFORE any external interaction (checks-effects-interactions).
    function _markProcessed(bytes32 messageId) internal {
        if (processed[messageId]) revert MessageAlreadyProcessed(messageId);
        processed[messageId] = true;
        emit MessageProcessed(messageId);
    }
}
