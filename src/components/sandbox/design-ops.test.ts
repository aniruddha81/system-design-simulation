import { describe, expect, it } from "vitest";
import type { Design } from "@/engine/types";
import { addNode, affectedBy, brokenRefs, connect, insertOnEdge, removeBrokenSteps, removeElements } from "./design-ops";
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
      expect(r.cacheId).toBe("cache"); // reuses the template cache that chaos kills
      d = r.design;
    }
    expect(gradeChallenge(noCacheDesign, cachingChallenge).verdict).toBe("fail");
    expect(gradeChallenge(d, cachingChallenge).verdict).toBe("pass");
  }, 120_000);
});
