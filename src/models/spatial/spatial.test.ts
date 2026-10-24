import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createSpatialModel, generateSpatialVariant, geohashCandidates, geohashDecode, geohashEncode, geohashNeighbours, nearestQuery, radiusQuery, solveSpatialVariant, spatialScenarios, type Point } from ".";

describe("spatial indexes", () => {
  it("replays scenario prefixes deterministically without mutation", () => {
    const m = createSpatialModel();
    for (const script of spatialScenarios) {
      let s = m.init(42);
      for (const a of script.actions) { const before = structuredClone(s), after = m.step(s, a); expect(s).toEqual(before); expect(m.invariants(after)).toEqual([]); s = after; }
      expect(s).toEqual(script.actions.reduce(m.step, m.init(42)));
    }
  });
  it("encodes known geohashes and contains coordinates on decoding", () => {
    expect(geohashEncode(42.6, -5.6, 5)).toBe("ezs42");
    fc.assert(fc.property(fc.integer({ min: -90000, max: 90000 }), fc.integer({ min: -180000, max: 180000 }), fc.integer({ min: 1, max: 12 }), (lat, lon, precision) => {
      const hash = geohashEncode(lat / 1000, lon / 1000, precision), b = geohashDecode(hash);
      expect(lat / 1000).toBeGreaterThanOrEqual(b.minY); expect(lat / 1000).toBeLessThanOrEqual(b.maxY);
      expect(lon / 1000).toBeGreaterThanOrEqual(b.minX); expect(lon / 1000).toBeLessThanOrEqual(b.maxX);
      expect(geohashEncode(b.latitude, b.longitude, precision)).toBe(hash);
    }));
  });
  it("recovers the prefix boundary neighbour and wraps at the dateline", () => {
    const west = { id: "west", x: -0.0001, y: 1 }, east = { id: "east", x: 0.0001, y: 1 };
    expect(geohashEncode(west.y, west.x, 6)[0]).not.toBe(geohashEncode(east.y, east.x, 6)[0]);
    expect(geohashCandidates([west, east], west, 6, false)).toEqual([west]);
    expect(geohashCandidates([west, east], west, 6)).toEqual([west, east]);
    expect(geohashNeighbours(geohashEncode(1, 179.9999, 5))).toContain(geohashEncode(1, -179.9999, 5));
    expect(geohashNeighbours(geohashEncode(90, 0, 2)).length).toBeLessThan(8);
  });
  it("radius and nearest results equal brute force, including splits and duplicate coordinates", () => {
    fc.assert(fc.property(fc.array(fc.tuple(fc.integer({ min: -100, max: 100 }), fc.integer({ min: -80, max: 80 })), { maxLength: 100 }), fc.integer({ min: -100, max: 100 }), fc.integer({ min: -80, max: 80 }), fc.integer({ min: 0, max: 200 }), fc.integer({ min: 1, max: 20 }), (coords, x, y, radius, k) => {
      const points: Point[] = coords.map(([x, y], i) => ({ id: `p${i}`, x, y })), m = createSpatialModel({ capacity: 2, points }), s = m.init(1), center = { id: "q", x, y };
      const dist = (p: Point) => Math.hypot(x - p.x, y - p.y);
      const sorted = [...points].sort((a, b) => dist(a) - dist(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      expect(radiusQuery(s.tree, center, radius).points).toEqual(sorted.filter(p => dist(p) <= radius));
      expect(nearestQuery(s.tree, center, k).points).toEqual(sorted.slice(0, k));
      expect(m.invariants(s)).toEqual([]);
    }), { numRuns: 150 });
    const m = createSpatialModel({ capacity: 1, points: Array.from({ length: 10 }, (_, i) => ({ id: String(i), x: 0, y: 0 })) });
    expect(nearestQuery(m.init(1).tree, { id: "q", x: 0, y: 0 }, 10).points).toHaveLength(10);
  });
  it("records visited cells, prunes distant quadrants, and rejects invalid input", () => {
    const m = createSpatialModel({ capacity: 1, points: [{ id: "a", x: -100, y: -50 }, { id: "b", x: 100, y: 50 }] }), s = m.init(1);
    const result = nearestQuery(s.tree, { id: "q", x: -100, y: -50 }, 1);
    expect(result.visited.map(c => c.id)).toEqual(["root", "root.0"]);
    expect(() => m.step(s, { type: "insert", point: { id: "a", x: 0, y: 0 } })).toThrow();
    expect(() => geohashEncode(91, 0)).toThrow(); expect(() => geohashDecode("a!")).toThrow();
    expect(() => radiusQuery(s.tree, { id: "q", x: 0, y: 0 }, -1)).toThrow();
    expect(m.invariants({ ...s, points: [] }).map(v => v.code)).toContain("partition");
  });
  it("solves generated variants through the model and agrees with brute force", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      const v = generateSpatialVariant(seed), m = createSpatialModel({ points: v.points }); expect(v).toEqual(generateSpatialVariant(seed));
      expect(solveSpatialVariant(v)).toEqual(m.step(m.init(seed), v.action).result!.points.map(p => p.id));
    }));
  });
  it("keeps initialization independent and offers executable actions after ID collisions", () => {
    const m = createSpatialModel({ points: [{ id: "point-1", x: 0, y: 0 }] }), s = m.init(1);
    s.tree.bounds.minX = -1;
    expect(m.init(1).tree.bounds.minX).toBe(-180);
    for (const action of m.actions(m.init(1))) expect(m.invariants(m.step(m.init(1), action))).toEqual([]);
  });
});
