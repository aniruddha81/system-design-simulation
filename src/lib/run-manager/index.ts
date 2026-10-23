// Module-level run manager (PLAN §5.10, §14): worker handles and run state live here, not in Effects.
// Components only subscribe; their Effect cleanup calls pause() so hidden routes (Activity) stop.
import { create } from "zustand";
import { newId, openStore } from "@/lib/persistence";
import type {
  Cursor, Design, FromWorker, LiveSnapshot, Packet, RunKey, RunResult, Scenario, Speed, ToWorker, ValidationIssue,
} from "@/engine/types";

export type RunStatus =
  | "idle" | "running" | "paused" | "finished" | "inconclusive" | "interrupted" | "stale" | "invalid";

export type RunInput = { design: Design; scenario: Scenario; seed: number };

export type RunState = {
  status: RunStatus;
  speed: Speed;
  input: RunInput | null;
  runKey: RunKey | null;
  snapshot: LiveSnapshot | null;
  result: RunResult | null;
  issues: ValidationIssue[];
  /** Why the run is interrupted/stale, for the banner. */
  note: string | null;
  /** Bumped when a finished run lands in persisted history. */
  historyRev: number;
};

const IDLE: RunState = {
  status: "idle", speed: 1, input: null, runKey: null, snapshot: null, result: null, issues: [], note: null, historyRev: 0,
};

export const useRuns = create<Record<string, RunState>>(() => ({}));

export function useRun(key: string): RunState {
  return useRuns((s) => s[key] ?? IDLE);
}

const get = (key: string) => useRuns.getState()[key] ?? IDLE;
const patch = (key: string, p: Partial<RunState>) => useRuns.setState({ [key]: { ...get(key), ...p } });

// ---------- worker handles ----------

type Handle = { worker: Worker; lastBeat: number; lastUsed: number; lastPaint: number };
const live = new Map<string, Handle>();
const MAX_LIVE = 2;
const WATCHDOG_MS = 5000;

const packetSubs = new Map<string, Set<(packets: Packet[], snap: LiveSnapshot) => void>>();

export function subscribePackets(key: string, cb: (packets: Packet[], snap: LiveSnapshot) => void): () => void {
  const set = packetSubs.get(key) ?? new Set();
  packetSubs.set(key, set);
  set.add(cb);
  return () => set.delete(cb);
}

function post(key: string, msg: ToWorker) {
  const h = live.get(key);
  if (!h) return;
  h.lastUsed = performance.now();
  h.worker.postMessage(msg);
}

function kill(key: string) {
  live.get(key)?.worker.terminate();
  live.delete(key);
}

function interrupt(key: string, note: string) {
  kill(key);
  patch(key, { status: "interrupted", note });
}

function onMessage(key: string, msg: FromWorker) {
  const h = live.get(key);
  if (h) h.lastBeat = performance.now();
  switch (msg.type) {
    case "invalid":
      kill(key);
      return patch(key, { status: "invalid", issues: msg.issues });
    case "started":
      return patch(key, { runKey: msg.runKey });
    case "snapshot":
      packetSubs.get(key)?.forEach((cb) => cb(msg.snapshot.packets, msg.snapshot));
      // The worker emits ~100 snapshots/s; React state only needs ~10/s (packets above get every one).
      if (h && get(key).status === "running" && h.lastBeat - h.lastPaint < 100) return;
      if (h) h.lastPaint = h.lastBeat;
      return patch(key, { snapshot: msg.snapshot });
    case "done":
      kill(key);
      void saveRun(key, msg.result);
      return patch(key, { status: msg.result.outcome, result: msg.result, runKey: msg.result.runKey, note: msg.result.inconclusiveReason ?? null });
    case "error":
      return interrupt(key, msg.message);
  }
}

async function saveRun(designId: string, r: RunResult) {
  try {
    const store = await openStore();
    const invariantCounts: Record<string, number> = {};
    for (const v of r.violations) invariantCounts[v.kind] = (invariantCounts[v.kind] ?? 0) + 1;
    await store.runs.add({
      schemaVersion: 1, revision: 0, id: newId(), designId, createdAt: Date.now(), runKey: r.runKey, replayCompatId: r.replayCompatId,
      summary: { metrics: r.metrics, outcome: r.outcome, invariantCounts, inconclusiveReason: r.inconclusiveReason },
    });
    patch(designId, { historyRev: get(designId).historyRev + 1 });
  } catch (err) {
    console.warn("Run history not saved", err);
  }
}

