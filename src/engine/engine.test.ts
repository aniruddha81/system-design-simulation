import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createSimulation, designHash, gradeChallenge, runToCompletion, traceRequest, validateDesign } from './index';
import { duration, EventHeap, hash32, Histogram, PRIORITY, Random, REPLAY_COMPAT_ID } from './core';
import { cacheAsideDesign, cachingChallenge, cachingScenario, noCacheDesign } from './fixtures';
import type { Design, NodeSpec, QueueParams, Scenario, Step } from './types';

const q = (concurrency = 1, queueCapacity = 100_000): QueueParams => ({ concurrency, queueCapacity, queueDiscipline: 'fifo', costPerHour: 0, region: 'test', zone: 'a' });
const node = (concurrency = 1): NodeSpec<'service'> => ({ id: 'server', kind: 'service', label: '', position: { x: 0, y: 0 }, params: { ...q(concurrency), serviceTime: { kind: 'exponential', meanUs: 1000 } } });
function simple(concurrency = 1): Design {
  return { schemaVersion: 1, id: 'test', name: '', nodes: [
    { id: 'client', kind: 'client', label: '', position: { x: 0, y: 0 }, params: { entry: 'server' } }, node(concurrency),
  ], edges: [{ id: 'link', from: 'client', to: 'server', latency: { kind: 'constant', us: 1 }, bandwidthBytesPerSec: 1e12, lossRate: 0 }], endpoints: [{ id: 'get', name: '', op: 'read', keyTemplate: 'user:{id}', requestBytes: 0, responseBytes: 0, idempotent: true }] };
}
function scenario(rps = 600): Scenario {
  return { id: 'test', version: 1, warmupUs: 10e6, measureUs: 60e6, drainUs: 1e6, chaos: [], workload: { arrival: { kind: 'poisson', rps }, keys: { kind: 'uniform', n: 100 }, mix: { get: 1 }, deadlineUs: 1e6 } };
}
function single(): Scenario {
  return { ...scenario(), warmupUs: 0, measureUs: 1_000_001, drainUs: 100_000, workload: { ...scenario().workload, arrival: { kind: 'constant', rps: 1 }, deadlineUs: 100_000 } };
}
const settings = { traceSampleRate: 0 };
const server = (d: Design) => d.nodes.find((n): n is NodeSpec<'service'> => n.kind === 'service')!;
const stats = (r: ReturnType<typeof runToCompletion>) => r.nodes.find(n => n.nodeId === 'server')!;

describe('deterministic core', () => {
  it('orders heap events by time, precedence, then sequence', () => {
    const h = new EventHeap();
    for (const priority of [6, 4, 2, 3, 5, 0, 1]) h.push({ time: 10, priority, seq: 1, run() {} });
    h.push({ time: 9, priority: 6, seq: 9, run() {} });
    h.push({ time: 10, priority: 2, seq: 0, run() {} });
    expect(h.pop()!.time).toBe(9);
    const order = []; while (h.size) { const e = h.pop()!; order.push([e.priority, e.seq]); }
    expect(order).toEqual([[0, 1], [1, 1], [2, 0], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1]]);
    expect(PRIORITY.completion).toBeLessThan(PRIORITY.timeout);
    expect(duration(0)).toBe(1); expect(duration(1.1)).toBe(2);
  });
  it('has stable independent PRNG substreams and canonical design hashes', () => {
    const a = new Random(1, 'a'), b = new Random(1, 'a'), c = new Random(1, 'b');
    expect(Array.from({ length: 10 }, () => a.next())).toEqual(Array.from({ length: 10 }, () => b.next()));
    expect(a.next()).not.toBe(c.next());
    const d = simple(), moved = structuredClone(d);
    moved.name = 'renamed'; moved.nodes[0].position.x = 123; moved.nodes[0].label = 'Client'; moved.nodes.reverse();
    expect(designHash(d)).toBe(designHash(moved));
    moved.edges[0].lossRate = .1; expect(designHash(d)).not.toBe(designHash(moved));
  });
  it('keeps histogram error below 1% and enforces sample thresholds', () => {
    const h = new Histogram();
    expect(h.percentiles().p50).toBeNull();
    for (let i = 1; i <= 999; i++) h.add(i * 100);
    expect(h.percentiles().p99).toBeNull();
    h.add(100000); expect(h.percentiles().p99! / 99000).toBeGreaterThanOrEqual(1); expect(h.percentiles().p99! / 99000).toBeLessThan(1.01);
    expect(h.percentiles().p999).toBeNull();
    for (let i = 1001; i <= 10000; i++) h.add(i * 100);
    expect(h.percentiles().p999).not.toBeNull();
  });
  it('produces identical JSON across reruns, insertion orders, slices and snapshots', () => {
    const d = structuredClone(cacheAsideDesign), s = { ...cachingScenario, warmupUs: 100000, measureUs: 1e6, drainUs: 500000, chaos: [] };
    const a = runToCompletion(d, s, 42, settings);
    expect(JSON.stringify(a)).toBe(JSON.stringify(runToCompletion(d, s, 42, settings)));
    d.nodes.reverse(); d.edges.reverse(); d.endpoints.reverse();
    expect(JSON.stringify(a)).toBe(JSON.stringify(runToCompletion(d, s, 42, settings)));
    const sim = createSimulation(d, s, 42, settings);
    while (sim.advance({ maxEvents: 113 }) !== 'done') sim.snapshot();
    expect(JSON.stringify(sim.result())).toBe(JSON.stringify(a));
  });
  it('pins a golden result to the replay compatibility id', () => {
    const result = runToCompletion(simple(), single(), 17, settings);
    expect({ replayCompatId: REPLAY_COMPAT_ID, resultHash: hash32(JSON.stringify(result)) }).toMatchInlineSnapshot(`
      {
        "replayCompatId": "exact-p1-2026-10-24.1",
        "resultHash": 220393151,
      }
    `);
  });
});

