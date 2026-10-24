// Pure design edits shared by the whiteboard, list editor and inspector.
import type {
  ComponentKind, Design, EdgeSpec, EntitySpec, GroupSpec, NodeId, NodeParams, NodeSpec, QueueParams, Step,
} from "@/engine/types";

const ms = (x: number) => x * 1000;
const sec = (x: number) => x * 1e6;
const REGION = "us-east-1";
const ZONE = "us-east-1a";

const queue = (concurrency: number, costPerHour: number): QueueParams => ({
  concurrency, queueCapacity: 200, queueDiscipline: "fifo", costPerHour, region: REGION, zone: ZONE,
});

export function defaultParams<K extends ComponentKind>(kind: K): NodeParams[K] {
  const p: { [k in ComponentKind]: NodeParams[k] } = {
    client: { entry: "" },
    loadBalancer: {
      ...queue(1000, 0.03), algorithm: "roundRobin", serviceTime: { kind: "constant", us: 200 },
      healthCheck: { intervalUs: ms(1000), unhealthyThreshold: 3, healthyThreshold: 2 },
    },
    service: { ...queue(16, 0.1), serviceTime: { kind: "lognormal", medianUs: ms(5), sigma: 0.4 } },
    cache: {
      ...queue(64, 0.07), serviceTime: { kind: "constant", us: 300 }, capacityBytes: 512 * 1024 ** 2, eviction: "lru", coalesce: false,
    },
    database: {
      ...queue(16, 0.5), readTime: { kind: "lognormal", medianUs: ms(8), sigma: 0.4 },
      writeTime: { kind: "lognormal", medianUs: ms(15), sigma: 0.4 }, replicas: 1,
    },
    rateLimiter: {
      ...queue(256, 0.03), serviceTime: { kind: "constant", us: 100 }, algorithm: "tokenBucket", ratePerSec: 1000, burst: 100,
    },
    dns: { resolutionTime: { kind: "lognormal", medianUs: ms(5), sigma: 0.5 }, ttlUs: sec(60), records: [] },
    cdn: {
      ...queue(512, 0.05), serviceTime: { kind: "constant", us: ms(1) }, capacityBytes: 1024 ** 3, eviction: "lru",
      ttlUs: sec(60), originShield: false, costPerGB: 0.08,
    },
    apiGateway: { ...queue(512, 0.05), serviceTime: { kind: "constant", us: ms(2) }, maxRequestBytes: 1024 ** 2 },
    kvStore: {
      ...queue(64, 0.3), readTime: { kind: "lognormal", medianUs: ms(2), sigma: 0.4 }, writeTime: { kind: "lognormal", medianUs: ms(3), sigma: 0.4 },
      members: 3, vnodes: 16, replicationFactor: 3, readQuorum: 2, writeQuorum: 2, hintedHandoff: true, readRepair: true, tombstoneGcUs: sec(60),
    },
    queue: {
      partitions: 4, capacityMessages: 10_000, visibilityTimeoutUs: sec(5), maxDeliveries: 5, retentionUs: sec(3600),
      publishTime: { kind: "constant", us: ms(2) }, costPerHour: 0.05, region: REGION, zone: ZONE,
    },
    worker: { ...queue(8, 0.1), serviceTime: { kind: "lognormal", medianUs: ms(10), sigma: 0.4 }, source: "", batchSize: 1 },
    objectStore: {
      readTime: { kind: "lognormal", medianUs: ms(30), sigma: 0.5 }, writeTime: { kind: "lognormal", medianUs: ms(60), sigma: 0.5 },
      costPerGBMonth: 0.023, costPerMillionRequests: 5, region: REGION, zone: ZONE,
    },
    searchIndex: { ...queue(16, 0.2), serviceTime: { kind: "lognormal", medianUs: ms(10), sigma: 0.4 }, indexLag: { kind: "lognormal", medianUs: sec(1), sigma: 0.5 }, source: "" },
    dedupStore: { ...queue(64, 0.05), serviceTime: { kind: "constant", us: 500 }, ttlUs: sec(86_400), atomic: true, durable: true },
    autoscaler: {
      targets: [], metric: "utilisation", targetValue: 0.6, min: 2, max: 32,
      cooldownUs: sec(3), provisionUs: sec(2), warmupUs: sec(1), evaluateEveryUs: sec(1),
    },
    circuitBreaker: { failureRateThreshold: 0.5, windowUs: sec(2), minRequests: 20, openUs: sec(1), halfOpenProbes: 3 },
  };
  return p[kind];
}

