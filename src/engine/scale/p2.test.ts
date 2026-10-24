import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { runToCompletion } from '@/engine';
import type { ChaosEvent, Design, EntitySpec, NodeParams, NodeSpec, QueueParams, Scenario, Step } from '../types';
import { capabilityMatrix, checkFidelity, featureCoverage, runScale } from './index';
import { cdf, mass, orderStatistic, point } from './math';
import { failureLadder } from './sweep';

const q: QueueParams = { concurrency: 4, queueCapacity: 10000, queueDiscipline: 'fifo', costPerHour: .1, region: 'a', zone: 'a1' };
const at = { x: 0, y: 0 };
const constant = (us: number) => ({ kind: 'constant' as const, us });
function node<K extends NodeSpec['kind']>(kind: K, params: NodeParams[K], id: string = kind): NodeSpec<K> {
  return { kind, params, id, label: id, position: at } as NodeSpec<K>;
}
function fixture(): { design: Design; scenario: Scenario } {
  return {
    design: { schemaVersion: 1, id: 'p2', name: 'P2', nodes: [node('client', { entry: 'svc' }, 'client'), { ...node('service', { ...q, concurrency: 64, serviceTime: constant(10) }, 'svc'), handlers: { get: [{ type: 'call', target: 'db', timeoutUs: 1_000_000 }] } }, node('database', { ...q, readTime: constant(1000), writeTime: constant(1000), replicas: 1 }, 'db')], edges: [['client', 'svc'], ['svc', 'db']].map(([from, to]) => ({ id: `${from}-${to}`, from, to, latency: constant(1), bandwidthBytesPerSec: 1e12, lossRate: 0 })), endpoints: [{ id: 'get', name: 'get', op: 'read', keyTemplate: 'key:{id}', requestBytes: 10, responseBytes: 100, idempotent: true }] },
    scenario: { id: 'p2', version: 1, warmupUs: 0, measureUs: 4_000_000, drainUs: 0, chaos: [], workload: { arrival: { kind: 'constant', rps: 1000 }, keys: { kind: 'zipf', n: 100, s: 1.2 }, mix: { get: 1 }, deadlineUs: 1_000_000 } },
  };
}
function entity(): EntitySpec {
  return { name: 'items', store: 'db', primaryKey: 'id', fields: [{ name: 'id', type: 'int', bytes: { meanBytes: 8, sdBytes: 0 } }], indexes: [{ name: 'byId', fields: ['id'], unique: false }], dataset: { count: 10000, keys: { kind: 'uniform', n: 10000 } } };
}
function handlers(design: Design, steps: Step[]) { design.nodes.find(n => n.id === 'svc')!.handlers = { get: steps }; }
function queueFixture() {
  const f = fixture();
  f.design.nodes = f.design.nodes.filter(n => n.id !== 'db');
  f.design.edges[1] = { ...f.design.edges[1], id: 'svc-jobs', to: 'jobs' };
  f.design.nodes.push(node('queue', { partitions: 4, capacityMessages: 10000, visibilityTimeoutUs: 1_000_000, maxDeliveries: 3, retentionUs: 60_000_000, publishTime: constant(10), costPerHour: .1, region: 'a', zone: 'a1' }, 'jobs'), node('worker', { ...q, concurrency: 1, serviceTime: constant(2000), source: 'jobs', batchSize: 1 }, 'consumer'));
  handlers(f.design, [{ type: 'publish', queue: 'jobs', timeoutUs: 1_000_000, orderedByKey: false }]);
  return f;
}
function autoscaleFixture() {
  const f = fixture();
  const db = f.design.nodes.find(n => n.kind === 'database')!;
  db.params.concurrency = 1;
  f.scenario.workload.arrival = { kind: 'step', rps: 500, stepAtUs: 1_000_000, stepRps: 1500 };
  f.design.nodes.push(node('autoscaler', { targets: ['db'], metric: 'utilisation', targetValue: .75, min: 1, max: 4, cooldownUs: 500_000, provisionUs: 200_000, warmupUs: 100_000, evaluateEveryUs: 100_000 }));
  return f;
}
function replicationFixture() {
  const f = fixture(), db = f.design.nodes.find(n => n.kind === 'database')!;
  db.params.replication = 'async'; db.params.replicationLag = constant(10000); db.params.replicas = 2;
  f.design.endpoints[0].op = 'write';
  return f;
}

