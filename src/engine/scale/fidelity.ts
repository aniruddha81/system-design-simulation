import type { ChaosEvent, ComponentKind, Condition, DataOp, Design, InvariantKind, Scenario, Step, Workload } from '../types';
import { responseBytes } from './p2';
import type { FidelityReport, Prediction, PredictionState, Support } from './types';

const cacheEffects: Prediction[] = ['hitRate', 'latency', 'utilisation', 'backlog', 'drops', 'timelySuccess'];
type Capability = { exact: Support; scale: Support; reason: string; disables: Prediction[] };
// Typed data replaces PLAN §5A.0's YAML without adding a YAML runtime dependency.
export const capabilityMatrix = {
  serialRoutes: { exact: 'supported', scale: 'approximate', reason: 'Serial convolution and branch mixtures assume independent hops.', disables: [] },
  parallel: { exact: 'supported', scale: 'approximate', reason: 'Parallel order statistics assume independent branch outcomes and latency; loser work is retained.', disables: [] },
  publish: { exact: 'supported', scale: 'approximate', reason: 'Publish acknowledgements and consumer backlog use bounded fluid queues; delivery correctness is unknown.', disables: [] },
  retries: { exact: 'supported', scale: 'approximate', reason: 'Timeout-tail feedback and shifted backoff mixtures assume independent attempts.', disables: [] },
  lruZipf: { exact: 'supported', scale: 'approximate', reason: 'Che / non-refreshing TTL-Che; stationary Zipf and fixed object bytes only.', disables: [] },
  lfu: { exact: 'supported', scale: 'unsupported', reason: 'LFU cache: Scale cannot predict hit rate or dependent traffic; run in Exact.', disables: cacheEffects },
  variableObjects: { exact: 'supported', scale: 'unsupported', reason: 'Variable object sizes: fixed-byte cache, link and egress predictions require Exact.', disables: cacheEffects.concat('cost') },
  invalidation: { exact: 'supported', scale: 'unsupported', reason: 'Cache invalidation/write traffic is outside the validated stationary read-cache envelope.', disables: cacheEffects },
  popularity: { exact: 'supported', scale: 'unsupported', reason: 'Cache predictions require stationary Zipf popularity.', disables: cacheEffects },
  coldStart: { exact: 'supported', scale: 'approximate', reason: 'Distinct-key coverage from completed successful origin fills; restart clears occupancy.', disables: [] },
  contention: { exact: 'supported', scale: 'unsupported', reason: 'Row locks, hot-row contention, isolation and dedup races require Exact.', disables: cacheEffects.concat('correctness') },
  replication: { exact: 'supported', scale: 'approximate', reason: 'Replication lag is shipping delay plus the backlog of write rate minus replica apply rate; correctness is unknown.', disables: ['correctness'] },
  failover: { exact: 'supported', scale: 'approximate', reason: 'Capacity effects only; split brain and fencing correctness require Exact.', disables: ['correctness'] },
  links: { exact: 'supported', scale: 'approximate', reason: 'Independent fluid bandwidth queues per direction, with loss probabilities.', disables: [] },
  autoscaling: { exact: 'supported', scale: 'supported', reason: 'Rate-based capacity steps after provisioning and warmup delay, with evaluation and cooldown boundaries.', disables: [] },
  chaos: { exact: 'supported', scale: 'supported', reason: 'Timeline maps to capacity/health multipliers; LB health convergence is approximate.', disables: [] },
  correctness: { exact: 'supported', scale: 'unsupported', reason: 'Scale never checks correctness invariants; correctness is unknown.', disables: ['correctness'] },
  percentiles: { exact: 'supported', scale: 'approximate', reason: 'Unavailable outside CV ≤ 4 and utilisation ≤ 0.95, or during an outage.', disables: [] },
  lifo: { exact: 'supported', scale: 'unsupported', reason: 'Backlog/capacity waiting models FIFO only.', disables: ['latency', 'timelySuccess'] },
  keyedBalancing: { exact: 'supported', scale: 'unsupported', reason: 'Consistent-hash key affinity is outside the independent flow split envelope.', disables: ['utilisation', 'backlog', 'drops', 'latency', 'timelySuccess'] },
  dns: { exact: 'supported', scale: 'approximate', reason: 'DNS adds resolution latency and selects the first healthy record; TTL convergence is approximate.', disables: [] },
  cdn: { exact: 'supported', scale: 'approximate', reason: 'Per-region LRU Che cache with successful origin fills; independent regional traffic.', disables: [] },
  gateway: { exact: 'supported', scale: 'approximate', reason: 'Gateway authentication latency and request-size admission limit.', disables: [] },
  breaker: { exact: 'supported', scale: 'approximate', reason: 'Circuit breaker uses a failure-rate threshold and timed open/closed capacity model; probe races are not represented.', disables: [] },
  limiter: { exact: 'supported', scale: 'approximate', reason: 'Rate limiter uses fluid pass-through admission capacity; window boundaries are approximate.', disables: [] },
  store: { exact: 'supported', scale: 'approximate', reason: 'Store read/write service cost is approximated; key and version correctness is unknown.', disables: [] },
  quorumStaleness: { exact: 'supported', scale: 'unsupported', reason: 'kvStore quorum staleness and repair require individual versions; run in Exact.', disables: ['correctness'] },
  dataConflict: { exact: 'supported', scale: 'unsupported', reason: 'Data-op 409 semantics, unique conflicts and conditional updates require Exact.', disables: cacheEffects.concat('correctness') },
  dataState: { exact: 'supported', scale: 'unsupported', reason: 'Found/dedup state branches require per-key state; dependent flow predictions require Exact.', disables: cacheEffects.concat('correctness') },
  dataPresence: { exact: 'supported', scale: 'approximate', reason: 'Read-only found branches use independent entity-count/key-population coverage; mutations invalidate this approximation.', disables: [] },
  query: { exact: 'supported', scale: 'approximate', reason: 'Query service cost uses entity count: full scan versus logarithmic indexed lookup plus returned rows.', disables: [] },
  clockSkew: { exact: 'supported', scale: 'unsupported', reason: 'Clock skew lease and fencing correctness is unknown in Scale.', disables: ['correctness'] },
  arrivals: { exact: 'supported', scale: 'supported', reason: 'Arrival curves are integrated as rates, with piecewise boundaries and adaptive time steps.', disables: [] },
  regions: { exact: 'supported', scale: 'approximate', reason: 'Region-matrix latency is added to both directions; cross-region bytes incur directional egress cost.', disables: [] },
} satisfies Record<string, Capability>;

