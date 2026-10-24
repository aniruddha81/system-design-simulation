import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createSimulation, designHash, gradeChallenge, runToCompletion, traceRequest, validateDesign } from './index';
import { autoscalingDesign, autoscalingScenario, cacheAsideDesign, cdnObjectStoreDesign, cdnObjectStoreScenario, fencedFailoverDesign, intersectingQuorumDesign, kvQuorumDesign, kvQuorumScenario, paymentsDesign, paymentsScenario, paymentsWithoutDedupDesign, queueDlqDesign, queueDlqScenario, replicationFailoverDesign, replicationFailoverScenario, retryStormDesign, retryStormScenario, ticketBookingDesign, ticketBookingScenario, unsafeTicketBookingDesign } from './fixtures';
import type { Design, InvariantKind, LiveEdit, NodeSpec, Scenario, Step } from './types';

const settings = { traceSampleRate: 0 };
const run = (d: Design, s: Scenario, seed = 1) => runToCompletion(d, s, seed, settings);
const kinds = (d: Design, s: Scenario, seed = 1) => run(d, s, seed).violations.map(v => v.kind);
const node = <K extends NodeSpec['kind']>(d: Design, kind: K) => d.nodes.find((n): n is Extract<NodeSpec, { kind: K }> => n.kind === kind)!;
const svc = (d: Design) => node(d, 'service');
const clone = <T>(v: T): T => structuredClone(v);

