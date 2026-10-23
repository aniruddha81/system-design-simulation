import type { Design, Scenario, Step } from '../types';
import type { FidelityReport, Prediction, PredictionState, Support } from './types';

const cacheEffects: Prediction[] = ['hitRate', 'latency', 'utilisation', 'backlog', 'drops', 'timelySuccess'];
type Capability = { exact: Support; scale: Support; reason: string; disables: Prediction[]; availableInP1?: boolean };
// Typed data replaces PLAN §5A.0's YAML without adding a YAML runtime dependency.
export const capabilityMatrix = {
  serialRoutes: { exact: 'supported', scale: 'approximate', reason: 'Serial convolution and branch mixtures assume independent hops.', disables: [] },
  parallel: { exact: 'supported', scale: 'approximate', availableInP1: false, reason: 'Planned independence approximation; parallel steps are outside the current P1 Step contract.', disables: ['latency', 'timelySuccess'] },
  publish: { exact: 'supported', scale: 'approximate', availableInP1: false, reason: 'Planned fluid queue; publish/consumers are outside the P1 component contract.', disables: ['utilisation', 'backlog', 'drops', 'latency', 'timelySuccess'] },
  retries: { exact: 'supported', scale: 'approximate', reason: 'Timeout-tail feedback and shifted backoff mixtures assume independent attempts.', disables: [] },
  lruZipf: { exact: 'supported', scale: 'approximate', reason: 'Che / non-refreshing TTL-Che; stationary Zipf and fixed object bytes only.', disables: [] },
  lfu: { exact: 'supported', scale: 'unsupported', reason: 'LFU cache: Scale cannot predict hit rate or dependent traffic; run in Exact.', disables: cacheEffects },
  variableObjects: { exact: 'supported', scale: 'unsupported', reason: 'Variable object sizes: Che requires fixed object bytes.', disables: cacheEffects },
  invalidation: { exact: 'supported', scale: 'unsupported', reason: 'Cache invalidation/write traffic is outside the validated stationary read-cache envelope.', disables: cacheEffects },
  popularity: { exact: 'supported', scale: 'unsupported', reason: 'Cache predictions require stationary Zipf popularity.', disables: cacheEffects },
  coldStart: { exact: 'supported', scale: 'approximate', reason: 'Distinct-key coverage from completed successful origin fills; restart clears occupancy.', disables: [] },
  contention: { exact: 'supported', scale: 'unsupported', availableInP1: false, reason: 'Row locks, isolation and dedup races are outside the P1 contract.', disables: ['latency', 'timelySuccess', 'correctness'] },
  replication: { exact: 'supported', scale: 'approximate', availableInP1: false, reason: 'Planned write/apply rate model; P1 replicas multiply capacity and cost, without lag semantics.', disables: ['correctness'] },
  failover: { exact: 'supported', scale: 'approximate', availableInP1: false, reason: 'Capacity effects only; failover, split brain and fencing correctness are unknown.', disables: ['correctness'] },
  links: { exact: 'supported', scale: 'approximate', reason: 'Independent fluid bandwidth queues per direction, with loss probabilities.', disables: [] },
  autoscaling: { exact: 'supported', scale: 'supported', availableInP1: false, reason: 'Planned capacity steps after provisioning; no autoscaling parameters exist in the P1 contract.', disables: ['utilisation', 'backlog', 'drops', 'latency', 'timelySuccess'] },
  chaos: { exact: 'supported', scale: 'supported', reason: 'Timeline maps to capacity/health multipliers; LB health convergence is approximate.', disables: [] },
  correctness: { exact: 'supported', scale: 'unsupported', reason: 'Scale never checks correctness invariants; correctness is unknown.', disables: ['correctness'] },
  percentiles: { exact: 'supported', scale: 'approximate', reason: 'Unavailable outside CV ≤ 4 and utilisation ≤ 0.95, or during an outage.', disables: [] },
  lifo: { exact: 'supported', scale: 'unsupported', reason: 'Backlog/capacity waiting models FIFO only.', disables: ['latency', 'timelySuccess'] },
  keyedBalancing: { exact: 'supported', scale: 'unsupported', reason: 'Consistent-hash key affinity is outside the independent flow split envelope.', disables: ['utilisation', 'backlog', 'drops', 'latency', 'timelySuccess'] },
} satisfies Record<string, Capability>;

export function routeSteps(steps: Step[]): Step[] {
  return steps.flatMap(s => s.type === 'branch' ? [s, ...routeSteps(s.then), ...routeSteps(s.else)] : [s]);
}

export function checkFidelity(design: Design, scenario: Scenario): FidelityReport {
  const names: Prediction[] = ['utilisation', 'backlog', 'drops', 'latency', 'hitRate', 'timelySuccess', 'cost', 'correctness'];
  const fresh = () => Object.fromEntries(names.map(p => [p, { enabled: true }])) as Record<Prediction, PredictionState>;
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
      else if (n.kind === 'service') for (const s of routeSteps(n.handlers?.[endpoint.id] ?? [])) {
        if (s.type === 'call') walk(s.target);
        else if (s.type === 'cacheGet' || s.type === 'cacheSet' || s.type === 'cacheDelete') walk(s.cache);
      }
      else if (n.kind === 'loadBalancer' || n.kind === 'rateLimiter') for (const e of design.edges.filter(e => e.from === id)) walk(e.to);
    };
    for (const n of design.nodes) if (n.kind === 'client') walk(n.id);
    const predictions = fresh(); disable(predictions, 'correctness');
    const nodes = design.nodes.filter(n => reachable.has(n.id));
    for (const n of nodes) {
      if (n.kind !== 'client' && n.params.queueDiscipline === 'lifo') disable(predictions, 'lifo');
      if (n.kind === 'loadBalancer' && n.params.algorithm === 'consistentHash') disable(predictions, 'keyedBalancing');
      if (n.kind !== 'cache') continue;
      if (n.params.eviction === 'lfu') disable(predictions, 'lfu');
      if (scenario.workload.keys.kind !== 'zipf') disable(predictions, 'popularity');
      const sizes = new Set(design.endpoints.filter(e => scenario.workload.mix[e.id] > 0).map(e => e.responseBytes));
      if (sizes.size > 1) disable(predictions, 'variableObjects');
      if (design.endpoints.some(e => scenario.workload.mix[e.id] > 0 && e.op === 'write') || nodes.some(s => routeSteps(s.handlers?.[endpoint.id] ?? []).some(s => s.type === 'cacheDelete' && s.cache === n.id))) disable(predictions, 'invalidation');
    }
    return { endpointId: endpoint.id, predictions };
  });
  const predictions = fresh(); disable(predictions, 'correctness');
  for (const path of paths) for (const name of names) {
    const state = path.predictions[name];
    if (!state.enabled) {
      const old = predictions[name];
      predictions[name] = { enabled: false, reasons: [...new Set([...(old.enabled ? [] : old.reasons), ...state.reasons])] };
    }
  }
  return { predictions, paths, correctness: 'unknown' };
}