/** Readable, deterministic ids: "cache-2". */
export function nextId(taken: Iterable<string>, prefix: string): string {
  const set = new Set(taken);
  for (let i = 1; ; i++) if (!set.has(`${prefix}-${i}`)) return `${prefix}-${i}`;
}

export const KIND_LABEL: Record<ComponentKind, string> = {
  client: "Client", loadBalancer: "Load balancer", service: "Service", cache: "Cache", database: "Database", rateLimiter: "Rate limiter",
  dns: "DNS", cdn: "CDN", apiGateway: "API gateway", kvStore: "KV store", queue: "Queue", worker: "Worker", objectStore: "Object store",
  searchIndex: "Search index", dedupStore: "Dedup store", autoscaler: "Autoscaler", circuitBreaker: "Circuit breaker",
};

const ID_PREFIX: Partial<Record<ComponentKind, string>> = {
  loadBalancer: "lb", rateLimiter: "limiter", apiGateway: "gateway", circuitBreaker: "breaker", kvStore: "kv",
  objectStore: "blob", searchIndex: "search", dedupStore: "dedup",
};

/** Kinds that run a route program per endpoint. Everything else has built-in behaviour. */
export const HANDLER_KINDS: ComponentKind[] = ["service", "worker"];
/** Kinds that hold entities (§8A.1). */
export const STORE_KINDS: ComponentKind[] = ["database", "kvStore", "cache", "searchIndex", "objectStore"];
/** Pass-through kinds that forward to their outgoing edge (§8A.5 insertion rule "calls to B now target X"). */
const PASS_THROUGH: ComponentKind[] = ["loadBalancer", "rateLimiter", "apiGateway", "circuitBreaker", "cdn"];

export const hasParam = (n: NodeSpec, key: string) => key in (n.params as object);

export function addNode(d: Design, kind: ComponentKind, position: { x: number; y: number }): { design: Design; id: NodeId } {
  const id = nextId(d.nodes.map((n) => n.id), ID_PREFIX[kind] ?? kind);
  const n = d.nodes.filter((x) => x.kind === kind).length + 1;
  const node = { id, kind, label: `${KIND_LABEL[kind]} ${n}`, position, params: defaultParams(kind) } as NodeSpec;
  return { design: { ...d, nodes: [...d.nodes, node] }, id };
}

export function connect(d: Design, from: NodeId, to: NodeId): { design: Design; error?: string } {
  if (from === to) return { design: d, error: "A component cannot call itself" };
  if (d.edges.some((e) => e.from === from && e.to === to)) return { design: d, error: "These are already connected" };
  const source = d.nodes.find((n) => n.id === from);
  const target = d.nodes.find((n) => n.id === to);
  if (target?.kind === "client") return { design: d, error: "Nothing calls a client" };
  if (source?.kind === "autoscaler" || target?.kind === "autoscaler")
    return { design: d, error: "An autoscaler is not in the request path — choose its targets in the inspector" };
  const edge: EdgeSpec = {
    id: nextId(d.edges.map((e) => e.id), `e-${from}-${to}`), from, to,
    latency: { kind: "constant", us: 500 }, bandwidthBytesPerSec: 1.25e9, lossRate: 0,
  };
  // Connecting fills an empty reference: client entry, DNS records, a worker's queue, a search index's source.
  const nodes = d.nodes.map((n): NodeSpec => {
    if (n.id === from && n.kind === "client" && !n.params.entry) return { ...n, params: { entry: to } };
    if (n.id === from && n.kind === "dns") return { ...n, params: { ...n.params, records: [...n.params.records, to] } };
    if (n.id === to && n.kind === "worker" && !n.params.source && source?.kind === "queue") return { ...n, params: { ...n.params, source: from } };
    if (n.id === to && n.kind === "searchIndex" && !n.params.source && source && STORE_KINDS.includes(source.kind)) return { ...n, params: { ...n.params, source: from } };
    return n;
  });
  return { design: { ...d, nodes, edges: [...d.edges, edge] } };
}