describe('P2 fidelity inventory', () => {
  it('covers every union member from the shared contract, including future additions', () => {
    const source = ts.createSourceFile('types.ts', readFileSync(new URL('../types.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const aliases = new Map(source.statements.filter(ts.isTypeAliasDeclaration).map(n => [n.name.text, n.type]));
    const literalValues = (type: ts.TypeNode, discriminator?: string): string[] => {
      if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return type.types.flatMap(t => literalValues(t, discriminator));
      if (ts.isParenthesizedTypeNode(type)) return literalValues(type.type, discriminator);
      if (!discriminator && ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return [type.literal.text];
      if (ts.isTypeLiteralNode(type)) return type.members.flatMap(m => ts.isPropertySignature(m) && m.name.getText(source) === discriminator && m.type ? literalValues(m.type) : []);
      return [];
    };
    const workload = aliases.get('Workload')! as ts.TypeLiteralNode;
    const arrival = workload.members.find(m => ts.isPropertySignature(m) && m.name.getText(source) === 'arrival') as ts.PropertySignature;
    const sets = { components: literalValues(aliases.get('ComponentKind')!), steps: literalValues(aliases.get('Step')!, 'type'), conditions: literalValues(aliases.get('Condition')!, 'kind'), chaos: literalValues(aliases.get('ChaosEvent')!, 'kind'), arrivals: literalValues(arrival.type!, 'kind'), dataOps: literalValues(aliases.get('DataOp')!, 'kind'), invariants: literalValues(aliases.get('InvariantKind')!) };
    for (const [group, values] of Object.entries(sets)) {
      const coverage = featureCoverage[group as keyof typeof featureCoverage];
      expect(Object.keys(coverage).sort(), group).toEqual(values.sort());
      for (const feature of Object.values(coverage)) {
        const entry = capabilityMatrix[feature];
        expect(entry.reason.length).toBeGreaterThan(10);
        expect(['supported', 'approximate', 'unsupported']).toContain(entry.scale);
        if (entry.scale === 'unsupported') expect(entry.disables.length).toBeGreaterThan(0);
      }
    }
  });

  it('disables dependent predictions for dedup state branches', () => {
    const { design, scenario } = fixture();
    handlers(design, [{ type: 'branch', cond: { kind: 'dedupHit' }, then: [{ type: 'call', target: 'db', timeoutUs: 1_000_000 }], else: [] }]);
    const result = runScale(design, scenario);
    expect(result.fidelity.predictions.utilisation.enabled).toBe(false);
    expect(result.metrics.estimatedTimelySuccessRatio).toBeNull();
    expect(result.metrics.successLatency.p99).toBeNull();
    expect(result.series.every(p => p.estimatedTimelySuccessRatio === null)).toBe(true);
    expect(failureLadder([{ multiple: 1, result, state: 'unstable — no steady state' }])).toEqual([]);
  });

  it('approximates read-only found branches from entity population and disables mutation-dependent state', () => {
    const { design, scenario } = fixture(); design.entities = [entity()];
    design.entities[0].dataset.count = 5000;
    handlers(design, [{ type: 'data', target: 'db', entity: 'items', op: { kind: 'get' }, timeoutUs: 1_000_000 }, { type: 'branch', cond: { kind: 'found' }, then: [{ type: 'respond', status: 200 }], else: [{ type: 'respond', status: 404 }] }]);
    const r = runScale(design, scenario);
    expect(r.fidelity.predictions.timelySuccess.enabled).toBe(true);
    expect(r.metrics.availability).toBeCloseTo(.5, 2);
    design.endpoints[0].op = 'write';
    expect(checkFidelity(design, scenario).predictions.timelySuccess.enabled).toBe(false);
  });

  it('disables conflict and contention predictions but keeps simple query costs available', () => {
    const { design, scenario } = fixture(); design.entities = [entity()];
    for (const op of [{ kind: 'conditionalPut' }, { kind: 'decrementIfPositive', field: 'id' }, { kind: 'insert' }, { kind: 'update', field: 'id', op: 'increment' }] as const) {
      handlers(design, [{ type: 'data', target: 'db', entity: 'items', op, timeoutUs: 1_000_000 }]);
      expect(checkFidelity(design, scenario).predictions.timelySuccess.enabled).toBe(false);
    }
    scenario.workload.arrival = { kind: 'constant', rps: 10 };
    const query = (index?: string) => {
      handlers(design, [{ type: 'data', target: 'db', entity: 'items', op: { kind: 'query', index, limit: 1 }, timeoutUs: 1_000_000 }]);
      return runScale(design, scenario);
    };
    const indexed = query('byId'), scan = query();
    expect(indexed.fidelity.predictions.latency.enabled).toBe(true);
    expect(scan.metrics.successLatency.p50!).toBeGreaterThan(indexed.metrics.successLatency.p50! * 5);
    design.entities[0].fields[0].bytes.sdBytes = 1;
    design.endpoints[0].responseFields = ['id'];
    expect(checkFidelity(design, scenario).predictions.cost.enabled).toBe(false);
  });
});

describe('P2 fluid semantics', () => {
  it('steps capacity only after evaluation, provisioning and warmup', () => {
    const { design, scenario } = autoscaleFixture();
    const r = runScale(design, scenario, { maxDtUs: 10000 });
    expect(r.series.filter(p => p.tUs < 1_400_000).every(p => p.nodes.db.concurrency === 1)).toBe(true);
    expect(r.series.some(p => p.tUs >= 1_400_000 && p.nodes.db.concurrency === 2)).toBe(true);
    expect(r.nodes.find(n => n.nodeId === 'db')!.concurrency).toBe(2);
    expect(r.fidelity.predictions.utilisation.enabled).toBe(true);
  });

  it('conserves a fluid publish/consumer queue and drains backlog when load falls', () => {
    const { design, scenario } = queueFixture();
    const r = runScale(design, scenario, { maxDtUs: 10000, onStep(_p, counts) {
      for (const c of counts) expect(c.backlogEnd).toBeCloseTo(c.backlogStart + c.arrivals - c.completions - c.drops, 7);
    } });
    expect(r.nodes.find(n => n.nodeId === 'jobs')!.queue!.depth).toBeCloseTo(2000, -1);
    expect(r.nodes.find(n => n.nodeId === 'consumer')!.utilisation).toBeCloseTo(1, 2);
    scenario.workload.arrival = { kind: 'step', rps: 1000, stepRps: 0, stepAtUs: 2_000_000 };
    expect(runScale(design, scenario, { maxDtUs: 10000 }).nodes.find(n => n.nodeId === 'jobs')!.queue!.depth).toBeLessThan(10);
  });

  it('retains messages when consumer processing fails', () => {
    const { design, scenario } = queueFixture();
    design.nodes.find(n => n.kind === 'worker')!.handlers = { get: [{ type: 'respond', status: 503 }] };
    const r = runScale(design, scenario, { maxDtUs: 10000 });
    expect(r.nodes.find(n => n.nodeId === 'jobs')!.queue!.depth).toBeCloseTo(4000, -1);
  });

  it('reports async lag without claiming version correctness', () => {
    const { design, scenario } = replicationFixture();
    const r = runScale(design, scenario);
    expect(r.nodes.find(n => n.nodeId === 'db')!.replication!.meanLagUs).toBeCloseTo(10000);
    expect(r.fidelity.predictions.correctness.enabled).toBe(false);
  });

  it.each(['all', 'any', 'quorum', 'firstN'] as const)('composes independent parallel %s latency and accounts for all branch traffic', kind => {
    const { design, scenario } = fixture();
    handlers(design, [{ type: 'parallel', branches: [[{ type: 'call', target: 'db', timeoutUs: 1_000_000 }], [{ type: 'call', target: 'db', timeoutUs: 1_000_000 }]], join: kind === 'quorum' ? { kind, k: 2 } : kind === 'firstN' ? { kind, n: 1 } : { kind }, cancelLosers: true }]);
    const r = runScale(design, scenario);
    expect(r.nodes.find(n => n.nodeId === 'db')!.arrivals).toBeCloseTo(8000, -1);
    expect(r.metrics.successLatency.p50).toBeGreaterThan(1000);
    expect(r.assumptions.some(a => a.includes('parallel'))).toBe(true);
  });

  it('uses success CDF order statistics without normalizing failed branches', () => {
    const branches = [point(10, .5), point(20, .5), point(30, .5)];
    expect(mass(orderStatistic(branches, 1))).toBeCloseTo(.875);
    expect(mass(orderStatistic(branches, 2))).toBeCloseTo(.5);
    expect(cdf(orderStatistic(branches, 3), 20)).toBe(0);
  });

  it.each(['ramp', 'diurnal', 'replay'] as const)('integrates %s arrival rates', kind => {
    const { design, scenario } = fixture();
    scenario.workload.arrival = kind === 'ramp' ? { kind, fromRps: 500, toRps: 1500 } : kind === 'diurnal' ? { kind, meanRps: 1000, amplitude: .5, periodUs: 4_000_000 } : { kind, points: [{ atUs: 0, rps: 500 }, { atUs: 4_000_000, rps: 1500 }] };
    expect(runScale(design, scenario, { maxDtUs: 10000 }).metrics.offered).toBeCloseTo(4000, 1);
  });

  const outages: ChaosEvent[] = [
    { id: 'p', kind: 'partition', target: '', atUs: 0, endUs: 2_000_000, links: [{ from: 'svc', to: 'db' }] },
    { id: 'z', kind: 'zoneOutage', target: 'a1', atUs: 0, endUs: 2_000_000 },
    { id: 'r', kind: 'regionOutage', target: 'a', atUs: 0, endUs: 2_000_000 },
    { id: 'l', kind: 'linkLoss', target: 'svc-db', atUs: 0, endUs: 2_000_000, lossRate: 1 },
  ];
  it.each(outages)('applies $kind and recovers at its timeline boundary', chaos => {
    const { design, scenario } = fixture(); scenario.chaos = [chaos];
    const r = runScale(design, scenario, { maxDtUs: 10000 });
    expect(r.metrics.availability).toBeCloseTo(.5, 2);
    expect(r.series.filter(p => p.tUs < 2_000_000).every(p => p.succeededPerSec === 0)).toBe(true);
  });

  it('adds link latency, traffic spikes and directional region egress', () => {
    const { design, scenario } = fixture();
    const db = design.nodes.find(n => n.kind === 'database')!; db.params.region = 'b';
    design.regions = { names: ['a', 'b'], latencyUs: [[0, 1000], [1000, 0]], egressCostPerGB: [[0, 1], [2, 0]] };
    const base = runScale(design, scenario);
    expect(base.metrics.successLatency.p50!).toBeGreaterThan(3000);
    expect(base.metrics.costPerMonth).toBeCloseTo(144 + 1000 * (10 + 200) / 1e9 * 30 * 24 * 3600, 1);
    scenario.chaos = [{ id: 'latency', kind: 'linkLatency', target: 'svc-db', atUs: 0, addUs: 5000 }, { id: 'spike', kind: 'trafficSpike', target: '', atUs: 0, multiplier: 1.5 }];
    const r = runScale(design, scenario);
    expect(r.metrics.offered).toBe(6000);
    expect(r.metrics.successLatency.p50!).toBeGreaterThan(base.metrics.successLatency.p50! + 9000);
  });

  it.each(['dns', 'cdn', 'apiGateway', 'circuitBreaker'] as const)('runs %s as an explicitly approximate forwarding component', kind => {
    const { design, scenario } = fixture();
    const params = {
      dns: { resolutionTime: constant(100), ttlUs: 1_000_000, records: ['db'] },
      cdn: { ...q, serviceTime: constant(10), capacityBytes: 10000, eviction: 'lru' as const, originShield: false, costPerGB: .01 },
      apiGateway: { ...q, serviceTime: constant(10), maxRequestBytes: 1000 },
      circuitBreaker: { failureRateThreshold: .5, windowUs: 100_000, minRequests: 10, openUs: 100_000, halfOpenProbes: 1, bulkheadMax: 64 },
    };
    design.nodes[1] = node(kind, params[kind], 'svc');
    const r = runScale(design, scenario, { maxDtUs: 10000 });
    expect(r.metrics.availability).toBeGreaterThan(.99);
    if (kind === 'cdn') expect(r.nodes.find(n => n.nodeId === 'svc')!.cache!.hitRate).toBeGreaterThan(.5);
  });

  it('opens a circuit on failure rate and enforces gateway admission', () => {
    const { design, scenario } = fixture();
    design.nodes[1] = node('circuitBreaker', { failureRateThreshold: .5, windowUs: 100_000, minRequests: 10, openUs: 500_000, halfOpenProbes: 1 }, 'svc');
    scenario.chaos = [{ id: 'gray', kind: 'gray', target: 'db', atUs: 0, errorRate: 1 }];
    const r = runScale(design, scenario, { maxDtUs: 10000 });
    expect(r.nodes.find(n => n.nodeId === 'db')!.arrivals).toBeLessThan(1000);
    design.nodes[1] = node('apiGateway', { ...q, serviceTime: constant(10), maxRequestBytes: 1 }, 'svc'); scenario.chaos = [];
    expect(runScale(design, scenario).metrics.availability).toBe(0);
  });

  it.each(['kvStore', 'objectStore', 'searchIndex', 'dedupStore'] as const)('models %s service cost and explicitly gates its unsupported semantics', kind => {
    const { design, scenario } = fixture();
    const params = {
      kvStore: { ...q, readTime: constant(1000), writeTime: constant(1000), members: 3, vnodes: 8, replicationFactor: 3, readQuorum: 2, writeQuorum: 2, hintedHandoff: true, readRepair: true, tombstoneGcUs: 1_000_000 },
      objectStore: { readTime: constant(1000), writeTime: constant(1000), region: 'a', zone: 'a1', costPerGBMonth: .1, costPerMillionRequests: 1 },
      searchIndex: { ...q, serviceTime: constant(1000), indexLag: constant(10000), source: 'db' },
      dedupStore: { ...q, serviceTime: constant(1000), ttlUs: 1_000_000, atomic: true, durable: true },
    };
    if (kind === 'searchIndex') {
      design.nodes.push(node(kind, params[kind], 'index'));
      design.edges.push({ ...design.edges[1], id: 'svc-index', to: 'index' });
      handlers(design, [{ type: 'call', target: 'index', timeoutUs: 1_000_000 }]);
    } else {
      design.nodes[2] = node(kind, params[kind], 'db');
      if (kind === 'dedupStore') handlers(design, [{ type: 'dedup', store: 'db', timeoutUs: 1_000_000 }]);
    }
    const r = runScale(design, scenario);
    expect(r.fidelity.predictions.correctness.enabled).toBe(false);
    expect(r.nodes.find(n => n.nodeId === (kind === 'searchIndex' ? 'index' : 'db'))!.arrivals).toBeGreaterThan(3900);
    expect(r.fidelity.predictions.timelySuccess.enabled).toBe(kind !== 'dedupStore');
  });

  it('keeps independent CDN occupancy for each requesting region', () => {
    const { design, scenario } = fixture();
    design.nodes[1] = node('cdn', { ...q, serviceTime: constant(10), capacityBytes: 10000, eviction: 'lru', originShield: false, costPerGB: 0 }, 'svc');
    design.nodes[0] = node('client', { entry: 'regional' }, 'client');
    design.nodes.push(node('loadBalancer', { ...q, concurrency: 64, algorithm: 'roundRobin', serviceTime: constant(1), healthCheck: { intervalUs: 1_000_000, unhealthyThreshold: 1, healthyThreshold: 1 } }, 'regional'));
    for (const region of ['a', 'b']) {
      design.nodes.push({ ...node('service', { ...q, region, concurrency: 64, serviceTime: constant(1) }, region), handlers: { get: [{ type: 'call', target: 'svc', timeoutUs: 1_000_000 }] } });
    }
    design.edges = [['client', 'regional'], ['regional', 'a'], ['regional', 'b'], ['a', 'svc'], ['b', 'svc'], ['svc', 'db']].map(([from, to]) => ({ ...design.edges[0], id: `${from}-${to}`, from, to }));
    const r = runScale(design, scenario, { maxDtUs: 10000 });
    // Each region can hold ~80 objects; a shared cache would stay below 100 distinct keys.
    expect(r.nodes.find(n => n.nodeId === 'svc')!.cache!.occupancy).toBeGreaterThan(100);
  });
});

describe('P2 Exact cross-validation (PLAN 5A.3, three seeds)', () => {
  const cases = [
    { name: 'autoscaling step load', make: autoscaleFixture, ready: 'autoscale', check: (scale: ReturnType<typeof runScale>, exact: ReturnType<typeof runToCompletion>[]) => {
      // Steady utilisation after scaling settles; aggregate utilisation has a changing denominator.
      const tail = scale.series.filter(p => p.tUs >= 2_000_000);
      const util = tail.reduce((sum, p) => sum + p.nodes.db.utilisation * p.dtUs, 0) / tail.reduce((sum, p) => sum + p.dtUs, 0);
      const average = exact.reduce((sum, r) => sum + r.series.filter(p => p.tUs >= 2_000_000).reduce((sum, p) => sum + p.nodeUtil.db, 0) / r.series.filter(p => p.tUs >= 2_000_000).length, 0) / exact.length;
      expect(Math.abs(util - average)).toBeLessThan(.05);
      const peak = exact.reduce((sum, r) => sum + r.nodes.find(n => n.nodeId === 'db')!.maxQueue, 0) / exact.length;
      expect(Math.abs(scale.nodes.find(n => n.nodeId === 'db')!.maxQueue - peak) / Math.max(1, peak)).toBeLessThan(.25);
    } },
    { name: 'queue/worker steady consumer lag', make: queueFixture, ready: 'queue', check: (scale: ReturnType<typeof runScale>, exact: ReturnType<typeof runToCompletion>[]) => {
      const peak = exact.reduce((sum, r) => sum + r.nodes.find(n => n.nodeId === 'jobs')!.queue!.consumerLagMax, 0) / exact.length;
      expect(Math.abs(scale.nodes.find(n => n.nodeId === 'jobs')!.queue!.consumerLagMaxUs - peak) / Math.max(1, peak)).toBeLessThan(.25);
      const average = exact.reduce((sum, r) => sum + r.nodes.find(n => n.nodeId === 'consumer')!.utilisation, 0) / exact.length;
      expect(Math.abs(scale.nodes.find(n => n.nodeId === 'consumer')!.utilisation - average)).toBeLessThan(.05);
    } },
    { name: 'async replication lag', make: replicationFixture, ready: 'replicationLagUs', check: (scale: ReturnType<typeof runScale>, exact: ReturnType<typeof runToCompletion>[]) => {
      const lag = exact.reduce((sum, r) => sum + r.nodes.find(n => n.nodeId === 'db')!.replicationLagUs!.mean, 0) / exact.length;
      expect(Math.abs(scale.nodes.find(n => n.nodeId === 'db')!.replication!.meanLagUs - lag) / Math.max(1, lag)).toBeLessThan(.25);
    } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const f = c.make();
      const exact = [11, 29, 47].map(seed => runToCompletion(f.design, f.scenario, seed, { traceSampleRate: 0 }));
      for (const r of exact) expect(r.outcome).toBe('finished');
      c.check(runScale(f.design, f.scenario, { maxDtUs: 10000 }), exact);
    });
  }
});
