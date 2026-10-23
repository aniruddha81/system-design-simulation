"use client";
// Equivalent list editor (PLAN §8, §13): same store as the whiteboard, works for every input method.
import { useState } from "react";
import type { ComponentKind } from "@/engine/types";
import { useRun } from "@/lib/run-manager";
import { addNode, connect, updateNode } from "./design-ops";
import { useDesign, useDesignApi } from "./design-store";
import { KIND_COLOR, KIND_LABEL, KINDS, KindIcon } from "./kinds";
import { fmtPct } from "./units";
import type { DeleteRequest } from "./Whiteboard";

const field = "h-8 rounded-(--radius-sm) border border-(--border) bg-(--bg) px-2 text-sm text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent)";
const btn = "h-8 rounded-(--radius-sm) border border-(--border) px-3 text-sm text-(--text) hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:opacity-50";

export function ListEditor({ runKey, allowedKinds, notify, openInspector, requestDelete }: {
  runKey: string;
  allowedKinds?: ComponentKind[];
  notify: (msg: string) => void;
  openInspector: () => void;
  requestDelete: (r: DeleteRequest) => void;
}) {
  const design = useDesign((s) => s.design);
  const selection = useDesign((s) => s.selection);
  const api = useDesignApi();
  const { commit, select } = api.getState();
  const run = useRun(runKey);
  const kinds = KINDS.filter((k) => !allowedKinds || allowedKinds.includes(k));
  const [kind, setKind] = useState<ComponentKind>(kinds[0] ?? "service");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const name = (id: string) => design.nodes.find((n) => n.id === id)?.label ?? id;
  const util = (id: string) =>
    run.status === "running" || run.status === "paused" ? run.snapshot?.nodeUtil[id] : run.result?.nodes.find((n) => n.nodeId === id)?.utilisation;

  return (
    <div className="h-full overflow-auto p-4">
      <p className="mb-3 text-sm text-(--text-muted)" aria-live="polite">
        {topologySummary(design)}
      </p>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Components</caption>
        <thead>
          <tr className="border-b border-(--border) text-left text-xs uppercase tracking-wider text-(--text-muted)">
            <th className="py-2 pr-3 font-medium">Name</th>
            <th className="py-2 pr-3 font-medium">Kind</th>
            <th className="py-2 pr-3 font-medium">May call</th>
            <th className="py-2 pr-3 font-medium">Busy</th>
            <th className="py-2 font-medium"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {design.nodes.map((n) => {
            const out = design.edges.filter((e) => e.from === n.id);
            const selected = selection?.kind === "node" && selection.id === n.id;
            return (
              <tr key={n.id} className={`border-b border-(--border) align-top ${selected ? "bg-(--surface-2)" : ""}`}>
                <td className="py-2 pr-3">
                  <input
                    aria-label={`Name of ${n.label}`}
                    value={n.label}
                    onFocus={() => select({ kind: "node", id: n.id })}
                    onChange={(e) => commit((d) => updateNode(d, n.id, (x) => ({ ...x, label: e.target.value })), `label:${n.id}`)}
                    onBlur={() => api.getState().endGesture()}
                    className={`${field} w-full min-w-28`}
                  />
                </td>
                <td className="py-2 pr-3">
                  <span className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap">
                    <span style={{ color: KIND_COLOR[n.kind] }}><KindIcon kind={n.kind} size={16} /></span>
                    {KIND_LABEL[n.kind]}
                  </span>
                </td>
                <td className="py-2 pr-3">
                  <ul className="flex flex-wrap gap-1">
                    {out.map((e) => (
                      <li key={e.id} className="inline-flex h-7 items-center gap-1 rounded-full border border-(--border) pl-2.5 text-xs">
                        → {name(e.to)}
                        <button
                          type="button"
                          aria-label={`Remove connection ${n.label} to ${name(e.to)}`}
                          onClick={() => requestDelete({ edgeIds: [e.id] })}
                          className="grid size-6 place-items-center rounded-full text-(--text-muted) hover:text-(--danger) focus-visible:outline-2 focus-visible:outline-(--accent)"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                    {out.length === 0 && <li className="h-7 text-xs leading-7 text-(--text-muted)">—</li>}
                  </ul>
                </td>
                <td className="py-2 pr-3 tabular-nums leading-8">{util(n.id) == null ? "—" : fmtPct(util(n.id)!, 0)}</td>
                <td className="whitespace-nowrap py-2">
                  <button type="button" className={btn} onClick={() => { select({ kind: "node", id: n.id }); openInspector(); }}>
                    Inspect<span className="sr-only"> {n.label}</span>
                  </button>{" "}
                  <button type="button" className={`${btn} hover:text-(--danger)`} onClick={() => requestDelete({ nodeIds: [n.id] })}>
                    Delete<span className="sr-only"> {n.label}</span>
                  </button>
                </td>
              </tr>
            );
          })}
          {design.nodes.length === 0 && (
            <tr><td colSpan={5} className="py-6 text-center text-(--text-muted)">No components yet. Add a client first.</td></tr>
          )}
        </tbody>
      </table>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const r = addNode(design, kind, { x: 120 + design.nodes.length * 40, y: 120 + (design.nodes.length % 4) * 120 });
            commit(() => r.design);
            select({ kind: "node", id: r.id });
            notify(`Added ${KIND_LABEL[kind]}`);
          }}
        >
          <h3 className="text-xs font-medium uppercase tracking-wider text-(--text-muted)">Add component</h3>
          <div className="flex gap-2">
            <select aria-label="Component kind" value={kind} onChange={(e) => setKind(e.target.value as ComponentKind)} className={`${field} flex-1`}>
              {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <button className={btn}>Add</button>
          </div>
        </form>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const r = connect(design, from, to);
            if (r.error) return notify(r.error);
            commit(() => r.design);
            notify(`Connected ${name(from)} → ${name(to)}`);
            setTo("");
          }}
        >
          <h3 className="text-xs font-medium uppercase tracking-wider text-(--text-muted)">Connect A → B (A may call B)</h3>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Caller (A)" value={from} onChange={(e) => setFrom(e.target.value)} className={`${field} min-w-0 flex-1`}>
              <option value="">A…</option>
              {design.nodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
            <span aria-hidden="true">→</span>
            <select aria-label="Callee (B)" value={to} onChange={(e) => setTo(e.target.value)} className={`${field} min-w-0 flex-1`}>
              <option value="">B…</option>
              {design.nodes.filter((n) => n.id !== from && n.kind !== "client").map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
            </select>
            <button className={btn} disabled={!from || !to}>Connect</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Text topology summary for screen readers (PLAN §13). */
export function topologySummary(d: { nodes: { id: string; label: string }[]; edges: { from: string; to: string }[] }): string {
  if (d.nodes.length === 0) return "Empty design.";
  const name = (id: string) => d.nodes.find((n) => n.id === id)?.label ?? id;
  const lines = d.nodes.map((n) => {
    const to = d.edges.filter((e) => e.from === n.id).map((e) => name(e.to));
    return to.length ? `${n.label} → ${to.join(", ")}` : null;
  }).filter(Boolean);
  return `${d.nodes.length} components, ${d.edges.length} connections. ${lines.join("; ")}${lines.length ? "." : ""}`;
}
