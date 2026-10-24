import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createQuorumModel } from ".";
import { generateQuorumVariant, solveQuorumVariant } from "./variants";

describe("quorum replication", () => {
  it("replays every script immutably and deterministically", () => {
    for (const sloppy of [false, true]) {
      const model = createQuorumModel({ sloppy });
      for (const script of model.scenarios) {
        let s = model.init(11);
        for (const action of script.actions) {
          const before = structuredClone(s), next = model.step(s, action);
          expect(s).toEqual(before); expect(next).not.toBe(s); s = next;
        }
        expect(s).toEqual(script.actions.reduce(model.step, model.init(11)));
      }
    }
  });
  it("can exhibit staleness iff R+W<=N on fixed replicas with sequential writes and retained versions", () => {
    for (let n = 1; n <= 6; n++) for (let r = 1; r <= n; r++) for (let w = 1; w <= n; w++) {
      const model = createQuorumModel({ n, r, w }), script = model.scenarios[0];
      const s = script.actions.reduce(model.step, model.init(0));
      expect(s.reads[0].stale).toBe(r + w <= n);
      expect(model.invariants(s).length > 0).toBe(r + w <= n);
    }
  });
  it("all overlapping read/write subsets return at least the latest acknowledged version", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 8 }), fc.nat(100), fc.nat(100), fc.array(fc.nat(100), { minLength: 8, maxLength: 8 }), (n, a, b, order) => {
      const w = 1 + a % n, r = 1 + b % n, ids = Array.from({ length: n }, (_, i) => `N${i}`);
      const read = ids.slice().sort((x, y) => order[ids.indexOf(x)] - order[ids.indexOf(y)]).slice(0, r);
      const model = createQuorumModel({ n, r, w });
      let s = model.step(model.init(0), { type: "write", key: "x", value: "latest", replicas: ids.slice(0, w) });
      s = model.step(s, { type: "read", key: "x", replicas: read });
      expect(s.reads[0].stale).toBe(!read.some(id => ids.slice(0, w).includes(id)));
      if (r + w > n) expect(s.reads[0].stale).toBe(false);
    }));
  });
  it("sloppy quorum breaks overlap and hinted handoff repairs the missing home replica", () => {
    const model = createQuorumModel({ n: 3, r: 2, w: 2, sloppy: true });
    let s = model.step(model.init(0), { type: "crash", replica: "N0" });
    s = model.step(s, { type: "write", key: "x", value: "new", replicas: ["N1", "N3"] });
    expect(s.writes[0].acknowledged).toBe(true); expect(s.hints).toHaveLength(1);
    s = model.step(s, { type: "recover", replica: "N0" });
    s = model.step(s, { type: "read", key: "x", replicas: ["N0", "N2"] });
    expect(s.reads.at(-1)?.stale).toBe(true);
    s = model.step(s, { type: "handoff" }); expect(s.hints).toEqual([]);
    s = model.step(s, { type: "read", key: "x", replicas: ["N0", "N2"], repair: true });
    expect(s.reads.at(-1)?.stale).toBe(false); expect(s.replicas[2].values.x.value).toBe("new");
    const scripted = model.scenarios[3].actions.reduce(model.step, model.init(0));
    expect(scripted.reads.map(r => r.stale)).toEqual([true, false]);
  });
  it("resurrects a tombstoned value after premature GC but prevents it if repair precedes GC", () => {
    const model = createQuorumModel(), s = model.scenarios[2].actions.reduce(model.step, model.init(0));
    expect(s.reads.at(-1)?.result?.value).toBe("old"); expect(model.invariants(s).map(i => i.code)).toContain("staleRead");
    let safe = model.init(0);
    safe = model.step(safe, { type: "write", key: "x", value: "old", replicas: ["N0", "N1", "N2"] });
    safe = model.step(safe, { type: "write", key: "x", value: null, replicas: ["N0", "N1"] });
    safe = model.step(safe, { type: "repair", key: "x" }); safe = model.step(safe, { type: "advance", ticks: 10 });
    safe = model.step(safe, { type: "gc" }); safe = model.step(safe, { type: "read", key: "x" });
    expect(safe.reads.at(-1)?.result).toBeNull(); expect(model.invariants(safe)).toEqual([]);
  });
  it("does not acknowledge partial writes and retains recent tombstones", () => {
    const model = createQuorumModel();
    let s = model.step(model.init(0), { type: "write", key: "__proto__", value: "x", replicas: ["N0"] });
    expect(s.writes[0].acknowledged).toBe(false); expect(Object.hasOwn(s.latestAcked, "__proto__")).toBe(false);
    s = model.step(s, { type: "write", key: "__proto__", value: null }); s = model.step(s, { type: "gc" });
    expect(Object.hasOwn(s.replicas[0].values, "__proto__")).toBe(true);
    expect(s.replicas[0].values["__proto__"].value).toBeNull();
    expect(() => model.step(s, { type: "read", key: "x", replicas: ["N0", "N0"] })).toThrow();
    expect(() => createQuorumModel({ n: 3, w: 4 })).toThrow();
  });
  it("solves parameterized variants by running their quorum schedule", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      const v = generateQuorumVariant(seed), model = createQuorumModel(v), s = v.actions.reduce(model.step, model.init(seed));
      expect(v).toEqual(generateQuorumVariant(seed)); expect(solveQuorumVariant(v)).toBe(s.reads.some(read => read.stale));
    }));
  });
});
