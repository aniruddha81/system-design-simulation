import type { ChallengeSpec, Design, EdgeSpec, EntitySpec, NodeSpec, QueueParams, Scenario, Step } from './types';

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

const instant = { kind: 'constant', us: 1 } as const;
const p2node = <K extends NodeSpec['kind']>(id: string, kind: K, params: Extract<NodeSpec, { kind: K }>['params']): NodeSpec => ({ id, kind, params, label: id, position: { x: 0, y: 0 } } as NodeSpec);
const p2entity = (name: string, store: string, field: string, initial: number): EntitySpec => ({ name, store, primaryKey: 'id', fields: [{ name: 'id', type: 'string', bytes: { meanBytes: 8, sdBytes: 0 } }, { name: field, type: 'int', bytes: { meanBytes: 8, sdBytes: 0 } }], indexes: [], dataset: { count: 1, keys: { kind: 'sequential', n: 1 }, initial: { [field]: initial } } });
const p2scenario = (id: string, rps = 1000, measureUs = 50000): Scenario => ({ id, version: 1, warmupUs: 0, measureUs, drainUs: 50000, chaos: [], workload: { arrival: { kind: 'constant', rps }, mix: { put: 1 }, keys: { kind: 'uniform', n: 1 }, deadlineUs: 40000 } });
function storeDesign(id: string, store: NodeSpec, entity: EntitySpec, write: Step[]): Design {
  return { schemaVersion: 1, id, name: id, nodes: [p2node('client', 'client', { entry: 'svc' }), { ...p2node('svc', 'service', { ...queue(100, 0), serviceTime: instant }), handlers: { put: write, get: [{ type: 'data', target: store.id, entity: entity.name, op: { kind: 'get' }, timeoutUs: 30000 }] } }, store], edges: [edge('client', 'svc'), edge('svc', store.id)], entities: [entity], endpoints: [
    { id: 'put', name: 'Write', op: 'write', keyTemplate: 'item:{id}', requestBytes: 8, responseBytes: 16, idempotent: false },
    { id: 'get', name: 'Read', op: 'read', keyTemplate: 'item:{id}', requestBytes: 8, responseBytes: 16, idempotent: true },
  ] };
}
const p2db = () => p2node('db', 'database', { ...queue(100, 0), readTime: instant, writeTime: instant, replicas: 1 });

export const paymentsDesign = storeDesign('payments', p2db(), p2entity('ledger', 'db', 'total', 0), []);
paymentsDesign.nodes.push({ ...p2node('payments', 'service', { ...queue(100, 0), serviceTime: instant }), handlers: { put: [
  { type: 'dedup', store: 'dedup', timeoutUs: 500 },
  { type: 'branch', cond: { kind: 'dedupHit' }, then: [{ type: 'respond', status: 200 }], else: [{ type: 'data', target: 'db', entity: 'ledger', op: { kind: 'update', field: 'total', op: 'increment', value: 1 }, timeoutUs: 500 }] },
] } }, p2node('dedup', 'dedupStore', { ...queue(100, 0), serviceTime: instant, ttlUs: 100000, atomic: true, durable: true }));
paymentsDesign.edges.push(edge('svc', 'payments'), edge('payments', 'db'), edge('payments', 'dedup'));
paymentsDesign.nodes.find(n => n.id === 'svc')!.handlers!.put = [{ type: 'call', target: 'payments', timeoutUs: 1000, retry: { max: 2, backoffUs: 1, multiplier: 1, jitter: 'none', retryOn: ['timeout'] } }];
export const paymentsScenario = p2scenario('lost-payment-ack', 100, 20001);
paymentsScenario.chaos = [{ id: 'lost-ack', kind: 'partition', target: '', atUs: 10600, endUs: 11000, links: [{ from: 'payments', to: 'svc' }] }];
export const paymentsWithoutDedupDesign = structuredClone(paymentsDesign);
paymentsWithoutDedupDesign.id = 'payments-without-dedup';
paymentsWithoutDedupDesign.nodes.find(n => n.id === 'payments')!.handlers!.put = [{ type: 'data', target: 'db', entity: 'ledger', op: { kind: 'update', field: 'total', op: 'increment', value: 1 }, timeoutUs: 500 }];
for (const n of paymentsWithoutDedupDesign.nodes) if (n.id === 'payments' && n.kind === 'service') n.params.serviceTime = { kind: 'constant', us: 204 };

export const ticketBookingDesign = storeDesign('ticket-booking', p2db(), p2entity('tickets', 'db', 'remaining', 1), [{ type: 'data', target: 'db', entity: 'tickets', op: { kind: 'decrementIfPositive', field: 'remaining' }, timeoutUs: 30000 }]);
export const ticketBookingScenario = p2scenario('one-seat-two-buyers', 20000, 101);
export const unsafeTicketBookingDesign = structuredClone(ticketBookingDesign);
unsafeTicketBookingDesign.nodes.find(n => n.id === 'svc')!.handlers!.put = [{ type: 'data', target: 'db', entity: 'tickets', op: { kind: 'get' }, timeoutUs: 30000 }, { type: 'data', target: 'db', entity: 'tickets', op: { kind: 'update', field: 'remaining', op: 'increment', value: -1 }, timeoutUs: 30000 }];

