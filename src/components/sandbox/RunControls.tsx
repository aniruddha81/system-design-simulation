"use client";
import { useState } from "react";
import type { Speed } from "@/engine/types";
import * as runs from "@/lib/run-manager";
import { fmtMs } from "./units";

const STATUS: Record<runs.RunStatus, { icon: string; text: string; color: string }> = {
  idle: { icon: "○", text: "Not run", color: "var(--text-muted)" },
  running: { icon: "▶", text: "Running", color: "var(--accent)" },
  paused: { icon: "❚❚", text: "Paused", color: "var(--warning)" },
  finished: { icon: "✓", text: "Finished", color: "var(--success)" },
  inconclusive: { icon: "?", text: "Inconclusive", color: "var(--warning)" },
  interrupted: { icon: "⚡", text: "Interrupted", color: "var(--danger)" },
  stale: { icon: "△", text: "Stale", color: "var(--warning)" },
  invalid: { icon: "✕", text: "Invalid", color: "var(--danger)" },
};
const SPEEDS: [Speed, string][] = [[0.1, "0.1×"], [1, "1×"], [10, "10×"], ["max", "Max"]];

const btn = "h-8 rounded-(--radius-sm) border border-(--border) px-2.5 text-sm text-(--text) hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:opacity-40 disabled:hover:bg-transparent";

/** blockedReason: why Run is disabled, shown beside it; onFix jumps to the problem. */
export function RunControls({ runKey, onRun, blockedReason, onFix }: { runKey: string; onRun: () => void; blockedReason: string | null; onFix?: () => void }) {
  const run = runs.useRun(runKey);
  const live = run.status === "running" || run.status === "paused";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={onRun}
        disabled={!!blockedReason}
        title={blockedReason ?? "Run the simulation"}
        aria-describedby={blockedReason ? `${runKey}-blocked` : undefined}
        data-tour="run"
        className="h-8 rounded-(--radius-sm) border border-transparent bg-(--accent) px-3.5 text-sm font-semibold text-(--accent-ink) hover:bg-(--accent-hover,var(--accent)) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent) disabled:cursor-not-allowed disabled:border-dashed disabled:border-(--rule,var(--border)) disabled:bg-transparent disabled:text-(--text-muted)"
      >
        {live ? "↻ Restart" : "▶ Run"}
      </button>
      {blockedReason && (
        <button
          type="button"
          id={`${runKey}-blocked`}
          onClick={onFix}
          title={`${blockedReason} Show me where.`}
          className="flex h-8 max-w-[20rem] items-center gap-1.5 rounded-(--radius-sm) bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] px-2.5 text-xs text-(--text) hover:bg-[color-mix(in_oklab,var(--warning)_22%,transparent)] focus-visible:outline-2 focus-visible:outline-(--accent)"
        >
          <span aria-hidden="true" className="text-(--warning)">△</span>
          <span className="truncate">{blockedReason}</span>
          <span className="shrink-0 font-medium text-(--accent)">Show me<span aria-hidden="true"> →</span></span>
        </button>
      )}
      {live && (
        <>
          <button type="button" className={btn} onClick={() => (run.status === "running" ? runs.pause(runKey) : runs.resume(runKey))}>
            {run.status === "running" ? "❚❚ Pause" : "▶ Resume"}
          </button>
          <button type="button" className={btn} disabled={run.status !== "paused"} onClick={() => runs.step(runKey)} title="Advance one event">
            Step
          </button>
        </>
      )}
      <label className="flex items-center gap-1 text-xs text-(--text-muted)">
        <span className="sr-only">Speed</span>
        <select
          aria-label="Speed"
          value={String(run.speed)}
          onChange={(e) => runs.setSpeed(runKey, e.target.value === "max" ? "max" : (Number(e.target.value) as Speed))}
          className="h-8 rounded-(--radius-sm) border border-(--border) bg-(--bg) px-1.5 text-sm text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent)"
        >
          {SPEEDS.map(([v, l]) => <option key={l} value={String(v)}>{l}</option>)}
        </select>
      </label>
      <span className="ml-1 inline-flex items-center gap-1.5 text-xs tabular-nums" style={{ color: STATUS[run.status].color }}>
        <span aria-hidden="true">{STATUS[run.status].icon}</span>
        {STATUS[run.status].text}
        {run.snapshot && live && <span className="text-(--text-muted)">· t = {fmtMs(run.snapshot.simTimeUs)}</span>}
      </span>
    </div>
  );
}

/** Banner for interrupted/stale runs with Restart / Replay-to (§5.10). */
export function RunBanner({ runKey }: { runKey: string }) {
  const run = runs.useRun(runKey);
  const lastT = run.snapshot?.cursor.timeUs ?? 0;
  const [t, setT] = useState("");
  if (run.status !== "interrupted" || !run.note) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-(--danger) bg-[color-mix(in_oklab,var(--danger)_10%,var(--surface))] px-4 py-2 text-sm">
      <span>⚡ Run interrupted: {run.note} Last results are kept below.</span>
      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        <button type="button" className={btn} onClick={() => runs.restart(runKey)}>Restart</button>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const sec = Number(t);
            runs.replayTo(runKey, t.trim() && Number.isFinite(sec) ? { timeUs: Math.round(sec * 1e6), seq: 0 } : undefined);
          }}
        >
          <label className="text-xs text-(--text-muted)" htmlFor={`${runKey}-replay`}>Replay to t =</label>
          <input id={`${runKey}-replay`} value={t} onChange={(e) => setT(e.target.value)} placeholder={(lastT / 1e6).toFixed(2)} inputMode="decimal" className="h-8 w-20 rounded-(--radius-sm) border border-(--border) bg-(--bg) px-2 text-sm tabular-nums" />
          <span className="text-xs text-(--text-muted)">s</span>
          <button className={btn}>Replay</button>
        </form>
      </span>
    </div>
  );
}
