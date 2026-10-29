// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BridgeMessage} from "./BridgeTypes.sol";

/// @notice Verification-method-independent interface used by BridgeVault and BridgeExecutor.
/// @dev The bridge contracts never know HOW a message is verified: a threshold signer set today,
///      a light client or a ZK proof per chain family later. `proof` is opaque to them.
///
///      Security levels (what it takes to forge a message):
///        1 SIGNER_SET            — collusion/compromise of `threshold` attesters (trust-based)
///        2 OPTIMISTIC            — reserved: signers + a challenge window in which anyone can
///                                  prove fraud (one honest watcher suffices)
///        3 CRYPTOGRAPHIC         — breaking the proof system / source-chain consensus only
///      Combining verifiers with AND (CompositeVerifier) never weakens: forging then requires
///      breaking EVERY part, so its level is the maximum of its parts.
///      A verifier MUST return a constant level. The level is a DECLARATION by the verifier's
///      author: it is enforced as a one-way ratchet by VerifierRouter, but only an independent
///      audit of the verifier's code (whose code hash the readiness gate pins) makes it true.
interface IMessageVerifier {
    /// @notice Reverts unless `proof` proves `m` under this verifier's rules.
    function verify(BridgeMessage calldata m, bytes[] calldata proof) external view;

    /// @notice Constant security level (see above).
    function securityLevel() external view returns (uint8);

    /// @notice Constant identifier of the verification method, e.g. keccak256("SIGNER_SET_THRESHOLD_V1").
    function verifierKind() external view returns (bytes32);
}

library SecurityLevel {
    uint8 internal constant SIGNER_SET = 1;
    uint8 internal constant OPTIMISTIC = 2;
    uint8 internal constant CRYPTOGRAPHIC = 3;
}