describe('P2 fixtures and invariant pairs', () => {
  it.each([
    [paymentsDesign, paymentsScenario], [ticketBookingDesign, ticketBookingScenario], [replicationFailoverDesign, replicationFailoverScenario],
    [kvQuorumDesign, kvQuorumScenario], [queueDlqDesign, queueDlqScenario], [retryStormDesign, retryStormScenario], [cdnObjectStoreDesign, cdnObjectStoreScenario], [autoscalingDesign, autoscalingScenario],
  ])('validates and finishes $0.id', (design, scenario) => {
    expect(validateDesign(design, scenario)).toEqual([]);
    const r = run(design, scenario);
    expect(r.outcome).toBe('finished'); expect(r.metrics.offered).toBe(r.metrics.succeeded + r.metrics.failed + r.metrics.unfinished);
  });
  it('lost acknowledgements duplicate a payment effect without dedup and preserve it with dedup', () => {
    expect(kinds(paymentsWithoutDedupDesign, paymentsScenario)).toContain('duplicateEffect');
    expect(kinds(paymentsDesign, paymentsScenario)).not.toContain('duplicateEffect');
    expect(run(paymentsDesign, paymentsScenario).metrics.goodput).toBe(1);
  });
  it('oversells a read-then-update booking, while atomic decrement rejects the second buyer', () => {
    expect(kinds(unsafeTicketBookingDesign, ticketBookingScenario)).toContain('oversell');
    const safe = run(ticketBookingDesign, ticketBookingScenario);
    expect(safe.violations).toEqual([]); expect(safe.metrics.statusCounts[409]).toBe(1);
  });
  it('loses acknowledged async writes on promotion; sync writes survive', () => {
    expect(kinds(replicationFailoverDesign, replicationFailoverScenario)).toContain('ackedWriteLost');
    expect(kinds(fencedFailoverDesign, replicationFailoverScenario)).not.toContain('ackedWriteLost');
  });
  it('detects overlapping leaders across terms without fencing; fencing rejects the stale leader', () => {
    expect(kinds(replicationFailoverDesign, replicationFailoverScenario)).toContain('splitBrainWrite');
    expect(kinds(fencedFailoverDesign, replicationFailoverScenario)).not.toContain('splitBrainWrite');
  });
  it('weak quorums can return stale data; intersecting read/write quorums cannot', () => {
    expect(kinds(kvQuorumDesign, kvQuorumScenario)).toContain('staleRead');
    expect(kinds(intersectingQuorumDesign, kvQuorumScenario)).not.toContain('staleRead');
  });
  it('hinted handoff converges replicas and read repair fills a contacted stale replica', () => {
    const d = clone(kvQuorumDesign); node(d, 'kvStore').params.hintedHandoff = true;
    expect(kinds(d, kvQuorumScenario)).not.toContain('staleRead');
    node(d, 'kvStore').params.hintedHandoff = false; node(d, 'kvStore').params.readQuorum = 2;
    const prior = [{ endpointId: 'put', key: 'item:0' }, { endpointId: 'get', key: 'item:0' }];
    expect(traceRequest(d, 'get', 'item:0', 1, prior).dataOps.some(s => s.endsWith('v1'))).toBe(true);
    node(d, 'kvStore').params.readRepair = true;
    expect(traceRequest(d, 'get', 'item:0', 1, prior).dataOps.some(s => s.endsWith('v2'))).toBe(true);
  });
  it('retained tombstones prevent resurrection; premature GC exposes the remaining stale copy', () => {
    const d = clone(intersectingQuorumDesign), s = clone(kvQuorumScenario);
    svc(d).handlers!.put = [{ type: 'data', target: 'kv', entity: 'items', op: { kind: 'delete' }, timeoutUs: 30000 }];
    s.workload.mix = { put: .1, get: .9 };
    expect(kinds(d, s)).not.toContain('staleRead');
    node(d, 'kvStore').params.tombstoneGcUs = 1;
    expect(kinds(d, s)).toContain('staleRead');
  });
  it('enforces unique indexes on one leader and detects unfenced cross-leader uniqueness conflicts', () => {
    const d = clone(replicationFailoverDesign), s = clone(replicationFailoverScenario);
    d.entities![0].fields.push({ name: 'email', type: 'string', bytes: { meanBytes: 20, sdBytes: 0 } });
    d.entities![0].indexes = [{ name: 'unique-email', fields: ['email'], unique: true }];
    d.endpoints[0].inputs = { id: { kind: 'sequence', start: 10 } };
    s.workload.arrival = { kind: 'step', rps: 0, stepAtUs: 20000, stepRps: 1000 };
    svc(d).handlers!.put = [{ type: 'data', target: 'db', entity: 'account', op: { kind: 'insert', values: { email: 'same' } }, timeoutUs: 30000 }];
    expect(kinds(d, s)).toContain('uniquenessViolated');
    node(d, 'database').params.failover!.fencing = true;
    expect(kinds(d, s)).not.toContain('uniquenessViolated');
  });
  it('checks late queue completions for ordering; a visibility timeout longer than service preserves order', () => {
    const d = clone(queueDlqDesign), s = clone(queueDlqScenario);
    node(d, 'worker').handlers = { put: [{ type: 'respond', status: 200 }] };
    node(d, 'worker').params.serviceTime = { kind: 'empirical', buckets: [{ us: 1, weight: 1 }, { us: 4000, weight: 1 }] };
    s.measureUs = 5001;
    const seeds = Array.from({ length: 20 }, (_, i) => i);
    expect(seeds.some(seed => kinds(d, s, seed).includes('orderingViolated'))).toBe(true);
    node(d, 'queue').params.visibilityTimeoutUs = 10000;
    for (const seed of seeds) expect(kinds(d, s, seed)).not.toContain('orderingViolated');
  });
});

describe('dedup honesty', () => {
  it.each(['expiry', 'restart'] as const)('a key lost through %s permits a late retry; the durable/long-TTL control prevents it', mode => {
    const d = clone(paymentsDesign), s = clone(paymentsScenario), dedup = node(d, 'dedupStore');
    if (mode === 'expiry') dedup.params.ttlUs = 1;
    else { dedup.params.durable = false; s.chaos.push({ id: 'dedup-restart', kind: 'kill', target: dedup.id, atUs: 10600, endUs: 10601 }); }
    expect(kinds(d, s)).toContain('duplicateEffect');
    dedup.params.ttlUs = 100000; dedup.params.durable = true;
    expect(kinds(d, s)).not.toContain('duplicateEffect');
  });
  it('reproduces a check-then-act race between concurrent deliveries; atomic insert blocks it', () => {
    const d = clone(queueDlqDesign), s = clone(queueDlqScenario), consumer = node(d, 'worker');
    const dedup = clone(node(paymentsDesign, 'dedupStore')); dedup.params.atomic = false; dedup.params.serviceTime = { kind: 'constant', us: 2000 };
    d.nodes.push(dedup); d.edges.push({ ...d.edges[0], id: 'consumer-dedup', from: 'consumer', to: 'dedup' });
    consumer.params.serviceTime = { kind: 'constant', us: 1 };
    consumer.handlers = { put: [{ type: 'dedup', store: 'dedup', timeoutUs: 10000 }, { type: 'branch', cond: { kind: 'dedupHit' }, then: [{ type: 'respond', status: 200 }], else: [{ type: 'data', target: 'db', entity: 'effects', op: { kind: 'update', field: 'count', op: 'increment' }, timeoutUs: 10000 }] }] };
    s.measureUs = 1001;
    expect(kinds(d, s)).toContain('duplicateEffect');
    dedup.params.atomic = true;
    expect(kinds(d, s)).not.toContain('duplicateEffect');
  });
});

