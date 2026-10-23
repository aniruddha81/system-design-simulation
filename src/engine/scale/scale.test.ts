import { describe, expect, it } from 'vitest';
import { runToCompletion } from '@/engine';
import type { Design, NodeSpec, QueueParams, Scenario } from '../types';
import { cacheAsideDesign } from '../fixtures';
import { capabilityMatrix, checkFidelity, runScale, sweep, whatIf } from './index';
import { convolve, cdf, distribution, erlangC, mass, mean, mixture, point, queueStep, scaled } from './math';

const queue: QueueParams = { concurrency: 1, queueCapacity: 100, queueDiscipline: 'fifo', costPerHour: .1, region: 'a', zone: 'a' };
function benchmark(rps = 2000, layered = false): { design: Design; scenario: Scenario } {
  const database: NodeSpec<'database'> = { id: 'db', label: 'DB', kind: 'database', position: { x: 0, y: 0 }, params: { ...queue, readTime: { kind: 'exponential', meanUs: 250 }, writeTime: { kind: 'exponential', meanUs: 250 }, replicas: 1 } };
  const design: Design = { id: 'bench', schemaVersion: 1, name: 'M/M/1', nodes: [{ id: 'client', label: 'Client', kind: 'client', position: { x: 0, y: 0 }, params: { entry: layered ? 'svc' : 'db' } }, ...(layered ? [{ id: 'svc', label: 'Service', kind: 'service' as const, position: { x: 0, y: 0 }, params: { ...queue, concurrency: 64, serviceTime: { kind: 'constant' as const, us: 25 } }, handlers: { get: [{ type: 'call' as const, target: 'db', timeoutUs: 100_000 }, { type: 'respond' as const, status: 200 as const }] } }] : []), database], edges: (layered ? [['client', 'svc'], ['svc', 'db']] : [['client', 'db']]).map(([from, to]) => ({ id: `${from}-${to}`, from, to, latency: { kind: 'constant', us: 1 }, bandwidthBytesPerSec: 1e12, lossRate: 0 })), endpoints: [{ id: 'get', name: 'get', op: 'read', keyTemplate: 'key:{id}', requestBytes: 0, responseBytes: 100, idempotent: true }] };
  const scenario: Scenario = { id: 'benchmark', version: 1, warmupUs: 1_000_000, measureUs: 2_000_000, drainUs: 200_000, chaos: [], workload: { arrival: { kind: 'poisson', rps }, keys: { kind: 'zipf', n: 1000, s: 1.2 }, mix: { get: 1 }, deadlineUs: 100_000 } };
  return { design, scenario };
}
function exactMean(design: Design, scenario: Scenario) {
  const results = [11, 29, 47].map(seed => runToCompletion(design, scenario, seed, { traceSampleRate: 0 }));
  for (const r of results) expect(r.outcome).toBe('finished');
  return {
    util: (id: string) => results.reduce((s, r) => s + r.nodes.find(n => n.nodeId === id)!.utilisation, 0) / results.length,
    p: (key: 'p50' | 'p99') => results.reduce((s, r) => s + r.metrics.successLatency[key]!, 0) / results.length,
    drops: (id: string) => results.reduce((s, r) => s + r.nodes.find(n => n.nodeId === id)!.drops / r.metrics.offered, 0) / results.length,
    results,
  };
}
const relative = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b));

