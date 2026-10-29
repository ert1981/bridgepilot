// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BridgeMessage, BridgeTypes} from "../../src/BridgeTypes.sol";
import {IMessageVerifier} from "../../src/IMessageVerifier.sol";

/// @notice TEST-ONLY stand-in for a future cryptographic verifier (light client / ZK). It accepts
///         proof[0] == abi.encode(messageId). It proves nothing; it only exercises the upgrade path.
contract MockProofVerifier is IMessageVerifier {
    error BadProof();

    function verify(BridgeMessage calldata m, bytes[] calldata proof) external pure {
        if (proof.length != 1 || keccak256(proof[0]) != keccak256(abi.encode(BridgeTypes.messageId(m)))) revert BadProof();
    }

    function securityLevel() external pure returns (uint8) {
        return 3;
    }

    function verifierKind() external pure returns (bytes32) {
        return keccak256("MOCK_PROOF_V0");
    }
}

/// @notice TEST-ONLY verifier whose declared level can be changed (models a lying/upgradeable verifier).
contract MutableLevelVerifier is IMessageVerifier {
    uint8 public level;

    constructor(uint8 l) {
        level = l;
    }

    function setLevel(uint8 l) external {
        level = l;
    }

    function verify(BridgeMessage calldata, bytes[] calldata) external pure {}

    function securityLevel() external view returns (uint8) {
        return level;
    }

    function verifierKind() external pure returns (bytes32) {
        return keccak256("MUTABLE_TEST");
    }
}