describe('queueing against analytical models', () => {
  it.each([1, 3])('M/M/%i mean queue wait matches Erlang C over several seeds', concurrency => {
    const d = simple(concurrency), serviceUs = 1000, rate = concurrency * 650, s = scenario(rate);
    const a = rate * serviceUs / 1e6, rho = a / concurrency;
    let term = 1, sum = 1;
    for (let k = 1; k < concurrency; k++) { term *= a / k; sum += term; }
    const tail = term * a / concurrency / (1 - rho), pWait = tail / (sum + tail);
    const expected = pWait / (concurrency * 1e6 / serviceUs - rate) * 1e6;
    const waits = [7, 19, 43].map(seed => stats(runToCompletion(d, s, seed, settings)).meanQueueWaitUs!);
    const observed = waits.reduce((x, y) => x + y, 0) / waits.length;
    expect(Math.abs(observed - expected) / expected).toBeLessThan(.13);
  }, 20000);
  it('M/M/1/K blocking matches the finite-capacity stationary distribution', () => {
    const d = simple(), s = scenario(800); server(d).params.queueCapacity = 3;
    const rho = .8, k = 4, expected = (1 - rho) * rho ** k / (1 - rho ** (k + 1));
    const rates = [7, 19, 43].map(seed => { const r = runToCompletion(d, s, seed, settings); return stats(r).drops / r.metrics.offered; });
    expect(Math.abs(rates.reduce((a, b) => a + b, 0) / rates.length - expected)).toBeLessThan(.012);
  }, 20000);
});

