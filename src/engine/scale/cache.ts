import type { NodeSpec, Scenario } from '../types';

type Group = { count: number; p: number; present: number; pending: number; target: number };
type Fill = { atUs: number; success: number; distinct: number[] };

export class FluidCache {
  private groups: Group[] = [];
  private fills: Fill[] = [];
  private lastRate = -1;
  private restartUs = 0;
  timeTo90Us: number | null = null;
  originUs = 0;
  originSuccess = 0;
  lookupRate = 0;
  originPerSec = 0;
  readonly capacity: number;

  constructor(readonly spec: NodeSpec<'cache'>, scenario: Scenario, objectBytes: number) {
    const keys = scenario.workload.keys;
    this.capacity = Math.min(keys.n, Math.floor(spec.params.capacityBytes / Math.max(1, objectBytes)));
    // Log-rank quadrature bounds memory for billion-key populations; small benchmarks retain each key.
    let rank = 1;
    while (rank <= keys.n) {
      const end = keys.n <= 4096 ? rank : Math.min(keys.n, Math.max(rank, Math.floor(rank * 1.02)));
      const middle = (rank + end) / 2, count = end - rank + 1;
      this.groups.push({ count, p: keys.kind === 'zipf' ? middle ** -keys.s : 1, present: 0, pending: 0, target: 0 });
      rank = end + 1;
    }
    const norm = this.groups.reduce((a, g) => a + g.p * g.count, 0);
    for (const g of this.groups) g.p /= norm;
  }

  reset(atUs: number) {
    for (const g of this.groups) { g.present = 0; g.pending = 0; }
    this.fills = []; this.restartUs = atUs; this.timeTo90Us = null;
    this.originSuccess = 0; this.originPerSec = 0;
  }

  private che(rate: number) {
    if (rate <= 0 || rate === this.lastRate) return;
    this.lastRate = rate;
    const ttl = this.spec.params.ttlUs === undefined ? null : this.spec.params.ttlUs / 1e6;
    const occupancy = (t: number, set = false) => this.groups.reduce((sum, g) => {
      const lambda = rate * g.p;
      const lru = -Math.expm1(-lambda * t);
      // Exact TTL is set-on-fill, not refreshed on reads (renewal reward TTL-Che).
      const h = ttl === null ? lru : Math.min(lru, lambda * ttl / (1 + lambda * ttl));
      if (set) g.target = h;
      return sum + h * g.count;
    }, 0);
    let hi = 1;
    while (occupancy(hi) < this.capacity && hi < 1e15) hi *= 2;
    let lo = 0;
    for (let i = 0; i < 70; i++) { const mid = (lo + hi) / 2; if (occupancy(mid) > this.capacity) hi = mid; else lo = mid; }
    occupancy(this.capacity > 0 ? (lo + hi) / 2 : 0, true);
  }

  rates(rate: number, cacheTimeoutUs: number, dt = .01) {
    this.lookupRate = rate; this.che(rate);
    let resident = 0, coalesced = 0, origins = 0;
    for (const g of this.groups) {
      const lambda = rate * g.p;
      const distinctPerSec = Math.max(0, 1 - g.present - g.pending) * -Math.expm1(-lambda * dt) / dt;
      const waiters = Math.max(0, lambda * (1 - g.present) - distinctPerSec);
      const coalescing = this.spec.params.coalesce && this.originUs <= cacheTimeoutUs;
      const suppressed = coalescing ? waiters * this.originSuccess : 0;
      resident += g.p * g.count * g.present;
      coalesced += rate > 0 ? suppressed * g.count / rate : 0;
      origins += (lambda * (1 - g.present) - suppressed) * g.count;
    }
    this.originPerSec = origins;
    return { hit: Math.min(1, resident + coalesced), resident, coalesced, origins };
  }

  schedule(atUs: number, dt: number, fillRate: number, lookupRate: number, originUs: number) {
    this.originUs = originUs;
    this.learn(fillRate, originUs);
    if (fillRate <= 0 || lookupRate <= 0) return;
    const distinct = this.groups.map(g => {
      const p = Math.max(0, 1 - g.present - g.pending) * -Math.expm1(-lookupRate * g.p * dt);
      g.pending += p; return p;
    });
    // Origin and cacheSet must have completed before their distinct objects can contribute.
    this.fills.push({ atUs: atUs + originUs, success: this.originSuccess, distinct });
  }

  learn(fillRate: number, originUs: number) {
    if (this.originPerSec > 1e-8) this.originSuccess = Math.min(1, fillRate / this.originPerSec);
    if (originUs > 0) this.originUs = originUs;
  }

  advance(atUs: number, dt: number) {
    const ready = this.fills.filter(f => f.atUs <= atUs);
    this.fills = this.fills.filter(f => f.atUs > atUs);
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i];
      for (const f of ready) {
        g.pending = Math.max(0, g.pending - f.distinct[i]);
        g.present = Math.min(1, g.present + f.distinct[i] * f.success);
      }
      const lambda = Math.max(0, this.lastRate) * g.p;
      const expiry = g.target > 0 ? lambda * (1 - g.target) / g.target : 0;
      if (g.target === 0) g.present = 0;
      else if (expiry > 0) g.present *= Math.exp(-expiry * dt);
    }
    const occupancy = this.occupancy;
    if (occupancy > this.capacity) for (const g of this.groups) g.present *= this.capacity / occupancy;
    if (this.timeTo90Us === null && this.steadyHitRate > 0 && this.hitRate >= this.steadyHitRate * .9) this.timeTo90Us = atUs - this.restartUs;
  }

  get occupancy() { return this.groups.reduce((a, g) => a + g.count * g.present, 0); }
  get hitRate() { return this.groups.reduce((a, g) => a + g.count * g.p * g.present, 0); }
  get steadyHitRate() { return this.groups.reduce((a, g) => a + g.count * g.p * g.target, 0); }

  change(dt: number, fillRate: number, lookupRate: number) {
    const success = this.originPerSec > 0 ? Math.min(1, fillRate / this.originPerSec) : 0;
    const added = this.groups.reduce((sum, g) => sum + g.count * (1 - g.present) * -Math.expm1(-lookupRate * g.p * success * dt), 0);
    return added / Math.max(1, this.occupancy);
  }
}
