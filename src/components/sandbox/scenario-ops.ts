// Pure scenario helpers: arrival text, presets, chaos timeline validation (§5.5, §5.6, §8A.4).
// CSV replay parsing and "1B requests/day" come from E2: parseReplayCsv / toPeakRps in "@/engine/workload".
import type { ChaosEvent, Design, Scenario, Workload } from "@/engine/types";
import { placeNames } from "./design-ops";

type Arrival = Workload["arrival"];
const nf = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

/** Peak rate an arrival curve reaches (for summaries). */
export function peakRps(a: Arrival): number {
  switch (a.kind) {
    case "poisson": case "constant": return a.rps;
    case "step": return Math.max(a.rps, a.stepRps);
    case "spike": return Math.max(a.rps, a.spikeRps);
    case "ramp": return Math.max(a.fromRps, a.toRps);
    case "diurnal": return a.meanRps * (1 + a.amplitude);
    case "replay": return Math.max(0, ...a.points.map((p) => p.rps));
  }
}

export function describeArrival(a: Arrival): string {
  const r = (x: number) => `${nf.format(x)} req/s`;
  switch (a.kind) {
    case "poisson": return `${r(a.rps)} (Poisson)`;
    case "constant": return `${r(a.rps)} (constant)`;
    case "step": return `${r(a.rps)} → ${r(a.stepRps)} at ${a.stepAtUs / 1e6} s`;
    case "spike": return `${r(a.rps)}, spike to ${r(a.spikeRps)} at ${a.spikeAtUs / 1e6} s`;
    case "ramp": return `ramp ${r(a.fromRps)} → ${r(a.toRps)}`;
    case "diurnal": return `${r(a.meanRps)} mean, ±${Math.round(a.amplitude * 100)}% diurnal`;
    case "replay": return `replay of ${a.points.length} points, peak ${r(peakRps(a))}`;
  }
}

// ---------- presets (§8A.4) ----------

export type Preset = { id: string; label: string; blurb: string; apply: (s: Scenario, endpoints: Design["endpoints"]) => Scenario };

const base = (s: Scenario) => peakRps(s.workload.arrival) || 1000;
const withWorkload = (s: Scenario, w: Partial<Workload>): Scenario => ({ ...s, workload: { ...s.workload, ...w } });

export const PRESETS: Preset[] = [
  {
    id: "launch", label: "Launch-day spike", blurb: "10× traffic for 3 s, a third of the way in",
    apply: (s) => withWorkload(s, { arrival: { kind: "spike", rps: base(s), spikeAtUs: s.warmupUs + Math.round(s.measureUs / 3), spikeDurUs: 3_000_000, spikeRps: base(s) * 10 } }),
  },
  {
    id: "diurnal", label: "Diurnal", blurb: "±60% around the mean, one cycle per run",
    apply: (s) => withWorkload(s, { arrival: { kind: "diurnal", meanRps: base(s), amplitude: 0.6, periodUs: s.warmupUs + s.measureUs } }),
  },
  {
    id: "viral", label: "Viral key", blurb: "One key takes 40% of all traffic",
    apply: (s) => withWorkload(s, { keys: { kind: "hotspot", n: Math.max(1000, s.workload.keys.n), hotFraction: 0.4 } }),
  },
  {
    id: "ddos", label: "DDoS", blurb: "50× flood from a third of the way in until the end",
    apply: (s) => withWorkload(s, { arrival: { kind: "step", rps: base(s), stepAtUs: s.warmupUs + Math.round(s.measureUs / 3), stepRps: base(s) * 50 } }),
  },
  {
    id: "backfill", label: "Batch backfill", blurb: "Constant writes over sequential keys",
    apply: (s, endpoints) => {
      const writes = endpoints.filter((e) => e.op === "write");
      const mix = writes.length ? Object.fromEntries(writes.map((e) => [e.id, 1 / writes.length])) : s.workload.mix;
      return withWorkload(s, { arrival: { kind: "constant", rps: base(s) }, mix, keys: { kind: "sequential", n: Math.max(10_000, s.workload.keys.n) } });
    },
  },
];

// ---------- chaos (§5.6) ----------

export type ChaosKind = ChaosEvent["kind"];
export type ChaosTargetType = "node" | "edge" | "zone" | "region" | "none";

