// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Per-token token-bucket limits on value leaving the bridge.
/// @dev Two independent buckets per token:
///      - `buckets`:       normal transfers (mint / release).
///      - `refundBuckets`: recovery (refunds of cancelled transfers).
///      Refunds are still bounded — a compromised signer set cannot drain through forged refunds
///      faster than the recovery limit — but normal traffic can never starve them: a full transfer
///      bucket does not block a refund. Both fail closed when not configured.
///      capacity = max amount per window; refills linearly over `window` seconds.
abstract contract RateLimiter {
    struct Bucket {
        uint128 capacity;
        uint128 available;
        uint64 window;
        uint64 updatedAt;
    }

    mapping(address => Bucket) public buckets;
    mapping(address => Bucket) public refundBuckets;

    error RateLimitExceeded(address token, uint256 requested, uint256 available);
    error RateLimitNotConfigured(address token);
    error RefundLimitExceeded(address token, uint256 requested, uint256 available);
    error RefundLimitNotConfigured(address token);
    error InvalidRateLimit();

    event RateLimitSet(address indexed token, uint256 capacity, uint256 window);
    event RefundLimitSet(address indexed token, uint256 capacity, uint256 window);

    function _setRateLimit(address token, uint128 capacity, uint64 window) internal {
        _configure(buckets[token], capacity, window);
        emit RateLimitSet(token, capacity, window);
    }

    function _setRefundLimit(address token, uint128 capacity, uint64 window) internal {
        _configure(refundBuckets[token], capacity, window);
        emit RefundLimitSet(token, capacity, window);
    }

    function availableToTransfer(address token) public view returns (uint256) {
        return _available(buckets[token]);
    }

    function availableToRefund(address token) public view returns (uint256) {
        return _available(refundBuckets[token]);
    }

    function _consumeRateLimit(address token, uint256 amount) internal {
        Bucket storage b = buckets[token];
        if (b.capacity == 0) revert RateLimitNotConfigured(token);
        uint256 avail = _currentAvailable(b);
        if (amount > avail) revert RateLimitExceeded(token, amount, avail);
        _spend(b, avail, amount);
    }

    function _consumeRefundLimit(address token, uint256 amount) internal {
        Bucket storage b = refundBuckets[token];
        if (b.capacity == 0) revert RefundLimitNotConfigured(token);
        uint256 avail = _currentAvailable(b);
        if (amount > avail) revert RefundLimitExceeded(token, amount, avail);
        _spend(b, avail, amount);
    }

    function _configure(Bucket storage b, uint128 capacity, uint64 window) private {
        if (capacity == 0 || window == 0) revert InvalidRateLimit();
        uint256 current = b.capacity == 0 ? capacity : _currentAvailable(b);
        b.capacity = capacity;
        b.window = window;
        // forge-lint: disable-next-line(unsafe-typecast)
        b.available = uint128(current > capacity ? capacity : current); // <= capacity (uint128)
        b.updatedAt = uint64(block.timestamp);
    }

    function _available(Bucket storage b) private view returns (uint256) {
        return b.capacity == 0 ? 0 : _currentAvailable(b);
    }

    function _currentAvailable(Bucket storage b) private view returns (uint256) {
        uint256 elapsed = block.timestamp - b.updatedAt;
        uint256 refill = (uint256(b.capacity) * elapsed) / b.window;
        uint256 avail = uint256(b.available) + refill;
        return avail > b.capacity ? b.capacity : avail;
    }

    function _spend(Bucket storage b, uint256 avail, uint256 amount) private {
        // forge-lint: disable-next-line(unsafe-typecast)
        b.available = uint128(avail - amount); // avail <= capacity (uint128)
        b.updatedAt = uint64(block.timestamp);
    }
}
