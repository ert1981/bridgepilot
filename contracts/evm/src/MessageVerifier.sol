// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {BridgeMessage, BridgeTypes, TestnetOnly} from "./BridgeTypes.sol";
import {IMessageVerifier, SecurityLevel} from "./IMessageVerifier.sol";

/// @notice Threshold-signature verifier (M-of-N attesters, strict majority).
/// @dev Trust model: a message is accepted iff `threshold` distinct current attesters signed the
///      EIP-712 Attestation for it. Attesters must only sign after source-chain finality.
///      Collusion of `threshold` attesters can forge messages; see docs/threat-model.md.
///      Signer-set changes are time-delayed so a compromised admin key cannot swap the set instantly,
///      and the set version is signed, so rotating the set invalidates all outstanding signatures.
contract MessageVerifier is IMessageVerifier, AccessControl, EIP712, TestnetOnly {
    bytes32 public constant KIND = keccak256("SIGNER_SET_THRESHOLD_V1");
    uint256 public constant MAX_SIGNERS = 32;
    uint64 public constant MIN_ROTATION_DELAY = 1 days;
    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(BridgeMessage message,uint64 signerSetVersion)BridgeMessage(uint8 version,uint8 kind,uint256 sourceChainId,address sourceContract,uint256 destChainId,address destContract,uint256 nonce,address canonicalToken,address sender,address recipient,uint256 amount)"
    );

    address[] private _signers;
    mapping(address => bool) public isSigner;
    uint8 public threshold;
    uint64 public signerSetVersion;

    uint64 public immutable rotationDelay;
    struct PendingSet {
        address[] signers;
        uint8 threshold;
        uint64 eta;
    }
    PendingSet private _pending;

    error InvalidSignerSet();
    error NotEnoughSignatures(uint256 provided, uint256 required);
    error TooManySignatures(uint256 provided);
    error InvalidSignature(uint256 index);
    error SignersNotSorted(uint256 index);
    error UnknownSigner(address signer);
    error NoPendingSet();
    error RotationNotReady(uint64 eta);

    event SignerSetProposed(address[] signers, uint8 threshold, uint64 eta);
    event SignerSetActivated(uint64 indexed version, address[] signers, uint8 threshold);
    event SignerSetProposalCancelled();

    constructor(address admin, address[] memory signers_, uint8 threshold_, uint64 rotationDelay_)
        EIP712("BridgePilot", "1")
    {
        if (rotationDelay_ < MIN_ROTATION_DELAY) revert InvalidSignerSet();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        rotationDelay = rotationDelay_;
        _activate(signers_, threshold_);
    }

    function signers() external view returns (address[] memory) {
        return _signers;
    }

    function pendingSignerSet() external view returns (address[] memory, uint8, uint64) {
        return (_pending.signers, _pending.threshold, _pending.eta);
    }

    /// @notice Trust-based: forging requires `threshold` colluding or compromised attesters.
    function securityLevel() external pure returns (uint8) {
        return SecurityLevel.SIGNER_SET;
    }

    function verifierKind() external pure returns (bytes32) {
        return KIND;
    }

    function digest(BridgeMessage memory m) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ATTESTATION_TYPEHASH, BridgeTypes.structHash(m), signerSetVersion)));
    }

    /// @notice Reverts unless signatures are from >= threshold distinct current signers,
    ///         ordered by strictly ascending signer address. Any invalid signature reverts.
    function verify(BridgeMessage calldata m, bytes[] calldata sigs) external view {
        uint256 n = sigs.length;
        if (n < threshold) revert NotEnoughSignatures(n, threshold);
        if (n > MAX_SIGNERS) revert TooManySignatures(n);
        bytes32 h = digest(m);
        address last = address(0);
        for (uint256 i = 0; i < n; i++) {
            (address s, ECDSA.RecoverError err,) = ECDSA.tryRecover(h, sigs[i]);
            if (err != ECDSA.RecoverError.NoError) revert InvalidSignature(i);
            if (s <= last) revert SignersNotSorted(i);
            if (!isSigner[s]) revert UnknownSigner(s);
            last = s;
        }
    }

    function proposeSignerSet(address[] calldata signers_, uint8 threshold_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _validate(signers_, threshold_);
        _pending.signers = signers_;
        _pending.threshold = threshold_;
        _pending.eta = uint64(block.timestamp) + rotationDelay;
        emit SignerSetProposed(signers_, threshold_, _pending.eta);
    }

    function cancelSignerSet() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_pending.eta == 0) revert NoPendingSet();
        delete _pending;
        emit SignerSetProposalCancelled();
    }

    /// @notice Anyone may activate a matured proposal.
    function executeSignerSet() external {
        if (_pending.eta == 0) revert NoPendingSet();
        if (block.timestamp < _pending.eta) revert RotationNotReady(_pending.eta);
        address[] memory s = _pending.signers;
        uint8 t = _pending.threshold;
        delete _pending;
        _activate(s, t);
    }

    function _activate(address[] memory signers_, uint8 threshold_) private {
        _validate(signers_, threshold_);
        for (uint256 i = 0; i < _signers.length; i++) isSigner[_signers[i]] = false;
        _signers = signers_;
        for (uint256 i = 0; i < signers_.length; i++) isSigner[signers_[i]] = true;
        threshold = threshold_;
        signerSetVersion += 1;
        emit SignerSetActivated(signerSetVersion, signers_, threshold_);
    }

    /// @dev Requires sorted unique non-zero signers and a strict-majority threshold.
    function _validate(address[] memory s, uint8 t) private pure {
        uint256 n = s.length;
        if (n == 0 || n > MAX_SIGNERS || t == 0 || t > n || uint256(t) * 2 <= n) revert InvalidSignerSet();
        address last = address(0);
        for (uint256 i = 0; i < n; i++) {
            if (s[i] <= last) revert InvalidSignerSet();
            last = s[i];
        }
    }
}
