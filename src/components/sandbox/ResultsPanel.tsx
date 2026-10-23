"use client";
import { useEffect, useRef, useState } from "react";
import type { Design, NodeStats, RunMetrics, SeriesPoint } from "@/engine/types";
import { openStore, type RunRecord } from "@/lib/persistence";
import { useRun } from "@/lib/run-manager";
import { elementName } from "./design-ops";
import { fmtMoney, fmtMs, fmtNum, fmtPct } from "./units";

function hitRate(nodes: NodeStats[]): number | null {
  let hits = 0, total = 0;
  for (const n of nodes) if (n.cache) { hits += n.cache.hits; total += n.cache.hits + n.cache.misses; }
  return total ? hits / total : null;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-(--radius-sm) border border-(--border) bg-(--bg) p-2.5">
      <p className="text-[11px] uppercase tracking-wider text-(--text-muted)">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-(--text)">{value}</p>
      {sub && <p className="text-[11px] text-(--text-muted)">{sub}</p>}
    </div>
  );
}

export function summarize(m: RunMetrics): string {
  return `Goodput ${fmtPct(m.goodput)}, success p99 ${fmtMs(m.successLatency.p99)}, ${fmtNum(m.throughput.completedPerSec)} completed per second, ${fmtNum(m.failed)} failed.`;
}