describe('Scale analytical model', () => {
  it.each([[1000, false], [2000, true], [3000, false]])('matches Exact at %i rps (layered: %s)', (rps, layered) => {
    const { design, scenario } = benchmark(rps, layered);
    const scale = runScale(design, scenario), exact = exactMean(design, scenario);
    expect(Math.abs(scale.nodes.find(n => n.nodeId === 'db')!.utilisation - exact.util('db'))).toBeLessThan(.05);
    if (layered) expect(Math.abs(scale.nodes.find(n => n.nodeId === 'svc')!.utilisation - exact.util('svc'))).toBeLessThan(.05);
    expect(relative(scale.metrics.successLatency.p50!, exact.p('p50'))).toBeLessThan(.25);
    expect(relative(scale.metrics.successLatency.p99!, exact.p('p99'))).toBeLessThan(.25);
    expect(scale.correctness).toBe('unknown');
    expect(scale.confidence).toBe('validated-envelope');
    expect(scale.metrics).not.toHaveProperty('goodput');
  });

  it('matches overload drops at 1.5× capacity and marks percentiles unavailable', () => {
    const { design, scenario } = benchmark(1500);
    const db = design.nodes.find(n => n.kind === 'database')!;
    if (db.kind === 'database') db.params.readTime = { kind: 'exponential', meanUs: 1000 };
    const scale = runScale(design, scenario), exact = exactMean(design, scenario);
    expect(relative(scale.nodes.find(n => n.nodeId === 'db')!.drops / scale.metrics.offered, exact.drops('db'))).toBeLessThan(.1);
    expect(scale.bottleneck).toBe(exact.results[0].bottleneck?.nodeId);
    expect(scale.metrics.successLatency.p99).toBeNull();
    expect(scale.confidence).toBe('low-confidence');
  });

  it('includes finite-buffer loss in the stable regime', () => {
    const { design, scenario } = benchmark(1000);
    const db = design.nodes.find(n => n.kind === 'database')!;
    if (db.kind === 'database') { db.params.queueCapacity = 0; db.params.readTime = { kind: 'exponential', meanUs: 500 }; }
    const result = runScale(design, scenario), exact = exactMean(design, scenario);
    expect(relative(result.nodes.find(n => n.nodeId === 'db')!.drops / result.metrics.offered, exact.drops('db'))).toBeLessThan(.1);
    expect(result.nodes.find(n => n.nodeId === 'db')!.avgQueue).toBe(0);
  });

  it('accounts for token-bucket admission separately from offered traffic and component cost', () => {
    const { design, scenario } = benchmark(2000);
    const limiter: NodeSpec<'rateLimiter'> = { id: 'limiter', kind: 'rateLimiter', label: 'Limiter', position: { x: 0, y: 0 }, params: { ...queue, concurrency: 64, serviceTime: { kind: 'constant', us: 10 }, algorithm: 'tokenBucket', ratePerSec: 1000, burst: 1000 } };
    design.nodes.splice(1, 0, limiter);
    if (design.nodes[0].kind === 'client') design.nodes[0].params.entry = 'limiter';
    design.edges = [['client', 'limiter'], ['limiter', 'db']].map(([from, to]) => ({ ...design.edges[0], id: `${from}-${to}`, from, to }));
    const result = runScale(design, scenario);
    expect(result.metrics.offered).toBeCloseTo(4000);
    expect(result.metrics.admitted).toBeCloseTo(2000, -2);
    expect(result.metrics.throughput.admittedPerSec).toBeCloseTo(1000, -2);
    expect(result.metrics.costPerMonth).toBeCloseTo(144, 8);
    expect(result.metrics.costPerMillionRequests).toBeCloseTo(144 / (30 * 24 * 3600 * 2000) * 1e6);
  });

  it('does not add stationary waiting to a transient queue, and conserves every step', () => {
    const stable = queueStep(2000, 250, 1, 1, 1, 100, 0, .1);
    expect(stable.regime).toBe('stable'); expect(stable.backlog).toBe(0);
    expect(mean(stable.wait)).toBeCloseTo(250, -1);
    const transient = queueStep(2000, 250, 1, 1, 1, 100, 50, .01);
    expect(transient.regime).toBe('transient'); expect(transient.stationaryQueue).toBe(0);
    expect(mean(transient.wait)).toBeCloseTo(10_000, -2);
    const { design, scenario } = benchmark(3000);
    scenario.chaos = [{ id: 'kill', kind: 'kill', target: 'db', atUs: 1_200_000, endUs: 1_350_000 }];
    let checked = 0;
    runScale(design, scenario, { onStep(_p, conservation) { for (const c of conservation) { expect(c.backlogEnd).toBeCloseTo(c.backlogStart + c.arrivals - c.completions - c.drops, 7); checked++; } } });
    expect(checked).toBeGreaterThan(20);
  });

  it('guards zero capacity and keeps every reported number finite', () => {
    const { design, scenario } = benchmark();
    scenario.chaos = [{ id: 'kill', kind: 'kill', target: 'db', atUs: 0 }];
    const result = runScale(design, scenario);
    expect(result.metrics.estimatedTimelySuccessRatio).toBe(0);
    expect(result.metrics.successLatency.p50).toBeNull();
    expect(result.nodes.find(n => n.nodeId === 'db')!.capacityPerSec).toBe(0);
    const visit = (value: unknown) => { if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true); else if (value && typeof value === 'object') Object.values(value).forEach(visit); };
    visit(result);
  });

  it('halving Δt changes stable and overloaded headlines by <2%', () => {
    for (const rate of [2000, 6000]) {
      const { design, scenario } = benchmark(rate);
      const a = runScale(design, scenario, { maxDtUs: 200_000 }), b = runScale(design, scenario, { maxDtUs: 100_000 });
      for (const key of ['estimatedTimelySuccessRatio', 'retryAmplification', 'costPerMillionRequests'] as const) expect(relative(a.metrics[key]!, b.metrics[key]!)).toBeLessThan(.02);
      for (const key of ['p50', 'p99'] as const) if (a.metrics.successLatency[key] !== null) expect(relative(a.metrics.successLatency[key]!, b.metrics.successLatency[key]!)).toBeLessThan(.02);
      expect(relative(a.nodes.find(n => n.nodeId === 'db')!.drops, b.nodes.find(n => n.nodeId === 'db')!.drops)).toBeLessThan(.02);
    }
  });

  it('composes serial convolution, branch mixtures, and timeout tails on the HDR grid', () => {
    expect(mean(convolve(point(100), point(200)))).toBe(300);
    const branch = mixture(scaled(point(100), .7), scaled(point(1000), .3));
    expect(cdf(branch, 200)).toBeCloseTo(.7);
    const exponential = distribution({ kind: 'exponential', meanUs: 1000 });
    expect(mass(exponential)).toBeCloseTo(1);
    expect(cdf(exponential, 1000)).toBeCloseTo(1 - Math.exp(-1), 2);
    expect(erlangC(.5, 1)).toBeCloseTo(.5);
  });

  it('feeds timeout tails into retry rates and shifted latency mixtures', () => {
    const { design, scenario } = benchmark(1000, true);
    const svc = design.nodes.find(n => n.kind === 'service')!;
    if (svc.kind === 'service') svc.handlers!.get = [{ type: 'call', target: 'db', timeoutUs: 250, retry: { max: 1, backoffUs: 1000, multiplier: 1, jitter: 'none', retryOn: ['timeout'] } }];
    const result = runScale(design, scenario);
    expect(result.metrics.retryAmplification).toBeGreaterThan(1.3);
    expect(result.metrics.retryAmplification).toBeLessThan(1.8);
    expect(result.metrics.timeoutTailFraction).toBeGreaterThan(.1);
    const exact = exactMean(design, scenario);
    const exactTimeouts = exact.results.reduce((sum, r) => sum + (r.metrics.statusCounts[504] ?? 0) / r.metrics.offered, 0) / exact.results.length;
    expect(relative(result.metrics.timeoutTailFraction!, exactTimeouts)).toBeLessThan(.25);
  });

  it('matches transient backlog peak and recovery time under a capacity brownout', () => {
    const { design, scenario } = benchmark(2000);
    scenario.workload.arrival.kind = 'constant'; scenario.workload.deadlineUs = 1_000_000;
    scenario.warmupUs = 500_000; scenario.measureUs = 1_000_000;
    const db = design.nodes.find(n => n.kind === 'database')!;
    if (db.kind === 'database') { db.params.readTime = { kind: 'constant', us: 250 }; db.params.queueCapacity = 500; }
    scenario.chaos = [{ id: 'brownout', kind: 'degrade', target: 'db', atUs: 1_000_000, endUs: 1_200_000, slowFactor: 10 }];
    let recovery = 0;
    const result = runScale(design, scenario, { maxDtUs: 10_000, onStep(p) { if (!recovery && p.tUs > 1_200_000 && p.nodes.db.backlog < 1) recovery = p.tUs; } });
    const exact = runToCompletion(design, scenario, 11, { traceSampleRate: 0 });
    expect(relative(result.nodes.find(n => n.nodeId === 'db')!.maxQueue, exact.nodes.find(n => n.nodeId === 'db')!.maxQueue)).toBeLessThan(.25);
    let exactRecovery = 0;
    for (const end of [1_300_000, 1_340_000, 1_380_000, 1_420_000]) {
      const s = structuredClone(scenario); s.measureUs = end - s.warmupUs; s.drainUs = 0;
      const prefix = runToCompletion(design, s, 11, { traceSampleRate: 0 });
      if (prefix.bottleneck?.nodeId === 'db' && prefix.bottleneck.queueGrowth <= 2) { exactRecovery = end; break; }
    }
    expect(exactRecovery).toBeGreaterThan(0);
    expect(relative(recovery - 1_200_000, exactRecovery - 1_200_000), JSON.stringify({ recovery, exactRecovery })).toBeLessThan(.25);
  });

  it('disables percentiles for heavy tails and reports unfinished cohorts separately', () => {
    const { design, scenario } = benchmark();
    const db = design.nodes.find(n => n.kind === 'database')!;
    if (db.kind === 'database') db.params.readTime = { kind: 'lognormal', medianUs: 100, sigma: 2 };
    const result = runScale(design, scenario);
    expect(result.confidence).toBe('low-confidence'); expect(result.metrics.successLatency.p99).toBeNull();
    scenario.warmupUs = 0; scenario.measureUs = 20_000; scenario.drainUs = 0;
    if (db.kind === 'database') db.params.readTime = { kind: 'constant', us: 50_000 };
    const short = runScale(design, scenario);
    expect(short.metrics.unfinished).toBeGreaterThan(0);
    expect(short.metrics.offered).toBeCloseTo(short.metrics.succeeded + short.metrics.failed + short.metrics.unfinished);
  });
});

