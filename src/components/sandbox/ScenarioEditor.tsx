"use client";
// Scenario editor (§5.5, §5.6, §8A.4): workload, presets, "1B requests/day", CSV replay and the chaos timeline.
import { useId, useState } from "react";
import type { ChaosEvent, Design, Scenario, Workload } from "@/engine/types";
import { arrivalRate, parseReplayCsv, toPeakRps } from "@/engine/workload";
import { elementName, nextId, placeNames } from "./design-ops";
import { btn, Check, inputCls, KeyDistField, Row, Select, sectionTitle, smallBtn, UnitField } from "./fields";
import { CHAOS_KINDS, chaosProblems, chaosTargetType, describeArrival, newChaos, peakRps, PRESETS, type ChaosKind } from "./scenario-ops";
import { fmtNum } from "./units";

type Arrival = Workload["arrival"];
const ARRIVALS: [Arrival["kind"], string][] = [
  ["poisson", "Poisson (random, steady mean)"], ["constant", "Constant"], ["step", "Step"], ["spike", "Spike"],
  ["ramp", "Ramp"], ["diurnal", "Diurnal (daily wave)"], ["replay", "Replay a CSV curve"],
];

function makeArrival(kind: Arrival["kind"], rps: number, s: Scenario): Arrival {
  const mid = s.warmupUs + Math.round(s.measureUs / 2);
  switch (kind) {
    case "poisson": case "constant": return { kind, rps };
    case "step": return { kind, rps, stepAtUs: mid, stepRps: rps * 2 };
    case "spike": return { kind, rps, spikeAtUs: mid, spikeDurUs: 2_000_000, spikeRps: rps * 5 };
    case "ramp": return { kind, fromRps: rps / 4, toRps: rps };
    case "diurnal": return { kind, meanRps: rps, amplitude: 0.5, periodUs: s.warmupUs + s.measureUs };
    case "replay": return { kind, points: [{ atUs: 0, rps }, { atUs: s.warmupUs + s.measureUs, rps }] };
  }
}

