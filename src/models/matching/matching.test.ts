import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createMatchingModel, generateMatchingVariant, matchingInvariants, matchingScenarios, orderBook, solveMatchingVariant, type MatchingAction } from ".";

describe("limit order book", () => {
  it("replays all scenarios immutably, deterministically and with invariants", () => {
    const m = createMatchingModel();
    for (const script of matchingScenarios) {
      let s = m.init(17);
      for (const a of script.actions) { const before = structuredClone(s); const after = m.step(s, a); expect(s).toEqual(before); expect(after).not.toBe(s); expect(m.invariants(after)).toEqual([]); s = after; }
      expect(script.actions.reduce(m.step, m.init(17))).toEqual(s);
    }
  });
  it("matches maker price, FIFO ties, partial fills, and both cancel races", () => {
    const m = createMatchingModel();
    const partial = matchingScenarios[1].actions.reduce(m.step, m.init(1));
    expect(partial.tape.map(t => [t.maker, t.price, t.quantity])).toEqual([["a", 100, 3], ["b", 100, 4], ["c", 101, 3]]);
    expect(orderBook(partial).asks.map(o => [o.id, o.remaining])).toEqual([["c", 5]]);
    expect(matchingScenarios[2].actions.reduce(m.step, m.init(1)).tape).toHaveLength(0);
    expect(matchingScenarios[3].actions.reduce(m.step, m.init(1)).tape).toHaveLength(1);
  });
  it("preserves invariants under random sequenced order streams", () => {
    fc.assert(fc.property(fc.integer(), fc.array(fc.record({ kind: fc.integer({ min: 0, max: 2 }), buy: fc.boolean(), price: fc.integer({ min: 1, max: 20 }), quantity: fc.integer({ min: 1, max: 20 }), cancel: fc.nat(100) }), { maxLength: 70 }), (seed, stream) => {
      const m = createMatchingModel(); let s = m.init(seed);
      stream.forEach((o, i) => {
        const a: MatchingAction = o.kind === 0 ? { type: "cancel", id: `o${o.cancel % (i + 1)}` } : o.kind === 1 ? { type: "limit", id: `o${i}`, side: o.buy ? "buy" : "sell", price: o.price, quantity: o.quantity } : { type: "market", id: `o${i}`, side: o.buy ? "buy" : "sell", quantity: o.quantity };
        s = m.step(s, a); expect(m.invariants(s)).toEqual([]);
      });
    }), { numRuns: 70 });
  });
  it("independently checks each fill against the prior resting book", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 1, max: 10 }), fc.integer({ min: 1, max: 10 })), { maxLength: 60 }), orders => {
      const m = createMatchingModel(); let s = m.init(1);
      orders.forEach(([buy, price, quantity], i) => {
        const side = buy ? "buy" : "sell", a: MatchingAction = { type: "limit", id: String(i), side, price, quantity };
        const candidates = s.orders.filter(o => o.remaining && o.side !== side && (buy ? o.price <= price : o.price >= price)).sort((a, b) => (buy ? a.price - b.price : b.price - a.price) || a.sequence - b.sequence);
        let remaining = quantity;
        const expected = candidates.flatMap(o => { const amount = Math.min(remaining, o.remaining); remaining -= amount; return amount ? [[o.id, o.price, amount]] : []; });
        const next = m.step(s, a);
        expect(next.tape.slice(s.tape.length).map(t => [t.maker, t.price, t.quantity])).toEqual(expected); s = next;
      });
    }));
  });
  it("rejects invalid orders, never reuses IDs, and detects corrupted records", () => {
    const m = createMatchingModel(), initial = m.init(1), a: MatchingAction = { type: "limit", id: "a", side: "sell", price: 5, quantity: 2 }, s = m.step(initial, a);
    for (const quantity of [0, -1, NaN, 1.5]) expect(() => m.step(initial, { ...a, quantity })).toThrow();
    expect(() => m.step(s, a)).toThrow(); expect(initial.orders).toEqual([]);
    expect(matchingInvariants({ ...s, orders: s.orders.map(o => ({ ...o, remaining: 9 })) }).map(v => v.code)).toContain("conservation");
    const crossed = matchingScenarios[0].actions.reduce(m.step, m.init(1));
    expect(matchingInvariants({ ...crossed, tape: crossed.tape.map(t => ({ ...t, price: 99 })) }).map(v => v.code)).toContain("priceTime");
  });
  it("solves every generated variant using the model", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      const v = generateMatchingVariant(seed), m = createMatchingModel(); expect(v).toEqual(generateMatchingVariant(seed));
      expect(solveMatchingVariant(v)).toBe(v.actions.reduce(m.step, m.init(seed)).tape.reduce((n, t) => n + t.quantity, 0));
    }));
  });
});
