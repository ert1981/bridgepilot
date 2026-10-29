// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Transparent protocol fee with an immutable hard cap.
abstract contract FeeController {
    uint16 public constant MAX_FEE_BPS = 100; // 1% hard cap, cannot be raised
    uint16 public feeBps;
    address public feeRecipient;

    error FeeTooHigh(uint256 bps);
    error ZeroAddress();

    event FeeSet(uint16 bps, address recipient);

    function _setFee(uint16 bps, address recipient) internal {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh(bps);
        if (recipient == address(0)) revert ZeroAddress();
        feeBps = bps;
        feeRecipient = recipient;
        emit FeeSet(bps, recipient);
    }

    /// @return fee charged and net amount bridged. Rounds the fee down (in the user's favour).
    function quoteFee(uint256 amount) public view returns (uint256 fee, uint256 net) {
        fee = (amount * feeBps) / 10_000;
        net = amount - fee;
    }
}
