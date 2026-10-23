import type { ChallengeSpec, Design, EdgeSpec, NodeSpec, QueueParams, Scenario, Step } from './types';

const queue = (concurrency: number, costPerHour: number): QueueParams => ({ concurrency, queueCapacity: 1000, queueDiscipline: 'fifo', costPerHour, region: 'us-east', zone: 'a' });
const edge = (from: string, to: string): EdgeSpec => ({ id: `${from}-${to}`, from, to, latency: { kind: 'constant', us: 100 }, bandwidthBytesPerSec: 1e9, lossRate: 0 });
const read: Step[] = [
  { type: 'cacheGet', cache: 'cache', timeoutUs: 2000 },
  { type: 'branch', cond: { kind: 'cacheHit' }, then: [{ type: 'respond', status: 200 }], else: [
    { type: 'call', target: 'db', timeoutUs: 200_000 },
    { type: 'cacheSet', cache: 'cache', timeoutUs: 2000 },
    { type: 'respond', status: 200 },
  ] },
];
const write: Step[] = [
  { type: 'call', target: 'db', timeoutUs: 200_000 },
  { type: 'cacheDelete', cache: 'cache', timeoutUs: 2000 },
  { type: 'respond', status: 200 },
];
const service = (id: string): NodeSpec<'service'> => ({ id, kind: 'service', label: `Service ${id.slice(-1)}`, position: { x: 420, y: id === 'svc1' ? 100 : 300 }, params: { ...queue(256, .035), serviceTime: { kind: 'constant', us: 100 } }, handlers: { get: structuredClone(read), put: structuredClone(write) } });

export const cacheAsideDesign: Design = {
  schemaVersion: 1, id: 'cache-aside', name: 'Cache-aside',
  nodes: [
    { id: 'client', kind: 'client', label: 'Clients', position: { x: 0, y: 200 }, params: { entry: 'lb' } },
    { id: 'lb', kind: 'loadBalancer', label: 'Load balancer', position: { x: 200, y: 200 }, params: { ...queue(512, .025), algorithm: 'roundRobin', serviceTime: { kind: 'constant', us: 50 }, healthCheck: { intervalUs: 100_000, unhealthyThreshold: 2, healthyThreshold: 2 } } },
    service('svc1'), service('svc2'),
    { id: 'cache', kind: 'cache', label: 'Cache', position: { x: 680, y: 100 }, params: { ...queue(64, .02), serviceTime: { kind: 'constant', us: 50 }, capacityBytes: 2_000_000, eviction: 'lru', ttlUs: 30_000_000, coalesce: true } },
    { id: 'db', kind: 'database', label: 'Database', position: { x: 680, y: 300 }, params: { ...queue(5, .2), queueCapacity: 40, readTime: { kind: 'exponential', meanUs: 5000 }, writeTime: { kind: 'exponential', meanUs: 4000 }, replicas: 1 } },
  ],
  edges: [edge('client', 'lb'), edge('lb', 'svc1'), edge('lb', 'svc2'), edge('svc1', 'cache'), edge('svc2', 'cache'), edge('svc1', 'db'), edge('svc2', 'db')],
  endpoints: [
    { id: 'get', name: 'GET /users/:userId', op: 'read', keyTemplate: 'user:{userId}', requestBytes: 128, responseBytes: 1024, idempotent: true },
    { id: 'put', name: 'PUT /users/:userId', op: 'write', keyTemplate: 'user:{userId}', requestBytes: 1024, responseBytes: 1024, idempotent: true },
  ],
};
export const noCacheDesign: Design = structuredClone(cacheAsideDesign);
noCacheDesign.id = 'no-cache'; noCacheDesign.name = 'Without caching';
// Keep the reachable cache node so the identical cache-failure scenario remains valid.
for (const n of noCacheDesign.nodes) if (n.kind === 'service') n.handlers = {
  get: [{ type: 'call', target: 'db', timeoutUs: 200_000 }, { type: 'respond', status: 200 }],
  put: [{ type: 'call', target: 'db', timeoutUs: 200_000 }, { type: 'respond', status: 200 }],
};
export const cachingScenario: Scenario = {
  id: 'zipf-cache-recovery', version: 1, warmupUs: 2_000_000, measureUs: 10_000_000, drainUs: 500_000,
  workload: { arrival: { kind: 'poisson', rps: 1500 }, mix: { get: .9, put: .1 }, keys: { kind: 'zipf', n: 2000, s: 1.25 }, deadlineUs: 250_000 },
  chaos: [{ id: 'cold-cache', kind: 'kill', target: 'cache', atUs: 7_000_000, endUs: 7_050_000 }],
};
export const cachingChallenge: ChallengeSpec = {
  id: 'cache-aside-recovery', title: 'Keep reads fast through a cache restart', scenario: cachingScenario,
  variantChaos: [[{ id: 'variant-cold-cache', kind: 'kill', target: 'cache', atUs: 5_000_000, endUs: 5_050_000 }]],
  slos: [{ kind: 'goodput', min: .99 }, { kind: 'successLatency', percentile: 'p99', maxUs: 80_000 }],
  invariants: ['duplicateEffect'], budgetPerMonth: 400,
  allowedKinds: ['client', 'loadBalancer', 'service', 'cache', 'database', 'rateLimiter'], seeds: [11, 22, 33, 44, 55],
};