function cacheBenchmark() {
  const design = structuredClone(cacheAsideDesign);
  design.endpoints = design.endpoints.filter(e => e.id === 'get');
  for (const n of design.nodes) {
    if (n.kind === 'service') delete n.handlers!.put;
    if (n.kind === 'cache') { n.params.ttlUs = undefined; n.params.capacityBytes = 10_000_000; n.params.coalesce = false; }
    if (n.kind === 'database') { n.params.concurrency = 20; n.params.readTime = { kind: 'exponential', meanUs: 1000 }; }
  }
  const scenario = benchmark(2000).scenario;
  scenario.warmupUs = 0; scenario.measureUs = 4_000_000;
  return { design, scenario };
}

describe('cache fills and fidelity', () => {
  it('cross-validates time to 90% of steady hit rate against Exact, and refines Δt', () => {
    const { design, scenario } = cacheBenchmark();
    const scale = runScale(design, scenario, { maxDtUs: 40_000 });
    const t90 = scale.nodes.find(n => n.nodeId === 'cache')!.cache!.timeTo90Us!;
    const exactAt = (time: number) => {
      const s = structuredClone(scenario); s.warmupUs = Math.max(0, Math.round(time - 100_000)); s.measureUs = 200_000;
      return [11, 29, 47].reduce((sum, seed) => sum + runToCompletion(design, s, seed, { traceSampleRate: 0 }).nodes.find(n => n.nodeId === 'cache')!.cache!.hitRate!, 0) / 3;
    };
    expect(t90).toBeGreaterThan(0);
    expect(exactAt(t90 * .75)).toBeLessThan(.9);
    expect(exactAt(t90 * 1.25)).toBeGreaterThanOrEqual(.9);
    const refined = runScale(design, scenario, { maxDtUs: 20_000 });
    expect(relative(scale.metrics.estimatedTimelySuccessRatio!, refined.metrics.estimatedTimelySuccessRatio!)).toBeLessThan(.02);
    expect(relative(scale.nodes.find(n => n.nodeId === 'cache')!.cache!.hitRate!, refined.nodes.find(n => n.nodeId === 'cache')!.cache!.hitRate!)).toBeLessThan(.02);
  }, 60_000);

  it('cold cache plus dead origin stays cold, then fills after recovery and restart clears it', () => {
    const { design, scenario } = cacheBenchmark();
    scenario.chaos = [{ id: 'dead', kind: 'kill', target: 'db', atUs: 0, endUs: 1_000_000 }, { id: 'restart', kind: 'kill', target: 'cache', atUs: 3_000_000, endUs: 3_050_000 }];
    const scale = runScale(design, scenario, { maxDtUs: 20_000 });
    for (const p of scale.series.filter(p => p.tUs < 1_000_000)) { expect(p.nodes.cache.cacheHitRate).toBe(0); expect(p.nodes.cache.occupancy).toBe(0); }
    expect(scale.series.some(p => p.tUs > 2_000_000 && p.nodes.cache.cacheHitRate! > .8)).toBe(true);
    expect(scale.series.find(p => p.tUs === 3_000_000)!.nodes.cache.occupancy).toBe(0);
    const exactScenario = structuredClone(scenario); exactScenario.measureUs = 800_000; exactScenario.chaos = [{ id: 'dead', kind: 'kill', target: 'db', atUs: 0 }];
    const exact = runToCompletion(design, exactScenario, 11, { traceSampleRate: 0 });
    expect(exact.nodes.find(n => n.nodeId === 'cache')!.cache!.hitRate).toBe(0);
  }, 60_000);

  it('disables exactly the declared LFU predictions, scoped to the affected endpoint', () => {
    const { design, scenario } = cacheBenchmark();
    const cache = design.nodes.find(n => n.kind === 'cache')!;
    if (cache.kind === 'cache') cache.params.eviction = 'lfu';
    design.endpoints.push({ ...design.endpoints[0], id: 'direct' }); scenario.workload.mix.direct = 1;
    for (const n of design.nodes) if (n.kind === 'service') n.handlers!.direct = [{ type: 'call', target: 'db', timeoutUs: 100_000 }];
    const report = checkFidelity(design, scenario);
    const disabled = Object.entries(report.predictions).filter(([, p]) => !p.enabled).map(([p]) => p).sort();
    expect(disabled).toEqual([...capabilityMatrix.lfu.disables, 'correctness'].sort());
    expect(report.paths.find(p => p.endpointId === 'direct')!.predictions.latency.enabled).toBe(true);
    expect(report.paths.find(p => p.endpointId === 'get')!.predictions.latency.enabled).toBe(false);
    const result = runScale(design, scenario);
    expect(result.metrics.successLatency.p50).toBeNull(); expect(result.metrics.estimatedTimelySuccessRatio).toBeNull();
  }, 60_000);

  it('detects non-Zipf, invalidation, variable object sizes, LIFO, and key affinity', () => {
    const { design, scenario } = cacheBenchmark(); scenario.workload.keys = { kind: 'uniform', n: 1000 };
    expect(checkFidelity(design, scenario).predictions.hitRate.enabled).toBe(false);
    const db = design.nodes.find(n => n.kind === 'database')!; if (db.kind === 'database') db.params.queueDiscipline = 'lifo';
    expect(checkFidelity(design, scenario).predictions.latency.enabled).toBe(false);
    const original = cacheBenchmark();
    const lb = original.design.nodes.find(n => n.kind === 'loadBalancer')!;
    if (lb.kind === 'loadBalancer') lb.params.algorithm = 'consistentHash';
    expect(checkFidelity(original.design, original.scenario).predictions.utilisation.enabled).toBe(false);
    const variable = cacheBenchmark();
    variable.design.endpoints.push({ ...variable.design.endpoints[0], id: 'big', responseBytes: 2000 });
    variable.scenario.workload.mix.big = 1;
    expect(checkFidelity(variable.design, variable.scenario).predictions.hitRate.enabled).toBe(false);
    const invalidated = cacheBenchmark(); invalidated.design.endpoints[0].op = 'write';
    expect(checkFidelity(invalidated.design, invalidated.scenario).predictions.hitRate.enabled).toBe(false);
  });

  it.each([false, true])('checks slow-origin single-key fills with coalescing=%s', coalesce => {
    const { design, scenario } = cacheBenchmark();
    scenario.workload.keys = { kind: 'zipf', n: 1, s: 1 };
    scenario.measureUs = 200_000; scenario.drainUs = 200_000;
    for (const n of design.nodes) {
      if (n.kind === 'cache') n.params.coalesce = coalesce;
      if (n.kind === 'database') { n.params.concurrency = 200; n.params.readTime = { kind: 'constant', us: 50_000 }; }
      if (n.kind === 'service') for (const s of n.handlers!.get!) if (s.type === 'cacheGet') s.timeoutUs = 100_000;
    }
    const result = runScale(design, scenario, { maxDtUs: 10_000 });
    const exact = runToCompletion(design, scenario, 11, { traceSampleRate: 0 });
    expect(relative(result.nodes.find(n => n.nodeId === 'db')!.arrivals, exact.nodes.find(n => n.nodeId === 'db')!.served)).toBeLessThan(.25);
    expect(result.nodes.find(n => n.nodeId === 'cache')!.cache!.occupancy).toBeCloseTo(1, 1);
  });
});

