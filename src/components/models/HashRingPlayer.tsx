"use client";

import { useId, useMemo, useState } from "react";
import { useStepDone } from "@/components/lesson/stepper";
import { formatNumber, formatPercent } from "@/lib/format";
import { compareModuloHashing, createHashRingModel, hashRingScenarios, loadStandardDeviation, type HashRingAction, type HashRingState } from "@/models";
import { hash32 } from "@/models/random";
import { Figure, nb, SERIES, SketchFilter } from "./notebook";
import { PlayerControls, usePlayer, Violations } from "./Player";

// ponytail: the UI caps the ring at 8 physical nodes so each keeps a distinct series colour; the model allows 128.
const NAMES = ["A", "B", "C", "D", "E", "F", "G", "H"];
const KEYS = Array.from({ length: 300 }, (_, i) => `key-${i}`);
const TAU = 2 ** 32;
const color = (node: string) => SERIES[Math.max(0, NAMES.indexOf(node)) % SERIES.length];

export const describeRingAction = (a: HashRingAction) =>
  a.type === "addNode" ? `add node ${a.node}` : a.type === "removeNode" ? `remove node ${a.node}` : a.type === "setVnodes" ? `set ${a.count} virtual node${a.count === 1 ? "" : "s"} per node` : `add ${a.keys.length} keys`;

/** Consistent-hashing ring (PLAN §6): vnodes, key movement, load histogram, modulo comparison. */
export function HashRingPlayer({ seed = 1 }: { seed?: number }) {
  const [script, setScript] = useState(0);
  const id = useId();
  return (
    <Figure
      no="M1"
      title="The consistent-hash ring"
      note="Each arc belongs to the next virtual node clockwise; a key lands on the arc its hash falls in. Change the ring and watch which keys change hands."
    >
      <label htmlFor={id} className="flex flex-wrap items-center gap-2 text-sm">
        Script
        <select id={id} className="field" value={script} onChange={(e) => setScript(Number(e.target.value))}>
          {hashRingScenarios.map((s, i) => (
            <option key={s.name} value={i}>
              {s.name}
            </option>
          ))}
          <option value={-1}>free play (no script)</option>
        </select>
        {script >= 0 && <span className={nb.note}>{hashRingScenarios[script].description}</span>}
      </label>
      <Session key={`${script}-${seed}`} seed={seed} script={script >= 0 ? hashRingScenarios[script].actions : []} />
    </Figure>
  );
}