function spawn(key: string): Worker {
  kill(key);
  // LRU: at most MAX_LIVE designs hold a worker, so hidden routes can't pile them up.
  while (live.size >= MAX_LIVE) {
    const [oldest] = [...live.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    interrupt(oldest, "Stopped because another design started a run. Replay to continue.");
  }
  const worker = new Worker(new URL("../../engine/engine.worker.ts", import.meta.url), { type: "module" });
  const now = performance.now();
  live.set(key, { worker, lastBeat: now, lastUsed: now, lastPaint: 0 });
  worker.onmessage = (e: MessageEvent<FromWorker>) => onMessage(key, e.data);
  worker.onerror = (e) => interrupt(key, `Simulation worker crashed: ${e.message || "unknown error"}`);
  worker.onmessageerror = () => interrupt(key, "Simulation worker sent an unreadable message");
  ensureWatchdog();
  return worker;
}

// ---------- public API ----------

export function start(key: string, input: RunInput, opts: { replayTo?: Cursor } = {}) {
  const { speed } = get(key);
  spawn(key);
  // A replay keeps the last snapshot on screen until the fresh worker catches up.
  patch(key, {
    status: opts.replayTo ? "paused" : "running", input, issues: [], note: null, result: null, runKey: null,
    snapshot: opts.replayTo ? get(key).snapshot : null,
  });
  post(key, { type: "start", ...input, settings: { traceSampleRate: 0.05 }, speed: opts.replayTo ? "max" : speed });
  if (opts.replayTo) {
    post(key, { type: "replayTo", cursor: opts.replayTo });
    post(key, { type: "pause" });
    post(key, { type: "setSpeed", speed });
  }
}

export function pause(key: string) {
  if (get(key).status !== "running") return;
  post(key, { type: "pause" });
  patch(key, { status: "paused" });
}

export function resume(key: string) {
  if (get(key).status !== "paused" || !live.has(key)) return;
  const h = live.get(key)!;
  h.lastBeat = performance.now(); // paused time never counts against the watchdog
  post(key, { type: "resume" });
  patch(key, { status: "running" });
}

export function step(key: string) {
  if (get(key).status === "paused") post(key, { type: "step", by: "event" });
}

export function setSpeed(key: string, speed: Speed) {
  post(key, { type: "setSpeed", speed });
  patch(key, { speed });
}

export function restart(key: string) {
  const { input } = get(key);
  if (input) start(key, input);
}

/** Deterministic replay in a fresh worker up to `cursor` (default: last acknowledged snapshot). */
export function replayTo(key: string, cursor?: Cursor) {
  const { input, snapshot } = get(key);
  const to = cursor ?? snapshot?.cursor;
  if (input && to) start(key, input, { replayTo: to });
  else restart(key);
}

/** Structural edit: stop any live run and mark results stale (§5.7). */
export function markStale(key: string) {
  const s = get(key);
  if (s.status === "idle" || s.status === "stale" || s.status === "invalid") return;
  kill(key);
  patch(key, { status: "stale", note: "Design changed — results are from the previous design." });
}

export function close(key: string) {
  kill(key);
  packetSubs.delete(key);
}

// ---------- watchdog (§5.10) ----------

let watchdog: ReturnType<typeof setInterval> | null = null;

function ensureWatchdog() {
  if (watchdog || typeof document === "undefined") return;
  watchdog = setInterval(() => {
    if (live.size === 0) {
      clearInterval(watchdog!);
      watchdog = null;
      return;
    }
    // Only running runs in a visible tab are judged; paused/hidden ones never are.
    if (document.visibilityState !== "visible") return;
    const now = performance.now();
    for (const [key, h] of live)
      if (get(key).status === "running" && now - h.lastBeat > WATCHDOG_MS)
        interrupt(key, "The simulation stopped responding (no heartbeat for 5 s).");
  }, 1000);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const [key, h] of live) {
      if (document.visibilityState === "hidden") pause(key);
      else {
        // Liveness check before judging again: reset the clock and ask for a pong.
        h.lastBeat = performance.now();
        h.worker.postMessage({ type: "ping" } satisfies ToWorker);
      }
    }
  });
}

// ---------- one-off tasks (grading, trace) in a short-lived worker, never on the main thread ----------

export type TaskRequest =
  | { type: "grade"; design: Design; challenge: import("@/engine/types").ChallengeSpec }
  | { type: "trace"; design: Design; endpointId: string; key: string; seed: number; priorInputs: import("@/engine/types").TraceInput[] };
export type TaskReply = { ok: true; value: unknown } | { ok: false; error: string };

export function runTask<T>(req: TaskRequest): { promise: Promise<T>; cancel: () => void } {
  const worker = new Worker(new URL("./tasks.worker.ts", import.meta.url), { type: "module" });
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    reject = rej;
    worker.onmessage = (e: MessageEvent<TaskReply>) => {
      worker.terminate();
      if (e.data.ok) res(e.data.value as T);
      else rej(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      rej(new Error(e.message || "Worker crashed"));
    };
  });
  worker.postMessage(req);
  return { promise, cancel: () => (worker.terminate(), reject(new Error("Cancelled"))) };
}
