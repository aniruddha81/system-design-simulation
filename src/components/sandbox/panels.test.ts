import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createSimulation } from "@/engine";
import { cacheAsideDesign, cachingScenario } from "@/engine/fixtures";
import type { InvariantKind, RunResult } from "@/engine/types";
import { addNode, KIND_LABEL } from "./design-ops";
import { createDesignStore, DesignCtx } from "./design-store";
import { UnitField } from "./fields";
import { Inspector } from "./Inspector";
import { KINDS } from "./kinds";
import { ResultsPanel } from "./ResultsPanel";

const run = vi.hoisted(() => ({ result: null as RunResult | null }));
vi.mock("@/lib/run-manager", () => ({ useRun: () => ({ ...run, status: "finished", snapshot: null, historyRev: 0 }) }));

it("renders an inspector for every library kind", () => {
  for (const kind of KINDS) {
    const { design, id } = addNode(cacheAsideDesign, kind, { x: 0, y: 0 });
    const store = createDesignStore(design);
    store.getState().select({ kind: "node", id });
    const html = renderToStaticMarkup(createElement(DesignCtx, { value: { ...store, getInitialState: store.getState } }, createElement(Inspector, { requestDelete: vi.fn() })));
    expect(html).toContain(KIND_LABEL[kind]);
    expect(html).toContain("Delete component");
  }
});

it("renders all P2 stats and every correctness invariant, including zero values", () => {
  const result = createSimulation(cacheAsideDesign, cachingScenario, 42).result();
  result.nodes = [{
    ...result.nodes[0], meanQueueWaitUs: 0, inFlight: 0, dropsOnEdit: 0, wastedWork: 2, failovers: 1,
    replicationLagUs: { mean: 1000, max: 2000 },
    queue: { depthMax: 8, redelivered: 2, deadLettered: 1, consumerLagMax: 3000 },
    breaker: { opens: 1, shortCircuited: 3 },
    autoscale: { minConcurrency: 2, maxConcurrency: 4, scaleEvents: 1 },
  }];
  const invariants: InvariantKind[] = ["ackedWriteLost", "duplicateEffect", "staleRead", "oversell", "uniquenessViolated", "splitBrainWrite", "orderingViolated"];
  result.violations = invariants.map((kind) => ({ kind, timeUs: 1000, detail: `detected ${kind}`, requestIds: ["request-1"] }));
  run.result = result;
  const html = renderToStaticMarkup(createElement(ResultsPanel, { runKey: "test", design: cacheAsideDesign }));
  for (const text of ["mean queue wait 0", "0 in flight", "0 dropped by live edits", "replication lag", "queue depth max", "breaker opened", "scaled 2", "failover", "wasted work"])
    expect(html).toContain(text);
  for (const kind of invariants) expect(html).toContain(`detected ${kind}`);
});

it("shows the configured field limit without changing its stored value", () => {
  const commit = vi.fn();
  const html = renderToStaticMarkup(createElement(UnitField, { label: "Capacity", value: 50, kind: "count", max: 100, onCommit: commit }));
  expect(html).toContain('aria-label="Capacity limit"');
  expect(html).toContain('max="100"');
  expect(commit).not.toHaveBeenCalled();
});
