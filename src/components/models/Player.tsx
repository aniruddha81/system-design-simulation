"use client";

import { useEffect, useEffectEvent, useId, useMemo, useState } from "react";
import type { Model, Violation } from "@/models";
import { LiveSummary } from "@/components/scale/LiveSummary";
import { nb } from "./notebook";

const STEP_MS = 1200;

/**
 * Script playback over a pure Model: states[i] is the state after i actions, so scrubbing
 * replays from init. Injecting an action at the cursor replaces the rest of the timeline.
 */
export function usePlayer<S, A>(model: Model<S, A>, seed: number, script: A[], onInteract: () => void) {
  const [timeline, setTimeline] = useState<A[]>(script);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const states = useMemo(() => {
    const out = [model.init(seed)];
    for (const a of timeline) out.push(model.step(out[out.length - 1], a));
    return out;
  }, [model, seed, timeline]);

  const go = (i: number) => {
    setPlaying(false);
    setCursor(Math.max(0, Math.min(timeline.length, i)));
    setError(null);
    onInteract();
  };
  const inject = (action: A) => {
    try {
      model.step(states[cursor], action); // validate before committing it to the timeline
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setPlaying(false);
    setTimeline([...timeline.slice(0, cursor), action]);
    setCursor(cursor + 1);
    setError(null);
    onInteract();
  };
  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (cursor >= timeline.length) setCursor(0);
    setPlaying(true);
    onInteract();
  };

  const tick = useEffectEvent(() => {
    if (cursor >= timeline.length) setPlaying(false);
    else setCursor(cursor + 1);
  });
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(tick, STEP_MS);
    return () => clearTimeout(t);
  }, [playing, cursor]);

  return { timeline, cursor, states, state: states[cursor], previous: cursor > 0 ? states[cursor - 1] : null, playing, error, go, inject, togglePlay };
}

export type Player<S, A> = ReturnType<typeof usePlayer<S, A>>;

/** Play/pause/step/scrub. Every control is a native button or range input (keyboard operable). */
export function PlayerControls<S, A>({ player, describe, summary }: { player: Player<S, A>; describe: (a: A) => string; summary: string }) {
  const { cursor, timeline, playing, go, togglePlay } = player;
  const id = useId();
  const label = cursor === 0 ? "Initial state" : `Step ${cursor} of ${timeline.length}: ${describe(timeline[cursor - 1])}`;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Playback">
        <button type="button" className="btn btn-ghost min-h-9 px-2.5" onClick={() => go(0)} disabled={cursor === 0} aria-label="Back to start">
          ⏮
        </button>
        <button type="button" className="btn btn-ghost min-h-9 px-2.5" onClick={() => go(cursor - 1)} disabled={cursor === 0} aria-label="Step back">
          ◀
        </button>
        <button type="button" className="btn min-h-9 px-3" onClick={togglePlay} disabled={timeline.length === 0} aria-pressed={playing}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button type="button" className="btn btn-ghost min-h-9 px-2.5" onClick={() => go(cursor + 1)} disabled={cursor >= timeline.length} aria-label="Step forward">
          ▶|
        </button>
        <label htmlFor={id} className="sr-only">
          Scrub through the script
        </label>
        <input
          id={id}
          type="range"
          min={0}
          max={timeline.length}
          value={cursor}
          onChange={(e) => go(Number(e.target.value))}
          aria-valuetext={label}
          className="min-h-6 min-w-32 flex-1"
        />
      </div>
      <p className="num text-sm text-muted">{label}</p>
      {player.error && (
        <p role="alert" className="text-sm text-danger">
          ✕ {player.error}
        </p>
      )}
      <LiveSummary text={`${label}. ${summary}`} />
    </div>
  );
}

export function Violations({ list, title = "Invariants" }: { list: Violation[]; title?: string }) {
  return (
    <div className="grid gap-1.5" aria-label={title} role="group">
      <p className="text-sm font-medium">{title}</p>
      {list.length === 0 ? (
        <p className="text-sm text-success">✓ None violated</p>
      ) : (
        <ul className="grid gap-1 text-sm">
          {list.map((v, i) => (
            <li key={i} className="flex gap-2 border-l-2 border-danger py-0.5 pl-2.5">
              <span aria-hidden className="font-bold text-danger">✕</span>
              <span>
                <strong className={`font-semibold ${nb.marker}`}>{v.code}</strong>: {v.message}
                {(v.transactions?.length || v.keys?.length) && (
                  <span className="text-muted">
                    {" "}
                    ({[v.transactions?.length && `transactions ${v.transactions.join(", ")}`, v.keys?.length && `keys ${v.keys.join(", ")}`].filter(Boolean).join("; ")})
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
