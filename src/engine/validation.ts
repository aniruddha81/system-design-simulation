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
    if (!['loadBalancer', 'service', 'cache', 'database', 'rateLimiter'].includes(n.kind) || !n.params) { issue('INVALID_COMPONENT', 'Unknown component or missing parameters.', n.id); continue; }
    const p = n.params;
    finite(p.concurrency, 1, 'concurrency', n.id, 250_000, true);
    finite(p.queueCapacity, 0, 'queueCapacity', n.id, LIMITS.queued, true);
    finite(p.costPerHour, 0, 'costPerHour', n.id);
    if (!['fifo', 'lifo'].includes(p.queueDiscipline)) issue('INVALID_PARAMETER', 'Choose FIFO or LIFO.', n.id);
    if (n.kind === 'database') {
      dist(n.params.readTime, 'readTime', n.id); dist(n.params.writeTime, 'writeTime', n.id);
      finite(n.params.replicas, 1, 'replicas', n.id, 1000, true);
    } else dist(n.params.serviceTime, 'serviceTime', n.id);
    if (n.kind === 'cache') {
      finite(n.params.capacityBytes, 0, 'capacityBytes', n.id);
      if (n.params.ttlUs !== undefined) finite(n.params.ttlUs, 1, 'ttlUs', n.id);
      if (!['lru', 'lfu'].includes(n.params.eviction)) issue('INVALID_PARAMETER', 'Choose LRU or LFU.', n.id);
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
  }
  const steps = (program: Step[], id: string, depth: number) => {
    if (!Array.isArray(program)) { issue('INVALID_ROUTE', 'Handler must be a step array.', id); return; }
    if (depth > 32) { issue('ROUTE_DEPTH', 'Route program nesting exceeds 32.', id); return; }
    for (const s of program) {
      if (s.type === 'branch') {
        if (s.cond.kind === 'prob') prob(s.cond.p, 'branch probability', id);
        steps(s.then, id, depth + 1); steps(s.else, id, depth + 1);
      } else if (s.type === 'respond') {
        if (![200, 201, 404, 409, 429, 503, 504].includes(s.status)) issue('INVALID_ROUTE', 'Unsupported response status.', id);
      } else if (['call', 'cacheGet', 'cacheSet', 'cacheDelete'].includes(s.type)) {
        const target = s.type === 'call' ? s.target : s.cache;
        if (!nodes.has(target)) issue('MISSING_TARGET', `Route target ${target} does not exist.`, id);
        else if (nodes.get(target)?.kind === 'client') issue('INCOMPATIBLE_TARGET', 'A client cannot serve calls.', id);
        else if (s.type !== 'call' && nodes.get(target)?.kind !== 'cache') issue('INCOMPATIBLE_TARGET', `${target} is not a cache.`, id);
        if (!design.edges.some(e => e.from === id && e.to === target)) issue('NO_EDGE_FOR_CALL', `Connect ${id} to ${target}.`, id);
        finite(s.timeoutUs, 1, 'timeoutUs', id);
        if (s.type === 'call' && s.retry) {
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
  const calls = (program: Step[]): string[] => program.flatMap(s => s.type === 'call' ? [s.target] : s.type === 'branch' ? [...calls(s.then), ...calls(s.else)] : []);
  for (const endpoint of endpoints) {
    const visited = new Map<string, number>();
    const walk = (id: string, path: Set<string>, depth: number): void => {
      if (path.has(id) || depth > 32) { issue('ROUTE_DEPTH', 'Recursive calls or a call chain exceed the route depth limit of 32.', id); return; }
      if ((visited.get(id) ?? -Infinity) >= depth) return;
      visited.set(id, depth);
      const n = nodes.get(id);
      const next = n?.kind === 'service' ? calls(n.handlers?.[endpoint] ?? []) : n?.kind === 'client' ? [n.params.entry] : n?.kind === 'loadBalancer' || n?.kind === 'rateLimiter' ? design.edges.filter(e => e.from === id).map(e => e.to) : [];
      for (const target of next) walk(target, new Set([...path, id]), depth + 1);
    };
    if (!issues.some(i => i.code === 'ROUTE_DEPTH' || i.code === 'INVALID_ROUTE')) for (const source of sources) walk(source.id, new Set(), -1);
  }
  const reachable = new Set(sources.map(n => n.id));
  for (let i = 0; i < design.nodes.length; i++) for (const e of design.edges) if (reachable.has(e.from)) reachable.add(e.to);
  for (const n of design.nodes) if (!reachable.has(n.id)) issue('UNREACHABLE_NODE', 'Node is unreachable from any traffic source.', n.id);
  const w = scenario.workload;
  finite(w.deadlineUs, 1, 'deadlineUs'); finite(w.arrival.rps, 0, 'rps', undefined, 1e9);
  if (!['constant', 'poisson', 'step', 'spike'].includes(w.arrival.kind)) issue('INVALID_PARAMETER', 'Unknown arrival process.');
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
    if (!nodes.has(c.target)) issue('MISSING_TARGET', 'Chaos target does not exist.', c.target);
    finite(c.atUs, 0, 'chaos.atUs', undefined, LIMITS.durationUs, true);
    if (c.endUs !== undefined) finite(c.endUs, c.atUs + 1, 'chaos.endUs', undefined, LIMITS.durationUs, true);
    if (c.kind === 'degrade') finite(c.slowFactor, 1, 'slowFactor');
    if (c.kind === 'gray') prob(c.errorRate, 'errorRate');
  }
  const timeline = [...scenario.chaos].sort((a, b) => a.atUs - b.atUs);
  for (let i = 0; i < timeline.length; i++) for (let j = i + 1; j < timeline.length; j++) {
    const a = timeline[i], b = timeline[j];
    if (a.target === b.target && b.atUs < (a.endUs ?? Infinity)) issue('OVERLAPPING_CHAOS', 'P1 chaos events on the same target must not overlap.', a.target);
  }
  return issues;
}
