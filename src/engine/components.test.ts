import { describe, expect, it } from 'vitest';
import { runToCompletion, traceRequest, validateDesign } from './index';
import { cacheAsideDesign, cachingScenario } from './fixtures';
import type { Design, NodeSpec, QueueParams, Scenario, Step } from './types';

const q: QueueParams = { concurrency: 1, queueCapacity: 100, queueDiscipline: 'fifo', costPerHour: 0, region: 'test', zone: 'a' };
const settings = { traceSampleRate: 0 };
function topology(): Design {
  return { schemaVersion: 1, id: 'components', name: '', endpoints: [{ id: 'read', name: '', keyTemplate: 'k:{id}', requestBytes: 0, responseBytes: 100, op: 'read', idempotent: true }], nodes: [
    { id: 'client', kind: 'client', label: '', position: { x: 0, y: 0 }, params: { entry: 'svc' } },
    { id: 'svc', kind: 'service', label: '', position: { x: 0, y: 0 }, params: { ...q, concurrency: 100, serviceTime: { kind: 'constant', us: 1 } }, handlers: { read: [{ type: 'call', target: 'db', timeoutUs: 100000 }, { type: 'respond', status: 200 }] } },
    { id: 'db', kind: 'database', label: '', position: { x: 0, y: 0 }, params: { ...q, replicas: 1, readTime: { kind: 'constant', us: 1000 }, writeTime: { kind: 'constant', us: 1000 } } },
  ], edges: ['client-svc', 'svc-db'].map((id, i) => ({ id, from: i ? 'svc' : 'client', to: i ? 'db' : 'svc', latency: { kind: 'constant', us: 1 }, bandwidthBytesPerSec: 1e12, lossRate: 0 })) };
}
function workload(rps = 1000, measureUs = 10001): Scenario {
  return { id: 'components', version: 1, warmupUs: 0, measureUs, drainUs: 100000, chaos: [], workload: { arrival: { kind: 'constant', rps }, mix: { read: 1 }, keys: { kind: 'uniform', n: 1 }, deadlineUs: 100000 } };
}
const service = (d: Design) => d.nodes.find((n): n is NodeSpec<'service'> => n.kind === 'service')!;
const database = (d: Design) => d.nodes.find((n): n is NodeSpec<'database'> => n.kind === 'database')!;
const cacheNode = (d: Design) => d.nodes.find((n): n is NodeSpec<'cache'> => n.kind === 'cache')!;