export function updateNode(d: Design, id: NodeId, fn: (n: NodeSpec) => NodeSpec): Design {
  return { ...d, nodes: d.nodes.map((n) => (n.id === id ? fn(n) : n)) };
}

export function updateEdge(d: Design, id: string, fn: (e: EdgeSpec) => EdgeSpec): Design {
  return { ...d, edges: d.edges.map((e) => (e.id === id ? fn(e) : e)) };
}

/** Immutable set by path; used by the data-driven inspector fields. */
export function setIn<T>(obj: T, path: readonly string[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path;
  const cur = obj as Record<string, unknown>;
  const next = { ...cur, [head]: setIn(cur?.[head], rest, value) };
  if (value === undefined && rest.length === 0) delete next[head];
  return next as T;
}

export function getIn(obj: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

// ---------- route references (§8A.5) ----------

export type StepRef = { owner: NodeId; endpointId: string; path: number[]; step: Step };

/** The node a step depends on (and so needs an edge to). */
export function stepTarget(s: Step): NodeId | undefined {
  switch (s.type) {
    case "call": case "data": return s.target;
    case "cacheGet": case "cacheSet": case "cacheDelete": return s.cache;
    case "publish": return s.queue;
    case "dedup": return s.store;
    case "branch": return s.cond.kind === "leaderAlive" ? s.cond.store : s.cond.kind === "breakerClosed" ? s.cond.breaker : undefined;
    default: return undefined;
  }
}

/** Child step lists: branch → [then, else]; parallel → its branches. Path segments index into these. */
export function childLists(s: Step): Step[][] {
  return s.type === "branch" ? [s.then, s.else] : s.type === "parallel" ? s.branches : [];
}

function withChildren(s: Step, lists: Step[][]): Step {
  if (s.type === "branch") return { ...s, then: lists[0], else: lists[1] };
  if (s.type === "parallel") return { ...s, branches: lists };
  return s;
}

function walk(steps: Step[], visit: (s: Step, path: number[]) => void, prefix: number[] = []) {
  steps.forEach((s, i) => {
    const path = [...prefix, i];
    visit(s, path);
    childLists(s).forEach((list, k) => walk(list, visit, [...path, k]));
  });
}

/** Rewrite a route bottom-up: `fn` maps each step (children already rewritten) to zero or more steps. */
export function mapSteps(steps: Step[], fn: (s: Step, path: number[]) => Step[], prefix: number[] = []): Step[] {
  return steps.flatMap((s, i) => {
    const path = [...prefix, i];
    const kids = childLists(s);
    return fn(kids.length ? withChildren(s, kids.map((l, k) => mapSteps(l, fn, [...path, k]))) : s, path);
  });
}

export function allStepRefs(d: Design): StepRef[] {
  const out: StepRef[] = [];
  for (const n of d.nodes)
    for (const [endpointId, steps] of Object.entries(n.handlers ?? {}))
      walk(steps ?? [], (step, path) => out.push({ owner: n.id, endpointId, path, step }));
  return out;
}

/** Steps that would lose their target if these nodes/edges were deleted. */
export function affectedBy(d: Design, sel: { nodeIds?: NodeId[]; edgeIds?: string[] }): StepRef[] {
  const nodes = new Set(sel.nodeIds ?? []);
  const edges = d.edges.filter((e) => sel.edgeIds?.includes(e.id));
  return allStepRefs(d).filter((r) => {
    if (nodes.has(r.owner)) return false; // the owner disappears with its routes
    const t = stepTarget(r.step);
    return t !== undefined && (nodes.has(t) || edges.some((e) => e.from === r.owner && e.to === t));
  });
}

/** Steps whose target is gone or not reachable over an edge from the owner. */
export function brokenRefs(d: Design): StepRef[] {
  const ids = new Set(d.nodes.map((n) => n.id));
  return allStepRefs(d).filter((r) => {
    const t = stepTarget(r.step);
    return t !== undefined && (!ids.has(t) || !d.edges.some((e) => e.from === r.owner && e.to === t));
  });
}

export function removeBrokenSteps(d: Design): Design {
  const broken = new Set(brokenRefs(d).map((r) => `${r.owner}|${r.endpointId}|${r.path.join(".")}`));
  return {
    ...d,
    nodes: d.nodes.map((n) =>
      n.handlers
        ? ({
            ...n,
            handlers: Object.fromEntries(Object.entries(n.handlers).map(([ep, s]) => [
              ep, mapSteps(s ?? [], (step, path) => (broken.has(`${n.id}|${ep}|${path.join(".")}`) ? [] : [step])),
            ])),
          } as NodeSpec)
        : n,
    ),
  };
}

export function removeElements(d: Design, sel: { nodeIds?: NodeId[]; edgeIds?: string[] }): Design {
  const nodes = new Set(sel.nodeIds ?? []);
  const edges = new Set(sel.edgeIds ?? []);
  return {
    ...d,
    nodes: d.nodes.filter((n) => !nodes.has(n.id)),
    edges: d.edges.filter((e) => !edges.has(e.id) && !nodes.has(e.from) && !nodes.has(e.to)),
  };
}

export function reachableTargets(d: Design, from: NodeId): NodeSpec[] {
  const to = new Set(d.edges.filter((e) => e.from === from).map((e) => e.to));
  return d.nodes.filter((n) => to.has(n.id));
}

export function describeStep(d: Design, s: Step): string {
  const name = (id: NodeId) => d.nodes.find((n) => n.id === id)?.label ?? `${id} (deleted)`;
  switch (s.type) {
    case "call": return `call ${name(s.target)}`;
    case "cacheGet": return `cacheGet ${name(s.cache)}`;
    case "cacheSet": return `cacheSet ${name(s.cache)}`;
    case "cacheDelete": return `cacheDelete ${name(s.cache)}`;
    case "respond": return `respond ${s.status}`;
    case "publish": return `publish to ${name(s.queue)}`;
    case "data": return `${s.op.kind} ${s.entity} on ${name(s.target)}`;
    case "dedup": return `dedup on ${name(s.store)}`;
    case "parallel": {
      const j = s.join;
      return `parallel ×${s.branches.length}, wait for ${j.kind === "quorum" ? `quorum ${j.k}` : j.kind === "firstN" ? `first ${j.n}` : j.kind}`;
    }
    case "branch": {
      const c = s.cond;
      switch (c.kind) {
        case "cacheHit": return "if cache hit";
        case "prob": return `with probability ${c.p}`;
        case "found": return "if the record was found";
        case "dedupHit": return "if already seen (dedup hit)";
        case "leaderAlive": return `if ${name(c.store)} has a leader`;
        case "breakerClosed": return `if ${name(c.breaker)} is closed`;
      }
    }
  }
}

// ---------- drop onto an edge (§8A.5) ----------

const CACHE_TIMEOUT_US = 50_000;
export type Rewritten = { owner: NodeId; endpointId: string }[];
type InsertResult = { design: Design; insertedId: NodeId; rewritten: Rewritten } | { error: string };

function rewriteHandlers(d: Design, owner: NodeId, fn: (steps: Step[], endpointId: string) => Step[], rewritten: Rewritten): Design {
  return updateNode(d, owner, (n) => {
    if (!n.handlers) return n;
    const handlers: Record<string, Step[]> = {};
    for (const [ep, steps] of Object.entries(n.handlers)) {
      const out = fn(steps ?? [], ep);
      if (JSON.stringify(out) !== JSON.stringify(steps)) rewritten.push({ owner: n.id, endpointId: ep });
      handlers[ep] = out;
    }
    return { ...n, handlers } as NodeSpec;
  });
}

/** Drop the edge a→b unless some step of a still references b (or a is a client entry pointing at b). */
function dropEdgeIfUnused(d: Design, a: NodeId, b: NodeId): Design {
  const used = allStepRefs(d).some((r) => r.owner === a && stepTarget(r.step) === b);
  const entry = d.nodes.some((n) => n.id === a && n.kind === "client" && n.params.entry === b);
  return used || entry ? d : { ...d, edges: d.edges.filter((e) => !(e.from === a && e.to === b)) };
}

/**
 * Drop a component onto the edge A→B. Each rule is one atomic design change (one undo step):
 * - cache between service/worker and a database/KV store: reads become cache-aside, writes gain cacheDelete;
 * - load balancer in front of a service, or a rate limiter / API gateway / circuit breaker / CDN as a pass-through:
 *   A's calls to B now target X, and X forwards to B;
 * - queue between a producer and what it calls: write calls become publish, and a new worker consumes the queue
 *   and makes the original call.
 */
export function insertOnEdge(d: Design, edgeId: string, kind: ComponentKind, position: { x: number; y: number }): InsertResult {
  const edge = d.edges.find((e) => e.id === edgeId);
  if (!edge) return { error: "That connection no longer exists" };
  const a = d.nodes.find((n) => n.id === edge.from);
  const b = d.nodes.find((n) => n.id === edge.to);
  if (!a || !b) return { error: "That connection no longer exists" };
  if (kind === "cache") return insertCache(d, a, b, position);
  if (kind === "queue") return insertQueue(d, a, b, position);
  if (PASS_THROUGH.includes(kind)) return insertPassThrough(d, a, b, kind, position);
  return { error: `No insertion rule for a ${KIND_LABEL[kind].toLowerCase()} on a connection — drop it on empty space and connect it` };
}

function insertCache(d: Design, a: NodeSpec, b: NodeSpec, position: { x: number; y: number }): InsertResult {
  if (!HANDLER_KINDS.includes(a.kind) || (b.kind !== "database" && b.kind !== "kvStore"))
    return { error: "A cache can only be inserted on a service → database (or KV store) connection" };
  // Reuse a cache this service already connects to (e.g. a template's cache, which chaos may target by id).
  const existing = d.edges.map((e) => e.from === a.id && d.nodes.find((n) => n.id === e.to && n.kind === "cache")).find(Boolean);
  let next: Design;
  let cacheId: NodeId;
  if (existing) {
    next = d;
    cacheId = existing.id;
  } else {
    const added = addNode(d, "cache", position);
    cacheId = added.id;
    next = connect(added.design, a.id, cacheId).design;
  }
  const ops = new Map(d.endpoints.map((e) => [e.id, e.op]));
  const rewritten: Rewritten = [];
  const hitsB = (s: Step) => (s.type === "call" || s.type === "data") && s.target === b.id;
  next = rewriteHandlers(next, a.id, (steps, ep) => {
    const op = ops.get(ep);
    if (!op) return steps;
    return mapSteps(steps, (s) => {
      if (!hitsB(s)) return [s];
      if (op === "write") return [s, { type: "cacheDelete", cache: cacheId, timeoutUs: CACHE_TIMEOUT_US }];
      return [
        { type: "cacheGet", cache: cacheId, timeoutUs: CACHE_TIMEOUT_US },
        { type: "branch", cond: { kind: "cacheHit" }, then: [], else: [s, { type: "cacheSet", cache: cacheId, timeoutUs: CACHE_TIMEOUT_US }] },
      ];
    });
  }, rewritten);
  return { design: next, insertedId: cacheId, rewritten };
}

function insertPassThrough(d: Design, a: NodeSpec, b: NodeSpec, kind: ComponentKind, position: { x: number; y: number }): InsertResult {
  const what = KIND_LABEL[kind].toLowerCase();
  if (kind === "loadBalancer" && b.kind !== "service") return { error: "A load balancer goes in front of a service" };
  if (STORE_KINDS.includes(b.kind) || b.kind === "queue" || b.kind === "dedupStore")
    return { error: `A ${what} passes calls through, so it goes in front of a service or another pass-through, not a ${KIND_LABEL[b.kind].toLowerCase()}` };
  if (kind === "cdn" && a.kind !== "client" && a.kind !== "dns") return { error: "A CDN goes between clients (or DNS) and the origin" };
  const added = addNode(d, kind, position);
  const x = added.id;
  let next = connect(connect(added.design, a.id, x).design, x, b.id).design;
  const rewritten: Rewritten = [];
  next = rewriteHandlers(next, a.id, (steps) => mapSteps(steps, (s) => [s.type === "call" && s.target === b.id ? { ...s, target: x } : s]), rewritten);
  next = updateNode(next, a.id, (n): NodeSpec => {
    if (n.kind === "client" && n.params.entry === b.id) return { ...n, params: { entry: x } };
    if (n.kind === "dns") return { ...n, params: { ...n.params, records: n.params.records.filter((r) => r !== x).map((r) => (r === b.id ? x : r)) } };
    return n;
  });
  next = dropEdgeIfUnused(next, a.id, b.id);
  return { design: next, insertedId: x, rewritten };
}

function insertQueue(d: Design, a: NodeSpec, b: NodeSpec, position: { x: number; y: number }): InsertResult {
  if (!HANDLER_KINDS.includes(a.kind)) return { error: "A queue goes between a service (the producer) and what it calls" };
  if (b.kind === "queue" || b.kind === "client") return { error: `A queue cannot feed a ${KIND_LABEL[b.kind].toLowerCase()} directly` };
  const writes = new Set(d.endpoints.filter((e) => e.op === "write").map((e) => e.id));
  const calls = new Map<string, Extract<Step, { type: "call" }>>();
  for (const r of allStepRefs(d))
    if (r.owner === a.id && writes.has(r.endpointId) && r.step.type === "call" && r.step.target === b.id && !calls.has(r.endpointId))
      calls.set(r.endpointId, r.step);
  if (calls.size === 0)
    return { error: `No write route on ${a.label} calls ${b.label}. A queue makes writes asynchronous; reads need the answer now` };

  const q = addNode(d, "queue", position);
  const w = addNode(q.design, "worker", { x: position.x, y: position.y + 112 });
  let next = updateNode(w.design, w.id, (n) => (n.kind === "worker" ? { ...n, params: { ...n.params, source: q.id } } : n));
  next = connect(next, a.id, q.id).design;
  next = connect(next, q.id, w.id).design;
  next = connect(next, w.id, b.id).design;
  const rewritten: Rewritten = [];
  next = rewriteHandlers(next, a.id, (steps, ep) =>
    writes.has(ep)
      ? mapSteps(steps, (s) => [s.type === "call" && s.target === b.id ? { type: "publish", queue: q.id, timeoutUs: s.timeoutUs, orderedByKey: false } : s])
      : steps, rewritten);
  next = updateNode(next, w.id, (n) => ({
    ...n,
    handlers: Object.fromEntries([...calls].map(([ep, call]) => [ep, [structuredClone(call), { type: "respond", status: 200 }]])),
  }) as NodeSpec);
  for (const ep of calls.keys()) rewritten.push({ owner: w.id, endpointId: ep });
  next = dropEdgeIfUnused(next, a.id, b.id);
  return { design: next, insertedId: q.id, rewritten };
}

/** Distance from p to segment ab, for edge hit-testing on drop. */
export function distToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Display name for a node id, or a link bottleneck id ("edge:<edgeId>"). */
export function elementName(d: Design, id: string): string {
  if (id.startsWith("edge:")) {
    const e = d.edges.find((x) => x.id === id.slice(5));
    return e ? `link ${elementName(d, e.from)} → ${elementName(d, e.to)}` : id;
  }
  return d.nodes.find((n) => n.id === id)?.label ?? id;
}

// ---------- copy / paste / duplicate ----------

export type Clip = { type: "sds-clip"; nodes: NodeSpec[]; edges: EdgeSpec[]; entities: EntitySpec[] };

/** Selected nodes, every edge touching them, and the entities they store. */
export function copySelection(d: Design, ids: NodeId[]): Clip {
  const set = new Set(ids);
  return {
    type: "sds-clip",
    nodes: d.nodes.filter((n) => set.has(n.id)),
    edges: d.edges.filter((e) => set.has(e.from) || set.has(e.to)),
    entities: (d.entities ?? []).filter((e) => set.has(e.store)),
  };
}

/** Replace every string equal to an old id with its new id (params and routes only, never labels). */
export function remapRefs<T>(value: T, map: Map<string, string>): T {
  if (typeof value === "string") return (map.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => remapRefs(v, map)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapRefs(v, map)])) as T;
  return value;
}

