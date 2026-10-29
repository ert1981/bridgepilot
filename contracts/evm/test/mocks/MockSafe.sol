// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice TEST-ONLY stand-in exposing the read interface of a Safe proxy (singleton in slot 0,
///         getOwners, getThreshold, getModulesPaginated). It is NOT a multisig: it lets the
///         deployment verifier's checks run on a local chain. Real deployments use a real Safe.
contract MockSafe {
    address internal singleton; // slot 0, as in SafeProxy
    address[] internal owners;
    uint256 internal threshold;
    address[] internal modules;

    constructor(address singleton_, address[] memory owners_, uint256 threshold_) {
        singleton = singleton_;
        owners = owners_;
        threshold = threshold_;
    }

    function getOwners() external view returns (address[] memory) {
        return owners;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getModulesPaginated(address, uint256) external view returns (address[] memory array, address next) {
        return (modules, address(0x1));
    }

    function enableModuleForTest(address m) external {
        modules.push(m);
    }
}
