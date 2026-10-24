"use client";

import { createRaftModel, canDeliverRaft, type RaftState } from "@/models";
import { FocusedPlayer, Diagram, ModelTable } from "./FocusedPlayer";
import { ringPoint } from "./view-logic";

const model = createRaftModel();
const summary = (s: RaftState) => `Tick ${s.now}. ${Object.values(s.nodes).map(n => `${n.id}: ${n.alive ? n.role : "offline"}, term ${n.term}, commit ${n.commitIndex}/${n.log.length}`).join("; ")}. Partitions: ${s.groups.map(g => g.join(", ")).join(" | ")}. ${s.messages.length} messages in flight.`;

export function RaftPlayer({ seed = 1 }: { seed?: number }) {
  return <FocusedPlayer model={model} seed={seed} no="M3" title="Raft elections and replicated logs" summary={summary}>{player => {
    const s = player.state, nodes = Object.values(s.nodes);
    const positions = Object.fromEntries(nodes.map((n, i) => [n.id, ringPoint(i, nodes.length)]));
    return <>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn min-h-9" onClick={() => player.inject({ type: "partition", groups: [[nodes[0].id], nodes.slice(1).map(n => n.id)] })}>Isolate {nodes[0].id}</button>
        <button type="button" className="btn min-h-9" onClick={() => player.inject({ type: "heal" })}>Heal partitions</button>
      </div>
      <Diagram label={`Raft node ring. ${summary(s)} Select a message to deliver it.`} height={350}>
        <ellipse cx={300} cy={175} rx={200} ry={115} fill="none" stroke="var(--rule)" strokeDasharray="4 4" />
        {nodes.flatMap((n, i) => nodes.slice(i + 1).filter(other => !s.groups.some(g => g.includes(n.id) && g.includes(other.id))).map(other => {
          const a = positions[n.id], b = positions[other.id], x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
          return <path key={`${n.id}-${other.id}`} d={`M${x - 15},${y - 25}l30,50 M${x + 15},${y - 25}l-30,50`} stroke="var(--danger)" strokeWidth={3}><title>Partition cuts {n.id} ↔ {other.id}</title></path>;
        }))}
        {s.messages.map((m, i) => {
          const from = positions[m.from], to = positions[m.to], x = (from.x + to.x) / 2 + (i % 3 - 1) * 30, y = (from.y + to.y) / 2 + Math.floor(i / 3) * 28;
          const deliverable = canDeliverRaft(s, m);
          return <g key={m.id}>
            <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="var(--kind-queue)" strokeDasharray="3 3" />
            <foreignObject x={x - 20} y={y - 14} width={40} height={28}>
              <button type="button" className="btn min-h-6 w-full p-0 text-xs" disabled={!deliverable} aria-label={`Deliver message ${m.id}: ${m.kind} ${m.from} to ${m.to}, term ${m.term}`} onClick={() => player.inject({ type: "deliver", message: m.id })}>{m.id} →</button>
            </foreignObject>
          </g>;
        })}
        {nodes.map(n => <g key={n.id} transform={`translate(${positions[n.id].x},${positions[n.id].y})`}>
          <rect x={-65} y={-26} width={130} height={52} rx={4} fill="var(--surface)" stroke={n.role === "leader" ? "var(--accent)" : "var(--rule)"} strokeWidth={2} strokeDasharray={n.alive ? undefined : "4 3"} />
          <text textAnchor="middle" y={-4} fill="currentColor" fontSize={14}>{n.id} · {n.alive ? n.role : "offline"}</text>
          <text textAnchor="middle" y={15} fill="currentColor" fontSize={12}>term {n.term} · commit {n.commitIndex}</text>
        </g>)}
      </Diagram>
      <ModelTable caption="Per-node logs (✓ committed; ○ uncommitted)" headers={["Node / role", "Term", "Commit index", "Log: index, term, command"]} rows={nodes.map(n => [n.id + " / " + (n.alive ? n.role : "offline"), n.term, n.commitIndex, n.log.map((e, i) => `${i < n.commitIndex ? "✓" : "○"} ${i + 1}:t${e.term} ${e.value ?? "no-op"}`).join("; ") || "empty"])} />
      <ModelTable caption="In-flight messages" headers={["Message", "Route / term", "Delivery", "Drop"]} rows={s.messages.map(m => [m.id + ": " + m.kind, `${m.from} → ${m.to} / ${m.term}`, <button key="deliver" type="button" className="btn min-h-9" disabled={!canDeliverRaft(s, m)} onClick={() => player.inject({ type: "deliver", message: m.id })}>{canDeliverRaft(s, m) ? "Deliver" : "Blocked / delayed"}</button>, <button key="drop" type="button" className="btn min-h-9" onClick={() => player.inject({ type: "drop", message: m.id })}>Drop {m.id}</button>])} />
    </>;
  }}</FocusedPlayer>;
}
