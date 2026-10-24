import type { Design, Dist, Scenario, Step, ValidationIssue } from './types';

export const LIMITS = { durationUs: 3_600_000_000, events: 50_000_000, liveRequests: 250_000, nodes: 200, edges: 600, heap: 2_000_000, storedKeys: 1_000_000, queued: 500_000, memoryBytes: 256 * 1024 * 1024 };

export function validateDesign(design: Design, scenario: Scenario): ValidationIssue[] {
  try { return validate(design, scenario); }
  catch { return [{ code: 'INVALID_INPUT', message: 'Malformed design or scenario: check component parameters, routes and workload fields.' }]; }
}

function validate(design: Design, scenario: Scenario): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (code: string, message: string, nodeId?: string) => issues.push({ code, message, ...(nodeId ? { nodeId } : {}) });
  if (!design || !Array.isArray(design.nodes) || !Array.isArray(design.edges) || !Array.isArray(design.endpoints) || !scenario?.workload) {
    return [{ code: 'INVALID_INPUT', message: 'Provide a design and a workload scenario.' }];
  }
  const finite = (x: number, min: number, name: string, nodeId?: string, max = Number.MAX_SAFE_INTEGER, integer = false) => {
    if (!Number.isFinite(x) || x < min || x > max || (integer && !Number.isInteger(x))) issue('INVALID_PARAMETER', `${name} must be ${integer ? 'an integer ' : ''}in [${min}, ${max}].`, nodeId);
  };
  const prob = (x: number, name: string, id?: string) => finite(x, 0, name, id, 1);
  const dist = (d: Dist, name: string, id?: string) => {
    if (!d) { issue('INVALID_DISTRIBUTION', `${name} is missing.`, id); return; }
    switch (d.kind) {
      case 'constant': finite(d.us, Number.MIN_VALUE, name, id); break;
      case 'exponential': finite(d.meanUs, Number.MIN_VALUE, name, id); break;
      case 'lognormal': finite(d.medianUs, Number.MIN_VALUE, name, id); finite(d.sigma, 0, `${name}.sigma`, id, 10); break;
      case 'empirical':
        if (!d.buckets?.length || !d.buckets.some(b => b.weight > 0)) issue('INVALID_DISTRIBUTION', `${name} needs positive bucket weight.`, id);
        for (const b of d.buckets ?? []) { finite(b.us, Number.MIN_VALUE, name, id); finite(b.weight, 0, `${name}.weight`, id); }
        break;
      default: issue('INVALID_DISTRIBUTION', `${name} has an unknown distribution.`, id);
    }
  };
  const ids = new Set<string>(), nodes = new Map(design.nodes.map(n => [n.id, n]));
  const finiteTree = (value: unknown, path: string, depth = 0) => {
    if (depth > 64) { issue('INVALID_PARAMETER', `${path} is nested too deeply.`); return; }
    if (typeof value === 'number' && !Number.isFinite(value)) issue('INVALID_PARAMETER', `${path} must be finite.`);
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) finiteTree(v, `${path}.${k}`, depth + 1);
  };
  for (const n of design.nodes) finiteTree(n.params, `nodes.${n.id}.params`);
  const unique = (id: string, scope: string) => {
    const k = `${scope}:${id}`;
    if (!id || ids.has(k)) issue('DUPLICATE_ID', `Missing or duplicate ${scope} id: ${id}.`);
    ids.add(k);
  };
  if (design.nodes.length > LIMITS.nodes || design.edges.length > LIMITS.edges) issue('GRAPH_LIMIT', 'Exact mode supports at most 200 nodes and 600 edges. Use Scale mode.');
  const sources = design.nodes.filter(n => n.kind === 'client');
  if (!sources.length) issue('NO_TRAFFIC_SOURCE', 'Add a client traffic source.');
  for (const n of design.nodes) {
    unique(n.id, 'node');
    if (n.kind === 'client') {
      if (!nodes.has(n.params.entry)) issue('MISSING_TARGET', 'Client entry does not exist.', n.id);
      if (nodes.get(n.params.entry)?.kind === 'client') issue('INCOMPATIBLE_TARGET', 'A client cannot serve calls.', n.id);
      if (!design.edges.some(e => e.from === n.id && e.to === n.params.entry)) issue('NO_EDGE_FOR_CALL', 'Connect the client to its entry node.', n.id);
      continue;
    }
    if (!['loadBalancer', 'service', 'cache', 'database', 'rateLimiter', 'dns', 'cdn', 'apiGateway', 'kvStore', 'queue', 'worker', 'objectStore', 'searchIndex', 'dedupStore', 'autoscaler', 'circuitBreaker'].includes(n.kind) || !n.params) { issue('INVALID_COMPONENT', 'Unknown component or missing parameters.', n.id); continue; }
    const p = n.params;
    const values = p as unknown as Record<string, unknown>;
    for (const field of ['coalesce', 'originShield', 'hintedHandoff', 'readRepair', 'atomic', 'durable', 'walDurable', 'readFromReplicas', 'centralised']) if (field in values && typeof values[field] !== 'boolean') issue('INVALID_PARAMETER', `${field} must be boolean.`, n.id);
    for (const field of ['region', 'zone']) if (field in values && (typeof values[field] !== 'string' || !values[field])) issue('INVALID_PARAMETER', `${field} must be a non-empty name.`, n.id);
    if (n.kind === 'dns') {
      dist(n.params.resolutionTime, 'resolutionTime', n.id); finite(n.params.ttlUs, 1, 'ttlUs', n.id, Number.MAX_SAFE_INTEGER, true);
      if (!n.params.records.length) issue('MISSING_TARGET', 'DNS needs at least one record.', n.id);
      for (const target of n.params.records) if (!nodes.has(target) || !design.edges.some(e => e.from === n.id && e.to === target)) issue('MISSING_TARGET', 'Connect each DNS record target.', n.id);
    }
    if (n.kind === 'queue') {
      for (const k of ['partitions', 'capacityMessages', 'visibilityTimeoutUs', 'maxDeliveries', 'retentionUs'] as const) finite(n.params[k], 1, k, n.id, k === 'capacityMessages' ? LIMITS.queued : Number.MAX_SAFE_INTEGER, true);
      dist(n.params.publishTime, 'publishTime', n.id); finite(n.params.costPerHour, 0, 'costPerHour', n.id);
    }
    if (n.kind === 'objectStore') {
      dist(n.params.readTime, 'readTime', n.id); dist(n.params.writeTime, 'writeTime', n.id);
      finite(n.params.costPerGBMonth, 0, 'costPerGBMonth', n.id); finite(n.params.costPerMillionRequests, 0, 'costPerMillionRequests', n.id);
    }
    if (n.kind === 'autoscaler') {
      for (const k of ['min', 'max', 'evaluateEveryUs'] as const) finite(n.params[k], 1, k, n.id, k === 'evaluateEveryUs' ? LIMITS.durationUs : 250_000, true);
      for (const k of ['cooldownUs', 'provisionUs', 'warmupUs'] as const) finite(n.params[k], 0, k, n.id);
      finite(n.params.targetValue, Number.MIN_VALUE, 'targetValue', n.id, n.params.metric === 'utilisation' ? 1 : LIMITS.queued);
      if (!['utilisation', 'queueLength'].includes(n.params.metric) || n.params.min > n.params.max || !n.params.targets.length) issue('INVALID_PARAMETER', 'Invalid autoscaler bounds, metric or targets.', n.id);
      for (const target of n.params.targets) if (!nodes.has(target) || !('concurrency' in nodes.get(target)!.params)) issue('INCOMPATIBLE_TARGET', 'Autoscaler targets must have concurrency.', n.id);
    }
    if (n.kind === 'circuitBreaker') {
      prob(n.params.failureRateThreshold, 'failureRateThreshold', n.id);
      for (const k of ['windowUs', 'minRequests', 'openUs', 'halfOpenProbes'] as const) finite(n.params[k], 1, k, n.id, Number.MAX_SAFE_INTEGER, true);
      if (n.params.bulkheadMax !== undefined) finite(n.params.bulkheadMax, 1, 'bulkheadMax', n.id, 250_000, true);
    }
    if (['cdn', 'apiGateway', 'circuitBreaker'].includes(n.kind) && design.edges.filter(e => e.from === n.id).length !== 1) issue('MISSING_TARGET', 'Forwarding component needs exactly one outgoing edge.', n.id);
    if (!('concurrency' in p)) continue;
    finite(p.concurrency, 1, 'concurrency', n.id, 250_000, true);
    finite(p.queueCapacity, 0, 'queueCapacity', n.id, LIMITS.queued, true);
    finite(p.costPerHour, 0, 'costPerHour', n.id);
    if (!['fifo', 'lifo'].includes(p.queueDiscipline)) issue('INVALID_PARAMETER', 'Choose FIFO or LIFO.', n.id);
    if (p.restartWarmupUs !== undefined) finite(p.restartWarmupUs, 1, 'restartWarmupUs', n.id);
    if (n.kind === 'database' || n.kind === 'kvStore') {
      dist(n.params.readTime, 'readTime', n.id); dist(n.params.writeTime, 'writeTime', n.id);
    } else if ('serviceTime' in n.params) dist(n.params.serviceTime, 'serviceTime', n.id);
    if (n.kind === 'database') {
      finite(n.params.replicas, 1, 'replicas', n.id, 1000, true);
      if (n.params.replication !== undefined && !['sync', 'semiSync', 'async'].includes(n.params.replication)) issue('INVALID_PARAMETER', 'Unknown replication mode.', n.id);
      if (n.params.replicationLag) dist(n.params.replicationLag, 'replicationLag', n.id);
      if (n.params.connectionPool !== undefined) finite(n.params.connectionPool, 1, 'connectionPool', n.id, 250_000, true);
      if (n.params.failover) {
        if (typeof n.params.failover.fencing !== 'boolean') issue('INVALID_PARAMETER', 'fencing must be boolean.', n.id);
        for (const k of ['heartbeatUs', 'missedHeartbeats', 'electionUs'] as const) finite(n.params.failover[k], 1, k, n.id, Number.MAX_SAFE_INTEGER, true);
      }
    }
    if (n.kind === 'kvStore') {
      for (const k of ['members', 'vnodes', 'replicationFactor', 'readQuorum', 'writeQuorum'] as const) finite(n.params[k], 1, k, n.id, k === 'vnodes' ? 4096 : 1000, true);
      if (n.params.replicationFactor > n.params.members || n.params.readQuorum > n.params.replicationFactor || n.params.writeQuorum > n.params.replicationFactor) issue('INVALID_QUORUM', 'Require R,W ≤ N ≤ members.', n.id);
      finite(n.params.tombstoneGcUs, 1, 'tombstoneGcUs', n.id, Number.MAX_SAFE_INTEGER, true);
    }
    if (n.kind === 'worker' || n.kind === 'searchIndex') {
      const source = nodes.get(n.params.source);
      if (!source || (n.kind === 'worker' ? source.kind !== 'queue' : !['database', 'kvStore', 'objectStore', 'cache'].includes(source.kind))) issue('INCOMPATIBLE_TARGET', 'Worker source must be a queue; search source must be a store.', n.id);
      if (n.kind === 'worker') finite(n.params.batchSize, 1, 'batchSize', n.id, LIMITS.queued, true);
      else dist(n.params.indexLag, 'indexLag', n.id);
    }
    if (n.kind === 'apiGateway') finite(n.params.maxRequestBytes, 0, 'maxRequestBytes', n.id);
    if (n.kind === 'dedupStore') finite(n.params.ttlUs, 1, 'ttlUs', n.id, Number.MAX_SAFE_INTEGER, true);
    if (n.kind === 'cache' || n.kind === 'cdn') {
      finite(n.params.capacityBytes, 0, 'capacityBytes', n.id);
      if (n.params.ttlUs !== undefined) finite(n.params.ttlUs, 1, 'ttlUs', n.id, Number.MAX_SAFE_INTEGER, true);
      if (!['lru', 'lfu'].includes(n.params.eviction)) issue('INVALID_PARAMETER', 'Choose LRU or LFU.', n.id);
      if (n.kind === 'cdn') finite(n.params.costPerGB, 0, 'costPerGB', n.id);
    }
    if (n.kind === 'loadBalancer') {
      const h = n.params.healthCheck;
      finite(h?.intervalUs, 1, 'healthCheck.intervalUs', n.id);
      finite(h?.unhealthyThreshold, 1, 'unhealthyThreshold', n.id, 1000, true);
      finite(h?.healthyThreshold, 1, 'healthyThreshold', n.id, 1000, true);
      if (!['roundRobin', 'leastConnections', 'p2c', 'consistentHash'].includes(n.params.algorithm)) issue('INVALID_PARAMETER', 'Unknown balancing algorithm.', n.id);
    }
    if (n.kind === 'rateLimiter') {
      finite(n.params.ratePerSec, Number.MIN_VALUE, 'ratePerSec', n.id);
      finite(n.params.burst, 1, 'burst', n.id, Number.MAX_SAFE_INTEGER, true);
      if (!['tokenBucket', 'leakyBucket', 'fixedWindow', 'slidingWindow'].includes(n.params.algorithm)) issue('INVALID_PARAMETER', 'Unknown limiter algorithm.', n.id);
      if (design.edges.filter(e => e.from === n.id).length !== 1) issue('INVALID_PARAMETER', 'Rate limiter requires exactly one outgoing edge.', n.id);
    }
    if ((n.kind === 'loadBalancer' || n.kind === 'rateLimiter') && !design.edges.some(e => e.from === n.id)) issue('MISSING_TARGET', 'Forwarding component needs an outgoing edge.', n.id);
  }
  const pairs = new Set<string>();
  for (const e of design.edges) {
    unique(e.id, 'edge');
    const pair = JSON.stringify([e.from, e.to]);
    if (pairs.has(pair)) issue('DUPLICATE_EDGE', 'Use one link per directed node pair.');
    pairs.add(pair);
    if (!nodes.has(e.from) || !nodes.has(e.to)) issues.push({ code: 'MISSING_TARGET', message: 'Edge endpoint does not exist.', edgeId: e.id });
    if (nodes.get(e.to)?.kind === 'client') issues.push({ code: 'INCOMPATIBLE_TARGET', message: 'A client cannot serve calls.', edgeId: e.id });
    dist(e.latency, 'edge latency'); finite(e.bandwidthBytesPerSec, Number.MIN_VALUE, 'bandwidth'); prob(e.lossRate, 'lossRate');
  }
  const endpoints = new Set(design.endpoints.map(e => e.id));
  for (const e of design.endpoints) {
    unique(e.id, 'endpoint'); finite(e.requestBytes, 0, 'requestBytes'); finite(e.responseBytes, 0, 'responseBytes');
    if (!['read', 'write'].includes(e.op)) issue('INVALID_PARAMETER', 'Endpoint operation must be read or write.');
    for (const [name, g] of Object.entries(e.inputs ?? {})) {
      if (g.kind === 'uniform' || g.kind === 'zipf') { finite(g.min, 0, `${name}.min`, undefined, Number.MAX_SAFE_INTEGER, true); finite(g.max, g.min, `${name}.max`, undefined, Number.MAX_SAFE_INTEGER, true); if (g.kind === 'zipf') { finite(g.s, 0, `${name}.s`, undefined, 20); finite(g.max - g.min + 1, 1, `${name}.keyspace`, undefined, LIMITS.storedKeys, true); } }
      else if (g.kind === 'sequence') finite(g.start, 0, `${name}.start`, undefined, Number.MAX_SAFE_INTEGER, true);
      else if (g.kind === 'size') { finite(g.meanBytes, 0, `${name}.meanBytes`); finite(g.sdBytes, 0, `${name}.sdBytes`); }
      else issue('INVALID_PARAMETER', 'Unknown input generator.');
    }
    if (e.inputs) for (const match of e.keyTemplate.matchAll(/\{([^}]+)\}/g)) if (!(match[1] in e.inputs)) issue('INVALID_PARAMETER', `Missing input ${match[1]}.`);
  }
  const entityNames = new Set<string>(), storeCounts = new Map<string, number>();
  for (const e of design.entities ?? []) {
    finiteTree(e, `entities.${e.name}`);
    if (entityNames.has(e.name)) issue('DUPLICATE_ID', `Duplicate entity ${e.name}.`); entityNames.add(e.name);
    if (!['database', 'kvStore', 'cache', 'searchIndex', 'objectStore'].includes(nodes.get(e.store)?.kind ?? '')) issue('INCOMPATIBLE_TARGET', `Entity ${e.name} requires a store.`);
    finite(e.dataset.count, 0, 'dataset.count', e.store, LIMITS.storedKeys, true);
    finite(e.dataset.keys.n, Math.max(1, e.dataset.count), 'dataset keyspace', e.store, LIMITS.storedKeys, true);
    if (!['uniform', 'zipf', 'hotspot', 'sequential'].includes(e.dataset.keys.kind)) issue('INVALID_PARAMETER', 'Unknown dataset key distribution.', e.store);
    if (e.dataset.keys.kind === 'zipf') finite(e.dataset.keys.s, 0, 'dataset Zipf exponent', e.store, 20);
    if (e.dataset.keys.kind === 'hotspot') prob(e.dataset.keys.hotFraction, 'dataset hotFraction', e.store);
    const count = (storeCounts.get(e.store) ?? 0) + e.dataset.count; storeCounts.set(e.store, count);
    if (count > LIMITS.storedKeys) issue('DATASET_LIMIT', 'Exact mode supports at most 1M records per store; use Scale mode.', e.store);
    const fields = new Set(e.fields.map(f => f.name));
    if (!fields.has(e.primaryKey) || e.shardKey !== undefined && !fields.has(e.shardKey)) issue('INVALID_PARAMETER', 'Primary/shard keys must name entity fields.', e.store);
    if (fields.size !== e.fields.length) issue('DUPLICATE_ID', 'Entity field names must be unique.', e.store);
    for (const f of e.fields) { finite(f.bytes.meanBytes, 0, 'field meanBytes'); finite(f.bytes.sdBytes, 0, 'field sdBytes'); if (!['string', 'int', 'float', 'bool', 'timestamp'].includes(f.type)) issue('INVALID_PARAMETER', 'Unknown field type.', e.store); }
    for (const idx of e.indexes) {
      if (!idx.fields.length || idx.fields.some(f => !fields.has(f))) issue('INVALID_PARAMETER', 'Index fields must exist.', e.store);
      if (idx.unique && idx.fields.every(field => e.fields.find(f => f.name === field)?.type === 'bool') && e.dataset.count > 2 ** idx.fields.length) issue('INVALID_PARAMETER', 'Dataset cannot satisfy boolean unique index.', e.store);
    }
  }
  if (design.regions) {
    const r = design.regions;
    if (new Set(r.names).size !== r.names.length || r.latencyUs.length !== r.names.length || r.egressCostPerGB.length !== r.names.length) issue('INVALID_PARAMETER', 'Region matrices must be square with unique region names.');
    for (const matrix of [r.latencyUs, r.egressCostPerGB]) for (const row of matrix) { if (row.length !== r.names.length) issue('INVALID_PARAMETER', 'Region matrix row has wrong size.'); for (const x of row) finite(x, 0, 'region matrix'); }
  }
  const steps = (program: Step[], id: string, depth: number) => {
    if (!Array.isArray(program)) { issue('INVALID_ROUTE', 'Handler must be a step array.', id); return; }
    if (depth > 32) { issue('ROUTE_DEPTH', 'Route program nesting exceeds 32.', id); return; }
    for (const s of program) {
      if (s.type === 'branch') {
        if (!['cacheHit', 'prob', 'found', 'dedupHit', 'leaderAlive', 'breakerClosed'].includes(s.cond.kind)) issue('INVALID_ROUTE', 'Unknown branch condition.', id);
        if (s.cond.kind === 'prob') prob(s.cond.p, 'branch probability', id);
        if (s.cond.kind === 'leaderAlive' && !['database', 'kvStore'].includes(nodes.get(s.cond.store)?.kind ?? '')) issue('INCOMPATIBLE_TARGET', 'leaderAlive requires a store.', id);
        if (s.cond.kind === 'breakerClosed' && nodes.get(s.cond.breaker)?.kind !== 'circuitBreaker') issue('INCOMPATIBLE_TARGET', 'breakerClosed requires a breaker.', id);
        steps(s.then, id, depth + 1); steps(s.else, id, depth + 1);
      } else if (s.type === 'parallel') {
        if (!['all', 'any', 'quorum', 'firstN'].includes(s.join.kind) || typeof s.cancelLosers !== 'boolean') issue('INVALID_ROUTE', 'Invalid parallel join/cancellation policy.', id);
        const required = s.join.kind === 'quorum' ? s.join.k : s.join.kind === 'firstN' ? s.join.n : 1;
        finite(required, 1, 'parallel join', id, s.branches.length, true);
        for (const branch of s.branches) steps(branch, id, depth + 1);
      } else if (s.type === 'respond') {
        if (![200, 201, 404, 409, 429, 503, 504].includes(s.status)) issue('INVALID_ROUTE', 'Unsupported response status.', id);
      } else if (s.type === 'call' || s.type === 'cacheGet' || s.type === 'cacheSet' || s.type === 'cacheDelete' || s.type === 'data' || s.type === 'dedup' || s.type === 'publish') {
        const target = s.type === 'call' || s.type === 'data' ? s.target : s.type === 'dedup' ? s.store : s.type === 'publish' ? s.queue : s.cache;
        if (!nodes.has(target)) issue('MISSING_TARGET', `Route target ${target} does not exist.`, id);
        else if (nodes.get(target)?.kind === 'client' || nodes.get(target)?.kind === 'autoscaler') issue('INCOMPATIBLE_TARGET', 'Clients and autoscalers cannot serve calls.', id);
        else if (s.type.startsWith('cache') && nodes.get(target)?.kind !== 'cache' || s.type === 'dedup' && nodes.get(target)?.kind !== 'dedupStore' || s.type === 'publish' && nodes.get(target)?.kind !== 'queue') issue('INCOMPATIBLE_TARGET', `${target} has an incompatible kind.`, id);
        if (s.type === 'data') {
          const op = s.op;
          const entity = design.entities?.find(e => e.name === s.entity);
          const targetNode = nodes.get(target);
          if (!['get', 'query', 'insert', 'put', 'update', 'delete', 'conditionalPut', 'decrementIfPositive'].includes(op.kind)) issue('INVALID_ROUTE', 'Unsupported data operation.', id);
          if (op.kind === 'update' && !['set', 'increment', 'append'].includes(op.op)) issue('INVALID_ROUTE', 'Unsupported field update.', id);
          finiteTree(op, 'data operation');
          if (op.kind === 'conditionalPut' && op.expectedVersion !== undefined) finite(op.expectedVersion, 0, 'expectedVersion', id, Number.MAX_SAFE_INTEGER, true);
          if ('values' in op) for (const field of Object.keys(op.values ?? {})) if (!entity?.fields.some(f => f.name === field)) issue('INVALID_PARAMETER', 'Unknown value field.', id);
          if (!entity || entity.store !== target && !(targetNode?.kind === 'searchIndex' && targetNode.params.source === entity.store)) issue('INCOMPATIBLE_TARGET', 'Data operation must target its entity store or a search index of that store.', id);
          if (op.kind === 'query') { finite(op.limit, 1, 'query.limit', id, LIMITS.storedKeys, true); if (op.index && op.index !== entity?.primaryKey && !entity?.indexes.some(i => i.name === op.index)) issue('INVALID_PARAMETER', 'Unknown query index.', id); }
          if ((op.kind === 'update' || op.kind === 'decrementIfPositive') && !entity?.fields.some(f => f.name === op.field)) issue('INVALID_PARAMETER', 'Unknown update field.', id);
        }
        if (!design.edges.some(e => e.from === id && e.to === target)) issue('NO_EDGE_FOR_CALL', `Connect ${id} to ${target}.`, id);
        finite(s.timeoutUs, 1, 'timeoutUs', id);
        if ((s.type === 'call' || s.type === 'data') && s.retry) {
          finite(s.retry.max, 0, 'retry.max', id, LIMITS.events, true);
          finite(s.retry.backoffUs, 0, 'retry.backoffUs', id);
          finite(s.retry.multiplier, 1, 'retry.multiplier', id, 1e6);
          if (!['none', 'full'].includes(s.retry.jitter) || !s.retry.retryOn.every(c => ['timeout', '5xx', '429'].includes(c))) issue('INVALID_PARAMETER', 'Invalid retry jitter or retry condition.', id);
        }
      } else issue('INVALID_ROUTE', 'Unknown route step.', id);
    }
  };
  for (const n of design.nodes) for (const [endpoint, program] of Object.entries(n.handlers ?? {})) {
    if (!endpoints.has(endpoint)) issue('MISSING_ENDPOINT', `Unknown endpoint ${endpoint}.`, n.id);
    if (program) steps(program, n.id, 0);
  }
  const calls = (program: Step[]): string[] => program.flatMap(s => s.type === 'call' ? [s.target] : s.type === 'branch' ? [...calls(s.then), ...calls(s.else)] : s.type === 'parallel' ? s.branches.flatMap(calls) : []);
  for (const endpoint of endpoints) {
    const visited = new Map<string, number>();
    const walk = (id: string, path: Set<string>, depth: number): void => {
      if (path.has(id) || depth > 32) { issue('ROUTE_DEPTH', 'Recursive calls or a call chain exceed the route depth limit of 32.', id); return; }
      if ((visited.get(id) ?? -Infinity) >= depth) return;
      visited.set(id, depth);
      const n = nodes.get(id);
      const next = n?.kind === 'service' || n?.kind === 'worker' ? calls(n.handlers?.[endpoint] ?? []) : n?.kind === 'client' ? [n.params.entry] : n?.kind === 'dns' ? n.params.records : n && ['loadBalancer', 'rateLimiter', 'cdn', 'apiGateway', 'circuitBreaker'].includes(n.kind) ? design.edges.filter(e => e.from === id).map(e => e.to) : [];
      for (const target of next) walk(target, new Set([...path, id]), depth + 1);
    };
    if (!issues.some(i => i.code === 'ROUTE_DEPTH' || i.code === 'INVALID_ROUTE')) for (const source of sources) walk(source.id, new Set(), -1);
  }
  const reachable = new Set(sources.map(n => n.id));
  for (let i = 0; i < design.nodes.length; i++) {
    for (const e of design.edges) if (reachable.has(e.from)) reachable.add(e.to);
    for (const n of design.nodes) if (n.kind === 'autoscaler' || (n.kind === 'worker' || n.kind === 'searchIndex') && reachable.has(n.params.source)) reachable.add(n.id);
  }
  for (const n of design.nodes) if (!reachable.has(n.id)) issue('UNREACHABLE_NODE', 'Node is unreachable from any traffic source.', n.id);
  const w = scenario.workload;
  finite(w.deadlineUs, 1, 'deadlineUs'); if ('rps' in w.arrival) finite(w.arrival.rps, 0, 'rps', undefined, 1e9);
  if (!['constant', 'poisson', 'step', 'spike', 'ramp', 'diurnal', 'replay'].includes(w.arrival.kind)) issue('INVALID_PARAMETER', 'Unknown arrival process.');
  if (w.arrival.kind === 'ramp') { finite(w.arrival.fromRps, 0, 'fromRps', undefined, 1e9); finite(w.arrival.toRps, 0, 'toRps', undefined, 1e9); }
  if (w.arrival.kind === 'diurnal') { finite(w.arrival.meanRps, 0, 'meanRps', undefined, 1e9); prob(w.arrival.amplitude, 'amplitude'); finite(w.arrival.periodUs, 1, 'periodUs'); }
  if (w.arrival.kind === 'replay') {
    if (!w.arrival.points.length || w.arrival.points.length > 10000) issue('INVALID_PARAMETER', 'Replay needs 1–10000 points.');
    let previous = -1;
    for (const p of w.arrival.points) { finite(p.atUs, previous + 1, 'replay.atUs', undefined, LIMITS.durationUs, true); finite(p.rps, 0, 'replay.rps', undefined, 1e9); previous = p.atUs; }
  }
  if (w.sessions) finite(w.sessions.count, 1, 'sessions.count', undefined, LIMITS.storedKeys, true);
  if (!['uniform', 'zipf', 'hotspot', 'sequential'].includes(w.keys.kind)) issue('INVALID_PARAMETER', 'Unknown key distribution.');
  if (w.arrival.kind === 'step') { finite(w.arrival.stepAtUs, 0, 'stepAtUs'); finite(w.arrival.stepRps, 0, 'stepRps', undefined, 1e9); }
  if (w.arrival.kind === 'spike') { finite(w.arrival.spikeAtUs, 0, 'spikeAtUs'); finite(w.arrival.spikeDurUs, 1, 'spikeDurUs'); finite(w.arrival.spikeRps, 0, 'spikeRps', undefined, 1e9); }
  finite(w.keys.n, 1, 'keyspace', undefined, LIMITS.storedKeys, true);
  if (w.keys.kind === 'zipf') finite(w.keys.s, 0, 'Zipf exponent', undefined, 20);
  if (w.keys.kind === 'hotspot') prob(w.keys.hotFraction, 'hotFraction');
  if (!Object.keys(w.mix).length || !Object.values(w.mix).some(v => v > 0)) issue('INVALID_MIX', 'Workload mix needs a positive weight.');
  for (const [e, weight] of Object.entries(w.mix)) { finite(weight, 0, 'mix weight'); if (!endpoints.has(e)) issue('MISSING_ENDPOINT', `Workload endpoint ${e} does not exist.`); }
  finite(scenario.warmupUs, 0, 'warmupUs', undefined, LIMITS.durationUs, true); finite(scenario.measureUs, 1, 'measureUs', undefined, LIMITS.durationUs, true); finite(scenario.drainUs, 0, 'drainUs', undefined, LIMITS.durationUs, true);
  if (scenario.warmupUs + scenario.measureUs + scenario.drainUs > LIMITS.durationUs) issue('DURATION_LIMIT', 'Exact runs are limited to one simulated hour. Use Scale mode.');
  for (const c of scenario.chaos) {
    unique(c.id, 'chaos');
    if (['kill', 'degrade', 'gray', 'clockSkew'].includes(c.kind) && !nodes.has(c.target)) issue('MISSING_TARGET', 'Chaos target does not exist.', c.target);
    if ((c.kind === 'linkLoss' || c.kind === 'linkLatency') && !design.edges.some(e => e.id === c.target)) issue('MISSING_TARGET', 'Chaos link does not exist.');
    if (c.kind === 'zoneOutage' || c.kind === 'regionOutage') { const field = c.kind === 'zoneOutage' ? 'zone' : 'region'; if (!design.nodes.some(n => field in n.params && (n.params as unknown as Record<string, unknown>)[field] === c.target)) issue('MISSING_TARGET', 'Failure domain does not exist.'); }
    if (c.kind === 'partition') for (const l of c.links) if (!design.edges.some(e => e.from === l.from && e.to === l.to || e.from === l.to && e.to === l.from)) issue('MISSING_TARGET', 'Partition link does not exist.');
    finite(c.atUs, 0, 'chaos.atUs', undefined, LIMITS.durationUs, true);
    if (c.endUs !== undefined) finite(c.endUs, c.atUs + 1, 'chaos.endUs', undefined, LIMITS.durationUs, true);
    if (c.kind === 'degrade') finite(c.slowFactor, 1, 'slowFactor');
    if (c.kind === 'gray') prob(c.errorRate, 'errorRate');
    if (c.kind === 'linkLoss') prob(c.lossRate, 'lossRate');
    if (c.kind === 'linkLatency') finite(c.addUs, 0, 'addUs');
    if (c.kind === 'clockSkew') finite(c.skewUs, -LIMITS.durationUs, 'skewUs', undefined, LIMITS.durationUs, true);
    if (c.kind === 'trafficSpike') finite(c.multiplier, 0, 'multiplier', undefined, 1e6);
  }
  const timeline = [...scenario.chaos].sort((a, b) => a.atUs - b.atUs);
  for (let i = 0; i < timeline.length; i++) for (let j = i + 1; j < timeline.length; j++) {
    const a = timeline[i], b = timeline[j];
    const overlapTarget = a.kind === 'partition' && b.kind === 'partition' ? a.links.some(x => b.links.some(y => x.from === y.from && x.to === y.to)) : a.target === b.target;
    if (a.kind === b.kind && overlapTarget && b.atUs < (a.endUs ?? Infinity)) issue('OVERLAPPING_CHAOS', 'Same-kind chaos events on the same target must not overlap.', a.target);
  }
  return issues;
}
