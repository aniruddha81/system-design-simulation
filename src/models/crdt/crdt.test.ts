import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createCrdtModel, crdtScenarios, crdtView, generateCrdtVariant, solveCrdtVariant, type CrdtAction } from ".";

describe("replicated CRDTs", () => {
  it("replays every scenario deterministically and without mutating a prefix", () => {
    const m = createCrdtModel();
    for (const script of crdtScenarios) {
      let s = m.init(42);
      for (const a of script.actions) { const before = structuredClone(s), after = m.step(s, a); expect(s).toEqual(before); expect(m.invariants(after)).toEqual([]); s = after; }
      expect(s).toEqual(script.actions.reduce(m.step, m.init(42)));
    }
  });
  it("converges under random local operations, reordered messages and duplicates", () => {
    fc.assert(fc.property(fc.integer(), fc.array(fc.record({ replica: fc.integer({ min: 0, max: 2 }), kind: fc.integer({ min: 0, max: 6 }), value: fc.integer({ min: 1, max: 10 }), delivery: fc.nat(10000), duplicate: fc.boolean() }), { maxLength: 40 }), (seed, commands) => {
      const m = createCrdtModel(); let s = m.init(seed);
      for (const c of commands) {
        const replica = s.replicas[c.replica], view = crdtView(replica), n = view.elements.filter(e => !e.deleted).length;
        const a: CrdtAction = c.kind === 0 ? { type: "increment", replica: replica.id, counter: "g", amount: c.value } : c.kind === 1 ? { type: "increment", replica: replica.id, counter: "pn", amount: c.value % 2 ? c.value : -c.value } : c.kind === 2 ? { type: "add", replica: replica.id, value: String(c.value % 3) } : c.kind === 3 ? { type: "remove", replica: replica.id, value: String(c.value % 3) } : c.kind === 4 || !n ? { type: "insert", replica: replica.id, index: c.value % (n + 1), text: String(c.value) } : { type: "delete", replica: replica.id, index: c.value % n, count: 1 };
        s = m.step(s, a);
        if (s.messages.length) {
          const message = s.messages[c.delivery % s.messages.length].id;
          if (c.duplicate) s = m.step(s, { type: "duplicate", message });
          s = m.step(s, { type: "deliver", message });
        }
        expect(m.invariants(s)).toEqual([]);
      }
      while (s.messages.length) s = m.step(s, { type: "deliver", message: s.messages[(Math.abs(seed) + s.messages.length * 7) % s.messages.length].id });
      expect(m.invariants(s)).toEqual([]);
      expect(s.replicas.map(r => crdtView(r))).toEqual(s.replicas.map(() => crdtView(s.replicas[0])));
      const all = new Map(s.replicas[0].operations.map(o => [o.id, o]));
      expect(crdtView(s.replicas[0]).g).toBe([...all.values()].reduce((sum, o) => sum + (o.kind === "g" ? o.amount : 0), 0));
    }), { numRuns: 100 });
  });
  it("an observed remove loses to a concurrent add, but removes observed tags", () => {
    const m = createCrdtModel(), s = crdtScenarios[1].actions.reduce(m.step, m.init(1));
    expect(crdtView(s.replicas[0]).set).toEqual(["x"]);
    const after = [{ type: "remove", replica: "C", value: "x" }, { type: "deliverAll" }].reduce((s, a) => m.step(s, a as CrdtAction), s);
    expect(crdtView(after.replicas[0]).set).toEqual([]);
  });
  it("RGA preserves concurrent children of a tombstoned element and local insertion position", () => {
    const m = createCrdtModel(), s = crdtScenarios[2].actions.reduce(m.step, m.init(1));
    expect(crdtView(s.replicas[0]).text).toBe("!i");
    const after = m.step(s, { type: "insert", replica: "A", index: 1, text: "xy" });
    expect(crdtView(after.replicas[0]).text).toBe("!xyi");
    expect(crdtView(after.replicas[0]).elements.some(e => e.deleted && e.value === "h")).toBe(true);
  });
  it("delay retains a message and invalid edits leave the old state intact", () => {
    const m = createCrdtModel({ replicas: ["__proto__", "B"] }), before = m.init(1), s = m.step(before, { type: "increment", replica: "__proto__", counter: "g", amount: 3 });
    const delayed = m.step(s, { type: "delay", message: 1 }); expect(delayed.messages[0].delays).toBe(1); expect(s.messages[0].delays).toBe(0);
    expect(() => m.step(s, { type: "increment", replica: "B", counter: "g", amount: -1 })).toThrow();
    expect(() => m.step(s, { type: "delete", replica: "B", index: 0, count: 1 })).toThrow();
    expect(before.replicas.every(r => r.operations.length === 0)).toBe(true);
  });
  it("solver agrees with every generated model replay", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      const v = generateCrdtVariant(seed), m = createCrdtModel(), s = v.actions.reduce(m.step, m.init(seed)), view = crdtView(s.replicas[0]);
      expect(v).toEqual(generateCrdtVariant(seed)); expect(solveCrdtVariant(v)).toEqual({ g: view.g, pn: view.pn, set: view.set, text: view.text }); expect(m.invariants(s)).toEqual([]);
    }));
  });
  it("reports a replica that loses an operation after the delivery queue drains", () => {
    const m = createCrdtModel();
    const s = crdtScenarios[0].actions.reduce(m.step, m.init(1));
    s.replicas[0].operations = [];
    expect(m.invariants(s).map(v => v.code)).toContain("convergence");
  });
});
