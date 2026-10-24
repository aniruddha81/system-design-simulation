import type { Model, Violation } from "../types";
import { hash32, random } from "../random";

export type GossipMode = "push" | "pull" | "pushPull";
export interface GossipOptions {
  nodes?: number; fanout?: number; mode?: GossipMode; threshold?: number;
  initialInterval?: number; minStdDev?: number; windowSize?: number;
}
export interface GossipState {
  seed: number; cursor: number; round: number; mode: GossipMode; fanout: number;
  nodes: { id: string; alive: boolean; infected: boolean }[];
  curve: number[]; contacts: { from: string; to: string }[];
  now: number;
  detector: { targetAlive: boolean; lastHeartbeat: number; intervals: number[]; threshold: number; phi: number; suspected: boolean; falsePositives: number; detectedAt: number | null; crashedAt: number | null; history: { at: number; phi: number; suspected: boolean; targetAlive: boolean }[] };
}
export type GossipAction =
  | { type: "round"; mode?: GossipMode; fanout?: number }
  | { type: "crash" | "recover"; node: string }
  | { type: "advance"; ms: number }
  | { type: "heartbeat" }
  | { type: "threshold"; value: number };

function integer(n: number, min: number, max: number) { if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}..${max}`); }
function positive(n: number) { if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw new Error("Use a positive finite value up to 1e9"); }

/** Normal-tail approximation (erfc), with a floor to keep phi finite in long outages. */
export function phiAccrual(elapsed: number, intervals: number[], initialInterval = 100, minStdDev = 25): number {
  if (!Number.isFinite(elapsed) || elapsed < 0 || intervals.some(v => !Number.isFinite(v) || v <= 0)) throw new Error("Use nonnegative elapsed time and positive heartbeat intervals");
  positive(initialInterval); positive(minStdDev);
  const mean = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : initialInterval;
  const deviation = Math.max(minStdDev, Math.sqrt(intervals.length ? intervals.reduce((sum, x) => sum + (x - mean) ** 2, 0) / intervals.length : 0));
  const z = (elapsed - mean) / deviation / Math.SQRT2, x = Math.abs(z), t = 1 / (1 + 0.3275911 * x);
  const tail = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x) / 2;
  return -Math.log10(Math.max(1e-300, z >= 0 ? tail : 1 - tail));
}

export function createGossipModel(options: GossipOptions = {}): Model<GossipState, GossipAction> {
  const count = options.nodes ?? 32, fanout = options.fanout ?? 1, mode = options.mode ?? "pushPull", threshold = options.threshold ?? 3;
  const initialInterval = options.initialInterval ?? 100, minStdDev = options.minStdDev ?? 25, windowSize = options.windowSize ?? 100;
  integer(count, 2, 512); integer(fanout, 1, count - 1); integer(windowSize, 2, 10000); positive(initialInterval); positive(minStdDev); positive(threshold);
  const modes: GossipMode[] = ["push", "pull", "pushPull"]; if (!modes.includes(mode)) throw new Error("Unknown gossip mode");
  function observe(s: GossipState) {
    const d = s.detector;
    d.phi = phiAccrual(s.now - d.lastHeartbeat, d.intervals, initialInterval, minStdDev);
    const suspected = d.phi >= d.threshold;
    if (suspected && !d.suspected && d.targetAlive) d.falsePositives++;
    if (suspected && !d.targetAlive && d.detectedAt === null) d.detectedAt = s.now;
    d.suspected = suspected;
    d.history.push({ at: s.now, phi: d.phi, suspected, targetAlive: d.targetAlive });
  }
  const training: GossipAction[] = Array.from({ length: 5 }, () => [{ type: "advance" as const, ms: initialInterval }, { type: "heartbeat" as const }]).flat();
  return {
    init(seed) {
      random(seed);
      const s: GossipState = { seed, cursor: 0, round: 0, mode, fanout, nodes: Array.from({ length: count }, (_, i) => ({ id: `N${i}`, alive: true, infected: i === 0 })), curve: [1], contacts: [], now: 0, detector: { targetAlive: true, lastHeartbeat: 0, intervals: [], threshold, phi: 0, suspected: false, falsePositives: 0, detectedAt: null, crashedAt: null, history: [] } };
      observe(s); return s;
    },
    actions: s => [{ type: "round" }, { type: "advance", ms: initialInterval / 2 }, ...(s.detector.targetAlive && s.now > s.detector.lastHeartbeat ? [{ type: "heartbeat" as const }] : []), ...s.nodes.map(node => ({ type: node.alive ? "crash" as const : "recover" as const, node: node.id })), ...[1, 3, 8].map(value => ({ type: "threshold" as const, value }))],
    step(state, action) {
      const s = structuredClone(state);
      switch (action.type) {
        case "round": {
          s.mode = action.mode ?? s.mode; s.fanout = action.fanout ?? s.fanout;
          if (!modes.includes(s.mode)) throw new Error("Unknown gossip mode"); integer(s.fanout, 1, count - 1);
          const infected = s.nodes.map(n => n.infected), next = infected.slice(); s.contacts = [];
          for (let i = 0; i < count; i++) {
            if (!s.nodes[i].alive) continue;
            const peers = Array.from({ length: count }, (_, j) => j).filter(j => j !== i);
            for (let contact = 0; contact < s.fanout; contact++) {
              const index = hash32(String(s.cursor++), s.seed) % peers.length, [j] = peers.splice(index, 1);
              s.contacts.push({ from: s.nodes[i].id, to: s.nodes[j].id });
              if (!s.nodes[j].alive) continue;
              if (s.mode !== "pull" && infected[i]) next[j] = true;
              if (s.mode !== "push" && infected[j]) next[i] = true;
            }
          }
          s.nodes.forEach((node, i) => { node.infected = next[i]; }); s.round++; s.curve.push(next.filter(Boolean).length); break;
        }
        case "crash": case "recover": {
          const node = s.nodes.find(n => n.id === action.node); if (!node) throw new Error("Unknown gossip node");
          node.alive = action.type === "recover";
          if (node.id === "N0") {
            s.detector.targetAlive = node.alive;
            if (!node.alive) { s.detector.crashedAt = s.now; s.detector.detectedAt = null; }
            observe(s);
          }
          break;
        }
        case "advance": positive(action.ms); s.now += action.ms; observe(s); break;
        case "heartbeat": {
          const d = s.detector;
          if (!d.targetAlive || s.now <= d.lastHeartbeat) throw new Error("A live target must send heartbeats at increasing times");
          d.intervals.push(s.now - d.lastHeartbeat); d.intervals = d.intervals.slice(-windowSize); d.lastHeartbeat = s.now; observe(s); break;
        }
        case "threshold": positive(action.value); s.detector.threshold = action.value; observe(s); break;
      }
      return s;
    },
    invariants: gossipInvariants,
    scenarios: [
      ...modes.map(mode => ({ name: `${mode} spread`, description: "Synchronous seeded fanout contacts expose the infection curve per round; rounds use a snapshot, so an infection advances at most one contact per round.", actions: Array.from({ length: Math.ceil(4 * Math.log2(count)) }, () => ({ type: "round" as const, mode })) })),
      { name: "phi false positive", description: "A delayed live heartbeat crosses a low threshold, then clears suspicion.", actions: [...training, { type: "threshold", value: 1 }, { type: "advance", ms: initialInterval + minStdDev * 2 }, { type: "heartbeat" }] },
      { name: "phi failure detection", description: "A higher threshold delays detection while reducing false suspicions from jitter.", actions: [...training, { type: "threshold", value: 8 }, { type: "crash", node: "N0" }, { type: "advance", ms: initialInterval + minStdDev * 8 }] },
    ],
  };
}

export function gossipInvariants(s: GossipState): Violation[] {
  const issues: Violation[] = [];
  if (s.curve.at(-1) !== s.nodes.filter(n => n.infected).length || s.curve.some((value, i) => value < 1 || value > s.nodes.length || (i > 0 && value < s.curve[i - 1]))) issues.push({ code: "infectionMonotonicity", message: "Infected nodes retain the rumor and the curve matches their count." });
  if (!Number.isFinite(s.detector.phi) || s.detector.phi < 0 || s.detector.suspected !== (s.detector.phi >= s.detector.threshold)) issues.push({ code: "detectorState", message: "Phi is finite and suspicion follows its threshold." });
  if (s.detector.suspected && s.detector.targetAlive) issues.push({ code: "falsePositive", message: "The detector suspects a live target because its heartbeat is delayed." });
  return issues;
}
