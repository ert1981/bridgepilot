// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BridgeMessage} from "./BridgeTypes.sol";
import {IMessageVerifier} from "./IMessageVerifier.sol";

/// @notice AND-combination of verifiers: a message is accepted only if EVERY part accepts it.
/// @dev The migration step from signer sets to proofs: AND(signer set, proof verifier) keeps the
///      signers as a second line of defence while the proof system matures. Forging requires breaking
///      every part, so the combined level is the maximum of the parts (never lower than any part).
///      Proof layout: proof.length == parts.length; proof[i] = abi.encode(bytes[] proofForPart_i).
///      Parts are immutable.
contract CompositeVerifier is IMessageVerifier {
    bytes32 public constant KIND = keccak256("COMPOSITE_ALL_OF_V1");
    IMessageVerifier[] private _parts;
    uint8 private immutable _level;

    error InvalidParts();
    error ProofLengthMismatch(uint256 provided, uint256 parts);

    constructor(IMessageVerifier[] memory parts_) {
        if (parts_.length < 2 || parts_.length > 4) revert InvalidParts();
        uint8 maxLevel;
        for (uint256 i = 0; i < parts_.length; i++) {
            if (address(parts_[i]).code.length == 0) revert InvalidParts();
            for (uint256 j = 0; j < i; j++) if (parts_[j] == parts_[i]) revert InvalidParts();
            uint8 l = parts_[i].securityLevel();
            if (l == 0 || l > 3) revert InvalidParts();
            if (l > maxLevel) maxLevel = l;
            _parts.push(parts_[i]);
        }
        _level = maxLevel;
    }

    function parts() external view returns (IMessageVerifier[] memory) {
        return _parts;
    }

    function verify(BridgeMessage calldata m, bytes[] calldata proof) external view {
        uint256 n = _parts.length;
        if (proof.length != n) revert ProofLengthMismatch(proof.length, n);
        for (uint256 i = 0; i < n; i++) {
            _parts[i].verify(m, abi.decode(proof[i], (bytes[])));
        }
    }

    function securityLevel() external view returns (uint8) {
        return _level;
    }

    function verifierKind() external pure returns (bytes32) {
        return KIND;
    }
}
