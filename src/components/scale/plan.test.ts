import { describe, expect, it } from "vitest";
import { cacheAsideDesign, cachingScenario } from "@/engine/fixtures";
import type { FailureRung, ScaleResult } from "@/engine/scale";
import type { Design } from "@/engine/types";
import { heatOf, remedyFor, scaleScenario, withRps } from "./plan";

const rung = (component: string, what: string): FailureRung => ({ multiple: 4, component, what, why: "", remedy: { suggestion: "", verified: false } });

describe("scale panel plan", () => {
  it("scales every arrival kind without mutating the input", () => {
    const s = scaleScenario(cachingScenario, 10);
    expect(s.workload.arrival).toEqual({ kind: "poisson", rps: 15000 });
    expect(cachingScenario.workload.arrival).toEqual({ kind: "poisson", rps: 1500 });
    const spike = scaleScenario({ ...cachingScenario, workload: { ...cachingScenario.workload, arrival: { kind: "spike", rps: 1, spikeAtUs: 0, spikeDurUs: 1, spikeRps: 5 } } }, 2);
    expect(spike.workload.arrival).toMatchObject({ rps: 2, spikeRps: 10 });
    expect(withRps(cachingScenario, 11574).workload.arrival).toEqual({ kind: "poisson", rps: 11574 });
  });

  it("builds a mechanical remedy per rung kind", () => {
    const db = remedyFor(cacheAsideDesign, rung("db", "capacity saturates"), []);
    expect(db?.design.nodes.find((n) => n.id === "db")?.params).toMatchObject({ replicas: 2 });
    expect(cacheAsideDesign.nodes.find((n) => n.id === "db")?.params).toMatchObject({ replicas: 1 });
    const lb = remedyFor(cacheAsideDesign, rung("lb", "queue overflows"), []);
    expect(lb?.design.nodes.find((n) => n.id === "lb")?.params).toMatchObject({ concurrency: 1024 });
    const global = remedyFor(cacheAsideDesign, rung("global", "timely-success falls"), [rung("global", "timely-success falls"), rung("db", "capacity saturates")]);
    expect(global?.label).toMatch(/replica/);
    expect(remedyFor(cacheAsideDesign, rung("edge:client-lb", "capacity saturates"), [])?.design.edges[0].bandwidthBytesPerSec).toBe(2e9);
    // The fixture has no retry policies, so there is nothing to test.
    expect(remedyFor(cacheAsideDesign, rung("db", "retry amplification"), [])).toBeNull();
    const withRetry: Design = structuredClone(cacheAsideDesign);
    withRetry.nodes[2].handlers!.get![0] = { type: "call", target: "db", timeoutUs: 1000, retry: { max: 3, backoffUs: 10, multiplier: 2, jitter: "none", retryOn: ["timeout"] } };
    const retried = remedyFor(withRetry, rung("db", "retry amplification"), []);
    expect(retried?.design.nodes[2].handlers!.get![0]).toMatchObject({ retry: { max: 1, backoffUs: 20 } });
  });

  it("heat covers design nodes only and adds the dropped fraction", () => {
    const node = (nodeId: string, utilisation: number, arrivals: number, drops: number) => ({ nodeId, utilisation, arrivals, drops }) as ScaleResult["nodes"][number];
    const result = { nodes: [node("db", 1, 100, 50), node("edge:client-lb", 0.2, 1, 0), node("lb", 0.1, 0, 0)], fidelity: { predictions: { utilisation: { enabled: true }, drops: { enabled: true } } } } as ScaleResult;
    const heat = heatOf(cacheAsideDesign, result);
    expect(heat).toEqual({ db: 1.5, lb: 0.1 });
    result.fidelity.predictions.drops = { enabled: false, reasons: ["unsupported"] };
    expect(heatOf(cacheAsideDesign, result)).toEqual({ db: 1, lb: 0.1 });
    result.fidelity.predictions.utilisation = { enabled: false, reasons: ["unsupported"] };
    expect(heatOf(cacheAsideDesign, result)).toEqual({});
  });
});