describe('operational semantics', () => {
  it('accepts a response at the exact inclusive logical deadline', () => {
    const d = simple(), s = single(); server(d).params.serviceTime = { kind: 'constant', us: 10 };
    s.workload.deadlineUs = 14;
    const r = runToCompletion(d, s, 1, settings);
    expect(r.metrics.succeeded).toBe(1); expect(r.metrics.goodput).toBe(1);
    s.workload.deadlineUs = 13; expect(runToCompletion(d, s, 1, settings).metrics.failed).toBe(1);
  });
  it('follows only measurement arrivals through drain and conserves unfinished work', () => {
    const d = simple(); server(d).params.serviceTime = { kind: 'constant', us: 1000 };
    const s = { ...single(), warmupUs: 1000, measureUs: 2000, drainUs: 2000 };
    s.workload.arrival = { kind: 'constant', rps: 1000 };
    const r = runToCompletion(d, s, 1, settings);
    expect(r.metrics.offered).toBe(2); expect(r.metrics.succeeded).toBe(2); expect(r.metrics.goodput).toBe(1);
    s.drainUs = 0; const noDrain = runToCompletion(d, s, 1, settings);
    expect(noDrain.metrics.unfinished).toBe(1);
    expect(noDrain.metrics.succeeded + noDrain.metrics.failed + noDrain.metrics.unfinished).toBe(2);
  });
  it('uses null metrics for zero traffic and keeps failure and success histograms separate', () => {
    const d = simple(), s = single(); s.workload.arrival.rps = 0;
    const r = runToCompletion(d, s, 1, settings);
    expect(r.metrics.goodput).toBeNull(); expect(r.metrics.availability).toBeNull(); expect(r.metrics.retryAmplification).toBeNull(); expect(r.metrics.successLatency.p50).toBeNull();
    s.workload.arrival.rps = 1; server(d).handlers = { get: [{ type: 'respond', status: 503 }] };
    const failed = runToCompletion(d, s, 1, settings);
    expect(failed.metrics.successLatency.p50).toBeNull(); expect(failed.metrics.allLatency.p50).not.toBeNull(); expect(failed.metrics.goodput).toBe(0);
  });
  it('traces cold reads, cache fills and prior-input lineage deterministically', () => {
    const cold = traceRequest(cacheAsideDesign, 'get', 'user:42', 5, []);
    expect(cold.status).toBe(200); expect(cold.dataOps).toContain('cache MISS user:42'); expect(cold.dataOps).toContain('DB read user:42 v0');
    expect(cold.spans.some(s => s.kind === 'network')).toBe(true);
    const inputs = [{ endpointId: 'get', key: 'user:42' }];
    const hot = traceRequest(cacheAsideDesign, 'get', 'user:42', 5, inputs);
    expect(hot.dataOps).toContain('cache HIT user:42'); expect(hot.totalUs).toBeLessThan(cold.totalUs);
    expect(hot).toEqual(traceRequest(cacheAsideDesign, 'get', 'user:42', 5, inputs));
    const written = traceRequest(cacheAsideDesign, 'get', 'user:42', 5, [...inputs, { endpointId: 'put', key: 'user:42' }]);
    expect(written.dataOps).toContain('DB read user:42 v1');
  });
  it('models lost response retries as duplicate effects, with idempotent and no-retry controls', () => {
    const d = simple(), s = single(); d.endpoints[0].op = 'write'; d.endpoints[0].idempotent = false;
    server(d).params.serviceTime = { kind: 'constant', us: 1 };
    const call: Step = { type: 'call', target: 'db', timeoutUs: 100, retry: { max: 1, backoffUs: 1, multiplier: 1, jitter: 'none', retryOn: ['timeout'] } };
    server(d).handlers = { get: [call, { type: 'respond', status: 200 }] };
    d.nodes.push({ id: 'db', kind: 'database', label: '', position: { x: 0, y: 0 }, params: { ...q(4), replicas: 1, readTime: { kind: 'constant', us: 1 }, writeTime: { kind: 'constant', us: 10 } } });
    d.edges.push({ ...d.edges[0], id: 'db-link', from: 'server', to: 'db', lossRate: .4 });
    let seed = 0;
    for (; seed < 1000; seed++) {
      const forward = new Random(seed, 'edge:db-link:forward'), reverse = new Random(seed, 'edge:db-link:reverse');
      if (forward.next() >= .4 && forward.next() >= .4 && reverse.next() < .4 && reverse.next() >= .4) break;
    }
    const r = runToCompletion(d, s, seed, settings);
    expect(r.violations.map(v => v.kind)).toEqual(['duplicateEffect']); expect(r.metrics.succeeded).toBe(1); expect(r.metrics.goodput).toBe(0); expect(r.metrics.attempts).toBe(2);
    d.endpoints[0].idempotent = true; expect(runToCompletion(d, s, seed, settings).violations).toEqual([]);
    d.endpoints[0].idempotent = false; delete call.retry; expect(runToCompletion(d, s, seed, settings).violations).toEqual([]);
  });
  it('stops retry amplification at a deterministic resource ceiling', () => {
    const d = simple(), s = single(); s.measureUs = 2e6; s.workload.arrival.rps = 1000;
    server(d).handlers = { get: [{ type: 'call', target: 'db', timeoutUs: 1, retry: { max: 1000, backoffUs: 0, multiplier: 1, jitter: 'none', retryOn: ['timeout'] } }] };
    server(d).params.concurrency = 1000;
    d.nodes.push({ id: 'db', kind: 'database', label: '', position: { x: 0, y: 0 }, params: { ...q(1000), replicas: 1, readTime: { kind: 'constant', us: 100000 }, writeTime: { kind: 'constant', us: 100000 } } });
    d.edges.push({ ...d.edges[0], id: 'db', from: 'server', to: 'db' });
    const r = runToCompletion(d, s, 1, { ...settings, limits: { liveRequests: 200 } });
    expect(r.outcome).toBe('inconclusive'); expect(r.inconclusiveReason).toContain('live requests'); expect(r.inconclusiveReason).toContain('reduce');
  });
});

