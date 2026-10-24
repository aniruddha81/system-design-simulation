import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheAsideDesign, cachingScenario } from "@/engine/fixtures";
import type { ScaleResult, SweepResult } from "@/engine/scale";
import type { Design, Scenario } from "@/engine/types";
import type { ScaleReply, ScaleTask } from "./scale.worker";

const messages: ScaleReply[] = [];
const scope = { postMessage: (reply: ScaleReply) => messages.push(reply), onmessage: null as ((event: { data: ScaleTask }) => void) | null };
const reads: Scenario = { ...cachingScenario, chaos: [], warmupUs: 0, measureUs: 100_000, drainUs: 0, workload: { ...cachingScenario.workload, mix: { get: 1 } } };
const direct: Design = {
  ...cacheAsideDesign,
  nodes: cacheAsideDesign.nodes.filter((n) => n.kind === "client" || n.kind === "database").map((n) => n.kind === "client" ? { ...n, params: { entry: "db" } } : n),
  edges: [{ ...cacheAsideDesign.edges[0], id: "client-db", from: "client", to: "db" }],
};

beforeAll(async () => {
  vi.stubGlobal("self", scope);
  await import("./scale.worker");
});
beforeEach(() => { messages.length = 0; });
afterAll(() => vi.unstubAllGlobals());

function send(task: ScaleTask) {
  scope.onmessage!({ data: task });
  const last = messages.at(-1)!;
  expect(last.type).toBe("done");
  if (last.type !== "done") throw new Error(JSON.stringify(last));
  return last.value;
}

describe("Scale worker protocol", () => {
  it("reports progress and returns fidelity-disabled estimates with reasons", () => {
    const result = send({ type: "run", design: cacheAsideDesign, scenario: { ...reads, workload: cachingScenario.workload } }) as ScaleResult;
    expect(messages.some((m) => m.type === "progress")).toBe(true);
    expect(result.correctness).toBe("unknown");
    expect(result.fidelity.predictions.timelySuccess.enabled).toBe(false);
    expect(result.fidelity.predictions.timelySuccess.reasons?.length).toBeGreaterThan(0);
    expect(result.metrics.estimatedTimelySuccessRatio).toBeNull();
  });

  it.each(["independent", "continuous"] as const)("posts completed %s levels and their unverified ladder before completion", (kind) => {
    const result = send({ type: "sweep", design: direct, scenario: reads, kind, levels: 2 }) as SweepResult;
    const levels = messages.filter((m) => m.type === "level");
    expect(result.kind).toBe(kind);
    expect(result.outcome).toBe("finished");
    expect(levels).toHaveLength(2);
    expect(result.levels.map((l) => l.multiple)).toEqual([1, 1000]);
    expect(levels[0].level).toEqual(result.levels[0]);
    expect(levels.at(-1)?.ladder).toEqual(result.ladder);
    expect(result.ladder.length).toBeGreaterThan(0);
    expect(result.ladder.every((r) => !r.remedy.verified && r.why.length > 0)).toBe(true);
  }, 30_000);

  it("reports invalid tasks as errors", () => {
    scope.onmessage!({ data: { type: "sweep", design: cacheAsideDesign, scenario: reads, kind: "independent", levels: 13 } });
    expect(messages.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("1–12") });
  });
});
