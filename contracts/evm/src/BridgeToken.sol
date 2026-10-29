// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Wrapped representation of a canonical token locked in BridgeVault on the home chain.
/// @dev Only the deploying BridgeExecutor can mint or burn; this authority is immutable.
contract BridgeToken is ERC20 {
    address public immutable bridge;
    address public immutable canonicalToken;
    uint256 public immutable homeChainId;
    uint8 private immutable _decimals;

    error OnlyBridge();

    constructor(string memory name_, string memory symbol_, uint8 decimals_, address canonical_, uint256 homeChainId_)
        ERC20(name_, symbol_)
    {
        bridge = msg.sender;
        canonicalToken = canonical_;
        homeChainId = homeChainId_;
        _decimals = decimals_;
    }

    modifier onlyBridge() {
        if (msg.sender != bridge) revert OnlyBridge();
        _;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyBridge {
        _mint(to, amount);
    }

    /// @dev Burns tokens owned by `from`. The executor only calls this with from == msg.sender of
    ///      its own burn() entrypoint, so no allowance is involved.
    function burn(address from, uint256 amount) external onlyBridge {
        _burn(from, amount);
    }
}