describe('breaking point tools', () => {
  it('matches the order of the first three saturating components in Exact', () => {
    const { design, scenario } = benchmark(1200);
    const db = design.nodes.find(n => n.kind === 'database')!;
    const databases = [3333, 1667, 833].map((us, i) => {
      const node = structuredClone(db); node.id = `db${i + 1}`;
      if (node.kind === 'database') node.params.readTime = { kind: 'exponential', meanUs: us };
      return node;
    });
    const lb = structuredClone(cacheAsideDesign.nodes.find(n => n.kind === 'loadBalancer')!);
    if (lb.kind === 'loadBalancer') lb.params.healthCheck.intervalUs = 1_000_000_000;
    design.nodes = [design.nodes[0], lb, ...databases];
    if (design.nodes[0].kind === 'client') design.nodes[0].params.entry = 'lb';
    design.edges = [['client', 'lb'], ...databases.map(n => ['lb', n.id])].map(([from, to]) => ({ ...design.edges[0], id: `${from}-${to}`, from, to }));
    const result = sweep(design, scenario, { levels: 3, maxMultiple: 4, warmupUs: 1_000_000, levelUs: 2_000_000 });
    const order: string[] = [];
    for (const multiple of [1, 2, 4]) {
      const s = structuredClone(scenario); s.workload.arrival.rps *= multiple;
      const exact = runToCompletion(design, s, 11, { traceSampleRate: 0 });
      for (const n of exact.nodes.filter(n => n.utilisation > .95).sort((a, b) => a.nodeId.localeCompare(b.nodeId))) if (!order.includes(n.nodeId)) order.push(n.nodeId);
    }
    expect(result.ladder.filter(r => r.what === 'capacity saturates').map(r => r.component)).toEqual(order);
    expect(order).toEqual(['db1', 'db2', 'db3']);
  }, 30_000);

  it('marks congested health-probe routing outside the validated ladder envelope', () => {
    const { design, scenario } = benchmark(1500);
    const db = design.nodes.find(n => n.kind === 'database')!;
    if (db.kind === 'database') { db.params.readTime = { kind: 'constant', us: 1000 }; db.params.queueCapacity = 200; }
    const lb = structuredClone(cacheAsideDesign.nodes.find(n => n.kind === 'loadBalancer')!);
    if (lb.kind === 'loadBalancer') lb.params.healthCheck.intervalUs = 10_000;
    design.nodes.splice(1, 0, lb);
    if (design.nodes[0].kind === 'client') design.nodes[0].params.entry = 'lb';
    design.edges = [['client', 'lb'], ['lb', 'db']].map(([from, to]) => ({ ...design.edges[0], id: `${from}-${to}`, from, to }));
    const result = runScale(design, scenario);
    expect(result.confidence).toBe('low-confidence');
    expect(result.warnings.some(w => w.includes('health-probe routing'))).toBe(true);
    expect(result.metrics.successLatency.p99).toBeNull();
  });
  it('is deterministic, log-spaced, bounded and flags levels without 30s steady state', () => {
    const { design, scenario } = benchmark(1000);
    const options = { levels: 3, maxMultiple: 9, warmupUs: 0, levelUs: 2_000_000 };
    const a = sweep(design, scenario, options);
    expect(a).toEqual(sweep(design, scenario, options));
    expect(a.levels.map(l => l.multiple)).toEqual([1, 3, 9]);
    expect(a.levels.every(l => l.state === 'unstable — no steady state')).toBe(true);
    expect(a.ladder[0].component).toBe('db');
    expect(a.ladder.every(r => !r.remedy.verified)).toBe(true);
    expect(() => sweep(design, scenario, { levels: 13 })).toThrow();
    expect(() => sweep(design, scenario, { levelUs: 1_800_000_001 })).toThrow();
  });

  it('detects steady state and preserves completed levels when cancelled', () => {
    const { design, scenario } = benchmark(1000);
    const signal = { aborted: false };
    const result = sweep(design, scenario, { levels: 3, levelUs: 32_000_000, warmupUs: 0, signal, onLevel() { signal.aborted = true; } });
    expect(result.outcome).toBe('cancelled'); expect(result.levels).toHaveLength(1); expect(result.levels[0].state).toBe('steady');
    const limited = sweep(design, scenario, { maxTotalSteps: 1 });
    expect(limited.outcome).toBe('step-limit'); expect(limited.levels).toHaveLength(0);
  });

  it('carries backlog across continuous ramp levels but resets independent levels', () => {
    const { design, scenario } = benchmark(6000);
    const firstBacklogs: number[] = [];
    const continuous = sweep(design, scenario, { kind: 'continuous', levels: 2, maxMultiple: 2, warmupUs: 0, levelUs: 2_000_000, onLevel(l) { firstBacklogs.push(l.result.series[0].nodes.db.backlog); } });
    expect(continuous.kind).toBe('continuous'); expect(firstBacklogs[1]).toBeGreaterThan(firstBacklogs[0]);
    const independent = sweep(design, scenario, { levels: 2, maxMultiple: 2, warmupUs: 0, levelUs: 2_000_000 });
    expect(independent.levels[1].result.series[0].nodes.db.backlog).toBeLessThan(100);
  });

  it('what-if reports metric/node deltas and verifies only remedies improved by the run', () => {
    const { design, scenario } = benchmark(6000);
    const b = structuredClone(design), db = b.nodes.find(n => n.kind === 'database')!;
    if (db.kind === 'database') db.params.replicas = 3;
    const diff = whatIf(design, b, scenario);
    expect(diff.deltas['estimatedTimelySuccessRatio']).toBeGreaterThan(0);
    expect(diff.nodeDeltas.db.utilisation).toBeLessThan(0);
    expect(diff.ladder.improved).toBe(true);
    expect(diff.ladder.a.some(r => r.remedy.verified)).toBe(true);
    expect(whatIf(design, design, scenario).ladder.improved).toBe(false);
  });
});
