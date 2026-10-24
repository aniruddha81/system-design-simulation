import { describe, expect, it } from "vitest";
import type { Design } from "@/engine/types";
import {
  addNode, affectedBy, alignNodes, brokenRefs, connect, copySelection, distributeNodes, insertOnEdge, liveDiff, parseClip, pasteClip,
  removeBrokenSteps, removeElements, updateNode,
} from "./design-ops";
import { KINDS } from "./kinds";
import { pushHistory, redoHistory, undoHistory, type History } from "./design-store";

function base(): Design {
  let d: Design = {
    schemaVersion: 1, id: "d", name: "t", nodes: [], edges: [],
    endpoints: [
      { id: "get", name: "GET /u/:id", op: "read", keyTemplate: "u:{id}", requestBytes: 100, responseBytes: 1000, idempotent: true },
      { id: "put", name: "PUT /u/:id", op: "write", keyTemplate: "u:{id}", requestBytes: 1000, responseBytes: 100, idempotent: true },
    ],
  };
  d = addNode(d, "client", { x: 0, y: 0 }).design;
  d = addNode(d, "service", { x: 200, y: 0 }).design;
  d = addNode(d, "database", { x: 400, y: 0 }).design;
  d = connect(d, "client-1", "service-1").design;
  d = connect(d, "service-1", "database-1").design;
  d.nodes[1] = {
    ...(d.nodes[1] as Extract<Design["nodes"][number], { kind: "service" }>),
    handlers: {
      get: [{ type: "call", target: "database-1", timeoutUs: 1000 }, { type: "respond", status: 200 }],
      put: [{ type: "call", target: "database-1", timeoutUs: 1000 }, { type: "respond", status: 201 }],
    },
  };
  return d;
}

describe("design ops", () => {
  it("connect sets the client entry and rejects duplicates", () => {
    const d = base();
    expect(d.nodes[0].params).toEqual({ entry: "service-1" });
    expect(connect(d, "client-1", "service-1").error).toBeTruthy();
  });

  it("cache dropped on service→DB applies the cache-aside rewrite", () => {
    const d = base();
    const r = insertOnEdge(d, d.edges[1].id, "cache", { x: 300, y: 100 });
    if ("error" in r) throw new Error(r.error);
    const svc = r.design.nodes.find((n) => n.id === "service-1")!;
    expect(svc.handlers!.get).toEqual([
      { type: "cacheGet", cache: "cache-1", timeoutUs: 50_000 },
      { type: "branch", cond: { kind: "cacheHit" }, then: [], else: [
        { type: "call", target: "database-1", timeoutUs: 1000 },
        { type: "cacheSet", cache: "cache-1", timeoutUs: 50_000 },
      ] },
      { type: "respond", status: 200 },
    ]);
    expect(svc.handlers!.put).toEqual([
      { type: "call", target: "database-1", timeoutUs: 1000 },
      { type: "cacheDelete", cache: "cache-1", timeoutUs: 50_000 },
      { type: "respond", status: 201 },
    ]);
    expect(r.design.edges.some((e) => e.from === "service-1" && e.to === "cache-1")).toBe(true);
    expect(r.design.edges.some((e) => e.from === "service-1" && e.to === "database-1")).toBe(true);
    expect(brokenRefs(r.design)).toEqual([]);
    expect(r.rewritten.map((x) => x.endpointId)).toEqual(["get", "put"]);
  });

  it("rejects drops without an insertion rule", () => {
    const d = base();
    expect("error" in insertOnEdge(d, d.edges[0].id, "cache", { x: 0, y: 0 })).toBe(true);
    expect("error" in insertOnEdge(d, d.edges[1].id, "loadBalancer", { x: 0, y: 0 })).toBe(true);
  });

  it("deleting a used edge lists affected steps and leaves them broken until removed", () => {
    const d = base();
    const edge = d.edges[1].id;
    expect(affectedBy(d, { edgeIds: [edge] })).toHaveLength(2);
    const after = removeElements(d, { edgeIds: [edge] });
    expect(brokenRefs(after)).toHaveLength(2);
    const fixed = removeBrokenSteps(after);
    expect(brokenRefs(fixed)).toEqual([]);
    expect(fixed.nodes[1].handlers!.get).toEqual([{ type: "respond", status: 200 }]);
  });
});