describe('validation and properties', () => {
  it('rejects disconnected graphs, missing targets/edges, invalid probabilities and limits', () => {
    const d = simple(), s = single();
    expect(validateDesign(d, s)).toEqual([]);
    server(d).handlers = { get: [{ type: 'call', target: 'absent', timeoutUs: 1 }, { type: 'branch', cond: { kind: 'prob', p: 2 }, then: [], else: [] }] };
    d.edges[0].latency = { kind: 'constant', us: 0 }; d.edges[0].lossRate = NaN;
    expect(validateDesign(d, s).map(i => i.code)).toContain('MISSING_TARGET'); expect(validateDesign(d, s).map(i => i.code)).toContain('NO_EDGE_FOR_CALL'); expect(validateDesign(d, s).map(i => i.code)).toContain('INVALID_PARAMETER');
    const isolated = simple(); isolated.nodes.push({ ...node(), id: 'isolated' });
    expect(validateDesign(isolated, s).map(i => i.code)).toContain('UNREACHABLE_NODE');
    isolated.nodes = [node()]; expect(validateDesign(isolated, s).map(i => i.code)).toContain('NO_TRAFFIC_SOURCE');
    s.chaos = [{ id: 'a', target: 'server', kind: 'kill', atUs: 1, endUs: 10 }, { id: 'b', target: 'server', kind: 'gray', errorRate: 0, atUs: 5 }];
    expect(validateDesign(simple(), s).map(i => i.code)).toContain('OVERLAPPING_CHAOS');
    s.workload.keys.n = 1_000_001; expect(validateDesign(simple(), s).map(i => i.code)).toContain('INVALID_PARAMETER');
  });
  it('conserves requests, never emits NaN, and advances monotonically on generated valid graphs', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 10000 }), fc.integer({ min: 0, max: 30 }), fc.integer(), (workers, rps, capacity, seed) => {
      const d = simple(workers), s = { ...single(), measureUs: 100000, drainUs: 100000 };
      server(d).params.queueCapacity = capacity; s.workload.arrival = { kind: 'poisson', rps };
      const sim = createSimulation(d, s, seed, settings); let previous = 0;
      while (sim.advance({ maxEvents: 17 }) !== 'done') { const current = sim.snapshot().simTimeUs; expect(current).toBeGreaterThanOrEqual(previous); previous = current; }
      const r = sim.result(); expect(r.metrics.offered).toBe(r.metrics.succeeded + r.metrics.failed + r.metrics.unfinished);
      const visit = (x: unknown) => { if (typeof x === 'number') expect(Number.isFinite(x)).toBe(true); else if (x && typeof x === 'object') for (const value of Object.values(x)) visit(value); };
      visit(r);
    }), { numRuns: 30 });
  });
});

describe('caching challenge', () => {
  it.each(cachingChallenge.seeds)('runs fixture seed %i within the two-second Node budget', seed => {
    const start = performance.now();
    const result = runToCompletion(cacheAsideDesign, cachingScenario, seed, settings);
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result.metrics.goodput).toBeGreaterThanOrEqual(.99);
    expect(result.metrics.successLatency.p99).toBeLessThanOrEqual(80000);
  });
  it('passes cache-aside with five seeds and chaos, and fails without caching', () => {
    const pass = gradeChallenge(cacheAsideDesign, cachingChallenge);
    expect(pass.perSeed.map(s => ({ seed: s.seed, failures: s.failures }))).toEqual(pass.perSeed.map(s => ({ seed: s.seed, failures: [] })));
    expect(pass.verdict).toBe('pass'); expect(pass.stars).toBe(3);
    const fail = gradeChallenge(noCacheDesign, cachingChallenge);
    expect(fail.verdict).toBe('fail'); expect(fail.stars).toBe(0);
  }, 30000);
  it('returns inconclusive for insufficient latency samples and unsupported invariants', () => {
    const c = structuredClone(cachingChallenge); c.scenario = single(); c.scenario.workload.mix = { get: 1 }; c.variantChaos = []; c.seeds = [1];
    expect(gradeChallenge(cacheAsideDesign, c).verdict).toBe('inconclusive');
    c.invariants = ['staleRead']; expect(gradeChallenge(cacheAsideDesign, c).verdict).toBe('inconclusive');
  });
});