export const replicationFailoverDesign = storeDesign('async-failover', p2node('db', 'database', { ...queue(100, 0), readTime: instant, writeTime: instant, replicas: 3, replication: 'async', replicationLag: { kind: 'constant', us: 10000 }, readFromReplicas: true, walDurable: true, failover: { heartbeatUs: 100, missedHeartbeats: 2, electionUs: 100, fencing: false } }), p2entity('account', 'db', 'balance', 0), [{ type: 'data', target: 'db', entity: 'account', op: { kind: 'update', field: 'balance', op: 'increment' }, timeoutUs: 30000 }]);
export const replicationFailoverScenario = p2scenario('leader-failure');
replicationFailoverScenario.chaos = [{ id: 'leader-down', kind: 'kill', target: 'db', atUs: 4500, endUs: 9000 }];
export const fencedFailoverDesign = structuredClone(replicationFailoverDesign);
for (const n of fencedFailoverDesign.nodes) if (n.kind === 'database') { n.params.replication = 'sync'; n.params.failover!.fencing = true; }

export const kvQuorumDesign = storeDesign('kv-quorum', p2node('kv', 'kvStore', { ...queue(100, 0), readTime: instant, writeTime: instant, members: 3, vnodes: 32, replicationFactor: 3, readQuorum: 1, writeQuorum: 1, hintedHandoff: false, readRepair: false, tombstoneGcUs: 100000 }), p2entity('items', 'kv', 'value', 0), [{ type: 'data', target: 'kv', entity: 'items', op: { kind: 'put' }, timeoutUs: 30000 }]);
export const kvQuorumScenario = p2scenario('quorum-read-write');
kvQuorumScenario.workload.mix = { put: .5, get: .5 };
export const intersectingQuorumDesign = structuredClone(kvQuorumDesign);
for (const n of intersectingQuorumDesign.nodes) if (n.kind === 'kvStore') { n.params.readQuorum = 2; n.params.writeQuorum = 2; }

export const queueDlqDesign: Design = { ...storeDesign('queue-dlq', p2db(), p2entity('effects', 'db', 'count', 0), [{ type: 'publish', queue: 'jobs', orderedByKey: true, timeoutUs: 30000 }]), nodes: [] };
queueDlqDesign.nodes = [p2node('client', 'client', { entry: 'svc' }), { ...p2node('svc', 'service', { ...queue(100, 0), serviceTime: instant }), handlers: { put: [{ type: 'publish', queue: 'jobs', orderedByKey: true, timeoutUs: 30000 }] } }, p2db(), p2node('jobs', 'queue', { partitions: 2, capacityMessages: 100, visibilityTimeoutUs: 1000, maxDeliveries: 3, retentionUs: 100000, publishTime: instant, costPerHour: 0, region: 'us-east', zone: 'a' }), { ...p2node('consumer', 'worker', { ...queue(4, 0), serviceTime: instant, source: 'jobs', batchSize: 4 }), handlers: { put: [{ type: 'respond', status: 503 }] } }];
queueDlqDesign.edges = [edge('client', 'svc'), edge('svc', 'jobs'), edge('consumer', 'db')];
export const queueDlqScenario = p2scenario('queue-redelivery-dlq', 1000, 10001);

export const retryStormDesign: Design = { ...paymentsDesign, id: 'retry-storm', nodes: [p2node('client', 'client', { entry: 'svc' }), { ...p2node('svc', 'service', { ...queue(100, 0), serviceTime: instant }), handlers: { put: [{ type: 'call', target: 'breaker', timeoutUs: 5000, retry: { max: 3, backoffUs: 100, multiplier: 1, jitter: 'none', retryOn: ['5xx'] } }] } }, p2node('breaker', 'circuitBreaker', { failureRateThreshold: .5, windowUs: 10000, minRequests: 2, openUs: 5000, halfOpenProbes: 1, bulkheadMax: 10 }), { ...p2node('downstream', 'service', { ...queue(100, 0), serviceTime: instant }), handlers: { put: [{ type: 'respond', status: 503 }] } }], edges: [edge('client', 'svc'), edge('svc', 'breaker'), edge('breaker', 'downstream')], entities: [] };
export const retryStormScenario = p2scenario('retry-storm-breaker');

export const cdnObjectStoreDesign: Design = { schemaVersion: 1, id: 'cdn-objects', name: 'CDN and object store', nodes: [p2node('client', 'client', { entry: 'cdn' }), p2node('cdn', 'cdn', { ...queue(100, .01), serviceTime: instant, capacityBytes: 100000, eviction: 'lru', ttlUs: 100000, originShield: true, costPerGB: .08 }), p2node('objects', 'objectStore', { readTime: { kind: 'constant', us: 1000 }, writeTime: { kind: 'constant', us: 1000 }, costPerGBMonth: .02, costPerMillionRequests: .4, region: 'us-east', zone: 'a' })], edges: [edge('client', 'cdn'), edge('cdn', 'objects')], endpoints: [{ id: 'get', name: 'Asset', op: 'read', keyTemplate: 'asset:{id}', requestBytes: 8, responseBytes: 4096, idempotent: true }], entities: [p2entity('assets', 'objects', 'size', 4096)] };
export const cdnObjectStoreScenario = p2scenario('popular-assets', 1000);
cdnObjectStoreScenario.workload.mix = { get: 1 };

export const autoscalingDesign: Design = { ...retryStormDesign, id: 'autoscaling', name: 'Scale a step load', nodes: [p2node('client', 'client', { entry: 'svc' }), p2node('svc', 'service', { ...queue(1, .01), serviceTime: { kind: 'constant', us: 10000 } }), p2node('autoscaler', 'autoscaler', { targets: ['svc'], metric: 'utilisation', targetValue: .7, min: 1, max: 64, cooldownUs: 50000, provisionUs: 10000, warmupUs: 10000, evaluateEveryUs: 10000 })], edges: [edge('client', 'svc')] };
export const autoscalingScenario = p2scenario('step-autoscaling', 100, 500000);
autoscalingScenario.workload.arrival = { kind: 'step', rps: 100, stepAtUs: 100000, stepRps: 1000 };
