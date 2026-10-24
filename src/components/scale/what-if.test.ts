import { describe, expect, it } from "vitest";
import { cacheAsideDesign, cachingScenario } from "@/engine/fixtures";
import { whatIf } from "@/engine/scale";
import type { Scenario } from "@/engine/types";
import { whatIfRows } from "./WhatIfTable";

const scenario: Scenario = {
  ...cachingScenario,
  warmupUs: 0,
  measureUs: 100_000,
  drainUs: 0,
  chaos: [],
  workload: { ...cachingScenario.workload, mix: { get: 1 } },
};

describe("what-if display", () => {
  it("includes every engine metric and node delta, with signed changes", () => {
    const changed = structuredClone(cacheAsideDesign);
    const db = changed.nodes.find((n) => n.kind === "database")!;
    db.params.costPerHour *= 2;
    const result = whatIf(cacheAsideDesign, changed, scenario);
    const rows = whatIfRows(result, cacheAsideDesign);
    expect(rows.length).toBe(Object.keys(result.deltas).length + Object.values(result.nodeDeltas).reduce((n, deltas) => n + Object.keys(deltas).length, 0));
    expect(rows.find((r) => r.name === "cost per month")?.delta).toMatch(/^\+/);
    expect(rows.find((r) => r.name === "offered")?.delta).toBe("±0");
    expect(rows.some((r) => r.name.includes("cache / hit rate"))).toBe(true);
    expect(rows.some((r) => r.name === "all latency / p999")).toBe(true);
  });

  it("does not expose values or deltas for fidelity-disabled predictions", () => {
    const result = whatIf(cacheAsideDesign, cacheAsideDesign, scenario);
    result.a.fidelity.predictions.utilisation = { enabled: false, reasons: ["unsupported traffic"] };
    result.b.fidelity.predictions.cost = { enabled: false, reasons: ["variable bytes"] };
    const rows = whatIfRows(result, cacheAsideDesign);
    expect(rows.find((r) => r.name === "availability")).toMatchObject({ a: "disabled", delta: "unavailable" });
    expect(rows.find((r) => r.name === "cost per month")).toMatchObject({ b: "disabled", delta: "unavailable" });
    expect(rows.filter((r) => r.name.endsWith(": utilisation")).every((r) => r.a === "disabled" && r.delta === "unavailable")).toBe(true);
  });
});
