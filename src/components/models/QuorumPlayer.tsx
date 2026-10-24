"use client";

import { useMemo, useState } from "react";
import { createQuorumModel, type QuorumState } from "@/models";
import { FocusedPlayer, ModelTable } from "./FocusedPlayer";

const summary = (s: QuorumState) => `N=${s.n}, R=${s.r}, W=${s.w}, ${s.sloppy ? "sloppy" : "fixed"} quorum. ${s.hints.length} hints waiting. ${s.reads.filter(r => r.stale).length} stale reads. ${s.replicas.map(n => `${n.id} ${n.alive ? "alive" : "offline"}: ${Object.entries(n.values).map(([k, v]) => `${k}=v${v.version} ${v.value ?? "tombstone"}`).join(", ") || "empty"}`).join("; ")}.`;

export function QuorumPlayer({ seed = 1 }: { seed?: number }) {
  const [sloppy, setSloppy] = useState(true);
  const model = useMemo(() => createQuorumModel({ sloppy }), [sloppy]);
  return <>
    <label className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" checked={sloppy} onChange={e => setSloppy(e.target.checked)} />Sloppy quorum with spare replicas</label>
    <FocusedPlayer key={String(sloppy)} model={model} seed={seed} no="M7" title="Quorum overlap and hinted handoff" summary={summary}>{p => {
      const s = p.state, write = s.writes.at(-1), read = s.reads.at(-1);
      return <>
        <p className="text-sm">R and W mark the latest read and write sets. A dashed replica is offline; spare replicas hold hints for home replicas.</p>
        <div className="grid gap-3 sm:grid-cols-3" aria-label="Replicas and quorum sets">
          {s.replicas.map((n, i) => <div key={n.id} className="rounded-sm border-2 p-3" style={{ borderStyle: n.alive ? "solid" : "dashed", borderColor: read?.replicas.includes(n.id) || write?.replicas.includes(n.id) ? "var(--accent-2)" : "var(--border)" }}>
            <p className="font-medium">{n.id} · {i < s.n ? "home" : "spare"} · {n.alive ? "alive" : "offline"}</p>
            <p className="num text-sm">{read?.replicas.includes(n.id) ? "[R] " : ""}{write?.replicas.includes(n.id) ? "[W]" : ""}</p>
            <ul className="text-sm">{Object.entries(n.values).map(([k, v]) => <li key={k}>{k}: v{v.version} = {v.value ?? "† tombstone"}</li>)}</ul>
            {!Object.keys(n.values).length && <p className="text-sm text-muted">No versions</p>}
          </div>)}
        </div>
        <ModelTable caption="Hinted handoff path" headers={["Holder → home", "Key", "Version / value"]} rows={s.hints.map(h => [`${h.holder} → ${h.target}`, h.key, `v${h.entry.version} / ${h.entry.value ?? "tombstone"}`])} />
        <ModelTable caption="Write acknowledgements" headers={["Key", "Version", "W set", "Acknowledged"]} rows={s.writes.map(w => [w.key, w.entry.version, w.replicas.join(", "), w.acknowledged ? "yes" : "no"])} />
        <ModelTable caption="Read results" headers={["Key", "R set", "Returned", "Expected", "Status"]} rows={s.reads.map(r => [r.key, r.replicas.join(", "), r.result ? `v${r.result.version}: ${r.result.value ?? "tombstone"}` : "absent", r.expected ? `v${r.expected.version}` : "absent", r.stale ? "✕ stale" : "✓ current"])} />
      </>;
    }}</FocusedPlayer>
  </>;
}