describe('components and links', () => {
  it('serializes bandwidth FIFO independently in each direction and reports saturated links', () => {
    const d = topology(), s = workload(1000, 1000001);
    service(d).handlers = { read: [{ type: 'respond', status: 200 }] };
    // Leave the reachable DB connected, but this route has no storage dependency.
    d.endpoints[0].requestBytes = 1000; d.endpoints[0].responseBytes = 1000;
    d.edges[0].bandwidthBytesPerSec = 100000;
    s.workload.deadlineUs = 5e6; s.drainUs = 5e6;
    const r = runToCompletion(d, s, 1, settings);
    expect(r.metrics.offered).toBe(1000); expect(r.metrics.succeeded).toBeGreaterThan(400); expect(r.metrics.succeeded).toBeLessThan(600);
    expect(r.bottleneck?.nodeId).toBe('edge:client-svc'); expect(r.bottleneck?.utilisation).toBeGreaterThan(.98);
  });
  it('retains wasted work by default and cancels it when explicitly requested', () => {
    const d = topology(), s = workload(1, 1000001);
    const step: Step = { type: 'call', target: 'db', timeoutUs: 10 };
    service(d).handlers = { read: [step] };
    let r = runToCompletion(d, s, 1, settings);
    expect(r.metrics.failed).toBe(1); expect(r.nodes.find(n => n.nodeId === 'db')!.served).toBe(1); expect(r.nodes.find(n => n.nodeId === 'db')!.wastedWork).toBe(1);
    step.cancelOnTimeout = true; r = runToCompletion(d, s, 1, settings);
    expect(r.nodes.find(n => n.nodeId === 'db')!.served).toBe(0); expect(r.nodes.find(n => n.nodeId === 'db')!.inFlight).toBe(0);
  });
  it('FIFO and LIFO choose different waiting requests without losing outcomes', () => {
    const d = topology(), s = workload(10000, 1001);
    service(d).params.concurrency = 1;
    service(d).params.serviceTime = { kind: 'constant', us: 1000 };
    service(d).handlers = { read: [{ type: 'respond', status: 200 }] };
    const fifo = runToCompletion(d, s, 1, { traceSampleRate: 1 });
    service(d).params.queueDiscipline = 'lifo'; const lifo = runToCompletion(d, s, 1, settings);
    expect(fifo.metrics.succeeded).toBe(lifo.metrics.succeeded); expect(fifo.metrics.allLatency.p50).not.toBe(lifo.metrics.allLatency.p50);
    expect(lifo.nodes.find(n => n.nodeId === 'svc')!.maxQueue).toBe(8);
  });
  it.each(['tokenBucket', 'leakyBucket', 'fixedWindow', 'slidingWindow'] as const)('%s rejects with 429 and marks rejected traffic unadmitted', algorithm => {
    const d = topology(), s = workload(1000, 100001);
    d.nodes[1] = { id: 'svc', kind: 'rateLimiter', label: '', position: { x: 0, y: 0 }, params: { ...q, concurrency: 100, serviceTime: { kind: 'constant', us: 1 }, algorithm, burst: 3, ratePerSec: 10 } };
    const r = runToCompletion(d, s, 1, settings);
    expect(r.metrics.statusCounts[429]).toBeGreaterThan(90); expect(r.metrics.admitted).toBeLessThan(10); expect(r.metrics.goodput).toBeLessThan(.1);
  });
  it.each(['roundRobin', 'leastConnections', 'p2c', 'consistentHash'] as const)('%s forwards through healthy targets', algorithm => {
    const d = structuredClone(cacheAsideDesign), s = { ...cachingScenario, warmupUs: 0, measureUs: 100000, drainUs: 500000, chaos: [] };
    const lb = d.nodes.find((n): n is NodeSpec<'loadBalancer'> => n.kind === 'loadBalancer')!; lb.params.algorithm = algorithm;
    const r = runToCompletion(d, s, 1, settings);
    expect(r.metrics.goodput).toBe(1); expect(r.nodes.find(n => n.nodeId === 'lb')!.served).toBeGreaterThan(100);
  });
  it('active health checks exclude a killed target after the configured threshold', () => {
    const d = structuredClone(cacheAsideDesign), s: Scenario = { ...cachingScenario, warmupUs: 500000, measureUs: 500000, drainUs: 500000, chaos: [{ id: 'kill', kind: 'kill', target: 'svc1', atUs: 1 }] };
    const r = runToCompletion(d, s, 7, settings);
    expect(r.metrics.goodput).toBe(1); expect(r.nodes.find(n => n.nodeId === 'svc1')!.served).toBe(0);
  });
  it('gray targets pass health checks while failing requests', () => {
    const d = structuredClone(cacheAsideDesign), s: Scenario = { ...cachingScenario, warmupUs: 500000, measureUs: 500000, drainUs: 500000, chaos: [{ id: 'gray', kind: 'gray', target: 'svc1', atUs: 0, errorRate: 1 }] };
    const r = runToCompletion(d, s, 7, settings);
    expect(r.metrics.goodput).toBeGreaterThan(.4); expect(r.metrics.goodput).toBeLessThan(.6);
  });
  it('down loses in-flight and queued work, but a killed caller leaves downstream work running', () => {
    const d = topology(), s = workload(1000, 10001);
    database(d).params.readTime = { kind: 'constant', us: 10000 };
    s.chaos = [{ id: 'kill', kind: 'kill', target: 'svc', atUs: 5000 }];
    const r = runToCompletion(d, s, 1, settings);
    expect(r.metrics.goodput).toBe(0); expect(r.metrics.failed).toBe(r.metrics.offered);
    expect(r.nodes.find(n => n.nodeId === 'db')!.served).toBe(4);
    expect(r.nodes.find(n => n.nodeId === 'db')!.wastedWork).toBe(4);
  });
  it('degrade multiplies new service samples and ends at the specified time', () => {
    const d = topology(), s = workload(1, 1000001);
    s.chaos = [{ id: 'slow', kind: 'degrade', target: 'db', atUs: 0, endUs: 10000000, slowFactor: 10 }];
    const slow = runToCompletion(d, s, 1, settings); s.chaos = []; const fast = runToCompletion(d, s, 1, settings);
    expect(slow.metrics.successLatency.p50! / fast.metrics.successLatency.p50!).toBeGreaterThan(9);
  });
});