type Feature = keyof typeof capabilityMatrix;
// Exhaustive maps are also the machine-readable fidelity inventory.
export const featureCoverage = {
  components: { client: 'serialRoutes', loadBalancer: 'serialRoutes', service: 'serialRoutes', cache: 'lruZipf', database: 'store', rateLimiter: 'limiter', dns: 'dns', cdn: 'cdn', apiGateway: 'gateway', kvStore: 'quorumStaleness', queue: 'publish', worker: 'publish', objectStore: 'store', searchIndex: 'store', dedupStore: 'contention', autoscaler: 'autoscaling', circuitBreaker: 'breaker' } satisfies Record<ComponentKind, Feature>,
  steps: { call: 'serialRoutes', cacheGet: 'lruZipf', cacheSet: 'coldStart', cacheDelete: 'invalidation', branch: 'serialRoutes', respond: 'serialRoutes', parallel: 'parallel', publish: 'publish', data: 'store', dedup: 'contention' } satisfies Record<Step['type'], Feature>,
  conditions: { cacheHit: 'lruZipf', prob: 'serialRoutes', found: 'dataPresence', dedupHit: 'dataState', leaderAlive: 'failover', breakerClosed: 'breaker' } satisfies Record<Condition['kind'], Feature>,
  chaos: { kill: 'chaos', degrade: 'chaos', gray: 'chaos', partition: 'chaos', linkLoss: 'chaos', linkLatency: 'chaos', clockSkew: 'clockSkew', zoneOutage: 'chaos', regionOutage: 'chaos', trafficSpike: 'chaos' } satisfies Record<ChaosEvent['kind'], Feature>,
  arrivals: { poisson: 'arrivals', constant: 'arrivals', step: 'arrivals', spike: 'arrivals', ramp: 'arrivals', diurnal: 'arrivals', replay: 'arrivals' } satisfies Record<Workload['arrival']['kind'], Feature>,
  dataOps: { get: 'store', query: 'query', insert: 'dataConflict', put: 'store', update: 'contention', delete: 'store', conditionalPut: 'dataConflict', decrementIfPositive: 'dataConflict' } satisfies Record<DataOp['kind'], Feature>,
  invariants: { ackedWriteLost: 'correctness', duplicateEffect: 'correctness', staleRead: 'correctness', oversell: 'correctness', uniquenessViolated: 'correctness', splitBrainWrite: 'correctness', orderingViolated: 'correctness' } satisfies Record<InvariantKind, Feature>,
};

