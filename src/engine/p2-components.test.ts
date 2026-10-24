import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createSimulation, runToCompletion, traceRequest, validateDesign } from './index';
import { ExactSimulation } from './simulation';
import { paymentsDesign, paymentsScenario, ticketBookingDesign, ticketBookingScenario } from './fixtures';
import type { Design, EdgeSpec, NodeSpec, QueueParams, Scenario } from './types';

const q: QueueParams = { concurrency: 100, queueCapacity: 100, queueDiscipline: 'fifo', costPerHour: 0, region: 'us-east', zone: 'a' };
const time = { kind: 'constant', us: 1 } as const;
const link = (from: string, to: string): EdgeSpec => ({ id: `${from}-${to}`, from, to, latency: time, bandwidthBytesPerSec: 1e9, lossRate: 0 });
const service = (d: Design) => d.nodes.find((n): n is NodeSpec<'service'> => n.kind === 'service')!;
const db = (d: Design) => d.nodes.find((n): n is NodeSpec<'database'> => n.kind === 'database')!;
const readScenario = (): Scenario => ({ ...structuredClone(ticketBookingScenario), measureUs: 20001, workload: { ...structuredClone(ticketBookingScenario.workload), arrival: { kind: 'constant', rps: 1000 }, mix: { get: 1 } } });
const run = (d: Design, s: Scenario) => runToCompletion(d, s, 7, { traceSampleRate: 0 });
function front(d: Design, n: NodeSpec) {
  const client = d.nodes.find((n): n is NodeSpec<'client'> => n.kind === 'client')!;
  client.params.entry = n.id; d.nodes.push(n);
  d.edges = d.edges.filter(e => e.from !== 'client'); d.edges.push(link('client', n.id), link(n.id, 'svc'));
}

