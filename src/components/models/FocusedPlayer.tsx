"use client";

import { useState, type ReactNode } from "react";
import { useStepDone } from "@/components/lesson/stepper";
import type { Model } from "@/models";
import { Figure, nb } from "./notebook";
import { PlayerControls, usePlayer, Violations, type Player } from "./Player";

export const describeAction = (action: unknown) => JSON.stringify(action).replace(/[{}\"]/g, "").replace(/,/g, ", ");

/** The same notebook and replay controls as the original two model players. */
export function FocusedPlayer<S, A>({ model, seed = 1, no, title, children, summary }: {
  model: Model<S, A>; seed?: number; no: string; title: string;
  children: (player: Player<S, A>) => ReactNode; summary: (state: S) => string;
}) {
  const [script, setScript] = useState(0);
  return <Figure no={no} title={title}>
    <label className="flex flex-wrap items-center gap-2 text-sm">Script
      <select className="field max-w-full" value={script} onChange={e => setScript(Number(e.target.value))}>
        {model.scenarios.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
        <option value={-1}>free play (no script)</option>
      </select>
    </label>
    {script >= 0 && <p className={nb.note}>{model.scenarios[script].description}</p>}
    <Session key={`${script}-${seed}`} model={model} seed={seed} script={script} summary={summary}>{children}</Session>
  </Figure>;
}

function Session<S, A>({ model, seed, script, children, summary }: {
  model: Model<S, A>; seed: number; script: number;
  children: (player: Player<S, A>) => ReactNode; summary: (state: S) => string;
}) {
  const done = useStepDone();
  const player = usePlayer(model, seed, script < 0 ? [] : model.scenarios[script].actions, done);
  const [chosen, setChosen] = useState(0);
  const actions = model.actions(player.state);
  const index = Math.min(chosen, Math.max(0, actions.length - 1));
  const text = summary(player.state);
  return <>
    <PlayerControls player={player} describe={describeAction} summary={text} />
    <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Your actions">
      <label className="min-w-0 flex-1">Action
        <select className="field ml-2 max-w-full" value={index} disabled={!actions.length} onChange={e => setChosen(Number(e.target.value))}>
          {actions.map((a, i) => <option key={i} value={i}>{describeAction(a)}</option>)}
        </select>
      </label>
      <button type="button" className="btn min-h-9" disabled={!actions.length} onClick={() => player.inject(actions[index])}>Inject action</button>
    </div>
    {children(player)}
    <p className="text-sm" aria-label="State summary">{text}</p>
    <Violations list={model.invariants(player.state)} />
  </>;
}

export function Diagram({ label, children, height = 320, width = 600 }: { label: string; children: ReactNode; height?: number; width?: number }) {
  return <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={`${label} (scrollable)`}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="paper-grid w-full min-w-[560px]" style={{ color: "var(--text)" }}>{children}</svg>
  </div>;
}

export function ModelTable({ caption, headers, rows }: { caption: string; headers: string[]; rows: ReactNode[][] }) {
  return <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={caption}>
    <table className="w-full text-left text-sm">
      <caption className="mb-2 text-left font-medium">{caption}</caption>
      <thead><tr>{headers.map(h => <th key={h} scope="col" className="border-b border-border p-2">{h}</th>)}</tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j} className="num border-b border-border p-2">{value}</td>)}</tr>)}</tbody>
    </table>
    {!rows.length && <p className="p-2 text-sm text-muted">No entries yet. Step through the script or inject an action.</p>}
  </div>;
}
