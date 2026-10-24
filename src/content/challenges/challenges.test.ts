import { describe, expect, it } from "vitest";
import { gradeChallenge, validateDesign } from "@/engine";
import type { Design, NodeSpec } from "@/engine/types";
import { getChallenge } from "./index";

describe("flash-sale challenge", () => {
  const c = getChallenge("flash-sale-no-oversell")!;

  it("starts valid and fails on oversell", () => {
    expect(validateDesign(c.start, c.spec.scenario)).toEqual([]);
    const r = gradeChallenge(c.start, c.spec);
    expect(r.verdict).toBe("fail");
    expect(r.perSeed[0].result.violations.some((v) => v.kind === "oversell")).toBe(true);
  }, 60_000);

  it("passes with an atomic decrementIfPositive", () => {
    const fixed: Design = {
      ...c.start,
      nodes: c.start.nodes.map((n) => (n.id === "svc" ? ({ ...n, handlers: { ...n.handlers, put: [{ type: "data", target: "db", entity: "tickets", op: { kind: "decrementIfPositive", field: "remaining" }, timeoutUs: 30_000 }] } } as NodeSpec) : n)),
    };
    const r = gradeChallenge(fixed, c.spec);
    expect(r.perSeed.flatMap((s) => s.failures)).toEqual([]);
    expect(r.verdict).toBe("pass");
  }, 60_000);
});