/** Parse clipboard text; untrusted, so only well-formed clips with known kinds pass. */
export function parseClip(text: string, kinds: ComponentKind[]): Clip | null {
  try {
    const v = JSON.parse(text) as Partial<Clip>;
    if (v?.type !== "sds-clip" || !Array.isArray(v.nodes) || !Array.isArray(v.edges)) return null;
    const okNode = (n: NodeSpec) => typeof n?.id === "string" && kinds.includes(n.kind) && typeof n.label === "string" && n.params && typeof n.position?.x === "number" && typeof n.position?.y === "number";
    const okEdge = (e: EdgeSpec) => typeof e?.id === "string" && typeof e.from === "string" && typeof e.to === "string" && e.latency && typeof e.bandwidthBytesPerSec === "number";
    if (!v.nodes.every(okNode) || !v.edges.every(okEdge)) return null;
    return { type: "sds-clip", nodes: v.nodes, edges: v.edges, entities: Array.isArray(v.entities) ? v.entities : [] };
  } catch {
    return null;
  }
}

export const MAX_NODES = 200;

/** Paste with fresh ids. Edges to nodes outside the clip are kept when those nodes exist here. */
export function pasteClip(d: Design, clip: Clip, offset: { x: number; y: number }): { design: Design; ids: NodeId[] } | { error: string } {
  if (d.nodes.length + clip.nodes.length > MAX_NODES) return { error: `A design holds at most ${MAX_NODES} components` };
  const map = new Map<string, string>();
  const taken = d.nodes.map((n) => n.id);
  for (const n of clip.nodes) {
    const id = nextId(taken, ID_PREFIX[n.kind] ?? n.kind);
    taken.push(id);
    map.set(n.id, id);
  }
  const nodes = clip.nodes.map((n) => ({
    ...n,
    id: map.get(n.id)!,
    label: `${n.label} copy`,
    position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
    params: remapRefs(n.params, map),
    handlers: n.handlers && remapRefs(n.handlers, map),
  }) as NodeSpec);
  const exists = new Set(d.nodes.map((n) => n.id));
  const resolve = (id: string) => map.get(id) ?? (exists.has(id) ? id : null);
  const edges = [...d.edges];
  for (const e of clip.edges) {
    const from = resolve(e.from), to = resolve(e.to);
    if (!from || !to || edges.some((x) => x.from === from && x.to === to)) continue;
    edges.push({ ...e, id: nextId(edges.map((x) => x.id), `e-${from}-${to}`), from, to });
  }
  const entities = [...(d.entities ?? [])];
  for (const en of clip.entities) {
    const store = map.get(en.store);
    if (store && !entities.some((x) => x.store === store && x.name === en.name)) entities.push({ ...en, store });
  }
  return { design: { ...d, nodes: [...d.nodes, ...nodes], edges, ...(entities.length ? { entities } : {}) }, ids: nodes.map((n) => n.id) };
}

