/** Token-bucket rate limiter keyed by caller identity. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly capacity: number, private readonly refillPerSec: number, private readonly now: () => number) {}

  take(key: string, cost = 1): { allowed: boolean; retryAfterSec: number; remaining: number } {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    const elapsed = Math.max(0, t - b.at) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.at = t;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      this.buckets.set(key, b);
      return { allowed: true, retryAfterSec: 0, remaining: Math.floor(b.tokens) };
    }
    this.buckets.set(key, b);
    const need = cost - b.tokens;
    return { allowed: false, retryAfterSec: this.refillPerSec > 0 ? Math.ceil(need / this.refillPerSec) : 3600, remaining: 0 };
  }

  prune(maxIdleMs = 3_600_000): void {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.at > maxIdleMs) this.buckets.delete(k);
  }
}
