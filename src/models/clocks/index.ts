import type { Model, Script, Violation } from "../types";
import { random } from "../random";

export type ClockType = "physical" | "lamport" | "vector" | "hlc";
export type CausalRelation = "before" | "after" | "concurrent" | "equal";
export interface HLC { wall: number; logical: number }
export interface ClockEvent {
  id: string; node: string; kind: "local" | "send" | "receive" | "write";
  parents: string[]; physical: number; lamport: number; vector: number[]; hlc: HLC; value?: string;
}
export interface ClockRegister { event: string; value: string; physical: number }
export interface ClockNode {
  id: string; skew: number; driftPpm: number; lamport: number; vector: number[]; hlc: HLC;
  lastEvent: string | null; register: ClockRegister | null;
}
export interface ClockMessage { id: string; from: string; to: string; event: string; register: ClockRegister | null }
export interface ClocksState {
  seed: number; now: number; clock: ClockType; nodes: ClockNode[]; events: ClockEvent[]; messages: ClockMessage[];
  lostUpdates: string[];
}
export type ClocksAction =
  | { type: "advance"; ms: number }
  | { type: "setClock"; clock: ClockType }
  | { type: "configure"; node: string; skew: number; driftPpm: number }
  | { type: "local"; node: string }
  | { type: "write"; node: string; value: string }
  | { type: "send"; from: string; to: string }
  | { type: "receive"; message: string };
export interface ClocksOptions { nodes?: { id: string; skew?: number; driftPpm?: number }[]; clock?: ClockType }

export function compareVectors(a: number[], b: number[]): CausalRelation {
  if (a.length !== b.length) throw new Error("Vectors must have the same dimensions");
  const less = a.some((value, i) => value < b[i]), greater = a.some((value, i) => value > b[i]);
  return less && greater ? "concurrent" : less ? "before" : greater ? "after" : "equal";
}
export function compareHLC(a: HLC, b: HLC): number { return a.wall - b.wall || a.logical - b.logical; }
export function physicalTime(node: ClockNode, now: number): number { return node.skew + now * (1 + node.driftPpm / 1e6); }

/** Independent causal graph traversal, useful for diagram edges and checking vector timestamps. */
export function causalRelation(state: ClocksState, a: string, b: string): CausalRelation {
  const events = new Map(state.events.map(e => [e.id, e]));
  if (!events.has(a) || !events.has(b)) throw new Error("Unknown clock event");
  if (a === b) return "equal";
  function ancestor(from: string, target: string): boolean {
    const pending = [from], seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === target) return true;
      if (!seen.has(id)) { seen.add(id); pending.push(...events.get(id)!.parents); }
    }
    return false;
  }
  return ancestor(b, a) ? "before" : ancestor(a, b) ? "after" : "concurrent";
}

