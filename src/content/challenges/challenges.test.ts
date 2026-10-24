import { describe, expect, it } from "vitest";
import { gradeChallenge, validateDesign } from "@/engine";
import { cacheAsideDesign } from "@/engine/fixtures";
import type { Design, NodeSpec } from "@/engine/types";
import { challenges, getChallenge } from "./index";

describe("challenges catalog", () => {
  it("contains 6 valid starter challenges", () => {
    expect(challenges.length).toBe(6);
    for (const c of challenges) {
      expect(validateDesign(c.start, c.spec.scenario)).toEqual([]);
      expect(c.hints.length).toBe(3);
    }
  });
});

describe("cache-aside-recovery challenge", () => {
  const c = getChallenge("cache-aside-recovery")!;

  it("passes with cache-aside and request coalescing", () => {
    const r = gradeChallenge(cacheAsideDesign, { ...c.spec, seeds: [11] });
    expect(r.verdict).toBe("pass");
  }, 60_000);
});

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

describe("idempotent-payment-retry challenge", () => {
  const c = getChallenge("idempotent-payment-retry")!;

  it("starts valid and fails on duplicateEffect", () => {
    const r = gradeChallenge(c.start, c.spec);
    expect(r.verdict).toBe("fail");
    expect(r.perSeed.some((s) => s.result.violations.some((v) => v.kind === "duplicateEffect"))).toBe(true);
  }, 60_000);

  it("passes with dedup + branch on dedupHit", () => {
    const fixed: Design = {
      ...c.start,
      nodes: c.start.nodes.map((n) =>
        n.id === "payments" && n.kind === "service"
          ? ({
              ...n,
              params: { ...n.params, serviceTime: { kind: "constant", us: 1 } },
              handlers: {
                put: [
                  { type: "dedup", store: "dedup", timeoutUs: 500 },
                  {
                    type: "branch",
                    cond: { kind: "dedupHit" },
                    then: [{ type: "respond", status: 200 }],
                    else: [
                      {
                        type: "data",
                        target: "db",
                        entity: "ledger",
                        op: { kind: "update", field: "total", op: "increment", value: 1 },
                        timeoutUs: 500,
                      },
                    ],
                  },
                ],
              },
            } as NodeSpec)
          : n,
      ),
    };
    const r = gradeChallenge(fixed, c.spec);
    expect(r.perSeed.flatMap((s) => s.failures)).toEqual([]);
    expect(r.verdict).toBe("pass");
  }, 60_000);
});

describe("fenced-leader-failover challenge", () => {
  const c = getChallenge("fenced-leader-failover")!;

  it("starts valid and fails on ackedWriteLost and splitBrainWrite", () => {
    const r = gradeChallenge(c.start, c.spec);
    expect(r.verdict).toBe("fail");
    expect(r.perSeed[0].result.violations.some((v) => v.kind === "ackedWriteLost")).toBe(true);
    expect(r.perSeed[0].result.violations.some((v) => v.kind === "splitBrainWrite")).toBe(true);
  }, 60_000);

  it("passes with sync replication and fencing enabled", () => {
    const fixed: Design = {
      ...c.start,
      nodes: c.start.nodes.map((n) =>
        n.kind === "database"
          ? ({
              ...n,
              params: {
                ...n.params,
                replication: "sync",
                failover: { ...n.params.failover!, fencing: true },
              },
            } as NodeSpec)
          : n,
      ),
    };
    const r = gradeChallenge(fixed, c.spec);
    expect(r.perSeed.flatMap((s) => s.failures)).toEqual([]);
    expect(r.verdict).toBe("pass");
  }, 60_000);
});

describe("quorum-fresh-reads challenge", () => {
  const c = getChallenge("quorum-fresh-reads")!;

  it("starts valid and fails on staleRead", () => {
    const r = gradeChallenge(c.start, c.spec);
    expect(r.verdict).toBe("fail");
    expect(r.perSeed.some((s) => s.result.violations.some((v) => v.kind === "staleRead"))).toBe(true);
  }, 60_000);

  it("passes with intersecting quorums R=2, W=2", () => {
    const fixed: Design = {
      ...c.start,
      nodes: c.start.nodes.map((n) =>
        n.kind === "kvStore"
          ? ({ ...n, params: { ...n.params, readQuorum: 2, writeQuorum: 2 } } as NodeSpec)
          : n,
      ),
    };
    const r = gradeChallenge(fixed, c.spec);
    expect(r.perSeed.flatMap((s) => s.failures)).toEqual([]);
    expect(r.verdict).toBe("pass");
  }, 60_000);
});

describe("ordered-queue-visibility challenge", () => {
  const c = getChallenge("ordered-queue-visibility")!;

  it("starts valid and fails on orderingViolated", () => {
    const r = gradeChallenge(c.start, c.spec);
    expect(r.verdict).toBe("fail");
    expect(r.perSeed.some((s) => s.result.violations.some((v) => v.kind === "orderingViolated"))).toBe(true);
  }, 60_000);

  it("passes when visibilityTimeoutUs exceeds slow worker latency", () => {
    const fixed: Design = {
      ...c.start,
      nodes: c.start.nodes.map((n) =>
        n.kind === "queue"
          ? ({ ...n, params: { ...n.params, visibilityTimeoutUs: 10_000 } } as NodeSpec)
          : n,
      ),
    };
    const r = gradeChallenge(fixed, c.spec);
    expect(r.perSeed.flatMap((s) => s.failures)).toEqual([]);
    expect(r.verdict).toBe("pass");
  }, 60_000);
});
