/**
 * Per-provider circuit breaker. After `threshold` consecutive failures the provider is skipped for
 * `cooldownMs`; then ONE trial request is let through (half-open). A success closes the circuit.
 * This keeps a failing provider from burning every request's time budget.
 */
export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  private s = new Map<string, { fails: number; openedAt?: number; trial?: boolean }>();

  constructor(private readonly threshold: number, private readonly cooldownMs: number, private readonly now: () => number) {}

  state(id: string): CircuitState {
    const e = this.s.get(id);
    if (!e?.openedAt) return 'closed';
    return this.now() - e.openedAt >= this.cooldownMs ? 'half_open' : 'open';
  }

  /** Returns false when the call must be skipped. Grants one trial while half-open. */
  allow(id: string): boolean {
    const st = this.state(id);
    if (st === 'closed') return true;
    if (st === 'open') return false;
    const e = this.s.get(id)!;
    if (e.trial) return false;
    e.trial = true;
    return true;
  }

  success(id: string): void {
    this.s.set(id, { fails: 0 });
  }

  failure(id: string): void {
    const e = this.s.get(id) ?? { fails: 0 };
    e.fails += 1;
    e.trial = false;
    if (e.fails >= this.threshold || e.openedAt) e.openedAt = this.now();
    this.s.set(id, e);
  }

  snapshot(): Record<string, { state: CircuitState; consecutive_failures: number }> {
    const out: Record<string, { state: CircuitState; consecutive_failures: number }> = {};
    for (const [id, e] of this.s) out[id] = { state: this.state(id), consecutive_failures: e.fails };
    return out;
  }
}
