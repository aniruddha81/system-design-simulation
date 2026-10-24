// Short-lived worker: one Scale task per worker, so Cancel = terminate (completed sweep
// levels were already posted). Scale runs are synchronous, so a cancel message could
// not be read mid-run anyway.
import { runScale, sweep, whatIf } from "@/engine/scale";
// TODO(E3): export failureLadder from "@/engine/scale" so partial ladders need no deep import.
import { failureLadder } from "@/engine/scale/sweep";
import type { SweepKind, SweepLevel } from "@/engine/scale";
import type { Design, Scenario } from "@/engine/types";

export type ScaleTask =
  | { type: "run"; design: Design; scenario: Scenario }
  | { type: "sweep"; design: Design; scenario: Scenario; kind: SweepKind; levels: number }
  | { type: "whatIf"; a: Design; b: Design; scenario: Scenario };

export type ScaleReply =
  | { type: "progress"; fraction: number }
  | { type: "level"; level: SweepLevel; ladder: ReturnType<typeof failureLadder> }
  | { type: "done"; value: unknown }
  | { type: "error"; message: string };

const post = (m: ScaleReply) => self.postMessage(m);

self.onmessage = (e: MessageEvent<ScaleTask>) => {
  const task = e.data;
  try {
    if (task.type === "run") {
      const { warmupUs, measureUs, drainUs } = task.scenario;
      const total = warmupUs + measureUs + drainUs;
      let last = 0;
      const value = runScale(task.design, task.scenario, {
        onStep(p) {
          const now = performance.now();
          if (now - last > 200) { last = now; post({ type: "progress", fraction: Math.min(1, p.tUs / total) }); }
        },
      });
      post({ type: "done", value });
    } else if (task.type === "sweep") {
      const levels: SweepLevel[] = [];
      const value = sweep(task.design, task.scenario, {
        kind: task.kind,
        levels: task.levels,
        onLevel(level) {
          levels.push(level);
          post({ type: "level", level, ladder: failureLadder(levels) });
        },
      });
      post({ type: "done", value });
    } else {
      post({ type: "done", value: whatIf(task.a, task.b, task.scenario) });
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
