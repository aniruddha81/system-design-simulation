import { describe, expect, it } from "vitest";
import { cacheAsideDesign, cachingScenario } from "@/engine/fixtures";
import type { ChaosEvent } from "@/engine/types";
import { chaosProblems, newChaos, PRESETS } from "./scenario-ops";

describe("chaos timeline validation", () => {
  const d = cacheAsideDesign;
  it("flags overlaps of one kind on one target, but not different kinds or targets", () => {
    const a: ChaosEvent = { id: "a", kind: "kill", target: "cache", atUs: 1e6, endUs: 3e6 };
    const b: ChaosEvent = { id: "b", kind: "kill", target: "cache", atUs: 2e6 };
    const c: ChaosEvent = { id: "c", kind: "degrade", target: "cache", atUs: 2e6, slowFactor: 2 };
    const e: ChaosEvent = { id: "e", kind: "kill", target: "db", atUs: 2e6, endUs: 2.5e6 };
    const p = chaosProblems(d, [a, b, c, e]);
    expect(Object.keys(p).sort()).toEqual(["a", "b"]);
    expect(chaosProblems(d, [a, { ...b, atUs: 3e6 }])).toEqual({}); // back-to-back is fine
  });
  it("flags missing targets and inverted intervals", () => {
    expect(chaosProblems(d, [{ id: "x", kind: "kill", target: "nope", atUs: 0 }])).toHaveProperty("x");
    expect(chaosProblems(d, [{ id: "y", kind: "kill", target: "db", atUs: 5, endUs: 5 }])).toHaveProperty("y");
  });
  it("partitions overlap only when they share a directional link", () => {
    const p1 = newChaos("partition", d, "p1", 0);
    const p2 = { ...newChaos("partition", d, "p2", 0) };
    expect(Object.keys(chaosProblems(d, [p1, p2]))).toHaveLength(2);
    const p3 = { ...p2, links: [{ from: "lb", to: "client" }] } as ChaosEvent;
    expect(chaosProblems(d, [p1, p3])).toEqual({});
  });
  it("every new event of every kind is valid on the fixture", () => {
    for (const k of ["kill", "degrade", "gray", "clockSkew", "linkLoss", "linkLatency", "partition", "zoneOutage", "regionOutage", "trafficSpike"] as const)
      expect(chaosProblems(d, [newChaos(k, d, "e", 0)])).toEqual({});
  });
});

describe("presets", () => {
  it("every preset produces a usable workload", () => {
    for (const p of PRESETS) {
      const s = p.apply(cachingScenario, cacheAsideDesign.endpoints);
      expect(Object.values(s.workload.mix).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    }
  });
});
