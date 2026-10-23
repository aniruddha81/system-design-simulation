import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compareModuloHashing, createHashRingModel, hashRingScenarios, loadStandardDeviation, type HashRingAction } from ".";
import { generateHashRingVariant, solveHashRingVariant } from "./variants";

describe("consistent hashing", () => {
  it("replays every scenario deterministically without mutating prior state", () => {
    const model = createHashRingModel();
    for (const script of hashRingScenarios) {
      let state = model.init(42);
      for (const action of script.actions) {
        const before = structuredClone(state);
        const next = model.step(state, action);
        expect(state).toEqual(before);
        expect(next).not.toBe(state);
        expect(model.invariants(next)).toEqual([]);
        state = next;
      }
      expect(state).toEqual(script.actions.reduce(model.step, model.init(42)));
    }
  });

  it("preserves ownership and exact movement through random topology changes", () => {
    fc.assert(fc.property(fc.integer(), fc.array(fc.record({ add: fc.boolean(), node: fc.integer({ min: 0, max: 12 }) }), { maxLength: 60 }), (seed, changes) => {
      const model = createHashRingModel({ keys: Array.from({ length: 200 }, (_, i) => `k${i}`) });
      let state = model.init(seed);
      for (const change of changes) {
        const node = `n${change.node}`;
        if (!change.add && state.nodes.length === 1 && state.nodes[0] === node) continue;
        const action: HashRingAction = { type: change.add ? "addNode" : "removeNode", node };
        const next = model.step(state, action);
        expect(model.invariants(next)).toEqual([]);
        expect(Object.values(next.load).reduce((a, b) => a + b, 0)).toBe(next.keys.length);
        expect(next.movedKeys).toEqual(state.keys.filter(key => state.ownership[key] !== next.ownership[key]));
        if (!change.add) expect(next.movedKeys.every(key => state.ownership[key] === node)).toBe(true);
        else expect(next.movedKeys.every(key => next.ownership[key] === node)).toBe(true);
        state = next;
      }
    }), { numRuns: 70 });
  });

  it("virtual nodes lower load standard deviation over seeded placement samples", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100000 }), seed => {
      let without = 0, withVnodes = 0;
      for (let sample = 0; sample < 12; sample++) {
        const options = { nodes: ["a", "b", "c", "d", "e", "f"], keys: Array.from({ length: 2000 }, (_, i) => `k${i}`) };
        without += loadStandardDeviation(createHashRingModel({ ...options, vnodes: 1 }).init(seed + sample));
        withVnodes += loadStandardDeviation(createHashRingModel({ ...options, vnodes: 128 }).init(seed + sample));
      }
      expect(withVnodes).toBeLessThan(without);
    }), { numRuns: 30 });
  });

  it("adding keys does not claim the new keys moved and deduplicates keys", () => {
    const model = createHashRingModel({ keys: ["x"] });
    const state = model.step(model.init(1), { type: "addKeys", keys: ["x", "y", "y"] });
    expect(state.keys).toEqual(["x", "y"]);
    expect(state.movedKeys).toEqual([]);
    expect(model.invariants(state)).toEqual([]);
  });

  it("is independent of node/key insertion order", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      expect(createHashRingModel({ nodes: ["b", "a", "c"], keys: ["y", "x"] }).init(seed))
        .toEqual(createHashRingModel({ nodes: ["c", "b", "a"], keys: ["x", "y"] }).init(seed));
    }));
  });

  it("offers executable actions and captures configuration independently of the caller", () => {
    const options = { nodes: ["node-3", "node-3-new", "C"], vnodes: 1, keys: ["key-1"] };
    const model = createHashRingModel(options);
    const before = model.init(1);
    options.vnodes = 32;
    options.nodes.push("D");
    expect(model.init(1)).toEqual(before);
    for (const action of model.actions(before)) expect(model.invariants(model.step(before, action))).toEqual([]);
    expect(model.actions(before).map(action => action.type)).toContain("addKeys");
  });

  it("handles dictionary-like identifiers as data", () => {
    const model = createHashRingModel({ nodes: ["__proto__", "constructor"], keys: ["__proto__", "toString"] });
    const state = model.step(model.init(2), { type: "addKeys", keys: ["constructor"] });
    expect(model.invariants(state)).toEqual([]);
    expect(Object.values(state.load).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("rejects empty rings and invalid vnode counts", () => {
    const model = createHashRingModel({ nodes: ["a"] });
    expect(() => model.step(model.init(0), { type: "removeNode", node: "a" })).toThrow();
    for (const count of [0, -1, 1.5, Infinity, 1025]) expect(() => model.step(model.init(0), { type: "setVnodes", count })).toThrow();
  });

  it("compares modulo resize movement using actual owners", () => {
    const model = createHashRingModel();
    const state = model.init(42);
    const after = model.step(state, { type: "addNode", node: "D" });
    const result = compareModuloHashing(state.keys, state.nodes, after.nodes, state.seed);
    expect(result.movedCount).toBe(state.keys.filter(key => result.before[key] !== result.after[key]).length);
    expect(result.movedCount).toBeGreaterThan(after.movedKeys.length);
    expect(compareModuloHashing(state.keys, state.nodes, state.nodes, 42).movedCount).toBe(0);
    expect(() => compareModuloHashing([], [], ["a"])).toThrow();
  });

  it("reports corrupted ownership, movement and load", () => {
    const model = createHashRingModel({ keys: ["x"] });
    const state = model.init(1);
    expect(model.invariants({ ...state, ownership: { x: "missing" } }).map(v => v.code)).toContain("singleOwnership");
    expect(model.invariants({ ...state, movedKeys: ["x"] }).map(v => v.code)).toContain("movedKeys");
    expect(model.invariants({ ...state, load: { A: 100 } }).map(v => v.code)).toContain("load");
  });

  it("solves generated variants by replaying the same model", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      const variant = generateHashRingVariant(seed);
      expect(variant).toEqual(generateHashRingVariant(seed));
      const model = createHashRingModel(variant);
      const before = model.init(seed), after = model.step(before, variant.action);
      expect(solveHashRingVariant(variant)).toBe(before.keys.filter(key => before.ownership[key] !== after.ownership[key]).length);
    }));
  });
});
