import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applyTextOperation, createOtModel, generateOtVariant, otScenarios, solveOtVariant, textOperation, transformPair, type TextEdit } from "./ot";

const editFrom = (text: string, insert: boolean, position: number, count: number, value: string): TextEdit => insert || !text.length ? { type: "insert", index: position % (text.length + 1), text: value || "x" } : { type: "delete", index: position % text.length, count: 1 + count % (text.length - position % text.length) };
describe("central text OT", () => {
  it("shows naive divergence and transformed convergence with the same script", () => {
    for (const mode of ["naive", "transform"] as const) {
      const m = createOtModel({ mode }), s = otScenarios[0].actions.reduce(m.step, m.init(1));
      expect(m.invariants(s).map(v => v.code)).toEqual(mode === "naive" ? ["otConvergence"] : []);
      if (mode === "transform") expect(s.clients.map(c => c.text)).toEqual(["XYab", "XYab"]);
    }
  });
  it("transforms random concurrent insert/delete pairs (including range overlaps)", () => {
    fc.assert(fc.property(fc.string({ maxLength: 30 }), fc.boolean(), fc.nat(100), fc.nat(100), fc.string({ minLength: 1, maxLength: 5 }), fc.boolean(), fc.nat(100), fc.nat(100), fc.string({ minLength: 1, maxLength: 5 }), (base, ai, ap, ac, av, bi, bp, bc, bv) => {
      const a = textOperation(base, editFrom(base, ai, ap, ac, av), "A"), b = textOperation(base, editFrom(base, bi, bp, bc, bv), "B"), before = structuredClone([a, b]);
      const [aPrime, bPrime] = transformPair(a, b);
      expect(applyTextOperation(applyTextOperation(base, a), bPrime)).toBe(applyTextOperation(applyTextOperation(base, b), aPrime)); expect([a, b]).toEqual(before);
    }), { numRuns: 500 });
  });
  it("central server converges over random concurrent edit rounds and receipt order", () => {
    fc.assert(fc.property(fc.string({ maxLength: 20 }), fc.array(fc.tuple(fc.boolean(), fc.nat(100), fc.nat(100), fc.boolean()), { maxLength: 20 }), (text, commands) => {
      const m = createOtModel({ text }); let s = m.init(42);
      for (const [insert, pos, count, reverse] of commands) {
        const a = editFrom(s.clients[0].text, insert, pos, count, "A"), b = editFrom(s.clients[1].text, !insert, count, pos, "B");
        s = m.step(s, { type: "edit", client: "A", edit: a }); s = m.step(s, { type: "edit", client: "B", edit: b });
        s = m.step(s, { type: "server", client: reverse ? "B" : "A" });
        s = m.step(s, { type: "flush" }); expect(m.invariants(s)).toEqual([]); expect(s.clients.every(c => c.text === s.serverText)).toBe(true);
      }
    }), { numRuns: 100 });
  });
  it("handles acknowledgements interleaved with new edits and stale client revisions", () => {
    const m = createOtModel({ text: "abc", clients: ["A", "B", "C"] }); let s = m.init(1);
    s = m.step(s, { type: "edit", client: "A", edit: { type: "insert", index: 1, text: "X" } });
    s = m.step(s, { type: "server", client: "A" }); s = m.step(s, { type: "receive", client: "A" });
    s = m.step(s, { type: "edit", client: "A", edit: { type: "delete", index: 2, count: 1 } });
    s = m.step(s, { type: "edit", client: "B", edit: { type: "delete", index: 0, count: 2 } });
    s = m.step(s, { type: "edit", client: "C", edit: { type: "insert", index: 2, text: "Y" } });
    s = m.step(s, { type: "flush" }); expect(m.invariants(s)).toEqual([]); expect(s.clients.every(c => c.text === s.serverText)).toBe(true);
  });
  it("converges with random asynchronous client edits, submissions and acknowledgements", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.nat(1000), fc.boolean(), fc.nat(100), fc.nat(100)), { maxLength: 60 }), commands => {
      const m = createOtModel({ text: "abcdef", clients: ["A", "B", "C"] }); let s = m.init(42);
      for (const [pick, insert, pos, count] of commands) {
        const available = m.actions(s).filter(a => a.type !== "flush");
        const a = available[pick % available.length];
        if (a.type === "edit") {
          const client = s.clients.find(c => c.id === a.client)!;
          a.edit = editFrom(client.text, insert, pos, count, a.client);
        }
        s = m.step(s, a);
      }
      s = m.step(s, { type: "flush" }); expect(m.invariants(s)).toEqual([]); expect(s.clients.every(c => c.text === s.serverText)).toBe(true);
    }), { numRuns: 200 });
  });
  it("replays scripts immutably and validates text boundaries", () => {
    const m = createOtModel();
    for (const script of otScenarios) {
      let s = m.init(13);
      for (const a of script.actions) { const before = structuredClone(s); const after = m.step(s, a); expect(s).toEqual(before); expect(m.invariants(after)).toEqual([]); s = after; }
      expect(s).toEqual(script.actions.reduce(m.step, m.init(13)));
    }
    expect(() => textOperation("a", { type: "delete", index: 0, count: 2 }, "x")).toThrow();
    expect(() => applyTextOperation("ab", textOperation("a", { type: "insert", index: 0, text: "x" }, "x"))).toThrow();
  });
  it("solves generated variants through the server model", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      const v = generateOtVariant(seed), m = createOtModel({ text: v.text }), s = v.actions.reduce(m.step, m.init(seed));
      expect(v).toEqual(generateOtVariant(seed)); expect(solveOtVariant(v)).toBe(s.serverText); expect(m.invariants(s)).toEqual([]);
    }));
  });
});