/** Tiny line chart: ≤2 series, 2px lines, crosshair + tooltip, data-table toggle (dataviz rules). */
function LineChart({ title, points, series, format }: {
  title: string;
  points: SeriesPoint[];
  series: { name: string; color: string; get: (p: SeriesPoint) => number | null }[];
  format: (v: number) => string;
}) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const W = 320, H = 120, PAD = 4;
  const max = Math.max(1e-9, ...points.flatMap((p) => series.map((s) => s.get(p) ?? 0)));
  const x = (i: number) => PAD + (i / Math.max(1, points.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  const path = (get: (p: SeriesPoint) => number | null) =>
    points.map((p, i) => { const v = get(p); return v == null ? "" : `${i && get(points[i - 1]) != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; }).join("");
  const t = (p: SeriesPoint) => `${(p.tUs / 1e6).toFixed(0)} s`;
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="flex items-center gap-3 text-xs">
        <span className="font-medium text-(--text)">{title}</span>
        {series.length > 1 && series.map((s) => (
          <span key={s.name} className="flex items-center gap-1 text-(--text-muted)"><span className="h-0.5 w-3 rounded" style={{ background: s.color }} />{s.name}</span>
        ))}
        <button type="button" onClick={() => setTable(!table)} aria-pressed={table} className="ml-auto whitespace-nowrap rounded-(--radius-sm) px-1.5 py-0.5 text-(--text-muted) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-(--accent)">
          {table ? "Show chart" : "Show table"}
        </button>
      </figcaption>
      {table ? (
        <div className="max-h-48 overflow-auto rounded-(--radius-sm) border border-(--border)">
          <table className="w-full text-xs tabular-nums">
            <thead className="sticky top-0 bg-(--surface)"><tr><th className="p-1.5 text-left font-medium">Time</th>{series.map((s) => <th key={s.name} className="p-1.5 text-right font-medium">{s.name}</th>)}</tr></thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.tUs} className="border-t border-(--border)">
                  <td className="p-1.5">{t(p)}</td>
                  {series.map((s) => { const v = s.get(p); return <td key={s.name} className="p-1.5 text-right">{v == null ? "—" : format(v)}</td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-28 w-full touch-none overflow-visible"
            preserveAspectRatio="none"
            role="img"
            aria-label={`${title}. Peak ${format(max)}. Use “Show table” for values.`}
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setHover(Math.round(((e.clientX - r.left) / r.width) * (points.length - 1)));
            }}
            onPointerLeave={() => setHover(null)}
          >
            <line x1={0} x2={W} y1={H - PAD} y2={H - PAD} style={{ stroke: "var(--border)" }} vectorEffect="non-scaling-stroke" />
            {series.map((s) => <path key={s.name} d={path(s.get)} fill="none" style={{ stroke: s.color }} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />)}
            {hover != null && points[hover] && <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} style={{ stroke: "var(--text-muted)" }} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
          </svg>
          <span className="absolute right-0 top-0 text-[10px] tabular-nums text-(--text-muted)">{format(max)}</span>
          {hover != null && points[hover] && (
            <div className="pointer-events-none absolute top-1 rounded-(--radius-sm) border border-(--border) bg-(--surface) px-2 py-1 text-[11px] tabular-nums shadow" style={{ left: `min(${(hover / Math.max(1, points.length - 1)) * 100}%, calc(100% - 8rem))` }}>
              <p className="text-(--text-muted)">{t(points[hover])}</p>
              {series.map((s) => { const v = s.get(points[hover]); return <p key={s.name}>{s.name}: {v == null ? "—" : format(v)}</p>; })}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

function RunHistory({ designId, rev }: { designId: string; rev: number }) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  useEffect(() => {
    let alive = true;
    openStore().then((s) => s.runs.listForDesign(designId, 10)).then((r) => alive && setRuns(r)).catch(() => alive && setRuns([]));
    return () => { alive = false; };
  }, [designId, rev]);
  if (!runs?.length) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-(--text-muted)">Run history (last {runs.length})</h3>
      <table className="w-full text-xs tabular-nums">
        <thead><tr className="text-left text-(--text-muted)"><th className="py-1 font-medium">When</th><th className="py-1 font-medium">Goodput</th><th className="py-1 font-medium">p99</th><th className="py-1 font-medium">Seed · design</th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-t border-(--border)">
              <td className="py-1">{new Date(r.createdAt).toLocaleTimeString()}</td>
              <td className="py-1">{fmtPct(r.summary.metrics.goodput)}{r.summary.outcome === "inconclusive" ? " (inconclusive)" : ""}</td>
              <td className="py-1">{fmtMs(r.summary.metrics.successLatency.p99)}</td>
              <td className="py-1 font-mono text-(--text-muted)" title={JSON.stringify(r.runKey)}>{r.runKey.seed} · {r.runKey.designHash.slice(0, 7)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ResultsPanel({ runKey, design }: { runKey: string; design: Design }) {
  const run = useRun(runKey);
  const result = run.result;
  const metrics = result?.metrics ?? run.snapshot?.metrics;
  const name = (id: string) => elementName(design, id);

  // aria-live run summary, throttled to at most one announcement per 5 s (PLAN §13).
  const [announce, setAnnounce] = useState("");
  const lastSaid = useRef(0);
  useEffect(() => {
    if (!metrics) return;
    const now = Date.now();
    const final = !!result;
    if (!final && now - lastSaid.current < 5000) return;
    lastSaid.current = now;
    setAnnounce(`${final ? "Run finished. " : ""}${summarize(metrics)}`);
  }, [metrics, result]);

  if (!metrics) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-(--text-muted)">Run the simulation to see goodput, latency and where it saturates.</p>
        <RunHistory designId={runKey} rev={run.historyRev} />
      </div>
    );
  }
  const nodes = result?.nodes ?? [];
  const hr = hitRate(nodes);
  const bn = result?.bottleneck;
  return (
    <div className="flex flex-col gap-5">
      <p className="sr-only" aria-live="polite">{announce}</p>
      {run.status === "stale" && <p className="rounded-(--radius-sm) border border-(--warning) p-2 text-xs text-(--warning)">⚠ Stale: the design changed after this run.</p>}
      {result?.outcome === "inconclusive" && <p className="rounded-(--radius-sm) border border-(--warning) p-2 text-xs text-(--warning)">⚠ Inconclusive: {result.inconclusiveReason}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Goodput" value={fmtPct(metrics.goodput, 2)} sub={`${fmtNum(metrics.succeeded)} ok · ${fmtNum(metrics.failed)} failed`} />
        <Tile label="Success p50 / p99" value={metrics.successLatency.p99 == null ? "—" : fmtMs(metrics.successLatency.p99)} sub={`p50 ${fmtMs(metrics.successLatency.p50)}`} />
        <Tile label="Throughput" value={`${fmtNum(metrics.throughput.completedPerSec)}/s`} sub={`offered ${fmtNum(metrics.throughput.offeredPerSec)}/s`} />
        <Tile label="Cache hit rate" value={result ? fmtPct(hr) : "…"} sub={`cost ${fmtMoney(metrics.costPerMonth)}/mo`} />
      </div>
      {metrics.successLatency.p99 == null && <p className="text-xs text-(--text-muted)">p99: insufficient data (too few successful requests to estimate).</p>}

      {bn && (
        <section className="rounded-(--radius-sm) border border-(--accent) bg-[color-mix(in_oklab,var(--accent)_8%,transparent)] p-3 text-sm">
          <h3 className="mb-1 font-medium">◎ Bottleneck: {name(bn.nodeId)}</h3>
          <p className="text-xs text-(--text-muted)">
            {fmtPct(bn.utilisation, 0)} busy · queue growth {fmtNum(bn.queueGrowth)}/s
            {bn.retryAmplification != null && ` · retry amplification ${bn.retryAmplification.toFixed(2)}×`}
          </p>
        </section>
      )}

      {result && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-(--text-muted)">Invariants</h3>
          {result.violations.length === 0 ? (
            <p className="text-sm text-(--success)">✓ No invariant violations.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {result.violations.map((v, i) => (
                <li key={i} className="text-(--danger)">✕ {v.kind} at {fmtMs(v.timeUs)}: <span className="text-(--text)">{v.detail}</span></li>
              ))}
            </ul>
          )}
        </section>
      )}

      {result && result.series.length > 1 && (
        <>
          <LineChart
            title="Requests per second"
            points={result.series}
            format={(v) => fmtNum(v)}
            series={[
              { name: "Succeeded", color: "var(--accent)", get: (p) => p.succeededPerSec },
              { name: "Failed", color: "var(--danger)", get: (p) => p.failedPerSec },
            ]}
          />
          <LineChart title="p99 latency" points={result.series} format={(v) => fmtMs(v)} series={[{ name: "p99", color: "var(--accent-2)", get: (p) => p.p99Us }]} />
        </>
      )}

      {nodes.length > 0 && (
        <section className="overflow-x-auto">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-(--text-muted)">Per component</h3>
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="text-left text-(--text-muted)">
                <th className="py-1 pr-2 font-medium">Component</th><th className="py-1 pr-2 text-right font-medium">Busy</th>
                <th className="py-1 pr-2 text-right font-medium">Avg queue</th><th className="py-1 pr-2 text-right font-medium">Drops</th>
                <th className="py-1 pr-2 text-right font-medium">Errors</th><th className="py-1 pr-2 text-right font-medium">p99</th>
                <th className="py-1 text-right font-medium">Hit rate</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n) => (
                <tr key={n.nodeId} className={`border-t border-(--border) ${bn?.nodeId === n.nodeId ? "text-(--accent)" : ""}`}>
                  <td className="py-1 pr-2">{name(n.nodeId)}</td>
                  <td className="py-1 pr-2 text-right">{fmtPct(n.utilisation, 0)}</td>
                  <td className="py-1 pr-2 text-right">{n.avgQueue.toFixed(1)}</td>
                  <td className="py-1 pr-2 text-right">{fmtNum(n.drops)}</td>
                  <td className="py-1 pr-2 text-right">{fmtNum(n.errors)}</td>
                  <td className="py-1 pr-2 text-right">{n.latency.p99 == null ? "—" : fmtMs(n.latency.p99)}</td>
                  <td className="py-1 text-right">{n.cache ? fmtPct(n.cache.hitRate) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <RunHistory designId={runKey} rev={run.historyRev} />
    </div>
  );
}