// ---------- align / distribute ----------

export type Align = "left" | "centerX" | "right" | "top" | "middle" | "bottom";

/** Nodes share one size on the board, so aligning top-left corners aligns their edges and centres too. */
export function alignNodes(d: Design, ids: NodeId[], how: Align): Design {
  const sel = d.nodes.filter((n) => ids.includes(n.id));
  if (sel.length < 2) return d;
  const axis = how === "left" || how === "centerX" || how === "right" ? "x" : "y";
  const vals = sel.map((n) => n.position[axis]);
  const target = how === "left" || how === "top" ? Math.min(...vals) : how === "right" || how === "bottom" ? Math.max(...vals) : (Math.min(...vals) + Math.max(...vals)) / 2;
  return { ...d, nodes: d.nodes.map((n) => (ids.includes(n.id) ? { ...n, position: { ...n.position, [axis]: target } } : n)) };
}

export function distributeNodes(d: Design, ids: NodeId[], axis: "x" | "y"): Design {
  const sel = d.nodes.filter((n) => ids.includes(n.id)).sort((a, b) => a.position[axis] - b.position[axis]);
  if (sel.length < 3) return d;
  const first = sel[0].position[axis], step = (sel.at(-1)!.position[axis] - first) / (sel.length - 1);
  const pos = new Map(sel.map((n, i) => [n.id, first + i * step]));
  return { ...d, nodes: d.nodes.map((n) => (pos.has(n.id) ? { ...n, position: { ...n.position, [axis]: pos.get(n.id)! } } : n)) };
}

