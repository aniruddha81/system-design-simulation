"use client";
// Send one request (§8A.3): waterfall of spans + data operations, in a trace session.
import { useState } from "react";
import type { Design, Span, TraceInput, TraceResult } from "@/engine/types";
import { runTask } from "@/lib/run-manager";
import { inputCls } from "./Inspector";
import { fmtMs } from "./units";

const SPAN_STYLE: Record<Span["kind"], { color: string; label: string }> = {
  network: { color: "var(--text-muted)", label: "network" },
  queue: { color: "var(--warning)", label: "queue wait" },
  service: { color: "var(--accent)", label: "service" },
  retryBackoff: { color: "var(--accent-2)", label: "retry backoff" },
  timeout: { color: "var(--danger)", label: "timeout" },
};
const SEED = 1;

export function TracePanel({ design, issues }: { design: Design; issues: number }) {
  const [endpointId, setEndpointId] = useState(design.endpoints[0]?.id ?? "");
  const ep = design.endpoints.find((e) => e.id === endpointId) ?? design.endpoints[0];
  const [key, setKey] = useState("");
  const [session, setSession] = useState<TraceInput[]>([]);
  const [trace, setTrace] = useState<TraceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => design.nodes.find((n) => n.id === id)?.label ?? id;
  const exampleKey = ep ? ep.keyTemplate.replace(/\{[^}]+\}/g, "42") : "";

  async function send() {
    if (!ep) return;
    const input = { endpointId: ep.id, key: key.trim() || exampleKey };
    setBusy(true);
    setError(null);
    try {
      const r = await runTask<TraceResult>({ type: "trace", design, endpointId: input.endpointId, key: input.key, seed: SEED, priorInputs: session }).promise;
      setTrace(r);
      setSession([...session, input]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const total = Math.max(1, trace?.totalUs ?? 1);
  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="flex flex-col gap-1 text-xs text-(--text-muted)">
          Endpoint
          <select className={inputCls} value={ep?.id ?? ""} onChange={(e) => setEndpointId(e.target.value)}>
            {design.endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-(--text-muted)">
          Key
          <input className={`${inputCls} font-mono`} value={key} placeholder={exampleKey} onChange={(e) => setKey(e.target.value)} />
        </label>
        <div className="flex items-center gap-2">
          <button
            disabled={busy || issues > 0 || !ep}
            className="h-8 rounded-(--radius-sm) bg-(--accent) px-3 text-sm font-medium text-(--bg) hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent) disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send one request"}
          </button>
          <button type="button" disabled={!session.length} onClick={() => { setSession([]); setTrace(null); }} className="h-8 rounded-(--radius-sm) border border-(--border) px-3 text-sm hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:opacity-50">
            Reset session
          </button>
        </div>
        <p className="text-xs text-(--text-muted)">
          {issues > 0 ? "Fix validation issues first. " : ""}Session: {session.length} earlier request{session.length === 1 ? "" : "s"} (seed {SEED}). Each trace starts from the seeded data plus these, so it replays exactly.
        </p>
      </form>
      {error && <p className="text-sm text-(--danger)">✕ {error}</p>}
      {trace && (
        <>
          <p className="text-sm">
            Status <strong className={trace.status < 300 ? "text-(--success)" : "text-(--danger)"}>{trace.status}</strong> in <strong>{fmtMs(trace.totalUs)}</strong>
          </p>
          <ol aria-label="Waterfall" className="flex flex-col gap-1">
            {trace.spans.map((s, i) => (
              <li key={i} className="grid grid-cols-[7rem_1fr] items-center gap-2 text-xs">
                <span className="truncate text-(--text-muted)" title={name(s.nodeId)}>{name(s.nodeId)}</span>
                <span className="relative h-5 rounded-sm bg-(--bg)">
                  <span
                    className="absolute inset-y-0.5 rounded-sm"
                    style={{ left: `${(s.startUs / total) * 100}%`, width: `max(2px, ${((s.endUs - s.startUs) / total) * 100}%)`, background: SPAN_STYLE[s.kind].color }}
                  />
                  <span className="sr-only">{SPAN_STYLE[s.kind].label} from {fmtMs(s.startUs)} to {fmtMs(s.endUs)}{s.note ? `: ${s.note}` : ""}</span>
                </span>
                <span className="col-start-2 -mt-0.5 text-[11px] text-(--text-muted)" aria-hidden="true">
                  {SPAN_STYLE[s.kind].label} · {fmtMs(s.endUs - s.startUs)}{s.note ? ` · ${s.note}` : ""}
                </span>
              </li>
            ))}
          </ol>
          <p className="flex flex-wrap gap-3 text-[11px] text-(--text-muted)">
            {Object.values(SPAN_STYLE).map((k) => <span key={k.label} className="flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: k.color }} />{k.label}</span>)}
          </p>
          <section>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-(--text-muted)">Data operations</h3>
            {trace.dataOps.length ? (
              <ol className="list-decimal pl-5 font-mono text-xs leading-6">{trace.dataOps.map((d, i) => <li key={i}>{d}</li>)}</ol>
            ) : <p className="text-xs text-(--text-muted)">No reads or writes.</p>}
          </section>
        </>
      )}
    </div>
  );
}