describe("P2 insertion rules (§8A.5)", () => {
  it("load balancer on client→service retargets the entry and rewires A→LB→B", () => {
    const d = base();
    const r = insertOnEdge(d, d.edges[0].id, "loadBalancer", { x: 100, y: 0 });
    if ("error" in r) throw new Error(r.error);
    expect(r.design.nodes[0].params).toEqual({ entry: r.insertedId });
    expect(r.design.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["client-1>lb-1", "lb-1>service-1", "service-1>database-1"]);
  });

  it("rate limiter between two services retargets calls and keeps the edge only if still used", () => {
    let d = base();
    d = addNode(d, "service", { x: 0, y: 200 }).design;
    d = connect(d, "service-1", "service-2").design;
    d = updateNode(d, "service-1", (n) => ({ ...n, handlers: { ...n.handlers, get: [{ type: "call", target: "service-2", timeoutUs: 9 }, { type: "respond", status: 200 }] } }));
    const r = insertOnEdge(d, d.edges.find((e) => e.to === "service-2")!.id, "rateLimiter", { x: 0, y: 0 });
    if ("error" in r) throw new Error(r.error);
    const svc = r.design.nodes.find((n) => n.id === "service-1")!;
    expect(svc.handlers!.get![0]).toEqual({ type: "call", target: r.insertedId, timeoutUs: 9 });
    expect(r.design.edges.some((e) => e.from === "service-1" && e.to === "service-2")).toBe(false);
    expect(r.rewritten).toEqual([{ owner: "service-1", endpointId: "get" }]);
    expect(brokenRefs(r.design)).toEqual([]);
  });

  it("queue turns write calls into publish and moves the call to a new worker", () => {
    const d = base();
    const r = insertOnEdge(d, d.edges[1].id, "queue", { x: 300, y: 100 });
    if ("error" in r) throw new Error(r.error);
    const svc = r.design.nodes.find((n) => n.id === "service-1")!;
    const worker = r.design.nodes.find((n) => n.kind === "worker")!;
    expect(svc.handlers!.put![0]).toEqual({ type: "publish", queue: r.insertedId, timeoutUs: 1000, orderedByKey: false });
    expect(svc.handlers!.get![0]).toEqual({ type: "call", target: "database-1", timeoutUs: 1000 }); // reads stay synchronous
    expect(worker.params).toMatchObject({ source: r.insertedId });
    expect(worker.handlers!.put).toEqual([{ type: "call", target: "database-1", timeoutUs: 1000 }, { type: "respond", status: 200 }]);
    expect(r.design.edges.some((e) => e.from === "service-1" && e.to === "database-1")).toBe(true); // still used by reads
    expect(brokenRefs(r.design)).toEqual([]);
  });

  it("rejects incompatible drops with a reason", () => {
    const d = base();
    const lbOnDb = insertOnEdge(d, d.edges[1].id, "loadBalancer", { x: 0, y: 0 });
    expect("error" in lbOnDb && lbOnDb.error).toMatch(/front of a service/);
    expect("error" in insertOnEdge(d, d.edges[0].id, "queue", { x: 0, y: 0 })).toBe(true);
    expect("error" in insertOnEdge(d, d.edges[1].id, "worker", { x: 0, y: 0 })).toBe(true);
  });

  it("rewrites calls nested inside parallel branches", () => {
    let d = base();
    d = updateNode(d, "service-1", (n) => ({ ...n, handlers: { get: [{ type: "parallel", join: { kind: "all" }, cancelLosers: false, branches: [[{ type: "call", target: "database-1", timeoutUs: 5 }], []] }] } }));
    const r = insertOnEdge(d, d.edges[1].id, "cache", { x: 0, y: 0 });
    if ("error" in r) throw new Error(r.error);
    const par = r.design.nodes[1].handlers!.get![0];
    expect(par.type === "parallel" && par.branches[0][0].type).toBe("cacheGet");
  });
});

describe("copy / paste", () => {
  it("remaps ids, route references and edges to existing nodes", () => {
    const d = base();
    const clip = parseClip(JSON.stringify(copySelection(d, ["service-1"])), KINDS)!;
    const r = pasteClip(d, clip, { x: 32, y: 32 });
    if ("error" in r) throw new Error(r.error);
    expect(r.ids).toEqual(["service-2"]);
    const copy = r.design.nodes.find((n) => n.id === "service-2")!;
    expect(copy.position).toEqual({ x: 232, y: 32 });
    expect(copy.handlers!.get![0]).toEqual({ type: "call", target: "database-1", timeoutUs: 1000 });
    // Edges into and out of the copy are kept because both ends exist.
    expect(r.design.edges.filter((e) => e.from === "service-2" || e.to === "service-2").map((e) => `${e.from}>${e.to}`).sort()).toEqual(["client-1>service-2", "service-2>database-1"]);
    expect(brokenRefs(r.design)).toEqual([]);
  });

  it("remaps references between pasted nodes", () => {
    const d = base();
    const r = pasteClip(d, copySelection(d, ["service-1", "database-1"]), { x: 0, y: 100 });
    if ("error" in r) throw new Error(r.error);
    const svc = r.design.nodes.find((n) => n.id === "service-2")!;
    expect(svc.handlers!.get![0]).toMatchObject({ target: "database-2" });
    expect(r.design.edges.some((e) => e.from === "service-2" && e.to === "database-2")).toBe(true);
    expect(r.design.edges.some((e) => e.from === "service-2" && e.to === "database-1")).toBe(false);
  });

  it("rejects malformed clipboard text", () => {
    expect(parseClip("not json", KINDS)).toBeNull();
    expect(parseClip(JSON.stringify({ type: "sds-clip", nodes: [{ id: "x", kind: "nope" }], edges: [] }), KINDS)).toBeNull();
  });
});