export function routeSteps(steps: Step[]): Step[] {
  return steps.flatMap(s => s.type === 'branch' ? [s, ...routeSteps(s.then), ...routeSteps(s.else)] : s.type === 'parallel' ? [s, ...s.branches.flatMap(routeSteps)] : [s]);
}

export function checkFidelity(design: Design, scenario: Scenario): FidelityReport {
  const names: Prediction[] = ['utilisation', 'backlog', 'drops', 'latency', 'hitRate', 'timelySuccess', 'cost', 'correctness'];
  const fresh = () => Object.fromEntries(names.map(p => [p, { enabled: true, reasons: [p === 'cost' ? 'Compute, fixed-byte egress, storage and request rates are integrated over measurement.' : 'Available inside the validated independent fluid-flow envelope.'] }])) as Record<Prediction, PredictionState>;
  const disable = (predictions: Record<Prediction, PredictionState>, feature: keyof typeof capabilityMatrix) => {
    const cap = capabilityMatrix[feature];
    for (const p of cap.disables) {
      const old = predictions[p];
      predictions[p] = { enabled: false, reasons: [...new Set([...(old.enabled ? [] : old.reasons), cap.reason])] };
    }
  };
  const paths = design.endpoints.filter(e => scenario.workload.mix[e.id] > 0).map(endpoint => {
    const reachable = new Set<string>();
    const walk = (id: string) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      const n = design.nodes.find(n => n.id === id);
      if (!n) return;
      if (n.kind === 'client') walk(n.params.entry);
      else if (n.kind === 'service' || n.kind === 'worker') for (const s of routeSteps(n.handlers?.[endpoint.id] ?? [])) {
        if (s.type === 'call') walk(s.target);
        else if (s.type === 'cacheGet' || s.type === 'cacheSet' || s.type === 'cacheDelete') walk(s.cache);
        else if (s.type === 'data') walk(s.target);
        else if (s.type === 'dedup') walk(s.store);
        else if (s.type === 'publish') walk(s.queue);
      }
      else if (n.kind === 'dns') n.params.records.forEach(walk);
      else if (['loadBalancer', 'rateLimiter', 'cdn', 'apiGateway', 'circuitBreaker'].includes(n.kind)) for (const e of design.edges.filter(e => e.from === id)) walk(e.to);
      if (n.kind === 'queue') for (const worker of design.nodes) if (worker.kind === 'worker' && worker.params.source === id) walk(worker.id);
    };
    for (const n of design.nodes) if (n.kind === 'client') walk(n.id);
    const predictions = fresh(); disable(predictions, 'correctness');
    const nodes = design.nodes.filter(n => reachable.has(n.id));
    if (nodes.some(n => n.kind === 'database' || n.kind === 'kvStore') && endpoint.op === 'write' && (scenario.workload.keys.kind === 'hotspot' || design.entities?.some(e => e.dataset.keys.kind === 'hotspot'))) disable(predictions, 'contention');
    if (endpoint.responseFields && design.entities?.some(e => e.fields.some(f => endpoint.responseFields!.includes(f.name) && f.bytes.sdBytes > 0)) || Object.values(endpoint.inputs ?? {}).some(g => g.kind === 'size' && g.sdBytes > 0)) {
      disable(predictions, 'variableObjects');
    }
    for (const n of nodes) {
      disable(predictions, featureCoverage.components[n.kind]);
      for (const s of routeSteps(n.handlers?.[endpoint.id] ?? [])) {
        disable(predictions, featureCoverage.steps[s.type]);
        if (s.type === 'branch') {
          disable(predictions, featureCoverage.conditions[s.cond.kind]);
          if (s.cond.kind === 'found' && (design.endpoints.some(e => scenario.workload.mix[e.id] > 0 && e.op === 'write') || design.nodes.some(n => Object.values(n.handlers ?? {}).some(steps => routeSteps(steps ?? []).some(s => s.type === 'data' && s.op.kind !== 'get' && s.op.kind !== 'query'))))) disable(predictions, 'dataState');
        }
        if (s.type === 'data') {
          disable(predictions, featureCoverage.dataOps[s.op.kind]);
          if (s.op.kind !== 'get' && s.op.kind !== 'query' && design.entities?.find(e => e.name === s.entity)?.indexes.some(i => i.unique)) disable(predictions, 'dataConflict');
        }
      }
      if ('queueDiscipline' in n.params && n.params.queueDiscipline === 'lifo') disable(predictions, 'lifo');
      if (n.kind === 'database' && n.params.failover) disable(predictions, 'failover');
      if (n.kind === 'loadBalancer' && n.params.algorithm === 'consistentHash') disable(predictions, 'keyedBalancing');
      if (n.kind !== 'cache' && n.kind !== 'cdn') continue;
      if (n.params.eviction === 'lfu') disable(predictions, 'lfu');
      const inputs = Object.values(endpoint.inputs ?? {});
      if (inputs.length ? inputs.length !== 1 || inputs[0].kind !== 'zipf' : scenario.workload.keys.kind !== 'zipf') disable(predictions, 'popularity');
      const sizes = new Set(design.endpoints.filter(e => scenario.workload.mix[e.id] > 0).map(e => responseBytes(design, e)));
      if (sizes.size > 1 || design.entities?.some(e => e.fields.some(f => f.bytes.sdBytes > 0)) || design.endpoints.some(e => Object.values(e.inputs ?? {}).some(g => g.kind === 'size' && g.sdBytes > 0))) disable(predictions, 'variableObjects');
      if (design.endpoints.some(e => scenario.workload.mix[e.id] > 0 && e.op === 'write') || nodes.some(s => routeSteps(s.handlers?.[endpoint.id] ?? []).some(s => s.type === 'cacheDelete' && s.cache === n.id))) disable(predictions, 'invalidation');
    }
    for (const c of scenario.chaos) disable(predictions, featureCoverage.chaos[c.kind]);
    const features = new Set<Feature>(['serialRoutes', 'links', 'arrivals', ...(design.regions ? ['regions' as const] : [])]);
    if (design.nodes.some(n => n.kind === 'autoscaler' && n.params.targets.some(id => reachable.has(id)))) features.add('autoscaling');
    for (const n of nodes) {
      features.add(featureCoverage.components[n.kind]);
      if (n.kind === 'database' && n.params.replication) features.add('replication');
      for (const step of routeSteps(n.handlers?.[endpoint.id] ?? [])) features.add(featureCoverage.steps[step.type]);
    }
    for (const state of Object.values(predictions)) if (state.enabled) state.reasons = [...state.reasons ?? [], ...[...features].filter(f => capabilityMatrix[f].scale !== 'unsupported').map(f => capabilityMatrix[f].reason)];
    return { endpointId: endpoint.id, predictions };
  });
  const predictions = fresh(); disable(predictions, 'correctness');
  for (const path of paths) for (const name of names) {
    const state = path.predictions[name];
    if (!state.enabled) {
      const old = predictions[name];
      predictions[name] = { enabled: false, reasons: [...new Set([...(old.enabled ? [] : old.reasons), ...state.reasons])] };
    } else if (predictions[name].enabled) predictions[name].reasons = [...new Set([...(predictions[name].reasons ?? []), ...state.reasons ?? []])];
  }
  return { predictions, paths, correctness: 'unknown' };
}