describe('boundary components and storage', () => {
  it('DNS caches resolution until TTL and resolves a healthy failover record', () => {
    const d = structuredClone(ticketBookingDesign), s = readScenario();
    const dns: NodeSpec<'dns'> = { id: 'dns', kind: 'dns', label: '', position: { x: 0, y: 0 }, params: { records: ['svc', 'backup'], resolutionTime: { kind: 'constant', us: 500 }, ttlUs: 100000 } };
    front(d, dns);
    d.nodes.push({ id: 'backup', kind: 'service', label: '', position: { x: 0, y: 0 }, params: { ...q, serviceTime: time } }); d.edges.push(link('dns', 'backup'));
    s.chaos = [{ id: 'primary-down', kind: 'kill', target: 'svc', atUs: 0 }];
    const cached = run(d, s); expect(cached.metrics.goodput).toBe(1); expect(cached.nodes.find(n => n.nodeId === 'backup')!.served).toBe(20);
    dns.params.ttlUs = 1;
    expect(run(d, s).metrics.successLatency.p50!).toBeGreaterThan(cached.metrics.successLatency.p50! + 400);
  });
  it('API gateway enforces request-size limits after auth latency and forwards accepted requests', () => {
    const d = structuredClone(ticketBookingDesign), s = readScenario();
    const gateway: NodeSpec<'apiGateway'> = { id: 'gateway', kind: 'apiGateway', label: '', position: { x: 0, y: 0 }, params: { ...q, serviceTime: { kind: 'constant', us: 100 }, maxRequestBytes: 4 } };
    front(d, gateway); expect(run(d, s).metrics.statusCounts[409]).toBe(20);
    gateway.params.maxRequestBytes = 8; expect(run(d, s).metrics.goodput).toBe(1);
  });
  it('search-index reads expose source lag; a caught-up index preserves read-your-writes sessions', () => {
    const d = structuredClone(ticketBookingDesign), s = readScenario();
    const index: NodeSpec<'searchIndex'> = { id: 'search', kind: 'searchIndex', label: '', position: { x: 0, y: 0 }, params: { ...q, serviceTime: time, source: 'db', indexLag: { kind: 'constant', us: 10000 } } };
    d.nodes.push(index); d.edges.push(link('svc', 'search'));
    service(d).handlers!.get = [{ type: 'data', target: 'search', entity: 'tickets', op: { kind: 'get' }, timeoutUs: 30000 }];
    service(d).handlers!.put = [{ type: 'data', target: 'db', entity: 'tickets', op: { kind: 'put' }, timeoutUs: 30000 }];
    s.workload.mix = { get: .5, put: .5 }; s.workload.sessions = { count: 1 };
    expect(run(d, s).violations.map(v => v.kind)).toContain('staleRead');
    index.params.indexLag = time; expect(run(d, s).violations).toEqual([]);
  });
  it('non-durable WAL loses acknowledged state on restart; durable WAL retains it', () => {
    const d = structuredClone(ticketBookingDesign), s = readScenario(); s.workload.mix = { put: 1 };
    s.chaos = [{ id: 'restart', kind: 'kill', target: 'db', atUs: 4500, endUs: 4501 }];
    db(d).params.walDurable = false;
    expect(run(d, s).violations.map(v => v.kind)).toContain('ackedWriteLost');
    db(d).params.walDurable = true; expect(run(d, s).violations).toEqual([]);
  });
  it('out-of-order replication preserves all increments when the follower is promoted', () => {
    const d = structuredClone(ticketBookingDesign), s = readScenario(), store = db(d);
    d.entities![0].dataset.initial = { remaining: 0 };
    store.params.replicas = 3; store.params.replication = 'async'; store.params.replicationLag = { kind: 'empirical', buckets: [{ us: 1, weight: 1 }, { us: 10000, weight: 1 }] };
    store.params.failover = { heartbeatUs: 10, missedHeartbeats: 1, electionUs: 10, fencing: true };
    service(d).handlers!.put = [{ type: 'data', target: 'db', entity: 'tickets', op: { kind: 'update', field: 'remaining', op: 'increment' }, timeoutUs: 30000 }];
    service(d).handlers!.get = [{ type: 'data', target: 'db', entity: 'tickets', op: { kind: 'decrementIfPositive', field: 'remaining' }, timeoutUs: 30000 }];
    s.measureUs = 100000; s.chaos = [{ id: 'promote', kind: 'kill', target: 'db', atUs: 20000 }];
    for (const seed of [1, 2, 3]) {
      const sim = new ExactSimulation(d, s, seed, { traceSampleRate: 0 }, true);
      for (let i = 0; i < 10; i++) expect(sim.trace({ endpointId: 'put', key: 'item:0' }).status).toBe(200);
      sim.advance({ untilUs: 21000 });
      for (let i = 0; i < 10; i++) expect(sim.trace({ endpointId: 'get', key: 'item:0' }).status).toBe(200);
      expect(sim.trace({ endpointId: 'get', key: 'item:0' }).status).toBe(409);
    }
  });
  it('a region outage keeps all database replicas unavailable despite a configured election', () => {
    const d = structuredClone(ticketBookingDesign), s = readScenario();
    db(d).params.replicas = 3; db(d).params.replication = 'async'; db(d).params.failover = { heartbeatUs: 10, missedHeartbeats: 1, electionUs: 10, fencing: true };
    s.chaos = [{ id: 'region', kind: 'regionOutage', target: 'us-east', atUs: 0, endUs: 10000 }];
    const sim = createSimulation(d, s, 1, { traceSampleRate: 0 }); sim.advance({ untilUs: 5000 });
    expect(sim.snapshot().nodeState.db).toBe('down'); expect(sim.snapshot().nodeState.svc).toBe('down');
  });
  it('connection pools cap concurrent database work, and hot-row locks serialize writes', () => {
    const d = structuredClone(ticketBookingDesign), s = structuredClone(ticketBookingScenario);
    db(d).params.writeTime = { kind: 'constant', us: 1000 }; db(d).params.connectionPool = 1;
    d.entities![0].dataset = { count: 2, keys: { kind: 'uniform', n: 2 } };
    d.endpoints[0].inputs = { id: { kind: 'sequence', start: 0 } };
    service(d).handlers!.put = [{ type: 'data', target: 'db', entity: 'tickets', op: { kind: 'put' }, timeoutUs: 30000 }];
    expect(run(d, s).nodes.find(n => n.nodeId === 'db')!.meanQueueWaitUs).toBeGreaterThan(0);
    db(d).params.connectionPool = 100; expect(run(d, s).nodes.find(n => n.nodeId === 'db')!.meanQueueWaitUs).toBe(0);
    delete d.endpoints[0].inputs; expect(run(d, s).nodes.find(n => n.nodeId === 'db')!.meanQueueWaitUs).toBeGreaterThan(0);
  });
  it('response fields determine serialized response bytes', () => {
    const d = structuredClone(ticketBookingDesign);
    d.endpoints[1].responseBytes = 10000; for (const e of d.edges) e.bandwidthBytesPerSec = 1e6;
    const full = traceRequest(d, 'get', 'item:0', 1).totalUs;
    d.endpoints[1].responseFields = ['remaining']; expect(traceRequest(d, 'get', 'item:0', 1).totalUs).toBeLessThan(full / 10);
  });
  it('endpoint input generators reset with every run', () => {
    const d = structuredClone(ticketBookingDesign), s = readScenario();
    d.endpoints[1].inputs = { id: { kind: 'sequence', start: 0 } };
    expect(run(d, s)).toEqual(run(d, s)); expect(run(d, s).metrics.statusCounts[404]).toBe(19);
  });
});

