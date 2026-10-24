import type { ChaosEvent, DataOp, Design, Dist, EdgeSpec, EntitySpec, FieldSpec, NodeParams, NodeSpec, QueueParams, RetryPolicy, Scenario, Status, Step, Workload } from "@/engine/types";

// Small builders shared by the case studies. Units: ms in, µs out. Everything here produces
// plain engine data (Design, Scenario), so a case study stays serialisable.

const us = (ms: number) => Math.round(ms * 1000);
export const lognormal = (medianMs: number, sigma = 0.4): Dist => ({ kind: "lognormal", medianUs: us(medianMs), sigma });
export const constant = (ms: number): Dist => ({ kind: "constant", us: Math.max(1, us(ms)) });

/** Worker pool: concurrency, $/hour, waiting slots. */
export const pool = (concurrency: number, costPerHour: number, queueCapacity = 2000, zone = "a"): QueueParams => ({
  concurrency, queueCapacity, queueDiscipline: "fifo", costPerHour, region: "us-east", zone,
});

/** Directed "may call" edge; 0.25 ms one-way inside a data centre, 10 Gbit/s. */
export const link = (from: string, to: string, latencyMs = 0.25, bandwidthBytesPerSec = 1.25e9): EdgeSpec => ({
  id: `${from}-${to}`, from, to, latency: lognormal(latencyMs, 0.2), bandwidthBytesPerSec, lossRate: 0,
});

/** Grid position: column and row on the whiteboard. */
type At = [number, number];
export function node<K extends NodeSpec["kind"]>(id: string, kind: K, label: string, at: At, params: NodeParams[K], handlers?: Record<string, Step[]>): NodeSpec {
  return { id, kind, label, position: { x: at[0] * 240, y: at[1] * 150 }, params, ...(handlers ? { handlers } : {}) } as NodeSpec;
}

export const client = (entry: string, at: At = [0, 1]) => node("client", "client", "Clients", at, { entry });
export const loadBalancer = (id: string, at: At, algorithm: NodeParams["loadBalancer"]["algorithm"] = "leastConnections") =>
  node(id, "loadBalancer", "Load balancer", at, {
    ...pool(4096, 0.025), algorithm, serviceTime: constant(0.05),
    healthCheck: { intervalUs: 200_000, unhealthyThreshold: 2, healthyThreshold: 2 },
  });
/** Stateless service instance (~4 vCPU): `concurrency` request workers. */
export const service = (id: string, label: string, at: At, handlers: Record<string, Step[]>, concurrency = 64, medianMs = 1) =>
  node(id, "service", label, at, { ...pool(concurrency, 0.17), serviceTime: lognormal(medianMs) }, handlers);
export const cache = (id: string, label: string, at: At, capacityBytes: number, ttlMs?: number, coalesce = true) =>
  node(id, "cache", label, at, { ...pool(128, 0.2), serviceTime: lognormal(0.2, 0.3), capacityBytes, eviction: "lru", ...(ttlMs ? { ttlUs: us(ttlMs) } : {}), coalesce });

/** Fields: name → [type, mean bytes]. The first field is the primary key. */
export function entity(name: string, store: string, fields: Record<string, [FieldSpec["type"], number]>, count: number, extra: Partial<EntitySpec> = {}): EntitySpec {
  const list = Object.entries(fields).map(([n, [type, bytes]]): FieldSpec => ({ name: n, type, bytes: { meanBytes: bytes, sdBytes: Math.round(bytes / 4) } }));
  return { name, store, fields: list, primaryKey: list[0].name, indexes: [], dataset: { count, keys: { kind: "uniform", n: count } }, ...extra };
}

// ---------- route steps ----------
export const respond = (status: Status = 200): Step => ({ type: "respond", status });
export const call = (target: string, timeoutMs: number, retry?: RetryPolicy): Step => ({ type: "call", target, timeoutUs: us(timeoutMs), ...(retry ? { retry } : {}) });
export const data = (target: string, entityName: string, op: DataOp, timeoutMs: number, retry?: RetryPolicy): Step => ({ type: "data", target, entity: entityName, op, timeoutUs: us(timeoutMs), ...(retry ? { retry } : {}) });
export const publish = (queue: string, orderedByKey = false, timeoutMs = 50): Step => ({ type: "publish", queue, orderedByKey, timeoutUs: us(timeoutMs) });
export const dedup = (store: string, timeoutMs = 5): Step => ({ type: "dedup", store, timeoutUs: us(timeoutMs) });
/** Exponential backoff with full jitter (AWS Architecture Blog, 2015). */
export const backoff = (max: number, baseMs: number, retryOn: RetryPolicy["retryOn"] = ["timeout", "5xx"]): RetryPolicy => ({ max, backoffUs: us(baseMs), multiplier: 2, jitter: "full", retryOn });

/** Cache-aside read: hit → 200; miss → `load` → fill → 200 (Nishtala et al. 2013). */
export const cacheAside = (cacheId: string, load: Step[], timeoutMs = 5): Step[] => [
  { type: "cacheGet", cache: cacheId, timeoutUs: us(timeoutMs) },
  { type: "branch", cond: { kind: "cacheHit" }, then: [respond(200)], else: [...load, { type: "cacheSet", cache: cacheId, timeoutUs: us(timeoutMs) }, respond(200)] },
];
export const cacheDelete = (cacheId: string, timeoutMs = 5): Step => ({ type: "cacheDelete", cache: cacheId, timeoutUs: us(timeoutMs) });

// ---------- scenarios ----------
/** A short Exact-mode run: 1 s warm-up (caches fill), 1.5 s measured, 0.5 s drain (3 s simulated). */
export function scenario(id: string, workload: Omit<Workload, "deadlineUs"> & { deadlineMs?: number }, chaos: ChaosEvent[] = []): Scenario {
  const { deadlineMs = 1000, ...rest } = workload;
  return { id, version: 1, warmupUs: 1_000_000, measureUs: 1_500_000, drainUs: 500_000, chaos, workload: { ...rest, deadlineUs: us(deadlineMs) } };
}
/** Same workload, new id and chaos; optional workload overrides. */
export const variant = (base: Scenario, id: string, chaos: ChaosEvent[], workload: Partial<Workload> = {}): Scenario =>
  ({ ...structuredClone(base), id, chaos, workload: { ...structuredClone(base.workload), ...workload } });
/** Chaos window in ms of simulated time (the measured window is 1000–2500 ms). */
export const window = (fromMs: number, toMs: number) => ({ atUs: us(fromMs), endUs: us(toMs) });

/** Deep copy with edits, for alternative designs. */
export function alter(design: Design, id: string, name: string, edit: (d: Design) => void): Design {
  const d = structuredClone(design);
  d.id = id; d.name = name; edit(d);
  return d;
}
export const find = <K extends NodeSpec["kind"]>(d: Design, id: string) => d.nodes.find((n) => n.id === id) as Extract<NodeSpec, { kind: K }>;
