import { expect, it } from 'vitest';
import type { Design, NodeSpec, Step } from '../types';
import { designSchema } from '../../lib/persistence/schemas';

it('round-trips every P2 design field, stripping unknown fields and enforcing graph limits', () => {
  const d = { kind: 'constant', us: 10 } as const;
  const q = { concurrency: 2, queueCapacity: 10, queueDiscipline: 'fifo' as const, costPerHour: .1, region: 'east', zone: 'a', restartWarmupUs: 20 };
  const meta = { id: 'node', label: 'Node', position: { x: 0, y: 0 } };
  const nodes: NodeSpec[] = [
    { ...meta, kind: 'database', params: { ...q, readTime: d, writeTime: d, replicas: 3, replication: 'semiSync', replicationLag: d, readFromReplicas: true, walDurable: true, connectionPool: 4, failover: { heartbeatUs: 10, missedHeartbeats: 3, electionUs: 20, fencing: true } } },
    { ...meta, kind: 'rateLimiter', params: { ...q, serviceTime: d, algorithm: 'slidingWindow', ratePerSec: 5, burst: 10, centralised: true } },
    { ...meta, kind: 'dns', params: { resolutionTime: d, ttlUs: 10, records: ['node'] } },
    { ...meta, kind: 'cdn', params: { ...q, serviceTime: d, capacityBytes: 100, eviction: 'lfu', ttlUs: 10, originShield: true, costPerGB: .2 } },
    { ...meta, kind: 'apiGateway', params: { ...q, serviceTime: d, maxRequestBytes: 1000 } },
    { ...meta, kind: 'kvStore', params: { ...q, readTime: d, writeTime: d, members: 3, vnodes: 10, replicationFactor: 3, readQuorum: 2, writeQuorum: 2, hintedHandoff: true, readRepair: true, tombstoneGcUs: 10 } },
    { ...meta, kind: 'queue', params: { partitions: 2, capacityMessages: 100, visibilityTimeoutUs: 20, maxDeliveries: 3, retentionUs: 100, publishTime: d, costPerHour: .1, region: 'east', zone: 'a' } },
    { ...meta, kind: 'worker', params: { ...q, serviceTime: d, source: 'node', batchSize: 2 } },
    { ...meta, kind: 'objectStore', params: { readTime: d, writeTime: d, costPerGBMonth: .1, costPerMillionRequests: .2, region: 'east', zone: 'a' } },
    { ...meta, kind: 'searchIndex', params: { ...q, serviceTime: d, indexLag: d, source: 'node' } },
    { ...meta, kind: 'dedupStore', params: { ...q, serviceTime: d, ttlUs: 10, atomic: true, durable: true } },
    { ...meta, kind: 'autoscaler', params: { targets: ['node'], metric: 'queueLength', targetValue: 5, min: 1, max: 10, cooldownUs: 10, provisionUs: 10, warmupUs: 10, evaluateEveryUs: 10 } },
    { ...meta, kind: 'circuitBreaker', params: { failureRateThreshold: .5, windowUs: 10, minRequests: 5, openUs: 10, halfOpenProbes: 1, bulkheadMax: 10 } },
  ];
  const steps: Step[] = [
    { type: 'call', target: 'node', timeoutUs: 10, propagateDeadline: true },
    ...(['all', 'any', 'quorum', 'firstN'] as const).map(kind => ({ type: 'parallel' as const, branches: [[{ type: 'respond' as const, status: 200 as const }]], join: kind === 'quorum' ? { kind, k: 1 } : kind === 'firstN' ? { kind, n: 1 } : { kind }, cancelLosers: true })),
    { type: 'publish', queue: 'node', timeoutUs: 10, orderedByKey: true }, { type: 'dedup', store: 'node', timeoutUs: 10 },
    ...(['found', 'dedupHit', 'leaderAlive', 'breakerClosed'] as const).map(kind => ({ type: 'branch' as const, cond: kind === 'leaderAlive' ? { kind, store: 'node' } : kind === 'breakerClosed' ? { kind, breaker: 'node' } : { kind }, then: [], else: [] })),
    ...(['get', 'insert', 'put', 'delete', 'conditionalPut'] as const).map(kind => ({ type: 'data' as const, target: 'node', entity: 'users', op: { kind }, timeoutUs: 10 })),
    { type: 'data', target: 'node', entity: 'users', op: { kind: 'query', index: 'id', limit: 10 }, timeoutUs: 10, retry: { max: 1, backoffUs: 1, multiplier: 2, jitter: 'full', retryOn: ['5xx'] } },
    { type: 'data', target: 'node', entity: 'users', op: { kind: 'update', field: 'stock', op: 'increment' }, timeoutUs: 10 },
    { type: 'data', target: 'node', entity: 'users', op: { kind: 'update', field: 'stock', op: 'set', value: 5 }, timeoutUs: 10 },
    { type: 'data', target: 'node', entity: 'users', op: { kind: 'conditionalPut', expectedVersion: 2 }, timeoutUs: 10 },
    { type: 'data', target: 'node', entity: 'users', op: { kind: 'decrementIfPositive', field: 'stock' }, timeoutUs: 10 },
  ];
  nodes[0].handlers = { get: steps };
  const design: Design = {
    schemaVersion: 1, id: 'p2', name: 'P2', nodes, edges: [],
    endpoints: [{ id: 'get', name: 'Get', op: 'read', keyTemplate: '{id}', requestBytes: 10, responseBytes: 10, idempotent: true, inputs: { id: { kind: 'zipf', min: 1, max: 10, s: 1 }, uniform: { kind: 'uniform', min: 1, max: 5 }, sequence: { kind: 'sequence', start: 1 }, size: { kind: 'size', meanBytes: 10, sdBytes: 2 } }, responseFields: ['id'] }],
    entities: [{ name: 'users', store: 'node', fields: ['string', 'int', 'float', 'bool', 'timestamp'].map(type => ({ name: type, type: type as 'string' | 'int' | 'float' | 'bool' | 'timestamp', bytes: { meanBytes: 10, sdBytes: 2 } })), primaryKey: 'string', indexes: [{ name: 'id', fields: ['int'], unique: true }], shardKey: 'int', dataset: { count: 10, keys: { kind: 'hotspot', n: 10, hotFraction: .5 }, initial: { int: 3 } } }],
    regions: { names: ['east'], latencyUs: [[0]], egressCostPerGB: [[0]] },
    groups: [{ id: 'region', kind: 'region', name: 'east', position: { x: 0, y: 0 }, size: { w: 100, h: 100 } }, { id: 'zone', kind: 'zone', name: 'a', position: { x: 1, y: 1 }, size: { w: 50, h: 50 } }],
    annotations: [{ type: 'ink', points: [1, 2] }, { text: 'hello' }],
  };
  expect(designSchema.parse({ ...design, unknown: true, nodes: nodes.map(n => ({ ...n, unknown: true, params: { ...n.params, unknown: true } })) })).toEqual(design);
  expect(designSchema.safeParse({ ...design, nodes: Array(201).fill(nodes[0]) }).success).toBe(false);
  expect(designSchema.safeParse({ ...design, edges: Array(601).fill({ id: 'e', from: 'a', to: 'b', latency: d, bandwidthBytesPerSec: 1, lossRate: 0 }) }).success).toBe(false);
  expect(designSchema.safeParse({ ...design, entities: [{ ...design.entities![0], dataset: { count: 1_000_001, keys: { kind: 'uniform', n: 10 } } }] }).success).toBe(false);
});
