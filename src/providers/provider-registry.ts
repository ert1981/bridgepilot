import type { AppConfig } from '../config/env.js';
import { AcrossAdapter } from './across-adapter.js';
import { LifiAdapter } from './lifi-adapter.js';
import type { RouteProvider } from './provider-interface.js';
import { SimulatedAdapter } from './simulated-adapter.js';

export class ProviderRegistry {
  private readonly byId = new Map<string, RouteProvider>();

  constructor(providers: RouteProvider[]) {
    for (const p of providers) {
      if (this.byId.has(p.id)) throw new Error(`duplicate provider id ${p.id}`);
      this.byId.set(p.id, p);
    }
  }

  get(id: string): RouteProvider | undefined {
    return this.byId.get(id);
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  all(): RouteProvider[] {
    return [...this.byId.values()];
  }
}

export function defaultRegistry(config: AppConfig): ProviderRegistry {
  if (config.providerMode === 'simulated') {
    return new ProviderRegistry([
      // provider_a: cheaper relay fee, slightly higher gas; provider_b: faster.
      new SimulatedAdapter('sim_alpha', 28n, 0n, 100_000n, 120),
      new SimulatedAdapter('sim_beta', 20n, 0n, 200_000n, 60),
    ]);
  }
  const all: RouteProvider[] = [new LifiAdapter(), new AcrossAdapter()];
  return new ProviderRegistry(all.filter((p) => config.enabledProviders.includes(p.id)));
}

