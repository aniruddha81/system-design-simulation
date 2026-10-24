import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createWindowingModel, generateWindowingVariant, solveWindowingVariant, windowingScenarios, type StreamEvent, type WindowAction, type WindowOptions } from ".";

describe("event-time windows", () => {
  it("replays every script deterministically and immutably in each mode", () => {
    for (const kind of ["tumbling", "sliding", "session"] as const) {
      const m = createWindowingModel({ kind, outOfOrderness: 100 });
      for (const script of windowingScenarios) {
        let s = m.init(42);
        for (const a of script.actions) { const before = structuredClone(s), after = m.step(s, a); expect(s).toEqual(before); expect(m.invariants(after)).toEqual([]); s = after; }
        expect(s).toEqual(script.actions.reduce(m.step, m.init(42)));
      }
    }
  });
  it("waits strictly beyond end plus lateness and accepts updates during the grace period", () => {
    const m = createWindowingModel({ allowedLateness: 5, latePolicy: "update" }); let s = m.init(1);
    s = m.step(s, { type: "event", event: { id: "a", time: 1, value: 2 } });
    s = m.step(s, { type: "watermark", time: 12 }); expect(s.emissions).toEqual([]);
    s = m.step(s, { type: "event", event: { id: "b", time: 2, value: 3 } }); expect(s.windows[0].total).toBe(5);
    s = m.step(s, { type: "watermark", time: 15 }); expect(s.emissions).toEqual([]);
    s = m.step(s, { type: "watermark", time: 16 }); expect(s.emissions[0]).toMatchObject({ count: 2, total: 5, watermark: 16 });
    s = m.step(s, { type: "event", event: { id: "c", time: 3, value: 100 } }); expect(s.dropped.map(e => e.id)).toEqual(["c"]); expect(s.windows[0].total).toBe(5);
  });
  it("drop and side output reject ended-window events and dedup rejected IDs too", () => {
    for (const latePolicy of ["drop", "sideOutput"] as const) {
      const m = createWindowingModel({ latePolicy, allowedLateness: 10 });
      const events: WindowAction[] = [{ type: "event", event: { id: "a", time: 1, value: 2 } }, { type: "watermark", time: 12 }, { type: "event", event: { id: "late", time: 2, value: 8 } }, { type: "event", event: { id: "late", time: 2, value: 8 } }];
      const s = events.reduce(m.step, m.init(1));
      expect(s.windows[0].total).toBe(2); expect(s.duplicates).toBe(1);
      expect((latePolicy === "drop" ? s.dropped : s.sideOutput).map(e => e.id)).toEqual(["late"]);
    }
  });
  it("advances bounded-out-of-order watermarks monotonically and classifies against the previous watermark", () => {
    const m = createWindowingModel({ outOfOrderness: 3 }); let s = m.init(1);
    s = m.step(s, { type: "event", event: { id: "a", time: 20, value: 1 } }); expect(s.watermark).toBe(17);
    s = m.step(s, { type: "event", event: { id: "b", time: 18, value: 1 } }); expect(s.watermark).toBe(17);
    s = m.step(s, { type: "watermark", time: 50 });
    s = m.step(s, { type: "event", event: { id: "c", time: 30, value: 1 } }); expect(s.watermark).toBe(50); expect(s.dropped.map(e => e.id)).toEqual(["c"]);
    expect(() => m.step(s, { type: "watermark", time: 49 })).toThrow();
  });
  it("merges session bridges by key, keeps gap boundaries separate, and never reopens finalized sessions", () => {
    const m = createWindowingModel({ kind: "session", gap: 10, outOfOrderness: 100 });
    const s = windowingScenarios[2].actions.reduce(m.step, m.init(1)); expect(s.emissions).toMatchObject([{ start: 0, end: 26, total: 6, count: 3 }]);
    const late = m.step(s, { type: "event", event: { id: "late", time: 9, value: 9 } }); expect(late.windows).toEqual(s.windows); expect(late.dropped).toHaveLength(1);
    const keyed: WindowAction[] = [{ type: "event", event: { id: "a", time: 0, key: "A", value: 1 } }, { type: "event", event: { id: "b", time: 10, key: "A", value: 2 } }, { type: "event", event: { id: "c", time: 1, key: "B", value: 3 } }];
    expect(keyed.reduce(m.step, m.init(1)).windows).toHaveLength(3);
  });
  it("on-time tumbling/sliding/session totals equal independent brute-force aggregation", () => {
    fc.assert(fc.property(fc.array(fc.record({ time: fc.integer({ min: -50, max: 100 }), value: fc.integer({ min: -10, max: 10 }), key: fc.constantFrom("A", "B") }), { maxLength: 60 }), fc.integer({ min: 2, max: 20 }), fc.integer({ min: 1, max: 10 }), (input, size, slide) => {
      const events: StreamEvent[] = input.map((e, i) => ({ ...e, id: `e${i}` }));
      for (const kind of ["tumbling", "sliding", "session"] as const) {
        const options: WindowOptions = { kind, size, slide, gap: size, outOfOrderness: 1000, allowedLateness: 5 }, m = createWindowingModel(options);
        let s = m.init(1);
        for (const e of events) { s = m.step(s, { type: "event", event: e }); s = m.step(s, { type: "event", event: e }); }
        s = m.step(s, { type: "watermark", time: 1000 });
        const actual = s.emissions.map(w => [w.key, w.start, w.end, w.count, w.total]).sort();
        const expected: (string | number)[][] = [];
        for (const key of ["A", "B"]) {
          const list = events.filter(e => e.key === key);
          if (kind === "session") {
            let group: StreamEvent[] = [];
            for (const e of list.sort((a, b) => a.time - b.time)) {
              if (group.length && e.time >= group[group.length - 1].time + size) { expected.push([key, group[0].time, group[group.length - 1].time + size, group.length, group.reduce((n, e) => n + e.value, 0)]); group = []; }
              group.push(e);
            }
            if (group.length) expected.push([key, group[0].time, group[group.length - 1].time + size, group.length, group.reduce((n, e) => n + e.value, 0)]);
          } else {
            const step = kind === "tumbling" ? size : slide;
            for (let start = -100; start <= 100; start++) if (start % step === 0) {
              const included = list.filter(e => e.time >= start && e.time < start + size);
              if (included.length) expected.push([key, start, start + size, included.length, included.reduce((n, e) => n + e.value, 0)]);
            }
          }
        }
        expect(actual).toEqual(expected.sort()); expect(s.duplicates).toBe(events.length); expect(m.invariants(s)).toEqual([]);
      }
    }), { numRuns: 80 });
  });
  it("sliding late updates may reach an open window while being rejected by an already-ended one", () => {
    const m = createWindowingModel({ kind: "sliding", size: 10, slide: 5, allowedLateness: 0, latePolicy: "sideOutput" });
    let s = m.step(m.init(1), { type: "watermark", time: 11 });
    s = m.step(s, { type: "event", event: { id: "x", time: 7, value: 4 } });
    expect(s.windows.map(w => [w.start, w.total])).toEqual([[5, 4]]); expect(s.sideOutput).toHaveLength(1);
  });
  it("rejects an entire session bridge if it would connect a final session to an open one", () => {
    const m = createWindowingModel({ kind: "session", gap: 10, allowedLateness: 0, outOfOrderness: 100 });
    let s = m.step(m.init(1), { type: "event", event: { id: "a", time: 0, value: 1 } });
    s = m.step(s, { type: "watermark", time: 11 });
    s = m.step(s, { type: "event", event: { id: "b", time: 18, value: 2 } });
    const before = structuredClone(s.windows);
    s = m.step(s, { type: "event", event: { id: "bridge", time: 9, value: 100 } });
    expect(s.windows).toEqual(before); expect(s.dropped.map(e => e.id)).toEqual(["bridge"]); expect(m.invariants(s)).toEqual([]);
  });
  it("detects premature emission and double counting in corrupted state", () => {
    const m = createWindowingModel();
    const s = m.step(m.init(1), { type: "event", event: { id: "a", time: 1, value: 2 } });
    expect(m.invariants({ ...s, windows: s.windows.map(w => ({ ...w, events: [...w.events, ...w.events] })) }).map(v => v.code)).toContain("dedup");
    expect(m.invariants({ ...s, emissions: [{ id: "x", key: "", start: 0, end: 10, count: 1, total: 2, watermark: 15 }] }).map(v => v.code)).toContain("prematureEmission");
  });
  it("all seeded variant solvers agree with model emissions", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      const v = generateWindowingVariant(seed), m = createWindowingModel(v.options), s = v.actions.reduce(m.step, m.init(seed));
      expect(v).toEqual(generateWindowingVariant(seed)); expect(solveWindowingVariant(v)).toEqual(s.emissions.map(({ start, end, count, total }) => ({ start, end, count, total }))); expect(m.invariants(s)).toEqual([]);
    }));
  });
});