describe('routes, data, replication and queues', () => {
  it.each(['all', 'any', 'quorum', 'firstN'] as const)('joins parallel branches with %s', kind => {
    const d = clone(ticketBookingDesign), s = clone(ticketBookingScenario);
    const join = kind === 'quorum' ? { kind, k: 1 } : kind === 'firstN' ? { kind, n: 1 } : { kind };
    svc(d).handlers!.put = [{ type: 'parallel', branches: [[{ type: 'respond', status: 200 }], [{ type: 'respond', status: 503 }]], join, cancelLosers: true }];
    expect(run(d, s).metrics.goodput).toBe(kind === 'all' ? 0 : 1);
  });
  it('propagates a deadline to queued work and leaves uncancelled slow work otherwise', () => {
    const d = clone(ticketBookingDesign), s = clone(ticketBookingScenario);
    const db = node(d, 'database'); db.params.concurrency = 1; db.params.writeTime = { kind: 'constant', us: 1000 };
    const call: Step = { type: 'call', target: 'db', timeoutUs: 500, propagateDeadline: true };
    svc(d).handlers!.put = [call];
    const propagated = run(d, s);
    call.propagateDeadline = false;
    const unpropagated = run(d, s);
    expect(propagated.nodes.find(n => n.nodeId === 'db')!.wastedWork).toBeLessThanOrEqual(unpropagated.nodes.find(n => n.nodeId === 'db')!.wastedWork!);
  });
  it('reads deterministic seeded records, enforces missing/conflict statuses, and resets between runs', () => {
    const d = clone(ticketBookingDesign);
    expect(traceRequest(d, 'get', 'item:0', 7).status).toBe(200);
    expect(traceRequest(d, 'get', 'item:999', 7).status).toBe(404);
    const prior = [{ endpointId: 'put', key: 'item:0' }];
    expect(traceRequest(d, 'put', 'item:0', 7, prior).status).toBe(409);
    expect(traceRequest(d, 'put', 'item:0', 7).status).toBe(200);
    const first = run(d, ticketBookingScenario); expect(run(d, ticketBookingScenario)).toEqual(first);
  });
  it('uses found state and the preceding version for conditional updates', () => {
    const d = clone(ticketBookingDesign);
    svc(d).handlers!.put = [{ type: 'data', target: 'db', entity: 'tickets', op: { kind: 'get' }, timeoutUs: 30000 }, { type: 'branch', cond: { kind: 'found' }, then: [{ type: 'data', target: 'db', entity: 'tickets', op: { kind: 'conditionalPut' }, timeoutUs: 30000 }], else: [{ type: 'respond', status: 404 }] }];
    expect(traceRequest(d, 'put', 'item:0', 1).status).toBe(200);
    expect(traceRequest(d, 'put', 'item:999', 1).status).toBe(404);
    const branch = svc(d).handlers!.put![1]; if (branch.type !== 'branch' || branch.then[0].type !== 'data') throw Error('fixture');
    branch.then[0].op = { kind: 'conditionalPut', expectedVersion: 999 };
    expect(traceRequest(d, 'put', 'item:0', 1).status).toBe(409);
  });
  it('leaderAlive treats degraded leaders as alive, and breakerClosed reads actual breaker state', () => {
    const d = clone(ticketBookingDesign), s = clone(ticketBookingScenario);
    svc(d).handlers!.put = [{ type: 'branch', cond: { kind: 'leaderAlive', store: 'db' }, then: [{ type: 'respond', status: 200 }], else: [{ type: 'respond', status: 503 }] }];
    s.chaos = [{ id: 'slow-leader', kind: 'degrade', target: 'db', atUs: 0, slowFactor: 2 }]; expect(run(d, s).metrics.goodput).toBe(1);
    s.chaos = [{ id: 'dead-leader', kind: 'kill', target: 'db', atUs: 0 }]; expect(run(d, s).metrics.goodput).toBe(0);
    const breaker = clone(retryStormDesign);
    svc(breaker).handlers!.put = [{ type: 'branch', cond: { kind: 'breakerClosed', breaker: 'breaker' }, then: [{ type: 'call', target: 'breaker', timeoutUs: 5000 }], else: [{ type: 'respond', status: 409 }] }];
    expect(run(breaker, retryStormScenario).metrics.statusCounts[409]).toBeGreaterThan(0);
  });
  it('unindexed queries cost more than indexed queries', () => {
    const d = clone(ticketBookingDesign); d.entities![0].dataset = { count: 1000, keys: { kind: 'uniform', n: 1000 } };
    const step: Step = { type: 'data', target: 'db', entity: 'tickets', op: { kind: 'query', limit: 1 }, timeoutUs: 30000 };
    svc(d).handlers!.get = [step];
    const scan = traceRequest(d, 'get', 'item:0', 3).totalUs;
    step.op = { kind: 'query', index: 'id', limit: 1 };
    expect(traceRequest(d, 'get', 'item:0', 3).totalUs).toBeLessThan(scan);
  });
  it('replica reads expose async lag, while sync acknowledgements wait for shipping', () => {
    const d = clone(replicationFailoverDesign), s = clone(replicationFailoverScenario); s.chaos = []; s.workload.mix = { put: .5, get: .5 };
    expect(kinds(d, s)).toContain('staleRead');
    node(d, 'database').params.replication = 'sync';
    expect(kinds(d, s)).not.toContain('staleRead');
  });
  it('redelivers failed deliveries into a DLQ while publisher success stays independent', () => {
    const r = run(queueDlqDesign, queueDlqScenario), q = r.nodes.find(n => n.nodeId === 'jobs')!.queue!;
    expect(r.metrics.goodput).toBe(1); expect(q.redelivered).toBeGreaterThan(0); expect(q.deadLettered).toBe(10);
  });
  it('selects the oldest eligible partition head without starving an overloaded partition', () => {
    const d = clone(queueDlqDesign), s = clone(queueDlqScenario);
    node(d, 'queue').params.partitions = 4; node(d, 'queue').params.retentionUs = 1000000; node(d, 'queue').params.capacityMessages = 1000;
    const consumer = node(d, 'worker'); consumer.params.concurrency = 1; consumer.params.serviceTime = { kind: 'constant', us: 2000 }; consumer.handlers = { put: [{ type: 'respond', status: 200 }] };
    svc(d).handlers!.put = [{ type: 'publish', queue: 'jobs', timeoutUs: 30000, orderedByKey: false }]; s.measureUs = 100001;
    expect(run(d, s).nodes.find(n => n.nodeId === 'jobs')!.queue!.consumerLagMax).toBeGreaterThan(50000);
  });
  it('attributes consumer cache work in drain to its original publisher cohort', () => {
    const d = clone(queueDlqDesign), s = clone(ticketBookingScenario), cache = clone(node(cacheAsideDesign, 'cache'));
    cache.params.coalesce = false; d.nodes.push(cache); d.edges.push({ ...d.edges[0], id: 'consumer-cache', from: 'consumer', to: 'cache' });
    node(d, 'queue').params.visibilityTimeoutUs = 20000;
    node(d, 'worker').params.serviceTime = { kind: 'constant', us: 2000 };
    node(d, 'worker').handlers = { put: [{ type: 'cacheGet', cache: 'cache', timeoutUs: 10000 }, { type: 'respond', status: 200 }] };
    const r = run(d, s); expect(r.metrics.goodput).toBe(1); expect(r.nodes.find(n => n.nodeId === 'cache')!.cache!.misses).toBe(2);
  });
  it('expires retained messages and rejects a full queue', () => {
    const d = clone(queueDlqDesign), s = clone(queueDlqScenario);
    d.nodes = d.nodes.filter(n => n.kind !== 'worker'); d.edges = d.edges.filter(e => e.from !== 'consumer'); d.edges.push({ ...d.edges[0], id: 'svc-db', from: 'svc', to: 'db' });
    node(d, 'queue').params.capacityMessages = 1; node(d, 'queue').params.retentionUs = 2000;
    const r = run(d, s); expect(r.metrics.statusCounts[503]).toBeGreaterThan(0); expect(r.metrics.succeeded).toBeGreaterThan(1);
  });
  it('circuit breaker fast failures reduce downstream work and do not improve goodput', () => {
    const withBreaker = run(retryStormDesign, retryStormScenario), d = clone(retryStormDesign);
    node(d, 'circuitBreaker').params.minRequests = 100000;
    const withoutBreaker = run(d, retryStormScenario);
    expect(withBreaker.nodes.find(n => n.nodeId === 'breaker')!.breaker!.opens).toBeGreaterThan(0);
    expect(withBreaker.nodes.find(n => n.nodeId === 'downstream')!.served).toBeLessThan(withoutBreaker.nodes.find(n => n.nodeId === 'downstream')!.served);
    expect(withBreaker.metrics.goodput).toBe(withoutBreaker.metrics.goodput);
  });
  it('CDN hits emerge from keys, origin shield coalesces requests, and costs include objects/egress', () => {
    const r = run(cdnObjectStoreDesign, cdnObjectStoreScenario);
    expect(r.nodes.find(n => n.nodeId === 'cdn')!.cache!.hits).toBeGreaterThan(0);
    expect(r.nodes.find(n => n.nodeId === 'objects')!.served).toBeLessThan(r.metrics.offered);
    expect(r.metrics.costBreakdown!.egress).toBeGreaterThan(0); expect(r.metrics.costBreakdown!.requests).toBeGreaterThan(0); expect(r.metrics.costBreakdown!.storage).toBeGreaterThan(0);
  });
  it('autoscaler provisions capacity under a step load', () => {
    const r = run(autoscalingDesign, autoscalingScenario), stats = r.nodes.find(n => n.nodeId === 'autoscaler')!.autoscale!;
    expect(stats.scaleEvents).toBeGreaterThan(0); expect(stats.maxConcurrency).toBeGreaterThan(1); expect(stats.maxConcurrency).toBeLessThanOrEqual(64);
  });
  it('half-open probes close a breaker after recovery and bulkheads reject excess parallel calls', () => {
    const d = clone(retryStormDesign), s = clone(retryStormScenario);
    d.nodes.find(n => n.id === 'downstream')!.handlers!.put = [{ type: 'respond', status: 200 }];
    s.chaos = [{ id: 'dependency-errors', kind: 'gray', target: 'downstream', atUs: 0, endUs: 15000, errorRate: 1 }];
    const recovered = run(d, s); expect(recovered.metrics.statusCounts[200]).toBeGreaterThan(0); expect(recovered.nodes.find(n => n.nodeId === 'breaker')!.breaker!.opens).toBeGreaterThan(0);
    s.chaos = []; node(d, 'circuitBreaker').params.bulkheadMax = 1;
    const downstream = d.nodes.find(n => n.id === 'downstream'); if (downstream?.kind !== 'service') throw Error('fixture'); downstream.params.serviceTime = { kind: 'constant', us: 5000 };
    expect(run(d, s).nodes.find(n => n.nodeId === 'breaker')!.breaker!.shortCircuited).toBeGreaterThan(0);
  });
});