// ---------- groups (§8): membership comes from region/zone params ----------

export function groupOf(groups: GroupSpec[], n: NodeSpec): GroupSpec | undefined {
  const p = n.params as { region?: string; zone?: string };
  return groups.find((g) => g.kind === "zone" && g.name === p.zone) ?? groups.find((g) => g.kind === "region" && g.name === p.region);
}

/** Region and zone names in use, for frames, chaos targets and the latency matrix. */
export function placeNames(d: Design): { regions: string[]; zones: string[] } {
  const regions = new Set<string>(d.regions?.names ?? []), zones = new Set<string>();
  for (const n of d.nodes) {
    const p = n.params as { region?: string; zone?: string };
    if (p.region) regions.add(p.region);
    if (p.zone) zones.add(p.zone);
  }
  return { regions: [...regions], zones: [...zones] };
}

// ---------- live edits (§5.7) ----------

export type LiveEditReq = { nodeId: string; path: string; value: unknown };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Leaf differences between two values; objects with different key sets (e.g. a Dist changing shape) are replaced whole. */
export function diffPaths(prev: unknown, next: unknown, path = ""): { path: string; value: unknown }[] {
  if (same(prev, next)) return [];
  if (Array.isArray(prev) && Array.isArray(next) && prev.length === next.length && path)
    return next.flatMap((v, i) => diffPaths(prev[i], v, `${path}.${i}`));
  if (isObj(prev) && isObj(next)) {
    const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])];
    // At the root optional params may come and go; deeper, a shape change replaces that subtree.
    if (!path || keys.every((k) => k in prev && k in next)) return keys.flatMap((k) => diffPaths(prev[k], next[k], path ? `${path}.${k}` : k));
  }
  return [{ path, value: next }];
}

