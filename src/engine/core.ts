import type { Design, Dist, Percentiles } from './types';

export const ENGINE_VERSION = '1.0.0';
export const REPLAY_COMPAT_ID = 'exact-p1-2026-10-24.1';
export const duration = (x: number) => Math.max(1, Math.ceil(x));

export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** xoshiro128**, with independently seeded component streams. */
export class Random {
  private s: number[];
  constructor(seed: number, componentId: string) {
    let x = hash32(`${seed}:${componentId}`);
    this.s = Array.from({ length: 4 }, () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
      return (z ^ (z >>> 15)) >>> 0;
    });
    if (!this.s.some(v => v !== 0)) this.s[0] = 1;
  }
  next(): number {
    const s = this.s;
    const x = Math.imul(s[1], 5);
    const result = Math.imul((x << 7) | (x >>> 25), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t;
    s[3] = (s[3] << 11) | (s[3] >>> 21);
    return (result + 0.5) / 4294967296;
  }
  sample(d: Dist): number {
    let x: number;
    switch (d.kind) {
      case 'constant': x = d.us; break;
      case 'exponential': x = -Math.log(this.next()) * d.meanUs; break;
      case 'lognormal': x = d.medianUs * Math.exp(d.sigma * Math.sqrt(-2 * Math.log(this.next())) * Math.cos(2 * Math.PI * this.next())); break;
      case 'empirical': {
        let w = this.next() * d.buckets.reduce((a, b) => a + b.weight, 0);
        x = d.buckets[d.buckets.length - 1].us;
        for (const b of d.buckets) { w -= b.weight; if (w <= 0) { x = b.us; break; } }
      }
    }
    return duration(x);
  }
}

export type Event = { time: number; priority: number; seq: number; run: () => void };
export const PRIORITY = { chaos: 0, edit: 1, completion: 2, response: 3, timeout: 4, retry: 5, arrival: 6 } as const;
const before = (a: Event, b: Event) => a.time < b.time || (a.time === b.time && (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)));
export class EventHeap {
  private items: Event[] = [];
  get size() { return this.items.length; }
  peek() { return this.items[0]; }
  push(e: Event) {
    const a = this.items;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >>> 1;
      if (!before(e, a[p])) break;
      a[i] = a[p]; i = p;
    }
    a[i] = e;
  }
  pop(): Event | undefined {
    const a = this.items, first = a[0], last = a.pop();
    if (a.length && last) {
      let i = 0;
      while (2 * i + 1 < a.length) {
        let c = 2 * i + 1;
        if (c + 1 < a.length && before(a[c + 1], a[c])) c++;
        if (!before(a[c], last)) break;
        a[i] = a[c]; i = c;
      }
      a[i] = last;
    }
    return first;
  }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function designHash(design: Design): string {
  const { nodes, edges, endpoints, schemaVersion } = design;
  const value = canonical({ schemaVersion,
    nodes: nodes.map(n => ({ id: n.id, kind: n.kind, params: n.params, handlers: n.handlers })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges].sort((a, b) => a.id.localeCompare(b.id)),
    endpoints: [...endpoints].sort((a, b) => a.id.localeCompare(b.id)),
  });
  // Two independent 32-bit hashes keep this synchronous in Node and workers.
  return hash32(value).toString(16).padStart(8, '0') + hash32(`design:${value}`).toString(16).padStart(8, '0');
}

/** Geometric buckets have <0.5% upper-bound error, including integer rounding. */
export class Histogram {
  private buckets = new Map<number, number>();
  count = 0;
  sum = 0;
  add(us: number) {
    const key = us <= 1000 ? Math.ceil(us) : 1000 + Math.ceil(Math.log(us / 1000) / Math.log(1.005));
    this.buckets.set(key, (this.buckets.get(key) ?? 0) + 1);
    this.count++; this.sum += us;
  }
  merge(other: Histogram) {
    for (const [key, count] of other.buckets) this.buckets.set(key, (this.buckets.get(key) ?? 0) + count);
    this.count += other.count; this.sum += other.sum;
  }
  percentile(p: number): number | null {
    if (!this.count) return null;
    let n = Math.ceil(this.count * p);
    for (const [key, count] of [...this.buckets].sort((a, b) => a[0] - b[0])) {
      n -= count;
      if (n <= 0) return key <= 1000 ? key : 1000 * 1.005 ** (key - 1000);
    }
    return null;
  }
  percentiles(): Percentiles {
    return { p50: this.percentile(.5), p90: this.percentile(.9), p99: this.count >= 1000 ? this.percentile(.99) : null, p999: this.count >= 10000 ? this.percentile(.999) : null };
  }
}
