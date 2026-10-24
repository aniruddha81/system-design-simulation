import { random } from "../random";
import type { Model, Script, Violation } from "../types";

export interface StreamEvent { id: string; time: number; value: number; key?: string }
export interface WindowOptions {
  kind?: "tumbling" | "sliding" | "session"; size?: number; slide?: number; gap?: number;
  outOfOrderness?: number; allowedLateness?: number; latePolicy?: "drop" | "sideOutput" | "update";
}
export interface WindowConfig { kind: "tumbling" | "sliding" | "session"; size: number; slide: number; gap: number; outOfOrderness: number; allowedLateness: number; latePolicy: "drop" | "sideOutput" | "update" }
export interface StreamWindow { id: string; key: string; start: number; end: number; events: StreamEvent[]; count: number; total: number; emittedAt: number | null }
export interface WindowEmission { id: string; key: string; start: number; end: number; count: number; total: number; watermark: number }
export interface WindowState {
  // shortcut: retain dedup IDs for complete replay; add a retention contract before evicting them.
  seed: number; config: WindowConfig; watermark: number; maxEventTime: number; seen: string[];
  windows: StreamWindow[]; emissions: WindowEmission[]; sideOutput: StreamEvent[];
  dropped: StreamEvent[]; duplicates: number;
}
export type WindowAction = { type: "event"; event: StreamEvent } | { type: "watermark"; time: number };
function finish(state: WindowState) {
  for (const w of state.windows) if (w.emittedAt === null && state.watermark > w.end + state.config.allowedLateness) {
    w.emittedAt = state.watermark;
    state.emissions.push({ id: w.id, key: w.key, start: w.start, end: w.end, count: w.count, total: w.total, watermark: state.watermark });
  }
}
function targets(state: WindowState, event: StreamEvent): StreamWindow[] {
  const { kind, gap, size, slide } = state.config, key = event.key ?? "";
  const empty = (start: number, end: number): StreamWindow => ({ id: JSON.stringify([key, start, end]), key, start, end, events: [], count: 0, total: 0, emittedAt: null });
  if (kind === "session") {
    const overlapping = state.windows.filter(w => w.key === key && event.time < w.end && event.time + gap > w.start);
    if (overlapping.some(w => w.emittedAt !== null)) return overlapping;
    const start = Math.min(event.time, ...overlapping.map(w => w.start)), end = Math.max(event.time + gap, ...overlapping.map(w => w.end));
    const merged = empty(start, end);
    merged.events = overlapping.flatMap(w => w.events);
    merged.count = merged.events.length; merged.total = merged.events.reduce((n, e) => n + e.value, 0);
    state.windows = state.windows.filter(w => !overlapping.includes(w));
    state.windows.push(merged); return [merged];
  }
  const step = kind === "tumbling" ? size : slide, result: StreamWindow[] = [];
  for (let start = Math.floor(event.time / step) * step; start + size > event.time; start -= step) {
    const id = JSON.stringify([key, start, start + size]);
    let w = state.windows.find(w => w.id === id);
    if (!w) { w = empty(start, start + size); state.windows.push(w); }
    result.push(w);
  }
  return result;
}
export const windowingScenarios: Script<WindowAction>[] = [
  { name: "bounded disorder and deduplication", description: "An older event arrives before finalization; replaying its ID adds no count.", actions: [{ type: "event", event: { id: "a", time: 8, value: 2 } }, { type: "event", event: { id: "b", time: 3, value: 4 } }, { type: "event", event: { id: "b", time: 3, value: 4 } }, { type: "watermark", time: 30 }] },
  { name: "late update then finalization", description: "With update policy and lateness 5, the grace period accepts a late update; finalized windows cannot reopen.", actions: [{ type: "event", event: { id: "a", time: 1, value: 1 } }, { type: "watermark", time: 12 }, { type: "event", event: { id: "b", time: 2, value: 3 } }, { type: "watermark", time: 16 }, { type: "event", event: { id: "c", time: 4, value: 9 } }] },
  { name: "session bridge", description: "A delayed event joins two still-open sessions when gap is 10.", actions: [{ type: "event", event: { id: "a", time: 0, value: 1 } }, { type: "event", event: { id: "b", time: 16, value: 2 } }, { type: "event", event: { id: "bridge", time: 8, value: 3 } }, { type: "watermark", time: 100 }] },
];
export function windowingInvariants(state: WindowState): Violation[] {
  const issues: Violation[] = [];
  if (state.emissions.some(w => w.watermark <= w.end + state.config.allowedLateness)) issues.push({ code: "prematureEmission", message: "Final results require watermark strictly past end plus allowed lateness." });
  if (state.windows.some(w => new Set(w.events.map(e => e.id)).size !== w.events.length || w.count !== w.events.length || w.total !== w.events.reduce((n, e) => n + e.value, 0))) issues.push({ code: "dedup", message: "Each event ID contributes at most once per window, with exact count and total." });
  if (new Set(state.seen).size !== state.seen.length) issues.push({ code: "seen", message: "Deduplication IDs must be unique." });
  if (state.windows.some(w => w.emittedAt !== null && !state.emissions.some(e => e.id === w.id && e.count === w.count && e.total === w.total))) issues.push({ code: "finalized", message: "Finalized windows cannot change." });
  return issues;
}
export function createWindowingModel(options: WindowOptions = {}): Model<WindowState, WindowAction> {
  const config: WindowConfig = { kind: "tumbling", size: 10, slide: 5, gap: 10, outOfOrderness: 10, allowedLateness: 5, latePolicy: "update", ...options };
  if (!["tumbling", "sliding", "session"].includes(config.kind) || !["drop", "sideOutput", "update"].includes(config.latePolicy)) throw new Error("Unknown window kind or late policy");
  for (const field of ["size", "slide", "gap", "outOfOrderness", "allowedLateness"] as const) if (!Number.isSafeInteger(config[field]) || config[field] < (["size", "slide", "gap"].includes(field) ? 1 : 0)) throw new Error("Window durations must be safe integers with positive window sizes");
  if (Math.ceil(config.size / config.slide) > 10000) throw new Error("At most 10000 sliding windows per event");
  return {
    init(seed) { random(seed); return { seed, config: { ...config }, watermark: -Infinity, maxEventTime: -Infinity, seen: [], windows: [], emissions: [], sideOutput: [], dropped: [], duplicates: 0 }; },
    actions: s => [{ type: "event", event: { id: `event-${s.seen.length}`, time: Number.isFinite(s.maxEventTime) ? s.maxEventTime + 1 : 0, value: 1 } }, { type: "watermark", time: Number.isFinite(s.watermark) ? s.watermark + 20 : 20 }],
    step(state, action) {
      const next = structuredClone(state);
      if (action.type === "watermark") {
        if (!Number.isSafeInteger(action.time) || action.time < state.watermark) throw new Error("Watermarks must be monotonic safe integer timestamps");
        next.watermark = action.time; finish(next); return next;
      }
      const event = action.event;
      if (!event.id || !Number.isSafeInteger(event.time) || !Number.isSafeInteger(event.time - Math.max(config.size, config.gap)) || !Number.isSafeInteger(event.time + Math.max(config.size, config.gap) + config.allowedLateness) || !Number.isFinite(event.value) || (event.key !== undefined && typeof event.key !== "string")) throw new Error("Use a named event with valid time, key and finite value");
      if (next.seen.includes(event.id)) { next.duplicates++; return next; }
      next.seen.push(event.id);
      // Classification uses the prior watermark: this event can advance, but cannot make itself late.
      const beforeTargets = structuredClone(next.windows), windows = targets(next, event);
      const touchesFinalSession = config.kind === "session" && windows.some(w => w.emittedAt !== null);
      let accepted = false, rejected = false;
      for (const w of windows) {
        const final = touchesFinalSession || w.emittedAt !== null || state.watermark > w.end + config.allowedLateness;
        const late = state.watermark > w.end;
        if (final || (late && config.latePolicy !== "update")) { rejected = true; continue; }
        if (!Number.isFinite(w.total + event.value)) throw new Error("Window total exceeds finite numeric range");
        w.events.push({ ...event }); w.count++; w.total += event.value; accepted = true;
      }
      // A rejected session bridge must not merge or rename existing sessions.
      if (config.kind === "session" && !accepted) next.windows = beforeTargets;
      else next.windows = next.windows.filter(w => w.count > 0);
      if (rejected) (config.latePolicy === "sideOutput" ? next.sideOutput : next.dropped).push({ ...event });
      next.maxEventTime = Math.max(next.maxEventTime, event.time);
      next.watermark = Math.max(next.watermark, next.maxEventTime - config.outOfOrderness);
      finish(next); return next;
    }, invariants: windowingInvariants, scenarios: structuredClone(windowingScenarios),
  };
}
export interface WindowingVariant { id: string; seed: number; prompt: string; options: WindowOptions; actions: WindowAction[] }
export function generateWindowingVariant(seed: number): WindowingVariant {
  const next = random(seed); return { id: `windowing:${seed}`, seed, prompt: "What final (start, end, count, total) windows are emitted?", options: { kind: ["tumbling", "sliding", "session"][Math.floor(next() * 3)] as WindowConfig["kind"], outOfOrderness: 100, allowedLateness: Math.floor(next() * 6), latePolicy: "update" }, actions: [...Array.from({ length: 8 }, (_, i): WindowAction => ({ type: "event", event: { id: `e${i}`, time: Math.floor(next() * 30), value: 1 + Math.floor(next() * 10) } })), { type: "watermark", time: 100 }] };
}
export function solveWindowingVariant(v: WindowingVariant) { const m = createWindowingModel(v.options); return v.actions.reduce(m.step, m.init(v.seed)).emissions.map(({ start, end, count, total }) => ({ start, end, count, total })); }
