/** Minimal Prometheus-style metrics registry (counters + summaries). */
type Labels = Record<string, string>;

const labelKey = (l: Labels) =>
  Object.keys(l)
    .sort()
    .map((k) => `${k}="${String(l[k]).replace(/["\\\n]/g, '_')}"`)
    .join(',');

export class Metrics {
  private counters = new Map<string, Map<string, number>>();
  private summaries = new Map<string, Map<string, { count: number; sum: number; max: number }>>();

  inc(name: string, labels: Labels = {}, by = 1): void {
    const m = this.counters.get(name) ?? new Map();
    const k = labelKey(labels);
    m.set(k, (m.get(k) ?? 0) + by);
    this.counters.set(name, m);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const m = this.summaries.get(name) ?? new Map();
    const k = labelKey(labels);
    const s = m.get(k) ?? { count: 0, sum: 0, max: 0 };
    s.count += 1;
    s.sum += value;
    s.max = Math.max(s.max, value);
    m.set(k, s);
    this.summaries.set(name, m);
  }

  counter(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.get(labelKey(labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, m] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const [k, v] of m) lines.push(`${name}${k ? `{${k}}` : ''} ${v}`);
    }
    for (const [name, m] of this.summaries) {
      lines.push(`# TYPE ${name} summary`);
      for (const [k, s] of m) {
        const l = k ? `{${k}}` : '';
        lines.push(`${name}_count${l} ${s.count}`, `${name}_sum${l} ${s.sum}`, `${name}_max${l} ${s.max}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}