describe('real cache state', () => {
  it.each(['lru', 'lfu'] as const)('%s evicts to byte capacity and honors TTL expiry', eviction => {
    const d = structuredClone(cacheAsideDesign), c = cacheNode(d);
    c.params.eviction = eviction; c.params.capacityBytes = 1036; c.params.coalesce = false;
    const inputs = [{ endpointId: 'get', key: 'user:1' }, { endpointId: 'get', key: 'user:2' }];
    const trace = traceRequest(d, 'get', 'user:1', 2, inputs);
    expect(trace.dataOps).toContain('cache MISS user:1');
    c.params.capacityBytes = 100000; c.params.ttlUs = 1;
    expect(traceRequest(d, 'get', 'user:1', 2, [inputs[0]]).dataOps).toContain('cache MISS user:1');
  });
  it('coalesces concurrent cold reads and starts empty after a kill/restart', () => {
    const d = structuredClone(cacheAsideDesign), s: Scenario = { ...cachingScenario, warmupUs: 0, measureUs: 200000, drainUs: 500000, chaos: [] };
    s.workload = { ...s.workload, arrival: { kind: 'constant', rps: 5000 }, keys: { kind: 'uniform', n: 1 }, mix: { get: 1 } };
    for (const n of d.nodes) if (n.kind === 'service') {
      const get = n.handlers!.get![0]; if (get.type === 'cacheGet') get.timeoutUs = 200000;
    }
    const on = runToCompletion(d, s, 2, settings);
    cacheNode(d).params.coalesce = false; const off = runToCompletion(d, s, 2, settings);
    const dbCount = (r: typeof on) => r.nodes.find(n => n.nodeId === 'db')!.served;
    expect(dbCount(on)).toBe(1); expect(dbCount(off)).toBeGreaterThan(1);
    cacheNode(d).params.coalesce = true;
    s.chaos = [{ id: 'restart', kind: 'kill', target: 'cache', atUs: 100000, endUs: 100010 }];
    const restarted = runToCompletion(d, s, 2, settings);
    expect(dbCount(restarted)).toBeGreaterThanOrEqual(2); expect(restarted.metrics.goodput).toBeGreaterThan(.99);
  });
});

describe('remaining hard boundaries', () => {
  it('validates recursion, incompatible calls, malformed inputs and unsafe numeric values', () => {
    const d = topology(), s = workload();
    service(d).handlers = { read: [{ type: 'call', target: 'svc', timeoutUs: 1 }] };
    d.edges.push({ ...d.edges[0], id: 'loop', from: 'svc', to: 'svc' });
    expect(validateDesign(d, s).map(i => i.code)).toContain('ROUTE_DEPTH');
    service(d).handlers = { read: [{ type: 'cacheGet', cache: 'db', timeoutUs: 1 }] };
    expect(validateDesign(d, s).map(i => i.code)).toContain('INCOMPATIBLE_TARGET');
    expect(validateDesign({} as Design, s)[0].code).toBe('INVALID_INPUT');
    s.measureUs = Infinity; expect(validateDesign(topology(), s).length).toBeGreaterThan(0);
    expect(runToCompletion(topology(), s, 1, settings).outcome).toBe('inconclusive');
  });
  it.each(['events', 'heap', 'queued', 'memoryBytes'] as const)('reports the %s limit with guidance', limit => {
    const d = topology(), s = workload(10000, 100001);
    database(d).params.readTime = { kind: 'constant', us: 100000 };
    const r = runToCompletion(d, s, 1, { ...settings, limits: { [limit]: limit === 'memoryBytes' ? 1000 : 2 } });
    expect(r.outcome).toBe('inconclusive'); expect(r.inconclusiveReason).toContain('resource limit'); expect(r.inconclusiveReason).toContain('Scale mode');
  });
});
