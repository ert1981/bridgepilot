// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Cross-chain message attested by the signer set.
/// @dev Every field is covered by the EIP-712 signature. `kind` binds the message to the
///      direction (lock->mint or burn->release) so one cannot be replayed as the other.
struct BridgeMessage {
    uint8 version;
    uint8 kind; // 0 = LOCK_MINT, 1 = BURN_RELEASE, 2 = REFUND
    uint256 sourceChainId;
    address sourceContract;
    uint256 destChainId;
    address destContract;
    uint256 nonce;
    address canonicalToken; // token address on the home (vault) chain
    address sender;
    address recipient;
    uint256 amount;
}

library BridgeTypes {
    uint8 internal constant VERSION = 1;
    uint8 internal constant KIND_LOCK_MINT = 0;
    uint8 internal constant KIND_BURN_RELEASE = 1;
    uint8 internal constant KIND_REFUND = 2;

    bytes32 internal constant MESSAGE_TYPEHASH = keccak256(
        "BridgeMessage(uint8 version,uint8 kind,uint256 sourceChainId,address sourceContract,uint256 destChainId,address destContract,uint256 nonce,address canonicalToken,address sender,address recipient,uint256 amount)"
    );

    function structHash(BridgeMessage memory m) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                MESSAGE_TYPEHASH,
                m.version,
                m.kind,
                m.sourceChainId,
                m.sourceContract,
                m.destChainId,
                m.destContract,
                m.nonce,
                m.canonicalToken,
                m.sender,
                m.recipient,
                m.amount
            )
        );
    }

    /// @notice Globally unique message id (independent of the verifying contract).
    function messageId(BridgeMessage memory m) internal pure returns (bytes32) {
        return keccak256(abi.encode(m));
    }

    /// @notice The refund message for a cancelled transfer: it travels back from the original
    ///         destination to the original source and pays the original SENDER. It is derived
    ///         deterministically, so one original has exactly one possible refund (1:1).
    function refundOf(BridgeMessage memory o) internal pure returns (BridgeMessage memory r) {
        r = BridgeMessage({
            version: o.version,
            kind: KIND_REFUND,
            sourceChainId: o.destChainId,
            sourceContract: o.destContract,
            destChainId: o.sourceChainId,
            destContract: o.sourceContract,
            nonce: o.nonce,
            canonicalToken: o.canonicalToken,
            sender: o.sender,
            recipient: o.sender,
            amount: o.amount
        });
    }
}

/// @dev ALLOWLIST of test networks. Any chain not explicitly listed (every mainnet, present or
///      future) is refused. This guards against mistaken deployment only; it is not a substitute
///      for access control or an audit. Remove only after an independent security review.
abstract contract TestnetOnly {
    error NotAnAllowedTestnet(uint256 chainId);

    constructor() {
        if (!isAllowedTestnet(block.chainid)) revert NotAnAllowedTestnet(block.chainid);
    }

    function isAllowedTestnet(uint256 id) public pure returns (bool) {
        return id == 11155111 // Sepolia
            || id == 17000 // Holesky
            || id == 560048 // Hoodi
            || id == 84532 // Base Sepolia
            || id == 421614 // Arbitrum Sepolia
            || id == 11155420 // OP Sepolia
            || id == 80002 // Polygon Amoy
            || (id >= 31337 && id <= 31339); // local anvil / hardhat
    }
}
