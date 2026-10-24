import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createGossipModel, phiAccrual, type GossipMode } from ".";
import { generateGossipVariant, solveGossipVariant } from "./variants";

describe("gossip and phi accrual", () => {
  it("replays all scenarios deterministically without modifying prior state", () => {
    const model = createGossipModel({ nodes: 16 });
    for (const script of model.scenarios) {
      let s = model.init(14);
      for (const action of script.actions) {
        const before = structuredClone(s), next = model.step(s, action);
        expect(s).toEqual(before); expect(next).not.toBe(s); s = next;
        expect(model.invariants(s).filter(i => i.code !== "falsePositive")).toEqual([]);
      }
      expect(s).toEqual(script.actions.reduce(model.step, model.init(14)));
    }
  });
  it.each(["push", "pull", "pushPull"] as GossipMode[])("%s spreads in logarithmic rounds statistically over seeded runs", mode => {
    for (const nodes of [16, 32, 64, 128]) {
      const model = createGossipModel({ nodes, mode });
      let total = 0, completed = 0;
      const budget = Math.ceil(8 * Math.log2(nodes));
      for (let seed = 0; seed < 32; seed++) {
        let s = model.init(seed);
        while (s.curve.at(-1)! < nodes && s.round < budget) s = model.step(s, { type: "round" });
        total += s.round; completed += Number(s.curve.at(-1) === nodes);
      }
      expect(completed).toBe(32); expect(total / 32).toBeLessThan(4 * Math.log2(nodes));
    }
  });
  it("uses synchronous fanout and does not infect offline nodes until recovery", () => {
    const model = createGossipModel({ nodes: 8, mode: "push", fanout: 2 });
    let s = model.step(model.init(1), { type: "round" }); expect(s.curve).toEqual([1, 3]);
    s = model.step(s, { type: "crash", node: "N7" });
    const before = s.nodes[7].infected;
    for (let i = 0; i < 20; i++) s = model.step(s, { type: "round" });
    expect(s.nodes[7].infected).toBe(before);
    s = model.step(s, { type: "recover", node: "N7" });
    for (let i = 0; i < 20; i++) s = model.step(s, { type: "round" });
    expect(s.curve.at(-1)).toBe(8); expect(model.invariants(s)).toEqual([]);
  });
  it("calculates phi from observed inter-arrival history and a variance floor", () => {
    expect(phiAccrual(100, [100, 100, 100])).toBeCloseTo(Math.log10(2), 5);
    expect(phiAccrual(200, [100, 100, 100])).toBeGreaterThan(phiAccrual(150, [100, 100, 100]));
    expect(phiAccrual(200, [50, 100, 150])).toBeLessThan(phiAccrual(200, [100, 100, 100]));
    expect(Number.isFinite(phiAccrual(1e9, [100]))).toBe(true);
    expect(() => phiAccrual(-1, [100])).toThrow(); expect(() => phiAccrual(0, [0])).toThrow();
  });
  it("demonstrates the false-positive versus detection-delay trade-off", () => {
    const low = createGossipModel({ threshold: 1 }), high = createGossipModel({ threshold: 8 });
    let l = low.init(0), h = high.init(0);
    for (let i = 0; i < 5; i++) {
      l = low.step(low.step(l, { type: "advance", ms: 100 }), { type: "heartbeat" });
      h = high.step(high.step(h, { type: "advance", ms: 100 }), { type: "heartbeat" });
    }
    l = low.step(l, { type: "advance", ms: 150 }); h = high.step(h, { type: "advance", ms: 150 });
    expect(l.detector.suspected).toBe(true); expect(h.detector.suspected).toBe(false);
    expect(l.detector.falsePositives).toBeGreaterThan(h.detector.falsePositives);
    l = low.step(l, { type: "heartbeat" }); h = high.step(h, { type: "heartbeat" });
    l = low.step(l, { type: "crash", node: "N0" }); h = high.step(h, { type: "crash", node: "N0" });
    for (let i = 0; i < 50; i++) { l = low.step(l, { type: "advance", ms: 10 }); h = high.step(h, { type: "advance", ms: 10 }); }
    expect(l.detector.detectedAt).not.toBeNull(); expect(h.detector.detectedAt).not.toBeNull();
    expect(l.detector.detectedAt!).toBeLessThan(h.detector.detectedAt!);
    expect(low.invariants(l)).toEqual([]);
  });
  it("variants get their infection counts from the stepper", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      const v = generateGossipVariant(seed), model = createGossipModel(v), s = v.actions.reduce(model.step, model.init(seed));
      expect(v).toEqual(generateGossipVariant(seed)); expect(solveGossipVariant(v)).toBe(s.nodes.filter(n => n.infected).length);
      expect(model.invariants(s)).toEqual([]);
    }));
  });
});