/** "1B", "250M", "40k" or plain numbers. */
function parseCount(text: string): number | null {
  const m = /^\s*([\d.,_]+)\s*([kmb]?)\s*$/i.exec(text);
  if (!m) return null;
  const v = Number(m[1].replace(/[,_]/g, "")) * ({ "": 1, k: 1e3, m: 1e6, b: 1e9 } as Record<string, number>)[m[2].toLowerCase()];
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/** Sparkline of the arrival rate over the run (warm-up shaded), drawn with E2's arrivalRate. */
function ArrivalPreview({ s }: { s: Scenario }) {
  const total = s.warmupUs + s.measureUs + s.drainUs;
  const N = 120, W = 320, H = 56;
  const pts = Array.from({ length: N + 1 }, (_, i) => {
    const t = (i / N) * total;
    let v = 0;
    try { v = arrivalRate(s.workload.arrival, t, total); } catch {}
    return [i, v] as const;
  });
  const max = Math.max(1, ...pts.map(([, v]) => v));
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${((i / N) * W).toFixed(1)},${(H - 4 - (v / max) * (H - 8)).toFixed(1)}`).join("");
  return (
    <figure className="flex flex-col gap-1">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" preserveAspectRatio="none" role="img" aria-label={`Arrival rate over the run: ${describeArrival(s.workload.arrival)}`}>
        <rect x={0} y={0} width={(s.warmupUs / total) * W} height={H} style={{ fill: "var(--surface-2)" }} />
        <path d={d} fill="none" style={{ stroke: "var(--accent)" }} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <figcaption className="flex justify-between text-[11px] text-(--text-muted)"><span>warm-up</span><span>peak {fmtNum(max)} req/s</span><span>{(total / 1e6).toFixed(1)} s</span></figcaption>
    </figure>
  );
}

function PerDay({ onApply }: { onApply: (peakRps: number, avgRps: number) => void }) {
  const [perDay, setPerDay] = useState("1B");
  const [factor, setFactor] = useState("3");
  const n = parseCount(perDay), f = Number(factor);
  let r: { avgRps: number; peakRps: number } | null = null, err: string | null = null;
  if (n === null) err = "Enter a count such as 1B, 250M or 40k";
  else try { r = toPeakRps(n, f); } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-2 rounded-(--radius-sm) border border-(--border) p-2.5">
      <legend className="px-1 text-xs text-(--text)">Requests per day</legend>
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`${id}-n`}>Requests per day</label>
        <input id={`${id}-n`} className={`${inputCls} w-24 tabular-nums`} value={perDay} onChange={(e) => setPerDay(e.target.value)} aria-invalid={n === null} />
        <span className="text-xs text-(--text-muted)">per day, peak ×</span>
        <label className="sr-only" htmlFor={`${id}-f`}>Peak factor</label>
        <input id={`${id}-f`} className={`${inputCls} w-16 tabular-nums`} inputMode="decimal" value={factor} onChange={(e) => setFactor(e.target.value)} />
        <button type="button" className={btn} disabled={!r} onClick={() => r && onApply(r.peakRps, r.avgRps)}>Use the peak</button>
      </div>
      <p className={`text-xs ${err ? "text-(--danger)" : "text-(--text-muted)"}`} aria-live="polite">
        {err ? `⚠ ${err}` : `≈ ${fmtNum(r!.avgRps)} req/s on average, ${fmtNum(r!.peakRps)} req/s at peak. Design for the peak.`}
      </p>
    </fieldset>
  );
}

function ArrivalEditor({ s, onChange }: { s: Scenario; onChange: (a: Arrival) => void }) {
  const a = s.workload.arrival;
  const [csvError, setCsvError] = useState<string | null>(null);
  const rate = (label: string, v: number, put: (x: number) => void) => (
    <UnitField label={label} kind="rate" value={v} slider={[0, Math.max(1000, Math.ceil((v * 4) / 1000) * 1000)]} onCommit={(x) => put(x!)} />
  );
  const at = (label: string, v: number, put: (x: number) => void, hint?: string) => <UnitField label={label} kind="duration" unit="s" value={v} hint={hint} onCommit={(x) => put(x!)} />;
  return (
    <div className="flex flex-col gap-2">
      <Row label="Arrivals"><Select label="Arrival process" value={a.kind} options={ARRIVALS} onChange={(k) => onChange(makeArrival(k, peakRps(a) || 1000, s))} /></Row>
      {(a.kind === "poisson" || a.kind === "constant") && rate("Rate", a.rps, (rps) => onChange({ ...a, rps }))}
      {a.kind === "step" && <>{rate("Before", a.rps, (rps) => onChange({ ...a, rps }))}{at("Step at", a.stepAtUs, (stepAtUs) => onChange({ ...a, stepAtUs }))}{rate("After", a.stepRps, (stepRps) => onChange({ ...a, stepRps }))}</>}
      {a.kind === "spike" && <>{rate("Base", a.rps, (rps) => onChange({ ...a, rps }))}{at("Spike at", a.spikeAtUs, (spikeAtUs) => onChange({ ...a, spikeAtUs }))}{at("Lasting", a.spikeDurUs, (spikeDurUs) => onChange({ ...a, spikeDurUs }))}{rate("Spike rate", a.spikeRps, (spikeRps) => onChange({ ...a, spikeRps }))}</>}
      {a.kind === "ramp" && <>{rate("From", a.fromRps, (fromRps) => onChange({ ...a, fromRps }))}{rate("To", a.toRps, (toRps) => onChange({ ...a, toRps }))}</>}
      {a.kind === "diurnal" && (
        <>
          {rate("Mean", a.meanRps, (meanRps) => onChange({ ...a, meanRps }))}
          <UnitField label="Swing" kind="fraction" value={a.amplitude} hint="±share of the mean, 0–100%" onCommit={(amplitude) => onChange({ ...a, amplitude: amplitude! })} />
          {at("Period", a.periodUs, (periodUs) => onChange({ ...a, periodUs: Math.max(1, periodUs) }))}
        </>
      )}
      {a.kind === "replay" && (
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-1 text-xs text-(--text-muted)">
            Upload a CSV with columns <code className="font-mono text-(--text)">atUs,rps</code> (time in microseconds, linear between points, up to 10,000 rows and 1 MB)
            <input
              type="file"
              accept=".csv,text/csv"
              className="text-sm text-(--text) file:mr-2 file:h-8 file:rounded-(--radius-sm) file:border file:border-(--border) file:bg-(--surface-2) file:px-3 file:text-(--text)"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                if (f.size > 1_048_576) return setCsvError("File is larger than 1 MB");
                const r = parseReplayCsv(await f.text());
                if ("error" in r) return setCsvError(r.error);
                setCsvError(null);
                onChange({ kind: "replay", points: r.points });
              }}
            />
          </label>
          {csvError ? <p role="alert" className="text-xs text-(--danger)">⚠ {csvError} The previous curve is kept.</p> : <p className="text-xs text-(--text-muted)">{a.points.length} points loaded.</p>}
        </div>
      )}
      <ArrivalPreview s={s} />
    </div>
  );
}

function ChaosRow({ ev, design, problem, total, onChange, onRemove }: {
  ev: ChaosEvent; design: Design; problem?: string; total: number; onChange: (e: ChaosEvent) => void; onRemove: () => void;
}) {
  const type = chaosTargetType(ev.kind);
  const { zones, regions } = placeNames(design);
  const label = CHAOS_KINDS.find((c) => c.kind === ev.kind)!.label;
  const options: [string, string][] =
    type === "node" ? design.nodes.map((n) => [n.id, n.label])
      : type === "edge" ? design.edges.map((e) => [e.id, elementName(design, `edge:${e.id}`)])
        : type === "zone" ? zones.map((z) => [z, z]) : type === "region" ? regions.map((r) => [r, r]) : [];
  const end = ev.endUs ?? total;
  return (
    <li className={`flex flex-col gap-2 rounded-(--radius-sm) border p-2 ${problem ? "border-(--danger)" : "border-(--border)"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        {type !== "none" && (
          <select aria-label={`${label} target`} aria-invalid={!options.some(([v]) => v === ev.target)} className={`${inputCls} h-7 min-w-0 flex-1`} value={ev.target} onChange={(e) => onChange({ ...ev, target: e.target.value })}>
            {!options.some(([v]) => v === ev.target) && <option value={ev.target}>{ev.target || "— pick a target —"}</option>}
            {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        )}
        <button type="button" className={`${smallBtn} ml-auto hover:text-(--danger)`} onClick={onRemove} aria-label={`Remove ${label} ${ev.id}`}>✕</button>
      </div>
      {/* timeline bar */}
      <div className="relative h-2 rounded-full bg-(--surface-2)" aria-hidden="true">
        <div className="absolute inset-y-0 rounded-full" style={{ left: `${(ev.atUs / total) * 100}%`, width: `max(3px, ${((Math.min(end, total) - ev.atUs) / total) * 100}%)`, background: problem ? "var(--danger)" : "var(--warning)" }} />
      </div>
      <UnitField label="Starts at" kind="duration" unit="s" value={ev.atUs} onCommit={(atUs) => onChange({ ...ev, atUs: atUs! })} />
      <UnitField label="Ends at" kind="duration" unit="s" optional value={ev.endUs} hint="Empty = lasts to the end of the run" onCommit={(endUs) => onChange({ ...ev, endUs })} />
      {ev.kind === "degrade" && <UnitField label="Slow-down ×" kind="number" value={ev.slowFactor} onCommit={(v) => onChange({ ...ev, slowFactor: Math.max(1, v!) })} />}
      {ev.kind === "gray" && <UnitField label="Error rate" kind="fraction" value={ev.errorRate} onCommit={(v) => onChange({ ...ev, errorRate: v! })} />}
      {ev.kind === "linkLoss" && <UnitField label="Loss rate" kind="fraction" value={ev.lossRate} onCommit={(v) => onChange({ ...ev, lossRate: v! })} />}
      {ev.kind === "linkLatency" && <UnitField label="Added latency" kind="duration" value={ev.addUs} onCommit={(v) => onChange({ ...ev, addUs: v! })} />}
      {ev.kind === "clockSkew" && <UnitField label="Skew" kind="duration" value={ev.skewUs} onCommit={(v) => onChange({ ...ev, skewUs: v! })} />}
      {ev.kind === "trafficSpike" && <UnitField label="Traffic ×" kind="number" value={ev.multiplier} onCommit={(v) => onChange({ ...ev, multiplier: Math.max(0, v!) })} />}
      {ev.kind === "partition" && (
        <fieldset className="flex flex-col gap-0.5">
          <legend className="mb-1 text-xs text-(--text-muted)">Cut these directions (A → B can fail while B → A works)</legend>
          {design.edges.flatMap((e) => [[e.from, e.to], [e.to, e.from]] as const).map(([from, to]) => {
            const on = ev.links.some((l) => l.from === from && l.to === to);
            return (
              <Check key={`${from}>${to}`} label={<span className="text-xs">{elementName(design, from)} → {elementName(design, to)}</span>} checked={on}
                onChange={(v) => onChange({ ...ev, links: v ? [...ev.links, { from, to }] : ev.links.filter((l) => !(l.from === from && l.to === to)) })} />
            );
          })}
        </fieldset>
      )}
      {problem && <p className="text-xs text-(--danger)">⚠ {problem}</p>}
    </li>
  );
}

export function ScenarioEditor({ scenario: s, design, onChange, live }: { scenario: Scenario; design: Design; onChange: (s: Scenario) => void; live: boolean }) {
  const [adding, setAdding] = useState<ChaosKind>("kill");
  const [note, setNote] = useState("");
  const w = s.workload;
  const setW = (patch: Partial<Workload>) => onChange({ ...s, workload: { ...w, ...patch } });
  const total = s.warmupUs + s.measureUs + s.drainUs;
  const problems = chaosProblems(design, s.chaos);
  const mixTotal = design.endpoints.reduce((t, e) => t + (w.mix[e.id] ?? 0), 0);
  return (
    <div className="flex flex-col gap-6">
      <p className="sr-only" aria-live="polite">{note}</p>
      {live && <p className="rounded-(--radius-sm) border border-(--accent) p-2 text-xs">Edits to arrivals, mix and future chaos go live at the next event boundary; other changes are rejected until the run stops.</p>}
      <section className="flex flex-col gap-2">
        <h3 className={sectionTitle}>Presets</h3>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className={btn} title={p.blurb} onClick={() => { onChange(p.apply(s, design.endpoints)); setNote(`Applied ${p.label}: ${p.blurb}.`); }}>
              {p.label}
            </button>
          ))}
        </div>
        <PerDay onApply={(peak, avg) => { setW({ arrival: { kind: "poisson", rps: Math.round(peak) } }); setNote(`Arrivals set to the peak, ${fmtNum(peak)} requests per second (average ${fmtNum(avg)}).`); }} />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={sectionTitle}>Traffic</h3>
        <ArrivalEditor s={s} onChange={(arrival) => setW({ arrival })} />
        <fieldset className="flex flex-col gap-2 rounded-(--radius-sm) border border-(--border) p-2.5">
          <legend className="px-1 text-xs text-(--text)">Mix (relative weights)</legend>
          {design.endpoints.map((e) => (
            <UnitField key={e.id} label={e.name} kind="number" value={w.mix[e.id] ?? 0} hint={mixTotal ? `${Math.round(((w.mix[e.id] ?? 0) / mixTotal) * 100)}% of requests` : undefined}
              onCommit={(v) => setW({ mix: { ...w.mix, [e.id]: v! } })} />
          ))}
          {mixTotal === 0 && <p className="text-xs text-(--danger)">⚠ Give at least one endpoint a weight above 0.</p>}
        </fieldset>
        <KeyDistField label="Keys" value={w.keys} onCommit={(keys) => setW({ keys })} />
        <UnitField label="Deadline" kind="duration" value={w.deadlineUs} hint="Per request; later answers count as failures" onCommit={(deadlineUs) => setW({ deadlineUs: Math.max(1, deadlineUs!) })} />
        <Check label="Sessions (sticky routing, read-your-writes)" checked={!!w.sessions} onChange={(on) => setW({ sessions: on ? { count: 1000 } : undefined })} />
        {w.sessions && <UnitField label="Sessions" kind="count" value={w.sessions.count} onCommit={(count) => setW({ sessions: { count: Math.max(1, count!) } })} />}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={sectionTitle}>Run length</h3>
        <UnitField label="Warm-up" kind="duration" unit="s" value={s.warmupUs} hint="Not measured" onCommit={(v) => onChange({ ...s, warmupUs: v! })} />
        <UnitField label="Measure" kind="duration" unit="s" value={s.measureUs} onCommit={(v) => onChange({ ...s, measureUs: Math.max(1, v!) })} />
        <UnitField label="Drain" kind="duration" unit="s" value={s.drainUs} onCommit={(v) => onChange({ ...s, drainUs: v! })} />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className={sectionTitle}>Chaos timeline</h3>
        {s.chaos.length === 0 && <p className="text-xs text-(--text-muted)">No failures scheduled. Add one to see how the design copes.</p>}
        <ol className="flex flex-col gap-2">
          {s.chaos.map((ev, i) => (
            <ChaosRow key={ev.id} ev={ev} design={design} total={total} problem={problems[ev.id]}
              onChange={(next) => onChange({ ...s, chaos: s.chaos.map((x, j) => (j === i ? next : x)) })}
              onRemove={() => onChange({ ...s, chaos: s.chaos.filter((_, j) => j !== i) })} />
          ))}
        </ol>
        <div className="flex items-center gap-1.5">
          <Select label="New chaos event" value={adding} options={CHAOS_KINDS.map((c) => [c.kind, c.label] as const)} onChange={setAdding} className="w-52" />
          <button type="button" className={btn} onClick={() => {
            const ev = newChaos(adding, design, nextId(s.chaos.map((c) => c.id), adding), s.warmupUs + Math.round(s.measureUs / 2));
            onChange({ ...s, chaos: [...s.chaos, ev] });
            setNote(`Added ${adding} at ${(ev.atUs / 1e6).toFixed(1)} s.`);
          }}>+ Add</button>
        </div>
        {Object.keys(problems).length > 0 && <p className="text-xs text-(--danger)">⚠ {Object.keys(problems).length} chaos event{Object.keys(problems).length === 1 ? "" : "s"} need fixing; they are left out of runs until fixed.</p>}
      </section>
    </div>
  );
}
