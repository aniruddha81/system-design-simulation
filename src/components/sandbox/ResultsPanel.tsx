"use client";
import { useEffect, useRef, useState } from "react";
import type { Design, InvariantKind, NodeStats, RunMetrics, SeriesPoint, Violation } from "@/engine/types";
import { openStore, type RunRecord } from "@/lib/persistence";
import { useRun } from "@/lib/run-manager";
import { Stats, Bars } from "@/components/visual/kit";
import { EmptyPlot } from "./visuals";
import { elementName } from "./design-ops";
import { fmtMoney, fmtMs, fmtNum, fmtPct } from "./units";

function hitRate(nodes: NodeStats[]): number | null {
  let hits = 0, total = 0;
  for (const n of nodes) if (n.cache) { hits += n.cache.hits; total += n.cache.hits + n.cache.misses; }
  return total ? hits / total : null;
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
        <button type="button" onClick={() => setTable(!table)} aria-pressed={table} className="ml-auto min-h-6 whitespace-nowrap rounded-(--radius-sm) px-1.5 py-0.5 text-(--text-muted) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-(--accent)">
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

const INVARIANT: Record<InvariantKind, { title: string; means: string }> = {
  ackedWriteLost: { title: "Acknowledged write lost", means: "A write was confirmed to the client, then disappeared (unshipped async replication at failover, or a non-durable WAL)." },
  duplicateEffect: { title: "Duplicate effect", means: "A retried non-idempotent write was applied twice. An idempotency key with a dedup store prevents it." },
  staleRead: { title: "Stale read", means: "A read returned an older version than one already acknowledged (replica lag, cache, or index lag)." },
  oversell: { title: "Oversell", means: "More units were sold than existed. Use decrementIfPositive or a conditional write on one store." },
  uniquenessViolated: { title: "Uniqueness violated", means: "Two records share a value that a unique index should forbid." },
  splitBrainWrite: { title: "Split-brain write", means: "Two leaders accepted writes at once. Enable fencing on failover." },
  orderingViolated: { title: "Ordering violated", means: "Messages for one key were processed out of order. Publish ordered by key." },
};

function Invariants({ violations }: { violations: Violation[] }) {
  if (violations.length === 0) return <p className="text-sm text-(--success)">✓ No invariant violations.</p>;
  const kinds = [...new Set(violations.map((v) => v.kind))];
  return (
    <ul className="flex flex-col gap-2">
      {kinds.map((k) => {
        const list = violations.filter((v) => v.kind === k);
        return (
          <li key={k} className="rounded-(--radius-sm) border border-(--danger) p-2.5 text-sm">
            <p className="font-medium text-(--danger)">✕ {INVARIANT[k]?.title ?? k} <span className="font-normal text-(--text-muted)">× {list.length}</span></p>
            <p className="mt-0.5 text-xs text-(--text-muted)">{INVARIANT[k]?.means}</p>
            <ol className="mt-1.5 flex flex-col gap-1 text-xs">
              {list.slice(0, 5).map((v, i) => (
                <li key={i}>
                  <span className="tabular-nums">t = {fmtMs(v.timeUs)}</span>: {v.detail}
                  {v.requestIds.length > 0 && <span className="block font-mono text-[11px] text-(--text-muted)">requests {v.requestIds.slice(0, 6).join(", ")}{v.requestIds.length > 6 ? ` +${v.requestIds.length - 6}` : ""}</span>}
                </li>
              ))}
              {list.length > 5 && <li className="text-(--text-muted)">…and {list.length - 5} more</li>}
            </ol>
          </li>
        );
      })}
    </ul>
  );
}

/** P2 per-kind stats: replication lag, queue depth / DLQ, breaker opens, autoscaling, failovers. */
function ComponentDetails({ nodes, name }: { nodes: NodeStats[]; name: (id: string) => string }) {
  const rows = nodes.flatMap((n) => {
    const out: string[] = [];
    if (n.replicationLagUs) out.push(`replication lag mean ${fmtMs(n.replicationLagUs.mean)}, max ${fmtMs(n.replicationLagUs.max)}`);
    if (n.queue) out.push(`queue depth max ${fmtNum(n.queue.depthMax)}, ${fmtNum(n.queue.redelivered)} redelivered, ${fmtNum(n.queue.deadLettered)} dead-lettered, consumer lag max ${fmtMs(n.queue.consumerLagMax)}`);
    if (n.breaker) out.push(`breaker opened ${fmtNum(n.breaker.opens)}×, ${fmtNum(n.breaker.shortCircuited)} calls failed fast`);
    if (n.autoscale) out.push(`scaled ${n.autoscale.minConcurrency}–${n.autoscale.maxConcurrency} workers in ${fmtNum(n.autoscale.scaleEvents)} steps`);
    if (n.failovers) out.push(`${fmtNum(n.failovers)} failover${n.failovers === 1 ? "" : "s"}`);
    if (n.wastedWork) out.push(`${fmtNum(n.wastedWork)} requests of wasted work (caller had timed out)`);
    if (n.meanQueueWaitUs != null) out.push(`mean queue wait ${fmtMs(n.meanQueueWaitUs)}`);
    if (n.inFlight != null) out.push(`${fmtNum(n.inFlight)} in flight`);
    if (n.dropsOnEdit != null) out.push(`${fmtNum(n.dropsOnEdit)} dropped by live edits`);
    return out.length ? [{ id: n.nodeId, out }] : [];
  });
  if (!rows.length) return null;
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-(--text-muted)">Component details</h3>
      <ul className="flex flex-col gap-1.5 text-xs">
        {rows.map((r) => <li key={r.id}><span className="font-medium text-(--text)">{name(r.id)}</span>: {r.out.join("; ")}.</li>)}
      </ul>
    </section>
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
        <EmptyPlot caption="Run to reveal throughput, latency and bottlenecks." />
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
      {run.status === "stale" && <p role="status" className="rounded-(--radius-sm) border border-(--warning) p-2 text-xs text-(--warning)">⚠ Stale: design changed. These results are from the earlier design.</p>}
      {result?.outcome === "inconclusive" && <p className="rounded-(--radius-sm) border border-(--warning) p-2 text-xs text-(--warning)">⚠ Inconclusive: {result.inconclusiveReason}</p>}
      <Stats title="Run headline" items={[
        { label: "Goodput", value: fmtPct(metrics.goodput, 2), sub: `${fmtNum(metrics.succeeded)} ok · ${fmtNum(metrics.failed)} failed` },
        { label: "Success p99", value: fmtMs(metrics.successLatency.p99), sub: `p50 ${fmtMs(metrics.successLatency.p50)}` },
        { label: "Throughput", value: `${fmtNum(metrics.throughput.completedPerSec)}/s`, sub: `offered ${fmtNum(metrics.throughput.offeredPerSec)}/s` },
        { label: "Cache hit rate", value: result ? fmtPct(hr) : "…", sub: `${fmtMoney(metrics.costPerMonth)}/mo` },
      ]} />
      {metrics.successLatency.p99 == null && <p className="text-xs text-(--text-muted)">p99: insufficient data (too few successful requests to estimate).</p>}

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
          <Invariants violations={result.violations} />
        </section>
      )}

      {metrics.costBreakdown && (
        <section>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-(--text-muted)">Cost per month · {fmtMoney(metrics.costPerMonth)}</h3>
          <dl className="grid grid-cols-4 gap-2 text-xs">
            {(["compute", "egress", "requests", "storage"] as const).map((k) => (
              <div key={k} className="rounded-(--radius-sm) bg-(--bg) p-2">
                <dt className="capitalize text-(--text-muted)">{k}</dt>
                <dd className="tabular-nums text-(--text)">{fmtMoney(metrics.costBreakdown![k])}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}


      {nodes.length > 0 && (
        <section>
          <Bars title="Component utilisation" items={nodes.map((n) => ({ label: name(n.nodeId), value: Math.round(n.utilisation * 100), unit: "%", tone: n.utilisation >= 0.9 ? "bad" : "info" }))} />
          <details className="overflow-x-auto">
          <summary className="min-h-6 cursor-pointer text-xs">Show data table · per component</summary>
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
          </details>
        </section>
      )}
      <ComponentDetails nodes={nodes} name={name} />
      <RunHistory designId={runKey} rev={run.historyRev} />
    </div>
  );
}
