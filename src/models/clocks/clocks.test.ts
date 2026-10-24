import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { causalRelation, compareHLC, compareVectors, createClocksModel, physicalTime, type ClocksState } from ".";
import { generateClocksVariant, solveClocksVariant } from "./variants";

function bruteForceGraph(s: ClocksState) {
  const edges = s.events.map(e => s.events.map(p => e.parents.includes(p.id)));
  for (let k = 0; k < edges.length; k++) for (let i = 0; i < edges.length; i++) for (let j = 0; j < edges.length; j++) edges[i][j] ||= edges[i][k] && edges[k][j];
  return edges;
}
describe("clocks", () => {
  it("replays every clock and LWW scenario immutably", () => {
    const model = createClocksModel();
    for (const script of model.scenarios) {
      let s = model.init(12);
      for (const action of script.actions) {
        const before = structuredClone(s), next = model.step(s, action);
        expect(s).toEqual(before); expect(next).not.toBe(s); s = next;
      }
      expect(s).toEqual(script.actions.reduce(model.step, model.init(12)));
      expect(model.invariants(s).filter(i => !["physicalOrderingAnomaly", "lwwLostUpdate"].includes(i.code))).toEqual([]);
    }
  });
  it("shows skew reversing send/receive and physical LWW discarding a causally later write", () => {
    const model = createClocksModel(), physical = model.scenarios[0].actions.reduce(model.step, model.init(1));
    const send = physical.events.find(e => e.kind === "send")!, receive = physical.events.find(e => e.kind === "receive")!;
    expect(receive.physical).toBeLessThan(send.physical);
    expect(receive.lamport).toBeGreaterThan(send.lamport); expect(compareHLC(send.hlc, receive.hlc)).toBeLessThan(0);
    expect(model.invariants(physical).map(i => i.code)).toContain("physicalOrderingAnomaly");
    const lww = model.scenarios.at(-1)!.actions.reduce(model.step, model.init(1));
    expect(lww.nodes[1].register?.value).toBe("first");
    expect(causalRelation(lww, "e1", "e4")).toBe("before");
    expect(model.invariants(lww).map(i => i.code)).toContain("lwwLostUpdate");
  });
  it("models drift and holds HLC monotonic across backwards physical jumps", () => {
    const model = createClocksModel({ nodes: [{ id: "A", skew: 5, driftPpm: 1000 }] });
    let s = model.step(model.init(0), { type: "advance", ms: 1000 });
    expect(physicalTime(s.nodes[0], s.now)).toBeCloseTo(1006);
    s = model.step(s, { type: "local", node: "A" });
    s = model.step(s, { type: "configure", node: "A", skew: -1000, driftPpm: 0 });
    s = model.step(s, { type: "local", node: "A" });
    expect(compareHLC(s.events[0].hlc, s.events[1].hlc)).toBeLessThan(0);
    expect(s.events[1].physical).toBeLessThan(s.events[0].physical);
  });
  it("vector happens-before agrees with a brute-force causal graph on arbitrary diagrams", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.nat(100), fc.nat(100), fc.nat(100)), { minLength: 1, maxLength: 40 }), choices => {
      const model = createClocksModel(); let s = model.init(9);
      for (const [op, a, b] of choices) {
        const from = s.nodes[a % 3].id, to = s.nodes[b % 3].id;
        s = model.step(s, op % 3 === 0 ? { type: "local", node: from } : op % 3 === 1 || !s.messages.length ? { type: "send", from, to } : { type: "receive", message: s.messages[b % s.messages.length].id });
      }
      const graph = bruteForceGraph(s);
      for (let i = 0; i < s.events.length; i++) for (let j = 0; j < s.events.length; j++) {
        const expected = i === j ? "equal" : graph[j][i] ? "before" : graph[i][j] ? "after" : "concurrent";
        expect(compareVectors(s.events[i].vector, s.events[j].vector)).toBe(expected);
        expect(causalRelation(s, s.events[i].id, s.events[j].id)).toBe(expected);
      }
      expect(model.invariants(s)).toEqual([]);
    }), { numRuns: 55 });
  });
  it("validates inputs and solves every seeded variant using the model", () => {
    const model = createClocksModel();
    expect(() => model.step(model.init(1), { type: "advance", ms: -1 })).toThrow();
    expect(() => model.step(model.init(1), { type: "receive", message: "missing" })).toThrow();
    expect(() => createClocksModel({ nodes: [{ id: "A", driftPpm: Infinity }] })).toThrow();
    fc.assert(fc.property(fc.integer(), seed => {
      const v = generateClocksVariant(seed), state = v.actions.reduce(model.step, model.init(seed)), graph = bruteForceGraph(state);
      expect(v).toEqual(generateClocksVariant(seed));
      const [i, j] = v.pair.map(id => state.events.findIndex(e => e.id === id));
      expect(solveClocksVariant(v)).toBe(graph[j][i] ? "before" : graph[i][j] ? "after" : "concurrent");
    }));
  });
});