describe('live edits and replay', () => {
  it('applies simultaneous chaos before edits and replays that precedence', () => {
    const d = clone(ticketBookingDesign), s = clone(ticketBookingScenario);
    s.chaos = [{ id: 'kill', kind: 'kill', target: 'svc', atUs: 0 }];
    const sim = createSimulation(d, s, 1, settings), log: LiveEdit[] = []; let observed = '';
    sim.liveEdit('svc', 'concurrency', 2, edit => { log.push(edit); observed = sim.snapshot().nodeState.svc; });
    sim.advance({ maxEvents: 1 }); expect(observed).toBe('down');
    while (sim.advance() !== 'done') { /* finish */ }
    const replay = createSimulation(d, s, 1, settings); replay.replayEdits(log); while (replay.advance() !== 'done') { /* finish */ }
    expect(replay.result()).toEqual(sim.result());
  });
  it('acknowledges at an event boundary and reproduces the complete edited run at identical cursors', () => {
    const d = clone(autoscalingDesign); d.nodes = d.nodes.filter(n => n.kind !== 'autoscaler');
    const s = clone(autoscalingScenario), sim = createSimulation(d, s, 11, settings), log: LiveEdit[] = [];
    sim.advance({ maxEvents: 10 });
    expect(sim.liveEdit('svc', 'concurrency', 8, edit => log.push(edit))).toBeUndefined(); expect(log).toEqual([]);
    sim.advance({ maxEvents: 1 }); expect(log[0].cursor).toEqual(sim.snapshot().cursor);
    expect(sim.liveEdit('svc', 'serviceTime.us', 2000, edit => log.push(edit))).toBeUndefined();
    sim.advance({ maxEvents: 20 });
    expect(sim.liveEdit('@workload', 'arrival.stepRps', 2000, edit => log.push(edit))).toBeUndefined();
    while (sim.advance() !== 'done') { /* finish */ }
    const replay = createSimulation(d, s, 11, settings); replay.replayEdits(log);
    while (replay.advance({ maxEvents: 37 }) !== 'done') replay.snapshot();
    expect(replay.result()).toEqual(sim.result()); expect(sim.result().runKey.designHash).toBe(designHash(d));
  });
  it('rejects structural edits, prototype paths, invalid values and past chaos', () => {
    const sim = createSimulation(autoscalingDesign, autoscalingScenario, 1, settings);
    expect(sim.liveEdit('missing', 'concurrency', 2)).toContain('Structural');
    expect(sim.liveEdit('svc', '__proto__.polluted', true)).toContain('Invalid');
    expect(sim.liveEdit('svc', 'concurrency', 0)).toBeTypeOf('string');
    expect(sim.liveEdit('@chaos', 'past', { id: 'past', kind: 'kill', target: 'svc', atUs: 0 })).toBeTypeOf('string');
  });
  it('drops excess queued requests newest-first and counts edit drops', () => {
    const sim = createSimulation(autoscalingDesign, autoscalingScenario, 1, settings);
    sim.advance({ untilUs: 150000 });
    expect(sim.liveEdit('svc', 'queueCapacity', 0)).toBeUndefined(); sim.advance({ maxEvents: 1 });
    expect(sim.result().nodes.find(n => n.nodeId === 'svc')!.dropsOnEdit).toBeGreaterThan(0);
  });
  it('rebalances KV members without losing acknowledged records and replays the transfer', () => {
    const d = clone(intersectingQuorumDesign), sim = createSimulation(d, kvQuorumScenario, 1, settings), log: LiveEdit[] = [];
    sim.advance({ untilUs: 10000 }); expect(sim.liveEdit('kv', 'members', 5, e => log.push(e))).toBeUndefined();
    while (sim.advance() !== 'done') { /* finish */ }
    expect(sim.result().violations).toEqual([]);
    const replay = createSimulation(d, kvQuorumScenario, 1, settings); replay.replayEdits(log);
    while (replay.advance() !== 'done') { /* finish */ }
    expect(replay.result()).toEqual(sim.result());
  });
});