describe("align / distribute", () => {
  it("aligns and spaces evenly", () => {
    const d = base();
    const ids = d.nodes.map((n) => n.id);
    expect(alignNodes(d, ids, "top").nodes.every((n) => n.position.y === 0)).toBe(true);
    const moved = updateNode(d, "service-1", (n) => ({ ...n, position: { x: 50, y: 0 } }));
    expect(distributeNodes(moved, ids, "x").nodes.map((n) => n.position.x)).toEqual([0, 200, 400]);
  });
});

describe("live edits (§5.7)", () => {
  it("parameter changes become live edits; structural ones return null", () => {
    const d = base();
    const p = updateNode(d, "database-1", (n) => (n.kind === "database" ? { ...n, label: "x", params: { ...n.params, concurrency: 99, readTime: { kind: "constant", us: 5 } } } : n));
    expect(liveDiff(d, p)).toEqual([
      { nodeId: "database-1", path: "concurrency", value: 99 },
      { nodeId: "database-1", path: "readTime", value: { kind: "constant", us: 5 } },
    ]);
    expect(liveDiff(d, addNode(d, "cache", { x: 0, y: 0 }).design)).toBeNull();
    expect(liveDiff(d, removeElements(d, { edgeIds: [d.edges[0].id] }))).toBeNull();
    expect(liveDiff(d, { ...d, annotations: [{ id: "a" }] })).toEqual([]);
    const t = updateNode(d, "service-1", (n) => ({ ...n, handlers: { ...n.handlers, get: [{ type: "call", target: "database-1", timeoutUs: 7 }, { type: "respond", status: 200 }] } }));
    expect(liveDiff(d, t)).toEqual([{ nodeId: "service-1", path: "handlers.get.0.timeoutUs", value: 7 }]);
    const structural = updateNode(d, "service-1", (n) => ({ ...n, handlers: { ...n.handlers, get: [{ type: "respond", status: 200 }] } }));
    expect(liveDiff(d, structural)).toBeNull();
  });
});

describe("history", () => {
  const d = (n: string) => ({ ...base(), name: n });
  it("coalesces commits with the same gesture key into one undo step", () => {
    let h: History = { design: d("0"), past: [], future: [], lastKey: null };
    h = pushHistory(h, d("1"), "drag:1");
    h = pushHistory(h, d("2"), "drag:1");
    h = pushHistory(h, d("3"), "drag:1");
    expect(h.past).toHaveLength(1);
    h = pushHistory(h, d("4"));
    expect(h.past).toHaveLength(2);
    h = undoHistory(h);
    expect(h.design.name).toBe("3");
    h = undoHistory(h);
    expect(h.design.name).toBe("0");
    h = redoHistory(h);
    expect(h.design.name).toBe("3");
  });
});

describe("against the real engine", () => {
  it("a cache dropped on a fixture service→DB edge yields a valid design", async () => {
    const { noCacheDesign, cachingScenario } = await import("@/engine/fixtures");
    const { validateDesign } = await import("@/engine");
    const d = removeElements(noCacheDesign, { nodeIds: ["cache"] });
    const r = insertOnEdge(d, "svc1-db", "cache", { x: 600, y: 100 });
    if ("error" in r) throw new Error(r.error);
    expect(r.rewritten).toHaveLength(2);
    expect(validateDesign(r.design, { ...cachingScenario, chaos: [] })).toEqual([]);
  });

  // P1 exit: starting from the challenge template, dropping a cache on both service→DB edges passes.
  it("the learner's cache-aside path passes the caching challenge", async () => {
    const { noCacheDesign, cachingChallenge } = await import("@/engine/fixtures");
    const { gradeChallenge } = await import("@/engine");
    let d = noCacheDesign;
    for (const edge of ["svc1-db", "svc2-db"]) {
      const r = insertOnEdge(d, edge, "cache", { x: 600, y: 100 });
      if ("error" in r) throw new Error(r.error);
      expect(r.insertedId).toBe("cache"); // reuses the template cache that chaos kills
      d = r.design;
    }
    expect(gradeChallenge(noCacheDesign, cachingChallenge).verdict).toBe("fail");
    expect(gradeChallenge(d, cachingChallenge).verdict).toBe("pass");
  }, 120_000);
});