/**
 * Edits that can be applied to a running simulation, or null when the change is structural
 * (components, connections, endpoints, entities or regions changed) and the run must stop.
 * Labels, positions, groups and annotations never matter to a run.
 */
export function liveDiff(prev: Design, next: Design): LiveEditReq[] | null {
  const shape = (d: Design) => JSON.stringify([
    d.nodes.map((n) => [n.id, n.kind]), d.edges.map((e) => [e.id, e.from, e.to]), d.endpoints, d.entities ?? null, d.regions ?? null,
  ]);
  if (shape(prev) !== shape(next)) return null;
  const out: LiveEditReq[] = [];
  for (const [i, n] of next.nodes.entries()) {
    const p = prev.nodes[i];
    for (const e of diffPaths(p.params, n.params)) out.push({ nodeId: n.id, ...e });
    // Route edits arrive as leaf paths ("handlers.get.0.timeoutUs"); the engine accepts timeout/retry changes only.
    for (const ep of new Set([...Object.keys(p.handlers ?? {}), ...Object.keys(n.handlers ?? {})])) {
      for (const e of diffPaths(p.handlers?.[ep], n.handlers?.[ep] ?? [], `handlers.${ep}`)) {
        if (!e.path.split(".").some((k) => k === "timeoutUs" || k === "retry")) return null;
        out.push({ nodeId: n.id, ...e });
      }
    }
  }
  next.edges.forEach((e, i) => {
    for (const x of diffPaths(prev.edges[i], e)) out.push({ nodeId: e.id, ...x });
  });
  return out;
}