function Session({ seed, script }: { seed: number; script: HashRingAction[] }) {
  const done = useStepDone();
  const model = useMemo(() => createHashRingModel({ keys: KEYS }), []);
  const player = usePlayer(model, seed, script, done);
  const { state, previous } = player;
  const last = player.cursor > 0 ? player.timeline[player.cursor - 1] : null;

  // Where moved keys went, e.g. "A → D: 40".
  const flows = new Map<string, number>();
  for (const k of state.movedKeys) {
    const f = `${state.previousOwnership[k]} → ${state.ownership[k]}`;
    flows.set(f, (flows.get(f) ?? 0) + 1);
  }
  const modulo = previous && last && (last.type === "addNode" || last.type === "removeNode") ? compareModuloHashing(state.keys, previous.nodes, state.nodes, seed) : null;
  const maxLoad = Math.max(1, ...state.nodes.map((n) => state.load[n]));
  const mean = state.keys.length / state.nodes.length;
  const share = (n: number) => formatPercent(n / Math.max(1, state.keys.length));
  const summary = `${state.nodes.length} nodes × ${state.vnodes} virtual nodes, ${state.keys.length} keys. Loads: ${state.nodes.map((n) => `${n} ${state.load[n]}`).join(", ")}. ${state.movedKeys.length} keys moved in the last step.`;

  return (
    <>
      <PlayerControls player={player} describe={describeRingAction} summary={summary} />
      <Inject state={state} onAction={player.inject} />
      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,340px)_1fr]">
        <Ring state={state} summary={summary} stepKey={player.cursor} />
        <div className="grid gap-5">
          <div>
            <p className="mb-2 text-sm font-medium">Keys per node</p>
            <ul className="grid gap-2" aria-label="Load histogram">
              {state.nodes.map((n) => (
                <li key={n} className="grid grid-cols-[1.75rem_1fr_3rem] items-center gap-2 text-sm">
                  <span className="grid size-6 place-items-center rounded-full border-2 bg-surface text-xs font-bold text-fg" style={{ borderColor: color(n) }}>
                    {n}
                  </span>
                  <span className="relative h-4 rounded-sm bg-surface-2">
                    <span className="absolute inset-y-0 left-0 rounded-sm transition-[width] duration-500 ease-out" style={{ width: `${(state.load[n] / maxLoad) * 100}%`, background: color(n) }} />
                    <span aria-hidden className="absolute -inset-y-1 border-l border-dashed border-fg" style={{ left: `${(mean / maxLoad) * 100}%` }} />
                  </span>
                  <span className="num text-right">{state.load[n]}</span>
                </li>
              ))}
            </ul>
            <p className={`${nb.note} mt-2`}>
              dashed line = an even share ({formatNumber(mean, 1)} keys); spread σ = {formatNumber(loadStandardDeviation(state), 1)} keys
            </p>
          </div>

          <div className="grid gap-2 text-sm" aria-label="Key movement" role="group">
            <p className="font-medium">{last ? `After “${describeRingAction(last)}”` : "Before any change"}</p>
            <p>
              <span aria-hidden className="mr-1">▲</span>
              <strong className={`num ${state.movedKeys.length ? nb.marker : ""}`}>{state.movedKeys.length}</strong> of {state.keys.length} keys changed owner ({share(state.movedKeys.length)})
              {flows.size > 0 && <span className="text-muted"> — {[...flows].map(([f, n]) => `${f}: ${n}`).join(", ")}</span>}
            </p>
            {modulo && (
              <div className="grid gap-1.5 rounded-md border border-dashed border-border p-3">
                <p className="text-xs uppercase tracking-wider text-muted">Compared with hash mod N ({previous!.nodes.length} → {state.nodes.length})</p>
                <Compare label="Consistent hashing" moved={state.movedKeys.length} total={state.keys.length} tone={SERIES[1]} />
                <Compare label="Modulo hashing" moved={modulo.movedCount} total={state.keys.length} tone="var(--danger)" />
              </div>
            )}
          </div>
          <Violations list={model.invariants(state)} />
        </div>
      </div>
    </>
  );
}

function Compare({ label, moved, total, tone }: { label: string; moved: number; total: number; tone: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-2">
      <span>{label}</span>
      <span className="order-3 col-span-2 h-2.5 rounded-sm bg-surface-2">
        <span className="block h-full rounded-sm transition-[width] duration-500" style={{ width: `${(moved / Math.max(1, total)) * 100}%`, background: tone }} />
      </span>
      <span className="num text-right">
        {moved} ({formatPercent(moved / Math.max(1, total), 0)})
      </span>
    </div>
  );
}

function Inject({ state, onAction }: { state: HashRingState; onAction: (a: HashRingAction) => void }) {
  const [removing, setRemoving] = useState("");
  const free = NAMES.find((n) => !state.nodes.includes(n));
  const target = state.nodes.includes(removing) ? removing : state.nodes[0];
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Your actions">
      <button type="button" className="btn min-h-9" disabled={!free} onClick={() => free && onAction({ type: "addNode", node: free })}>
        + Add node {free}
      </button>
      <span className="flex items-center gap-1">
        <select aria-label="Node to remove" className="field min-h-9" value={target} onChange={(e) => setRemoving(e.target.value)}>
          {state.nodes.map((n) => <option key={n}>{n}</option>)}
        </select>
        <button type="button" className="btn min-h-9" disabled={state.nodes.length < 2} onClick={() => onAction({ type: "removeNode", node: target })}>
          − Remove
        </button>
      </span>
      <label className="flex items-center gap-1">
        Virtual nodes
        <select className="field min-h-9" value={state.vnodes} onChange={(e) => onAction({ type: "setVnodes", count: Number(e.target.value) })}>
          {[...new Set([1, 8, 32, 128, state.vnodes])].sort((a, b) => a - b).map((n) => <option key={n}>{n}</option>)}
        </select>
      </label>
      <button
        type="button"
        className="btn min-h-9"
        disabled={state.keys.length > 9950}
        onClick={() => onAction({ type: "addKeys", keys: Array.from({ length: 50 }, (_, i) => `key-${state.keys.length + i}`) })}
      >
        + 50 keys
      </button>
    </div>
  );
}

const C = 170, R = 128;
const at = (pos: number, r: number) => {
  const a = (pos / TAU) * 2 * Math.PI - Math.PI / 2;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};
