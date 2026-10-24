import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { bloomContains, bloomStatistics, countMinBounds, countMinEstimate, createSketchModel, generateSketchVariant, hllEstimate, hllStatistics, sketchScenarios, solveSketchVariant } from ".";

describe("probabilistic sketches", () => {
  it("replays scripts immutably and deterministically", () => {
    const m = createSketchModel();
    for (const script of sketchScenarios) {
      let s = m.init(42);
      for (const a of script.actions) { const before = structuredClone(s), after = m.step(s, a); expect(s).toEqual(before); expect(m.invariants(after)).toEqual([]); s = after; }
      expect(s).toEqual(script.actions.reduce(m.step, m.init(42)));
    }
  });
  it("Bloom has no false negatives and count-min never underestimates random positive updates", () => {
    fc.assert(fc.property(fc.integer(), fc.array(fc.tuple(fc.string({ maxLength: 10 }), fc.integer({ min: 1, max: 100 })), { maxLength: 100 }), (seed, input) => {
      const m = createSketchModel({ bloomBits: 64, width: 8, depth: 3 }); let s = m.init(seed);
      const actual = new Map<string, number>();
      for (const [key, count] of input) { actual.set(key, (actual.get(key) ?? 0) + count); s = m.step(s, { type: "add", key, count }); }
      for (const [key, count] of actual) { expect(bloomContains(s, key)).toBe(true); expect(countMinEstimate(s, key)).toBeGreaterThanOrEqual(count); }
      expect(m.invariants(s)).toEqual([]);
      expect(countMinBounds(s)).toEqual({ epsilon: Math.E / 8, delta: Math.exp(-3), additiveError: Math.E * s.total / 8 });
    }), { numRuns: 80 });
  });
  it("measured Bloom false-positive rate is close to theory on fixed seeded probes", () => {
    const m = createSketchModel({ bloomBits: 512, bloomHashes: 4 }); let s = m.init(42);
    for (let i = 0; i < 100; i++) s = m.step(s, { type: "add", key: `insert-${i}` });
    s = m.step(s, { type: "probe", keys: [...Array.from({ length: 5000 }, (_, i) => `absent-${i}`), "insert-0"] });
    const stats = bloomStatistics(s);
    expect(stats.probes).toBe(5000);
    expect(stats.theoretical).toBeCloseTo((1 - Math.exp(-4 * 100 / 512)) ** 4, 12);
    expect(Math.abs(stats.measured - stats.theoretical)).toBeLessThan(0.025);
  });
  it("HLL seeded streams stay within three standard errors and repeated keys change no registers", () => {
    for (const seed of [1, 7, 42, 2026]) {
      const m = createSketchModel(); let s = m.init(seed);
      expect(hllEstimate(s)).toBe(0);
      for (let i = 0; i < 1200; i++) s = m.step(s, { type: "add", key: `item-${i}` });
      const stats = hllStatistics(s);
      expect(Math.abs(stats.relativeError)).toBeLessThan(3 * stats.standardError);
      const repeated = m.step(s, { type: "add", key: "item-0", count: 100 });
      expect(repeated.registers).toEqual(s.registers); expect(hllEstimate(repeated)).toBe(stats.estimate);
    }
  }, 20000);
  it("checks count-min error probability across fixed seeded independent hash rows", () => {
    let outside = 0, queries = 0;
    for (const seed of [3, 17, 42, 81]) {
      const m = createSketchModel({ width: 32, depth: 4 }); let s = m.init(seed);
      for (let i = 0; i < 200; i++) s = m.step(s, { type: "add", key: `item-${i}`, count: 1 + i % 7 });
      for (const [key, actual] of s.counts) { queries++; if (countMinEstimate(s, key) - actual > countMinBounds(s).additiveError) outside++; }
    }
    expect(outside / queries).toBeLessThan(Math.exp(-4));
  });
  it("rejects negative updates and invalid dimensions without changing existing state", () => {
    const m = createSketchModel(), s = m.init(1), before = structuredClone(s);
    expect(() => m.step(s, { type: "add", key: "a", count: -1 })).toThrow(); expect(s).toEqual(before);
    expect(() => createSketchModel({ hllPrecision: 3 })).toThrow(); expect(() => createSketchModel({ width: 0 })).toThrow();
  });
  it("every seeded variant solver agrees with model queries", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      const v = generateSketchVariant(seed), m = createSketchModel(v.options), s = v.actions.reduce(m.step, m.init(seed));
      expect(v).toEqual(generateSketchVariant(seed)); expect(solveSketchVariant(v)).toEqual({ contains: bloomContains(s, v.key), count: countMinEstimate(s, v.key), cardinality: hllEstimate(s) });
    }));
  });
  it("reports false negatives, underestimates and malformed registers", () => {
    const m = createSketchModel(), s = m.step(m.init(1), { type: "add", key: "a" });
    expect(m.invariants({ ...s, bits: s.bits.map(() => 0) }).map(v => v.code)).toContain("falseNegative");
    expect(m.invariants({ ...s, table: s.table.map(row => row.map(() => 0)) }).map(v => v.code)).toContain("underestimate");
    expect(m.invariants({ ...s, registers: s.registers.map(() => 99) }).map(v => v.code)).toContain("register");
  });
});