export function createClocksModel(options: ClocksOptions = {}): Model<ClocksState, ClocksAction> {
  const definitions = structuredClone(options.nodes ?? [{ id: "A", skew: 100 }, { id: "B", skew: -100 }, { id: "C" }]);
  const clock = options.clock ?? "vector";
  const types: ClockType[] = ["physical", "lamport", "vector", "hlc"];
  if (!types.includes(clock) || !definitions.length || definitions.length > 32 || definitions.some(n => !n.id) || new Set(definitions.map(n => n.id)).size !== definitions.length) throw new Error("Use a clock type and 1..32 distinct nodes");
  function calibrate(skew: number, drift: number) {
    if (!Number.isFinite(skew) || !Number.isFinite(drift) || Math.abs(skew) > 1e9 || Math.abs(drift) > 100000) throw new Error("Use finite skew within 1e9ms and drift within 100000ppm");
  }
  definitions.forEach(n => calibrate(n.skew ?? 0, n.driftPpm ?? 0));
  function node(s: ClocksState, id: string) { const n = s.nodes.find(n => n.id === id); if (!n) throw new Error("Unknown clock node"); return n; }
  function merge(n: ClockNode, incoming: ClockRegister | null) {
    if (incoming && (!n.register || incoming.physical > n.register.physical || (incoming.physical === n.register.physical && incoming.event > n.register.event))) n.register = { ...incoming };
  }
  function event(s: ClocksState, n: ClockNode, kind: ClockEvent["kind"], received?: ClockEvent, value?: string) {
    const physical = physicalTime(n, s.now), old = n.hlc;
    n.lamport = Math.max(n.lamport, received?.lamport ?? 0) + 1;
    n.vector = n.vector.map((v, i) => Math.max(v, received?.vector[i] ?? 0));
    n.vector[s.nodes.indexOf(n)]++;
    const wall = Math.max(physical, old.wall, received?.hlc.wall ?? -Infinity);
    const logical = wall === old.wall && wall === received?.hlc.wall ? Math.max(old.logical, received.hlc.logical) + 1
      : wall === old.wall ? old.logical + 1 : wall === received?.hlc.wall ? received.hlc.logical + 1 : 0;
    n.hlc = { wall, logical };
    const e: ClockEvent = { id: `e${s.events.length + 1}`, node: n.id, kind, parents: [...new Set([...(n.lastEvent ? [n.lastEvent] : []), ...(received ? [received.id] : [])])], physical, lamport: n.lamport, vector: n.vector.slice(), hlc: { ...n.hlc }, ...(value === undefined ? {} : { value }) };
    s.events.push(e); n.lastEvent = e.id; return e;
  }
  const ids = definitions.map(n => n.id), [a, b] = ids;
  const exchange: ClocksAction[] = b ? [{ type: "local", node: a }, { type: "send", from: a, to: b }, { type: "local", node: b }, { type: "advance", ms: 1 }, { type: "receive", message: "m1" }] : [{ type: "local", node: a }];
  const scenarios: Script<ClocksAction>[] = types.map(type => ({ name: `${type} clock`, description: type === "physical" ? "Skew can put a receive timestamp before its send." : type === "vector" ? "Concurrent events are incomparable; receive merges causal history." : type === "hlc" ? "HLC preserves causality even when the physical clock goes backwards." : "Causal events increase Lamport time; total order alone cannot identify concurrency.", actions: [{ type: "setClock", clock: type }, ...exchange, ...(type === "hlc" ? [{ type: "configure" as const, node: a, skew: -1000, driftPpm: 0 }, { type: "local" as const, node: a }] : [])] }));
  if (b) scenarios.push({ name: "last-writer-wins loses an update under skew", description: "B observes A's write, then makes a causally later write which physical-timestamp LWW discards.", actions: [{ type: "setClock", clock: "physical" }, { type: "configure", node: a, skew: 100, driftPpm: 0 }, { type: "configure", node: b, skew: -100, driftPpm: 0 }, { type: "write", node: a, value: "first" }, { type: "send", from: a, to: b }, { type: "receive", message: "m1" }, { type: "advance", ms: 1 }, { type: "write", node: b, value: "later" }] });
  return {
    init(seed) {
      random(seed);
      return { seed, now: 0, clock, nodes: definitions.map(n => ({ id: n.id, skew: n.skew ?? 0, driftPpm: n.driftPpm ?? 0, lamport: 0, vector: ids.map(() => 0), hlc: { wall: n.skew ?? 0, logical: 0 }, lastEvent: null, register: null })), events: [], messages: [], lostUpdates: [] };
    },
    actions: s => [{ type: "advance", ms: 1 }, ...s.nodes.flatMap(n => [{ type: "local" as const, node: n.id }, { type: "write" as const, node: n.id, value: `value-${s.events.length}` }, ...ids.filter(id => id !== n.id).map(to => ({ type: "send" as const, from: n.id, to }))]), ...s.messages.map(m => ({ type: "receive" as const, message: m.id }))],
    step(state, action) {
      const s = structuredClone(state);
      switch (action.type) {
        case "setClock": if (!types.includes(action.clock)) throw new Error("Unknown clock type"); s.clock = action.clock; break;
        case "advance": if (!Number.isFinite(action.ms) || action.ms < 0 || action.ms > 1e9) throw new Error("Advance by 0..1e9 finite ms"); s.now += action.ms; break;
        case "configure": { calibrate(action.skew, action.driftPpm); const n = node(s, action.node); n.skew = action.skew; n.driftPpm = action.driftPpm; break; }
        case "local": event(s, node(s, action.node), "local"); break;
        case "write": {
          if (typeof action.value !== "string") throw new Error("Use string register values");
          const n = node(s, action.node), e = event(s, n, "write", undefined, action.value);
          merge(n, { event: e.id, value: action.value, physical: e.physical });
          if (n.register!.event !== e.id) s.lostUpdates.push(e.id); break;
        }
        case "send": {
          const n = node(s, action.from); node(s, action.to);
          const e = event(s, n, "send");
          s.messages.push({ id: `m${s.events.filter(e => e.kind === "send").length}`, from: n.id, to: action.to, event: e.id, register: n.register ? { ...n.register } : null }); break;
        }
        case "receive": {
          const index = s.messages.findIndex(m => m.id === action.message); if (index < 0) throw new Error("Unknown clock message");
          const [m] = s.messages.splice(index, 1), n = node(s, m.to);
          event(s, n, "receive", s.events.find(e => e.id === m.event)!); merge(n, m.register); break;
        }
      }
      return s;
    },
    invariants: clocksInvariants,
    scenarios,
  };
}

export function clocksInvariants(s: ClocksState): Violation[] {
  const issues: Violation[] = [];
  const causalPairs = s.events.flatMap(e => e.parents.map(id => [s.events.find(p => p.id === id)!, e] as const));
  if (causalPairs.some(([a, b]) => a.lamport >= b.lamport)) issues.push({ code: "lamportCausality", message: "A causal edge must increase Lamport time." });
  if (causalPairs.some(([a, b]) => compareHLC(a.hlc, b.hlc) >= 0)) issues.push({ code: "hlcCausality", message: "A causal edge must increase HLC time." });
  if (s.events.some(a => s.events.some(b => compareVectors(a.vector, b.vector) !== causalRelation(s, a.id, b.id)))) issues.push({ code: "vectorCausality", message: "Vector order must match happens-before." });
  if (s.clock === "physical" && causalPairs.some(([a, b]) => a.physical >= b.physical)) issues.push({ code: "physicalOrderingAnomaly", message: "A causal successor has an equal or earlier physical timestamp." });
  if (s.lostUpdates.length) issues.push({ code: "lwwLostUpdate", message: "Physical-timestamp LWW discarded a local update under skew." });
  return issues;
}