describe('validation, workload and property coverage', () => {
  it('excludes all whiteboard metadata from hashes and includes data/regions', () => {
    const d = clone(ticketBookingDesign), h = designHash(d); d.groups = []; d.annotations = [{ text: 'note' }]; d.nodes[0].position.x = 999; d.nodes[0].label = 'new';
    expect(designHash(d)).toBe(h); d.entities![0].dataset.count = 2; expect(designHash(d)).not.toBe(h);
  });
  it('rejects impossible joins/quorums, oversized stores and incompatible sources', () => {
    const d = clone(kvQuorumDesign); node(d, 'kvStore').params.readQuorum = 4;
    expect(validateDesign(d, kvQuorumScenario).map(i => i.code)).toContain('INVALID_QUORUM');
    d.entities![0].dataset.count = 1000001; expect(validateDesign(d, kvQuorumScenario).length).toBeGreaterThan(1);
    svc(d).handlers!.put = [{ type: 'parallel', branches: [[]], join: { kind: 'quorum', k: 2 }, cancelLosers: false }];
    expect(validateDesign(d, kvQuorumScenario).map(i => i.code)).toContain('INVALID_PARAMETER');
  });
  it.each(['ramp', 'diurnal', 'replay'] as const)('generates arrivals from %s including low/zero rate intervals', kind => {
    const s = clone(ticketBookingScenario); s.measureUs = 1000000;
    s.workload.arrival = kind === 'ramp' ? { kind, fromRps: 0, toRps: 50 } : kind === 'diurnal' ? { kind, meanRps: 20, amplitude: .5, periodUs: 1000000 } : { kind, points: [{ atUs: 0, rps: 0 }, { atUs: 500000, rps: 50 }] };
    expect(run(ticketBookingDesign, s).metrics.offered).toBeGreaterThan(5);
  });
  it('allows composed chaos of different kinds and rejects same-kind overlaps', () => {
    const s = clone(ticketBookingScenario); s.chaos = [{ id: 'down', kind: 'kill', target: 'db', atUs: 0, endUs: 1000 }, { id: 'slow', kind: 'degrade', target: 'db', atUs: 0, endUs: 2000, slowFactor: 10 }];
    expect(validateDesign(ticketBookingDesign, s)).toEqual([]); expect(run(ticketBookingDesign, s).outcome).toBe('finished');
    s.chaos.push({ id: 'down2', kind: 'kill', target: 'db', atUs: 100 });
    expect(validateDesign(ticketBookingDesign, s).map(i => i.code)).toContain('OVERLAPPING_CHAOS');
  });
  it('certifies all supported invariants in the grader and couples latency with goodput', () => {
    const invariants: InvariantKind[] = ['ackedWriteLost', 'duplicateEffect', 'staleRead', 'oversell', 'uniquenessViolated', 'splitBrainWrite', 'orderingViolated'];
    const report = gradeChallenge(paymentsDesign, { id: 'all', title: '', scenario: paymentsScenario, variantChaos: [], slos: [{ kind: 'goodput', min: 1 }], invariants, budgetPerMonth: 1000, allowedKinds: paymentsDesign.nodes.map(n => n.kind), seeds: [1] });
    expect(report.verdict).toBe('pass');
  });
  it('conserves traffic and time with random P2 graphs, failures and capacities', () => {
    const pairs = [[paymentsDesign, paymentsScenario], [kvQuorumDesign, kvQuorumScenario], [queueDlqDesign, queueDlqScenario], [cdnObjectStoreDesign, cdnObjectStoreScenario], [retryStormDesign, retryStormScenario], [autoscalingDesign, autoscalingScenario]] as const;
    fc.assert(fc.property(fc.integer({ min: 0, max: pairs.length - 1 }), fc.integer(), fc.integer({ min: 1, max: 8 }), (index, seed, concurrency) => {
      const [base, scenario] = pairs[index], d = clone(base); for (const n of d.nodes) if ('concurrency' in n.params) n.params.concurrency = concurrency;
      const sim = createSimulation(d, scenario, seed, settings); let previous = 0;
      while (sim.advance({ maxEvents: 19 }) !== 'done') { const now = sim.snapshot().simTimeUs; expect(now).toBeGreaterThanOrEqual(previous); previous = now; }
      const r = sim.result(); expect(r.outcome).toBe('finished'); expect(r.metrics.offered).toBe(r.metrics.succeeded + r.metrics.failed + r.metrics.unfinished);
      const finite = (value: unknown) => { if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true); else if (value && typeof value === 'object') for (const v of Object.values(value)) finite(v); }; finite(r);
    }), { numRuns: 30 });
  });
});