/** Clockwise arc from `from` to `to` (ring positions), wrapping through zero. */
function arc(from: number, to: number, r: number): string {
  const span = (((to - from) % TAU) + TAU) % TAU;
  const [x1, y1] = at(from, r), [x2, y2] = at(to, r);
  return `M${x1.toFixed(2)},${y1.toFixed(2)}A${r},${r} 0 ${span > TAU / 2 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
}

function Ring({ state, summary, stepKey }: { state: HashRingState; summary: string; stepKey: number }) {
  const sketch = `sk${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const moved = new Set(state.movedKeys);
  const keyPos = useMemo(() => new Map(state.keys.map((k) => [k, hash32(`key:${k}`, state.seed)])), [state.keys, state.seed]);
  const { ring } = state;
  // Each node's label sits at its virtual node 0, just outside the ring.
  const labelAt = new Map<string, number>();
  for (const p of ring) if (p.vnode === 0) labelAt.set(p.node, p.position);

  return (
    <svg viewBox="0 0 340 340" className="paper-grid w-full max-w-[340px]" role="img" aria-label={`Hash ring diagram. ${summary}`}>
      <SketchFilter id={sketch} />
      {/* Ownership arcs: the segment ending at a vnode belongs to that vnode's node. */}
      <g filter={`url(#${sketch})`} strokeLinecap="butt" fill="none">
        {ring.length === 1 ? (
          <circle cx={C} cy={C} r={R} stroke={color(ring[0].node)} strokeWidth={12} />
        ) : (
          ring.map((p, i) => (
            <path key={`${p.node}-${p.vnode}`} d={arc(ring[(i - 1 + ring.length) % ring.length].position, p.position, R)} stroke={color(p.node)} strokeWidth={12} opacity={0.85} />
          ))
        )}
        <circle cx={C} cy={C} r={R + 7} stroke="var(--text)" strokeWidth={1} opacity={0.5} />
        <circle cx={C} cy={C} r={R - 7} stroke="var(--text)" strokeWidth={1} opacity={0.5} />
      </g>
      {/* Virtual-node ticks, drafting style. */}
      {ring.map((p) => {
        const [x1, y1] = at(p.position, R + 7), [x2, y2] = at(p.position, R + (state.vnodes > 32 ? 11 : 15));
        return <line key={`t-${p.node}-${p.vnode}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--text)" strokeWidth={1} opacity={0.7} />;
      })}
      {[...labelAt].map(([node, pos]) => {
        const [x, y] = at(pos, R + 28);
        return (
          <g key={`l-${node}`} transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}>
            <circle r={10} fill="var(--surface)" stroke={color(node)} strokeWidth={2} />
            <text textAnchor="middle" y={4} fontSize={11} fontWeight={700} fill="var(--text)">
              {node}
            </text>
          </g>
        );
      })}
      {/* Keys, coloured by owner; keys that just changed hands are triangles with a ripple. */}
      {state.keys.map((k) => {
        const [x, y] = at(keyPos.get(k)!, R - 22);
        const fill = color(state.ownership[k]);
        if (!moved.has(k)) return <circle key={k} cx={x} cy={y} r={2.2} fill={fill} style={{ transition: "fill 500ms" }} />;
        return (
          <g key={k}>
            <circle key={stepKey} cx={x} cy={y} r={4} fill="none" stroke={fill} strokeWidth={1.5} className={nb.pulse} />
            <path d={`M${x},${y - 4.5}L${x + 4},${y + 3}L${x - 4},${y + 3}Z`} fill={fill} stroke="var(--text)" strokeWidth={0.8} />
          </g>
        );
      })}
      <text x={C} y={C - 6} textAnchor="middle" fontSize={30} fontWeight={600} fill="var(--text)" style={{ fontFamily: "var(--font-display, var(--font-sans))" }}>
        {state.keys.length}
      </text>
      <text x={C} y={C + 14} textAnchor="middle" fontSize={11} fill="var(--text-muted)" style={{ fontFamily: "var(--font-mono)" }}>
        keys · {state.nodes.length} nodes × {state.vnodes}
      </text>
      {state.movedKeys.length > 0 && (
        <text x={C} y={C + 32} textAnchor="middle" fontSize={11} fill="var(--text)" style={{ fontFamily: "var(--font-mono)" }}>
          ▲ {state.movedKeys.length} moved
        </text>
      )}
    </svg>
  );
}
