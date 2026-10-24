"use client";

import { useState } from "react";
import { createCrdtModel, createOtModel, crdtView, type CrdtState, type OtState } from "@/models";
import { FocusedPlayer, ModelTable } from "./FocusedPlayer";

const crdt = createCrdtModel();
const ot = createOtModel();
const naive = createOtModel({ mode: "naive" });
const crdtSummary = (s: CrdtState) => `${s.messages.length} messages pending. ${s.replicas.map(r => { const v = crdtView(r); return `${r.id}: G=${v.g}, PN=${v.pn}, set {${v.set}}, text ${JSON.stringify(v.text)}`; }).join("; ")}.`;
const otSummary = (s: OtState) => `${s.mode} mode, server ${JSON.stringify(s.serverText)}, revision ${s.history.length}. ${s.clients.map(c => `${c.id}: ${JSON.stringify(c.text)}, revision ${c.revision}, ${c.pending ? "pending edit" : "acknowledged"}`).join("; ")}.`;

export function CrdtPlayer({ seed = 1 }: { seed?: number }) {
  const [mode, setMode] = useState("crdt");
  return <>
    <label className="flex items-center gap-2 text-sm">Replication algorithm
      <select className="field" value={mode} onChange={e => setMode(e.target.value)}><option value="crdt">CRDT counters, set and RGA</option><option value="ot">OT with transformation</option><option value="naive">OT without transformation</option></select>
    </label>
    {mode === "crdt" ? <FocusedPlayer key="crdt" model={crdt} seed={seed} no="M8" title="Replicas converge as messages arrive" summary={crdtSummary}>{p => <>
      <div className="grid gap-3 sm:grid-cols-3" aria-label="CRDT replicas side by side">
        {p.state.replicas.map(r => { const v = crdtView(r); return <section key={r.id} className="rounded-sm border border-border p-3">
          <h3 className="font-medium">Replica {r.id}</h3>
          <p className="num text-sm">G {v.g} · PN {v.pn}</p><p className="text-sm">Set: {v.set.join(", ") || "∅"}</p>
          <p className="num my-3 min-h-9 break-all border-l-2 border-accent-2 pl-2" aria-label={`RGA text at ${r.id}`}>{v.text || "(empty text)"}</p>
          <p className="text-xs text-muted">{v.elements.filter(e => e.deleted).length} text tombstones · {r.operations.length} operations</p>
          <div className="mt-3 flex flex-wrap gap-1">
            <button type="button" className="btn min-h-9" onClick={() => p.inject({ type: "increment", replica: r.id, counter: "pn", amount: -1 })}>PN −1</button>
            <button type="button" className="btn min-h-9" onClick={() => p.inject({ type: "add", replica: r.id, value: "x" })}>Add x</button>
            <button type="button" className="btn min-h-9" onClick={() => p.inject({ type: "remove", replica: r.id, value: "x" })}>Remove x</button>
            <button type="button" className="btn min-h-9" disabled={!v.text.length} onClick={() => p.inject({ type: "delete", replica: r.id, index: 0, count: 1 })}>Delete first letter</button>
          </div>
        </section>; })}
      </div>
      <ModelTable caption="Messages between replicas" headers={["ID", "Route", "Operations / delays", "Delivery"]} rows={p.state.messages.map(m => [m.id, `${m.from} → ${m.to}`, `${m.operations.length} / ${m.delays}`, <button key="deliver" type="button" className="btn min-h-9" onClick={() => p.inject({ type: "deliver", message: m.id })}>Deliver {m.id}</button>])} />
    </>}</FocusedPlayer> : <FocusedPlayer key={mode} model={mode === "ot" ? ot : naive} seed={seed} no="M8" title="Concurrent text edits through an OT server" summary={otSummary}>{p => <>
      <div className="border-l-2 border-accent-2 p-3"><p className="font-medium">Server · revision {p.state.history.length}</p><p className="num break-all">{p.state.serverText || "(empty text)"}</p></div>
      <div className="grid gap-3 sm:grid-cols-2" aria-label="OT replicas side by side">{p.state.clients.map(c => <section key={c.id} className="rounded-sm border border-border p-3">
        <h3 className="font-medium">Client {c.id}</h3><p className="num my-3 break-all">{c.text || "(empty text)"}</p><p className="text-sm">Revision {c.revision} · {c.pending ? "edit pending" : "acknowledged"}</p>
        <button type="button" className="btn mt-2 min-h-9" disabled={!!c.pending || !c.text.length} onClick={() => p.inject({ type: "edit", client: c.id, edit: { type: "delete", index: 0, count: 1 } })}>Delete first letter</button>
      </section>)}</div>
      <ModelTable caption="Pending client submissions" headers={["Client", "Base revision", "Operation"]} rows={p.state.messages.map(m => [m.client, m.revision, JSON.stringify(m.operation.components)])} />
    </>}</FocusedPlayer>}
  </>;
}