describe('network and composed chaos', () => {
  it('adds asymmetric region latency and directional egress charges', () => {
    const d = structuredClone(ticketBookingDesign), s = readScenario();
    const baseline = run(d, s); db(d).params.region = 'eu';
    d.regions = { names: ['us-east', 'eu'], latencyUs: [[0, 1000], [2000, 0]], egressCostPerGB: [[0, .1], [.2, 0]] };
    const cross = run(d, s); expect(cross.metrics.successLatency.p50! - baseline.metrics.successLatency.p50!).toBeGreaterThanOrEqual(2990);
    expect(cross.metrics.costBreakdown!.egress).toBeGreaterThan(0);
  });
  it('adds injected dependency latency on both transfer directions', () => {
    const d = structuredClone(ticketBookingDesign), s = readScenario(), baseline = run(d, s);
    s.chaos = [{ id: 'latency', kind: 'linkLatency', target: 'svc-db', atUs: 0, addUs: 1000 }];
    expect(run(d, s).metrics.successLatency.p50! - baseline.metrics.successLatency.p50!).toBeGreaterThanOrEqual(1990);
  });
  it('combines independent loss probabilities with the configured link loss', () => {
    const d = structuredClone(ticketBookingDesign), s = readScenario(); s.measureUs = 1000000;
    d.edges.find(e => e.id === 'svc-db')!.lossRate = .5;
    const baseline = run(d, s);
    s.chaos = [{ id: 'loss', kind: 'linkLoss', target: 'svc-db', atUs: 0, lossRate: .5 }];
    expect(run(d, s).metrics.succeeded).toBeLessThan(baseline.metrics.succeeded / 2);
  });
  it.each(['zoneOutage', 'regionOutage'] as const)('%s overrides simultaneous degraded/gray states', kind => {
    const d = structuredClone(ticketBookingDesign), s = readScenario();
    s.chaos = [{ id: 'outage', kind, target: kind === 'zoneOutage' ? 'a' : 'us-east', atUs: 0 }, { id: 'slow', kind: 'degrade', target: 'db', atUs: 0, slowFactor: 10 }, { id: 'gray', kind: 'gray', target: 'db', atUs: 0, errorRate: 1 }];
    expect(validateDesign(d, s)).toEqual([]);
    const sim = createSimulation(d, s, 1, { traceSampleRate: 0 }); sim.advance({ untilUs: 1000 }); expect(sim.snapshot().nodeState.db).toBe('down');
    expect(run(d, s).metrics.goodput).toBe(0);
  });
  it('a traffic spike changes the offered cohort and clock skew can expire dedup keys early', () => {
    const d = structuredClone(ticketBookingDesign), s = readScenario(), baseline = run(d, s); s.measureUs = 20001;
    s.chaos = [{ id: 'spike', kind: 'trafficSpike', target: '', atUs: 5000, endUs: 15000, multiplier: 3 }];
    expect(run(d, s).metrics.offered).toBeGreaterThan(baseline.metrics.offered);
    const payments = structuredClone(paymentsScenario); payments.chaos.push({ id: 'skew', kind: 'clockSkew', target: 'dedup', atUs: 10600, skewUs: 100000 });
    expect(run(paymentsDesign, payments).violations.map(v => v.kind)).toContain('duplicateEffect');
  });
});

it('handles generated valid P2 call graphs without NaN, time reversal or lost logical outcomes', () => {
  fc.assert(fc.property(fc.array(fc.constantFrom('service', 'dns', 'apiGateway', 'cdn', 'circuitBreaker'), { minLength: 1, maxLength: 6 }), fc.integer(), (kinds, seed) => {
    const d = structuredClone(ticketBookingDesign), s = readScenario();
    d.nodes = d.nodes.filter(n => n.kind !== 'service'); d.edges = [];
    d.nodes[0] = { id: 'client', kind: 'client', label: '', position: { x: 0, y: 0 }, params: { entry: 'n0' } };
    d.edges.push(link('client', 'n0'));
    kinds.forEach((kind, i) => {
      const id = `n${i}`, target = i + 1 === kinds.length ? 'db' : `n${i + 1}`, base = { id, label: '', position: { x: 0, y: 0 } };
      const n: NodeSpec = kind === 'service' ? { ...base, kind, params: { ...q, serviceTime: time }, handlers: { get: [{ type: 'call', target, timeoutUs: 30000 }] } } : kind === 'dns' ? { ...base, kind, params: { resolutionTime: time, ttlUs: 10000, records: [target] } } : kind === 'apiGateway' ? { ...base, kind, params: { ...q, serviceTime: time, maxRequestBytes: 1000 } } : kind === 'cdn' ? { ...base, kind, params: { ...q, serviceTime: time, capacityBytes: 10000, eviction: 'lru', ttlUs: 10000, originShield: true, costPerGB: .01 } } : { ...base, kind: 'circuitBreaker', params: { failureRateThreshold: .5, windowUs: 10000, minRequests: 2, openUs: 1000, halfOpenProbes: 1 } };
      d.nodes.push(n); d.edges.push(link(id, target));
    });
    expect(validateDesign(d, s)).toEqual([]);
    const sim = createSimulation(d, s, seed, { traceSampleRate: 0 }); let prior = 0;
    while (sim.advance({ maxEvents: 13 }) !== 'done') { const t = sim.snapshot().simTimeUs; expect(t).toBeGreaterThanOrEqual(prior); prior = t; }
    const r = sim.result(); expect(r.outcome).toBe('finished'); expect(r.metrics.offered).toBe(r.metrics.succeeded + r.metrics.failed + r.metrics.unfinished);
    const finite = (v: unknown) => { if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true); else if (v && typeof v === 'object') for (const x of Object.values(v)) finite(x); }; finite(r);
  }), { numRuns: 40 });
});
