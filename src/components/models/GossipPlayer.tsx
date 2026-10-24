"use client";

import { createGossipModel, type GossipState } from "@/models";
import { FocusedPlayer, Diagram, ModelTable } from "./FocusedPlayer";
import { scale } from "./view-logic";

const model = createGossipModel();
const summary = (s: GossipState) => `Round ${s.round}, ${s.mode}, fanout ${s.fanout}: ${s.curve.at(-1)} of ${s.nodes.length} infected. At ${s.now} ms phi=${s.detector.phi.toFixed(2)}, threshold ${s.detector.threshold}; N0 ${s.detector.targetAlive ? "alive" : "crashed"}, ${s.detector.suspected ? "suspected" : "not suspected"}; ${s.detector.falsePositives} false positives.`;

export function GossipPlayer({ seed = 1 }: { seed?: number }) {
  return <FocusedPlayer model={model} seed={seed} no="M6" title="Rumor spread and failure suspicion" summary={summary}>{p => {
    const s = p.state, d = s.detector, history = d.history;
    const rounds = p.states.slice(0, p.cursor + 1).filter((state, i, states) => i === 0 || state.round !== states[i - 1].round);
    const xmax = Math.max(100, s.now), ymax = Math.max(4, d.threshold, ...history.map(h => h.phi));
    const x = (at: number) => scale(at, 0, xmax, 55, 565), y = (phi: number) => scale(phi, 0, ymax, 200, 35);
    return <>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-8" aria-label={`Infection grid at round ${s.round}`}>
        {s.nodes.map(n => <div key={n.id} className="rounded-sm border border-border p-2 text-center text-xs" style={{ background: n.infected ? "var(--surface-2)" : "var(--surface)", borderColor: n.infected ? "var(--kind-service)" : "var(--border)" }}>{n.id}<br />{n.alive ? n.infected ? "✓ knows" : "○ unaware" : "✕ offline"}</div>)}
      </div>
      <ModelTable caption="Infection over rounds" headers={["Round", "Infected / total", "Node IDs knowing the rumor"]} rows={rounds.map(r => [r.round, `${r.curve.at(-1)} / ${r.nodes.length}`, r.nodes.filter(n => n.infected).map(n => n.id).join(", ")])} />
      <Diagram label={`Phi-accrual suspicion chart. ${summary(s)}`} height={250}>
        <line x1={55} x2={565} y1={200} y2={200} stroke="var(--rule)" />
        <line x1={55} x2={565} y1={y(d.threshold)} y2={y(d.threshold)} stroke="var(--danger)" strokeDasharray="5 4" />
        <text x={55} y={y(d.threshold) - 7} fill="currentColor" fontSize={12}>threshold {d.threshold}</text>
        <polyline points={history.map(h => `${x(h.at)},${y(h.phi)}`).join(" ")} fill="none" stroke="var(--accent-2)" strokeWidth={2} />
        {history.map((h, i) => <circle key={i} cx={x(h.at)} cy={y(h.phi)} r={3} fill="var(--accent-2)" />)}
        <text x={12} y={25} fill="currentColor" fontSize={12}>φ {ymax.toFixed(1)}</text>
        <text x={55} y={225} fill="currentColor" fontSize={12}>0 ms</text><text x={490} y={225} fill="currentColor" fontSize={12}>{xmax} ms</text>
      </Diagram>
      <ModelTable caption="Phi observations (text alternative)" headers={["Time (ms)", "Phi", "Suspected", "Target alive"]} rows={history.map(h => [h.at, h.phi.toFixed(3), h.suspected ? "yes" : "no", h.targetAlive ? "yes" : "no"])} />
    </>;
  }}</FocusedPlayer>;
}
