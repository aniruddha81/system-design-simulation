"use client";

import { useState } from "react";
import { causalRelation, createClocksModel, type ClocksState } from "@/models";
import { FocusedPlayer, Diagram, ModelTable } from "./FocusedPlayer";

const model = createClocksModel();
const summary = (s: ClocksState) => `${s.clock} clock, physical elapsed ${s.now} ms. ${s.events.length} events, ${s.messages.length} messages waiting. ${s.nodes.map(n => `${n.id}: Lamport ${n.lamport}, vector [${n.vector}], HLC ${n.hlc.wall}:${n.hlc.logical}`).join("; ")}.`;

export function ClocksPlayer({ seed = 1 }: { seed?: number }) {
  return <FocusedPlayer model={model} seed={seed} no="M4" title="Clocks and happens-before" summary={summary}>{p => <ClockDiagram state={p.state} />}</FocusedPlayer>;
}

function ClockDiagram({ state: s }: { state: ClocksState }) {
  const [selected, setSelected] = useState("");
  const focus = s.events.some(e => e.id === selected) ? selected : s.events.at(-1)?.id;
  const x = (id: string) => 100 + s.nodes.findIndex(n => n.id === id) * 180;
  const y = (id: string) => 65 + s.events.findIndex(e => e.id === id) * 65;
  const height = Math.max(220, 100 + s.events.length * 65);
  return <>
    <label className="text-sm">Highlight causal predecessors of
      <select className="field ml-2" value={focus ?? ""} disabled={!s.events.length} onChange={e => setSelected(e.target.value)}>
        {!s.events.length && <option value="">Create an event first</option>}
        {s.events.map(e => <option key={e.id}>{e.id}</option>)}
      </select>
    </label>
    <p className="text-sm text-muted">Time flows down in event order. Solid highlighted edges happen before the selected event; dashed edges are messages. Stamps show L / vector / HLC.</p>
    <Diagram label={`Space-time message diagram. Selected ${focus ?? "none"}. ${summary(s)}`} height={height}>
      {s.nodes.map(n => <g key={n.id}><text x={x(n.id)} y={24} textAnchor="middle" fill="currentColor">{n.id}</text><line x1={x(n.id)} x2={x(n.id)} y1={36} y2={height - 15} stroke="var(--rule)" /></g>)}
      {s.events.flatMap(e => e.parents.map(parent => {
        const a = s.events.find(a => a.id === parent)!;
        const highlighted = focus && (e.id === focus || causalRelation(s, e.id, focus) === "before");
        return <line key={`${parent}-${e.id}`} x1={x(a.node)} y1={y(parent)} x2={x(e.node)} y2={y(e.id)} stroke={highlighted ? "var(--accent)" : "var(--rule)"} strokeWidth={highlighted ? 3 : 1} strokeDasharray={a.node !== e.node ? "5 3" : undefined} />;
      }))}
      {s.events.map(e => <g key={e.id}>
        <circle cx={x(e.node)} cy={y(e.id)} r={6} fill={e.id === focus ? "var(--accent)" : "var(--kind-service)"} />
        <text x={x(e.node) + 10} y={y(e.id) - 10} fill="currentColor" fontSize={12}>{e.id} {e.kind}</text>
        <text x={x(e.node) + 10} y={y(e.id) + 10} fill="currentColor" fontSize={11}>{e.lamport} / [{e.vector.join(",")}]</text>
        <text x={x(e.node) + 10} y={y(e.id) + 25} fill="currentColor" fontSize={11}>HLC {e.hlc.wall}:{e.hlc.logical}</text>
      </g>)}
    </Diagram>
    <ModelTable caption="Event stamps and causal relation (text alternative)" headers={["Event", "Node / kind", "Physical / Lamport", "Vector / HLC", `Relation to ${focus ?? "selection"}`]} rows={s.events.map(e => [e.id, `${e.node} / ${e.kind}`, `${e.physical} / ${e.lamport}`, `[${e.vector}] / ${e.hlc.wall}:${e.hlc.logical}`, focus ? causalRelation(s, e.id, focus) : "—"])} />
  </>;
}
