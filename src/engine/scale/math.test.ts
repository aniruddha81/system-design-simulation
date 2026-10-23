import { expect, it } from 'vitest';
import type { NodeSpec, Scenario } from '../types';
import { FluidCache } from './cache';
import { distribution, mean, moments, percentile, queueStep } from './math';

const cache: NodeSpec<'cache'> = {
  id: 'cache', kind: 'cache', label: 'Cache', position: { x: 0, y: 0 }, params: {
    concurrency: 10, queueCapacity: 100, costPerHour: 1, queueDiscipline: 'fifo', region: 'a', zone: 'a',
    capacityBytes: 100, coalesce: false, eviction: 'lru', ttlUs: 1_000_000, serviceTime: { kind: 'constant', us: 1 },
  },
};
const scenario: Scenario = {
  id: 'ttl', version: 1, warmupUs: 0, measureUs: 1_000_000, drainUs: 0, chaos: [],
  workload: { arrival: { kind: 'poisson', rps: 10 }, keys: { kind: 'zipf', n: 1, s: 1 }, deadlineUs: 100_000, mix: { get: 1 } },
};

it('TTL-Che reduces to the non-refreshing renewal TTL probability when capacity fits every key', () => {
  const c = new FluidCache(cache, scenario, 1);
  c.rates(10, 100_000);
  expect(c.steadyHitRate).toBeCloseTo(10 / 11, 5);
  expect(c.occupancy).toBe(0);
  c.schedule(0, .01, 10, 10, 50_000);
  c.advance(40_000, .04); expect(c.occupancy).toBe(0);
  c.advance(60_000, .02); expect(c.occupancy).toBeGreaterThan(0);
  const old = c.occupancy;
  c.advance(2_000_000, 2); expect(c.occupancy).toBeLessThan(old);
  c.reset(2_000_000); expect(c.occupancy).toBe(0);
});

it('Che LRU bounds occupancy and uses bounded memory for planet-size keyspaces', () => {
  const spec = structuredClone(cache); spec.params.ttlUs = undefined; spec.params.capacityBytes = 30;
  const s = structuredClone(scenario); s.workload.keys = { kind: 'zipf', n: 1_000_000_000, s: 1.2 };
  const c = new FluidCache(spec, s, 1);
  c.rates(1_000_000, 100_000);
  expect(c.steadyHitRate).toBeGreaterThan(0); expect(c.steadyHitRate).toBeLessThan(1);
  for (let i = 0; i < 10; i++) { c.schedule(i * 10_000, .01, 1_000_000, 1_000_000, 1000); c.advance((i + 1) * 10_000, .01); }
  expect(c.occupancy).toBeLessThanOrEqual(30.000001);
});

it('keeps the distribution quadrature within 2% of exponential and lognormal means', () => {
  for (const d of [{ kind: 'exponential' as const, meanUs: 1000 }, { kind: 'lognormal' as const, medianUs: 1000, sigma: .5 }]) {
    expect(Math.abs(mean(distribution(d)) / moments(d).mean - 1)).toBeLessThan(.02);
  }
  expect(percentile(distribution({ kind: 'lognormal', medianUs: 1000, sigma: .5 }), .5)).toBeCloseTo(1000, -2);
});

it('conserves counts through overload, recovery, and zero capacity', () => {
  let backlog = 0;
  for (let i = 0; i < 100; i++) {
    const rate = i < 40 ? 1500 : 500, workers = i > 50 && i < 60 ? 0 : 1;
    const q = queueStep(rate, 1000, 1, 1, workers, 10, backlog, .01);
    expect(q.backlog).toBeCloseTo(backlog + q.arrivals - q.completions - q.drops, 10);
    expect(Number.isFinite(mean(q.wait))).toBe(true);
    backlog = q.backlog;
  }
  expect(backlog).toBe(0);
});
