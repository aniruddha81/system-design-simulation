// Pure design edits shared by the whiteboard, list editor and inspector.
import type { ComponentKind, Design, EdgeSpec, NodeId, NodeParams, NodeSpec, QueueParams, Step } from "@/engine/types";

const ms = (x: number) => x * 1000;

const queue = (concurrency: number, costPerHour: number): QueueParams => ({
  concurrency, queueCapacity: 200, queueDiscipline: "fifo", costPerHour, region: "us-east-1", zone: "us-east-1a",
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
};

export function addNode(d: Design, kind: ComponentKind, position: { x: number; y: number }): { design: Design; id: NodeId } {
  const id = nextId(d.nodes.map((n) => n.id), kind === "loadBalancer" ? "lb" : kind === "rateLimiter" ? "limiter" : kind);
  const n = d.nodes.filter((x) => x.kind === kind).length + 1;
  const node = { id, kind, label: `${KIND_LABEL[kind]} ${n}`, position, params: defaultParams(kind) } as NodeSpec;
  return { design: { ...d, nodes: [...d.nodes, node] }, id };
}

export function connect(d: Design, from: NodeId, to: NodeId): { design: Design; error?: string } {
  if (from === to) return { design: d, error: "A component cannot call itself" };
  if (d.edges.some((e) => e.from === from && e.to === to)) return { design: d, error: "These are already connected" };
  const target = d.nodes.find((n) => n.id === to);
  if (target?.kind === "client") return { design: d, error: "Nothing calls a client" };
  const edge: EdgeSpec = {
    id: nextId(d.edges.map((e) => e.id), `e-${from}-${to}`), from, to,
    latency: { kind: "constant", us: 500 }, bandwidthBytesPerSec: 1.25e9, lossRate: 0,
  };
  // A client sends its traffic to its first outgoing edge unless told otherwise.
  const nodes = d.nodes.map((n) => (n.id === from && n.kind === "client" && !n.params.entry ? { ...n, params: { entry: to } } : n));
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

export function stepTarget(s: Step): NodeId | undefined {
  return s.type === "call" ? s.target : s.type === "cacheGet" || s.type === "cacheSet" || s.type === "cacheDelete" ? s.cache : undefined;
}

function walk(steps: Step[], visit: (s: Step, path: number[]) => void, prefix: number[] = []) {
  steps.forEach((s, i) => {
    const path = [...prefix, i];
    visit(s, path);
    if (s.type === "branch") {
      walk(s.then, visit, [...path, 0]);
      walk(s.else, visit, [...path, 1]);
    }
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
  const prune = (owner: NodeId, ep: string, steps: Step[], prefix: number[]): Step[] =>
    steps.flatMap((s, i): Step[] => {
      const path = [...prefix, i];
      if (broken.has(`${owner}|${ep}|${path.join(".")}`)) return [];
      if (s.type !== "branch") return [s];
      return [{ ...s, then: prune(owner, ep, s.then, [...path, 0]), else: prune(owner, ep, s.else, [...path, 1]) }];
    });
  return {
    ...d,
    nodes: d.nodes.map((n) =>
      n.handlers
        ? ({ ...n, handlers: Object.fromEntries(Object.entries(n.handlers).map(([ep, s]) => [ep, prune(n.id, ep, s ?? [], [])])) } as NodeSpec)
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
    case "branch": return s.cond.kind === "cacheHit" ? "if cache hit" : `with probability ${s.cond.p}`;
    case "respond": return `respond ${s.status}`;
  }
}

// ---------- drop onto an edge (§8A.5) ----------

const CACHE_TIMEOUT_US = 50_000;

/**
 * Cache dropped onto service -> database: add the cache next to the edge, add service -> cache,
 * keep service -> database (cache-aside: the service still reads the DB on a miss), and rewrite
 * the service's routes: reads become cacheGet -> (miss: call DB, cacheSet), writes gain cacheDelete.
 */
export function insertOnEdge(
  d: Design, edgeId: string, kind: ComponentKind, position: { x: number; y: number },
): { design: Design; cacheId?: NodeId; rewritten: { owner: NodeId; endpointId: string }[] } | { error: string } {
  const edge = d.edges.find((e) => e.id === edgeId);
  if (!edge) return { error: "That connection no longer exists" };
  const a = d.nodes.find((n) => n.id === edge.from);
  const b = d.nodes.find((n) => n.id === edge.to);
  if (kind !== "cache") return { error: `No insertion rule for a ${KIND_LABEL[kind].toLowerCase()} on a connection yet — drop it on empty space and connect it` };
  if (a?.kind !== "service" || b?.kind !== "database") return { error: "A cache can only be inserted on a service → database connection" };

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
  const rewritten: { owner: NodeId; endpointId: string }[] = [];

  const rewrite = (steps: Step[], op: "read" | "write"): Step[] =>
    steps.flatMap((s): Step[] => {
      if (s.type === "branch") return [{ ...s, then: rewrite(s.then, op), else: rewrite(s.else, op) }];
      if (s.type !== "call" || s.target !== b.id) return [s];
      if (op === "write") return [s, { type: "cacheDelete", cache: cacheId, timeoutUs: CACHE_TIMEOUT_US }];
      return [
        { type: "cacheGet", cache: cacheId, timeoutUs: CACHE_TIMEOUT_US },
        { type: "branch", cond: { kind: "cacheHit" }, then: [], else: [s, { type: "cacheSet", cache: cacheId, timeoutUs: CACHE_TIMEOUT_US }] },
      ];
    });

  next = updateNode(next, a.id, (n) => {
    if (!n.handlers) return n;
    const handlers: Record<string, Step[]> = {};
    for (const [ep, steps] of Object.entries(n.handlers)) {
      const op = ops.get(ep);
      const out = op ? rewrite(steps ?? [], op) : steps ?? [];
      if (JSON.stringify(out) !== JSON.stringify(steps)) rewritten.push({ owner: n.id, endpointId: ep });
      handlers[ep] = out;
    }
    return { ...n, handlers } as NodeSpec;
  });
  return { design: next, cacheId, rewritten };
}

/** Squared distance from p to segment ab, for edge hit-testing on drop. */
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