export const CHAOS_KINDS: { kind: ChaosKind; label: string; target: ChaosTargetType }[] = [
  { kind: "kill", label: "Kill", target: "node" },
  { kind: "degrade", label: "Degrade (slow)", target: "node" },
  { kind: "gray", label: "Gray failure (flaky)", target: "node" },
  { kind: "clockSkew", label: "Clock skew", target: "node" },
  { kind: "linkLoss", label: "Packet loss", target: "edge" },
  { kind: "linkLatency", label: "Latency injection", target: "edge" },
  { kind: "partition", label: "Network partition", target: "none" },
  { kind: "zoneOutage", label: "Zone outage", target: "zone" },
  { kind: "regionOutage", label: "Region outage", target: "region" },
  { kind: "trafficSpike", label: "Traffic spike", target: "none" },
];
export const chaosTargetType = (k: ChaosKind) => CHAOS_KINDS.find((c) => c.kind === k)!.target;

export function newChaos(kind: ChaosKind, d: Design, id: string, atUs: number): ChaosEvent {
  const node = d.nodes.find((n) => n.kind !== "client")?.id ?? "";
  const edge = d.edges[0];
  const { zones, regions } = placeNames(d);
  const at = { id, atUs, endUs: atUs + 2_000_000 };
  switch (kind) {
    case "kill": return { ...at, kind, target: node };
    case "degrade": return { ...at, kind, target: node, slowFactor: 5 };
    case "gray": return { ...at, kind, target: node, errorRate: 0.2 };
    case "clockSkew": return { ...at, kind, target: node, skewUs: 500_000 };
    case "linkLoss": return { ...at, kind, target: edge?.id ?? "", lossRate: 0.1 };
    case "linkLatency": return { ...at, kind, target: edge?.id ?? "", addUs: 100_000 };
    case "partition": return { ...at, kind, target: "", links: edge ? [{ from: edge.from, to: edge.to }] : [] };
    case "zoneOutage": return { ...at, kind, target: zones[0] ?? "" };
    case "regionOutage": return { ...at, kind, target: regions[0] ?? "" };
    case "trafficSpike": return { ...at, kind, target: "", multiplier: 5 };
  }
}

export function chaosTargetOk(d: Design, e: ChaosEvent): boolean {
  switch (chaosTargetType(e.kind)) {
    case "node": return d.nodes.some((n) => n.id === e.target);
    case "edge": return d.edges.some((x) => x.id === e.target);
    case "zone": return placeNames(d).zones.includes(e.target);
    case "region": return placeNames(d).regions.includes(e.target);
    case "none": return e.kind !== "partition" || (e.links.length > 0 && e.links.every((l) => d.nodes.some((n) => n.id === l.from) && d.nodes.some((n) => n.id === l.to)));
  }
}

const overlaps = (a: ChaosEvent, b: ChaosEvent) => a.atUs < (b.endUs ?? Infinity) && b.atUs < (a.endUs ?? Infinity);
const sameTarget = (a: ChaosEvent, b: ChaosEvent) =>
  a.kind === "partition" && b.kind === "partition"
    ? a.links.some((l) => b.links.some((m) => l.from === m.from && l.to === m.to))
    : a.target === b.target;

/** Inline problems per event id: missing target, bad interval, or overlap with the same kind on the same target. */
export function chaosProblems(d: Design, events: ChaosEvent[]): Record<string, string> {
  const out: Record<string, string> = {};
  events.forEach((e, i) => {
    if (!chaosTargetOk(d, e)) out[e.id] = "Pick a target that exists in this design";
    else if (e.endUs !== undefined && e.endUs <= e.atUs) out[e.id] = "End must be after start";
    else {
      const clash = events.find((o, j) => j !== i && o.kind === e.kind && sameTarget(e, o) && overlaps(e, o));
      if (clash) out[e.id] = `Overlaps another ${e.kind} on the same target (${clash.id}); events of one kind on one target must not overlap`;
    }
  });
  return out;
}

// ---------- persistence: the sandbox scenario lives beside the design record ----------

// shortcut: scenarios live in localStorage outside design exports; move into DesignRecord when it supports scenarios.
const key = (designId: string) => `sds:scenario:${designId}`;

export function loadScenario(designId: string, fallback: Scenario): Scenario {
  try {
    const v = JSON.parse(localStorage.getItem(key(designId)) ?? "null") as Scenario | null;
    if (v && v.workload?.arrival && v.workload.mix && v.workload.keys && Array.isArray(v.chaos) && v.measureUs > 0) return v;
  } catch {}
  return fallback;
}

export function saveScenario(designId: string, s: Scenario) {
  try {
    localStorage.setItem(key(designId), JSON.stringify(s));
  } catch {}
}
