// Pure helpers for the Scale panel: load entry, remedy variants and failure-ladder heat.
import type { FailureRung, ScaleResult } from "@/engine/scale";
import type { Design, NodeId, Scenario, Step } from "@/engine/types";

/** Every arrival rate in the scenario multiplied by `m` (the sweep's load multiple). */
export function scaleScenario(scenario: Scenario, m: number): Scenario {
  const a = scenario.workload.arrival;
  const arrival =
    a.kind === "poisson" || a.kind === "constant" ? { ...a, rps: a.rps * m }
    : a.kind === "step" ? { ...a, rps: a.rps * m, stepRps: a.stepRps * m }
    : a.kind === "spike" ? { ...a, rps: a.rps * m, spikeRps: a.spikeRps * m }
    : a.kind === "ramp" ? { ...a, fromRps: a.fromRps * m, toRps: a.toRps * m }
    : a.kind === "diurnal" ? { ...a, meanRps: a.meanRps * m }
    : { ...a, points: a.points.map((p) => ({ ...p, rps: p.rps * m })) };
  return { ...scenario, workload: { ...scenario.workload, arrival } };
}

/** Steady Poisson arrivals at `rps` (the "requests per day" load entry). */
export function withRps(scenario: Scenario, rps: number): Scenario {
  return { ...scenario, workload: { ...scenario.workload, arrival: { kind: "poisson", rps } } };
}

export function describeArrival(scenario: Scenario): string {
  const a = scenario.workload.arrival;
  const f = (n: number) => `${Math.round(n).toLocaleString("en-US")} rps`;
  switch (a.kind) {
    case "poisson": case "constant": return `${f(a.rps)} (${a.kind})`;
    case "step": return `${f(a.rps)} stepping to ${f(a.stepRps)}`;
    case "spike": return `${f(a.rps)} with a spike to ${f(a.spikeRps)}`;
    case "ramp": return `ramp ${f(a.fromRps)} → ${f(a.toRps)}`;
    case "diurnal": return `diurnal, mean ${f(a.meanRps)}`;
    case "replay": return `replayed curve (${a.points.length} points)`;
  }
}

function mapCalls(steps: Step[], fn: (s: Extract<Step, { type: "call" }>) => Step): Step[] {
  return steps.map((s) =>
    s.type === "call" ? fn(s)
    : s.type === "branch" ? { ...s, then: mapCalls(s.then, fn), else: mapCalls(s.else, fn) }
    : s.type === "parallel" ? { ...s, branches: s.branches.map((b) => mapCalls(b, fn)) }
    : s,
  );
}

export type Remedy = { label: string; design: Design };

/**
 * A concrete what-if variant for a ladder rung's suggestion, or null when there is no
 * mechanical change to test. "global" rungs borrow the first component rung's remedy.
 */
export function remedyFor(design: Design, rung: FailureRung, ladder: FailureRung[]): Remedy | null {
  const next = structuredClone(design);
  if (rung.what === "retry amplification") {
    let changed = false;
    for (const n of next.nodes) {
      if (!n.handlers) continue;
      for (const [ep, steps] of Object.entries(n.handlers)) {
        n.handlers[ep] = mapCalls(steps ?? [], (c) => {
          if (!c.retry || c.retry.max <= 1) return c;
          changed = true;
          return { ...c, retry: { ...c.retry, max: 1, backoffUs: c.retry.backoffUs * 2 } };
        });
      }
    }
    return changed ? { label: "Retry budget: at most 1 retry, 2× backoff", design: next } : null;
  }
  if (rung.component === "global") {
    const first = ladder.find((r) => r.component !== "global" && r.what !== "retry amplification");
    return first ? remedyFor(design, first, ladder) : null;
  }
  if (rung.component.startsWith("edge:")) {
    const edge = next.edges.find((e) => `edge:${e.id}` === rung.component);
    if (!edge) return null;
    edge.bandwidthBytesPerSec *= 2;
    return { label: `Double bandwidth on link ${edge.from} → ${edge.to}`, design: next };
  }
  const node = next.nodes.find((n) => n.id === rung.component);
  if (!node || !("concurrency" in node.params)) return null;
  if (node.kind === "database" && !node.params.replication) {
    node.params.replicas += 1;
    return { label: `+1 ${node.label} replica (${node.params.replicas} total)`, design: next };
  }
  const before = node.params.concurrency;
  node.params.concurrency = before * 2;
  return { label: `Double ${node.label} workers (${before} → ${before * 2})`, design: next };
}

/** Node heat for the board: utilisation plus the dropped fraction (0..2), design nodes only. */
export function heatOf(design: Design, result: ScaleResult): Record<NodeId, number> {
  const heat: Record<NodeId, number> = {};
  if (!result.fidelity.predictions.utilisation.enabled) return heat;
  for (const n of result.nodes) {
    if (!design.nodes.some((d) => d.id === n.nodeId)) continue;
    heat[n.nodeId] = n.utilisation + (result.fidelity.predictions.drops.enabled && n.arrivals > 0 ? Math.min(1, n.drops / n.arrivals) : 0);
  }
  return heat;
}

export const rungKey = (r: FailureRung) => `${r.component}:${r.what}`;

/** Component name for display: node label, "link a → b" for edges, or the raw id. */
export function componentName(design: Design, id: string): string {
  if (id === "global") return "Whole system";
  const node = design.nodes.find((n) => n.id === id);
  if (node) return node.label;
  const edge = design.edges.find((e) => `edge:${e.id}` === id);
  return edge ? `Link ${edge.from} → ${edge.to}` : id;
}
