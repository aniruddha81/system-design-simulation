"use client";

import { useReducedMotionConfig } from "motion/react";
import { useEffect, useEffectEvent, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Figure, HEAT, HEAT_WORDS, heatBucket, nb } from "@/components/models/notebook";
import type { FailureRung, Prediction, ScaleResult, SweepKind, SweepLevel, SweepResult, WhatIfResult } from "@/engine/scale";
import type { Design, NodeId, Scenario } from "@/engine/types";
import { toPeakRps } from "@/engine/workload";
import { formatDuration, formatNumber, formatPercent, formatRps, formatUsdEstimate } from "@/lib/format";
import { EmptyPlot } from "@/components/sandbox/visuals";
import { Chart } from "./Chart";
import { LiveSummary } from "./LiveSummary";
import { WhatIfTable } from "./WhatIfTable";
import { componentName, describeArrival, heatOf, remedyFor, rungKey, scaleScenario, withRps } from "./plan";
import type { ScaleReply, ScaleTask } from "./scale.worker";

export type ScalePanelProps = {
  design: Design;
  scenario: Scenario;
  /** Node heat (0..1+, utilisation plus dropped fraction) per failure-ladder rung; null when playback stops. */
  onHeat: (heat: Record<NodeId, number> | null) => void;
};

function startTask(task: ScaleTask, on: (m: ScaleReply) => void): () => void {
  const worker = new Worker(new URL("./scale.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<ScaleReply>) => {
    if (e.data.type === "done" || e.data.type === "error") worker.terminate();
    on(e.data);
  };
  worker.onerror = (e) => {
    worker.terminate();
    on({ type: "error", message: e.message || "The Scale worker crashed." });
  };
  try {
    worker.postMessage(task);
  } catch (err) {
    worker.terminate();
    throw err;
  }
  return () => worker.terminate();
}

const PREDICTION_NAMES: Record<Prediction, string> = {
  utilisation: "Utilisation", backlog: "Backlog", drops: "Drops", latency: "Latency percentiles", hitRate: "Cache hit rate",
  timelySuccess: "Estimated timely-success ratio", cost: "Cost", correctness: "Correctness",
};
const STEP_MS = 1600;
const multipleText = (m: number) => `${formatNumber(m, m < 10 ? 1 : 0)}×`;

type Run = { result: ScaleResult; design: Design; scenario: Scenario; loadKey: string };
type Sweep = { kind: SweepKind; n: number; levels: SweepLevel[]; ladder: FailureRung[]; outcome: SweepResult["outcome"] | null; design: Design; scenario: Scenario; inputScenario: Scenario; loadKey: string };
type RemedyStatus = { label: string; verified: boolean; detail: string };
type Busy = { what: "run" | "sweep" | "whatIf"; label: string; progress: string };

export function ScalePanel({ design, scenario, onHeat }: ScalePanelProps) {
  const reduced = useReducedMotionConfig() ?? false;
  const [loadMode, setLoadMode] = useState<"scenario" | "daily">("scenario");
  const [perDay, setPerDay] = useState(1e9);
  const [peak, setPeak] = useState(3);
  const [kind, setKind] = useState<SweepKind>("independent");
  const [levelCount, setLevelCount] = useState(6);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [remedies, setRemedies] = useState<Record<string, RemedyStatus>>({});
  const [diff, setDiff] = useState<{ label: string; multiple: number; result: WhatIfResult; design: Design } | null>(null);
  const [playIndex, setPlayIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  const ids = useId();

  // ---- load entry ----
  let peakLoad: { avgRps: number; peakRps: number } | null = null;
  try {
    peakLoad = toPeakRps(perDay, peak);
  } catch {
    peakLoad = null;
  }
  const loadKey = loadMode === "scenario" ? "scenario" : `${perDay}/${peak}`;
  const effective = loadMode === "daily" && peakLoad ? withRps(scenario, peakLoad.peakRps) : scenario;
  const loadInvalid = loadMode === "daily" && !peakLoad;

  // ---- tasks ----
  const begin = (b: Busy, task: ScaleTask, on: (m: ScaleReply) => void) => {
    cancelRef.current?.();
    setError(null);
    setBusy(b);
    try {
      cancelRef.current = startTask(task, (m) => {
        if (m.type === "progress") setBusy((cur) => cur && { ...cur, progress: `${formatPercent(m.fraction, 0)} simulated` });
        else if (m.type === "error") {
          cancelRef.current = null;
          setBusy(null);
          setError(m.message);
        } else {
          if (m.type === "done") {
            cancelRef.current = null;
            setBusy(null);
          }
          on(m);
        }
      });
    } catch (err) {
      cancelRef.current = null;
      setBusy(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancel = () => {
    cancelRef.current?.();
    cancelRef.current = null;
    setBusy(null);
    // Completed sweep levels stay; the sweep is marked cancelled.
    setSweep((s) => (s && s.outcome === null ? { ...s, outcome: "cancelled" } : s));
  };

  const startRun = () => {
    stopPlayback();
    begin({ what: "run", label: "Scale run", progress: "starting" }, { type: "run", design, scenario: effective }, (m) => {
      if (m.type === "done") setRun({ result: m.value as ScaleResult, design, scenario, loadKey });
    });
  };

  const startSweep = () => {
    stopPlayback();
    setRemedies({});
    setDiff(null);
    setSweep({ kind, n: levelCount, levels: [], ladder: [], outcome: null, design, scenario: effective, inputScenario: scenario, loadKey });
    let done = 0;
    begin({ what: "sweep", label: "Breaking-point sweep", progress: `level 1 of ${levelCount}` }, { type: "sweep", design, scenario: effective, kind, levels: levelCount }, (m) => {
      if (m.type === "level") {
        done++;
        setSweep((s) => s && { ...s, levels: [...s.levels, m.level], ladder: m.ladder });
        setBusy((b) => b && { ...b, progress: `level ${Math.min(done + 1, levelCount)} of ${levelCount}` });
      } else if (m.type === "done") {
        const r = m.value as SweepResult;
        setSweep((s) => s && { ...s, levels: r.levels, ladder: r.ladder, outcome: r.outcome });
      }
    });
  };

  const tryRemedy = (rung: FailureRung, s: Sweep) => {
    const remedy = remedyFor(s.design, rung, s.ladder);
    if (!remedy) return;
    begin({ what: "whatIf", label: `What-if: ${remedy.label}`, progress: "running both designs" }, { type: "whatIf", a: s.design, b: remedy.design, scenario: scaleScenario(s.scenario, rung.multiple) }, (m) => {
      if (m.type !== "done") return;
      const result = m.value as WhatIfResult;
      const reproduced = result.ladder.a.find((r) => rungKey(r) === rungKey(rung));
      const verified = Boolean(reproduced?.remedy.verified);
      const detail = verified
        ? `Verified: at ${multipleText(rung.multiple)} the what-if removes this rung and timely-success does not fall.`
        : !reproduced
          ? `Not verified: this rung did not reproduce in a fresh run at ${multipleText(rung.multiple)}${s.kind === "continuous" ? " (it may need the carried-over ramp state)" : ""}.`
          : "Not verified: the what-if did not improve the failure ladder.";
      setRemedies((all) => ({ ...all, [rungKey(rung)]: { label: remedy.label, verified, detail } }));
      setDiff({ label: remedy.label, multiple: rung.multiple, result, design: s.design });
    });
  };

  // ---- failure-ladder playback ----
  const heatFor = (i: number) => {
    if (!sweep) return null;
    const level = sweep.levels.find((l) => l.multiple === sweep.ladder[i].multiple);
    if (!level) return null;
    const heat = heatOf(sweep.design, level.result);
    return Object.keys(heat).length ? heat : null;
  };
  const show = (i: number) => {
    setPlayIndex(i);
    onHeat(heatFor(i));
  };
  function stopPlayback() {
    setPlaying(false);
    if (playIndex !== null) onHeat(null);
    setPlayIndex(null);
  }
  const advance = useEffectEvent(() => {
    if (playIndex === null || !sweep) return;
    if (playIndex + 1 < sweep.ladder.length) show(playIndex + 1);
    else stopPlayback();
  });
  useEffect(() => {
    if (!playing || playIndex === null) return;
    const t = setTimeout(advance, STEP_MS);
    return () => clearTimeout(t);
  }, [playing, playIndex]);

  const unmount = useEffectEvent(() => {
    cancelRef.current?.();
    onHeat(null);
  });
  useEffect(() => () => unmount(), []);

  // ---- derived ----
  const fidelity = run?.result.fidelity.predictions;
  const enabled = (p: Prediction) => fidelity?.[p].enabled ?? false;
  const stale = run && (run.design !== design || run.scenario !== scenario || run.loadKey !== loadKey);
  const ladder = sweep?.ladder ?? [];
  const completed = sweep?.levels.length ?? 0;

  const summary = busy
    ? `${busy.label}: ${busy.progress}.`
    : error
      ? `Scale mode error: ${error}`
      : playIndex !== null && ladder[playIndex]
        ? `Rung ${playIndex + 1} of ${ladder.length}: at ${multipleText(ladder[playIndex].multiple)}, ${componentName(design, ladder[playIndex].component)} ${ladder[playIndex].what}.`
        : sweep?.outcome
          ? `Sweep ${sweep.outcome}: ${completed} of ${sweep.n} levels, ${ladder.length} failure-ladder rungs.`
          : run
            ? `Scale run ${run.result.outcome}.`
            : "";

  // Heat of the rung's own component at its level (max over nodes for "global").
  const rungHeat = (i: number) => {
    const heat = heatFor(i);
    if (!heat) return null;
    const own = heat[ladder[i].component];
    return heatBucket(own ?? Math.max(0, ...Object.values(heat)));
  };

  return (
    <section aria-label="Scale mode" className="grid gap-6 text-[0.9375rem]">
      <LiveSummary text={summary} />

      {/* ---- load + run ---- */}
      <Figure className="" no="S1" title="Load" note="Scale mode is a fluid estimate for large loads. Every number carries its fidelity; correctness is never checked here.">
        <fieldset className="grid gap-3">
          <legend className="sr-only">Load</legend>
          <label className="flex min-h-6 items-center gap-2">
            <input type="radio" name={`${ids}-load`} checked={loadMode === "scenario"} onChange={() => setLoadMode("scenario")} className="size-4" />
            As in the scenario: <span className="num">{describeArrival(scenario)}</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-h-6 items-center gap-2">
              <input type="radio" name={`${ids}-load`} checked={loadMode === "daily"} onChange={() => setLoadMode("daily")} className="size-4" />
              Requests per day
            </label>
            <input
              type="number"
              min={0}
              step="any"
              aria-label="Requests per day"
              value={Number.isNaN(perDay) ? "" : perDay}
              onChange={(e) => {
                setPerDay(e.target.valueAsNumber);
                setLoadMode("daily");
              }}
              className="field w-40"
            />
            <label className="flex items-center gap-2">
              Peak ×
              <input type="number" min={1} step={0.5} value={Number.isNaN(peak) ? "" : peak} onChange={(e) => setPeak(e.target.valueAsNumber)} className="field w-20" />
            </label>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPerDay(1e9);
                setLoadMode("daily");
              }}
            >
              1B requests/day
            </button>
          </div>
          {peakLoad ? (
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="num">{formatNumber(perDay, 0)}/day</span>
              <span className="text-muted">≈</span>
              <span className="num">{formatRps(peakLoad.avgRps)} average</span>
              <span className="text-muted">× {formatNumber(peak, 1)} peak =</span>
              <strong className={`num ${loadMode === "daily" ? nb.marker : ""}`}>{formatRps(peakLoad.peakRps)}</strong>
              <span className={nb.note}>simulated as steady Poisson arrivals at the peak</span>
            </p>
          ) : (
            <p className="text-sm text-danger">✕ Enter a non-negative daily volume and a peak factor of at least 1.</p>
          )}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary" disabled={busy !== null || loadInvalid} onClick={startRun}>
            Run Scale mode
          </button>
          {busy && (
            <>
              <span className="flex items-center gap-2 text-sm">
                <span aria-hidden className="inline-block size-2 animate-pulse rounded-full bg-accent" />
                {busy.label}: <span className="num">{busy.progress}</span>
              </span>
              <button type="button" className="btn" onClick={cancel}>
                Cancel
              </button>
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="flex gap-2 border-l-2 border-danger pl-3 text-sm">
            <span aria-hidden className="font-bold text-danger">✕</span>
            {error}
          </p>
        )}
      </Figure>

      {/* ---- headline outputs ---- */}
      {run && fidelity && (
        <Figure className="" no="S2" title="Scale-mode estimate" note={`${formatDuration(run.result.simEndUs)} simulated in ${formatNumber(run.result.steps, 0)} fluid steps`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`${nb.stamp} ${run.result.confidence === "low-confidence" ? "text-warning" : "text-success"}`}>
              {run.result.confidence === "low-confidence" ? "! low-confidence" : "✓ validated envelope"}
            </span>
            <span className={`${nb.stamp} text-muted`}>? correctness: unknown</span>
            {run.result.outcome !== "finished" && <span className={`${nb.stamp} text-warning`}>! run {run.result.outcome}</span>}
            {stale && <span className={`${nb.stamp} text-warning`}>! design or load changed since</span>}
          </div>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Timely-success (est.)" hint="Successes within the deadline ÷ offered. Not goodput: correctness is unknown.">
              {enabled("timelySuccess") ? (run.result.metrics.estimatedTimelySuccessRatio === null ? "n/a" : formatPercent(run.result.metrics.estimatedTimelySuccessRatio)) : <Disabled />}
            </Stat>
            <Stat label="Latency p50 / p99">{enabled("latency") ? <Percentile result={run.result} /> : <Disabled />}</Stat>
            <Stat label="Cost per month">{enabled("cost") ? formatUsd(run.result.metrics.costPerMonth) : <Disabled />}</Stat>
            <Stat label="Cost per 1M requests">{!enabled("cost") ? <Disabled /> : run.result.metrics.costPerMillionRequests === null ? "n/a" : formatUsd(run.result.metrics.costPerMillionRequests)}</Stat>
          </dl>
          <p className="-mt-2 text-xs text-muted">Costs are estimates (USD).</p>
          <DisabledList predictions={fidelity} />
          {run.result.series.length > 1 && (
            <Chart
              title="Over simulated time"
              series={[
                { name: "Timely-success", stroke: "var(--text)", points: run.result.series.map((p) => ({ x: p.tUs, y: enabled("timelySuccess") ? p.estimatedTimelySuccessRatio : null, label: formatDuration(p.tUs) })) },
                {
                  name: "Busiest node",
                  stroke: HEAT[3],
                  dash: "6 4",
                  points: run.result.series.map((p) => ({ x: p.tUs, y: enabled("utilisation") ? Math.max(0, ...Object.entries(p.nodes).filter(([id]) => !id.startsWith("edge:")).map(([, n]) => n.utilisation)) : null, label: formatDuration(p.tUs) })),
                },
              ]}
              xTicks={[0, 0.5, 1].map((f) => {
                const x = run.result.series[0].tUs + f * (run.result.series.at(-1)!.tUs - run.result.series[0].tUs);
                return { x, label: formatDuration(x) };
              })}
              formatY={(y) => formatPercent(y, 0)}
              table={{
                head: ["Sim time", "Offered", "Succeeded", "Timely-success", "Busiest node"],
                rows: run.result.series.map((p) => [formatDuration(p.tUs), formatRps(p.offeredPerSec), enabled("utilisation") ? formatRps(p.succeededPerSec) : "disabled", !enabled("timelySuccess") ? "disabled" : p.estimatedTimelySuccessRatio === null ? "n/a" : formatPercent(p.estimatedTimelySuccessRatio), enabled("utilisation") ? formatPercent(Math.max(0, ...Object.entries(p.nodes).filter(([id]) => !id.startsWith("edge:")).map(([, n]) => n.utilisation))) : "disabled"]),
              }}
            />
          )}
          <details>
            <summary className="min-h-6 cursor-pointer text-sm">Show data table · nodes and links</summary>
            <NodeTable run={run} enabled={enabled} />
          </details>
          {run.result.warnings.length > 0 && (
            <ul className="grid gap-1 text-sm">
              {run.result.warnings.map((w) => (
                <li key={w} className={nb.note}>
                  <span aria-hidden className="not-italic text-warning">! </span>
                  {w}
                </li>
              ))}
            </ul>
          )}
          <details className="text-sm text-muted">
            <summary className="inline-flex min-h-6 cursor-pointer items-center">Model assumptions</summary>
            <ul className="mt-2 grid list-disc gap-1 pl-5">
              {run.result.assumptions.map((a) => <li key={a}>{a}</li>)}
            </ul>
          </details>
        </Figure>
      )}

      {/* ---- sweep ---- */}
      <Figure className="" no="S3" title="Breaking-point sweep" note="Log-spaced load: 1× → 10× → 100× → 1000×.">
        {sweep && (sweep.design !== design || sweep.inputScenario !== scenario || sweep.loadKey !== loadKey) && <p className="text-sm text-warning">! Design, scenario or load changed since this sweep; results use its original snapshot.</p>}
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">Sweep kind</legend>
          {(
            [
              ["independent", "Independent levels", "Reset → warm up → measure each level."],
              ["continuous", "Continuous ramp", "Carry state → raise load → observe lag."],
            ] as const
          ).map(([value, title, text]) => (
            <label key={value} className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 transition-colors ${kind === value ? "border-fg bg-surface-2" : "border-border"}`}>
              <input type="radio" name={`${ids}-kind`} checked={kind === value} onChange={() => setKind(value)} className="mt-1 size-4" />
              <span className="grid gap-0.5">
                <strong className="font-semibold">{title}</strong>
                <span className="text-sm text-muted">{text}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            Levels
            <select value={levelCount} onChange={(e) => setLevelCount(Number(e.target.value))} className="field">
              {[4, 6, 8, 10, 12].map((n) => <option key={n}>{n}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-primary" disabled={busy !== null || loadInvalid} onClick={startSweep}>
            Run sweep
          </button>
          {busy?.what === "sweep" && (
            <button type="button" className="btn" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
        {sweep && (busy?.what === "sweep" || sweep.levels.length > 0) && <LevelStrip sweep={sweep} running={busy?.what === "sweep"} />}
        {sweep && sweep.levels.length > 0 && <SweepView sweep={sweep} design={sweep.design} />}
        {sweep?.levels[0] && <DisabledList predictions={sweep.levels[0].result.fidelity.predictions} />}
        {sweep?.outcome && sweep.outcome !== "finished" && (
          <p className={nb.note}>
            Sweep {sweep.outcome === "wall-limit" ? "stopped at the 120 s wall-time limit" : sweep.outcome === "step-limit" ? "stopped at the 5M-step limit" : "cancelled"}; {completed} of {sweep.n} levels completed and kept.
          </p>
        )}
      </Figure>

      {/* ---- failure ladder ---- */}
      {sweep && (sweep.outcome !== null || ladder.length > 0) && (
        <Figure className="" no="S4" title="Failure ladder" note={`Failure order (${sweep.kind === "independent" ? "independent levels" : "continuous ramp"}). Verify suggested remedies with a what-if.`}>
          {ladder.length === 0 ? (
            <EmptyPlot caption="Completed levels stayed within capacity." />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Ladder playback on the board">
                {!reduced && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    aria-pressed={playing}
                    onClick={() => {
                      if (playing) setPlaying(false);
                      else {
                        setPlaying(true);
                        show(playIndex === null || playIndex >= ladder.length - 1 ? 0 : playIndex);
                      }
                    }}
                  >
                    {playing ? "❚❚ Pause" : "▶ Play on the board"}
                  </button>
                )}
                <button type="button" className="btn" disabled={playIndex === 0} onClick={() => show(playIndex === null ? 0 : playIndex - 1)}>
                  ← Previous
                </button>
                <button type="button" className="btn" disabled={playIndex === ladder.length - 1} onClick={() => show(playIndex === null ? 0 : playIndex + 1)}>
                  Next →
                </button>
                <button type="button" className="btn btn-ghost" disabled={playIndex === null} onClick={stopPlayback}>
                  ■ Stop
                </button>
                <HeatLegend />
              </div>
              {reduced && <p className={nb.note}>Reduced motion: step through the rungs; nothing advances on its own.</p>}
              <ol className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2" aria-label="Failure heat sequence">
                {ladder.map((rung, i) => {
                  const h = rungHeat(i);
                  return <li key={rungKey(rung)}><button type="button"
                    className="grid min-h-16 w-full gap-1 border-2 bg-surface p-2 text-left text-xs motion-safe:transition-colors focus-visible:outline-2 focus-visible:outline-(--accent)"
                    style={{ borderColor: playIndex === i ? "var(--text)" : "var(--rule)" }}
                    aria-current={playIndex === i ? "step" : undefined} onClick={() => { setPlaying(false); show(i); }}>
                    <span aria-hidden="true" className="h-2 w-full" style={{ background: h === null ? "var(--text-muted)" : HEAT[h] }} />
                    <strong>{i + 1}. {multipleText(rung.multiple)}</strong>
                    <span>{componentName(sweep.design, rung.component)}</span>
                    <span>{h === null ? "Heat unavailable" : HEAT_WORDS[h]}</span>
                  </button></li>;
                })}
              </ol>
              <ol className={nb.ladder}>
                {ladder.map((rung, i) => {
                  const key = rungKey(rung);
                  const status = remedies[key];
                  const remedy = remedyFor(sweep.design, rung, ladder);
                  const h = rungHeat(i);
                  return (
                    <li key={key} aria-current={playIndex === i ? "step" : undefined} className={`${nb.rung} ${playIndex === i ? nb.rungActive : ""}`} style={{ "--rung-heat": h === null ? "var(--text-muted)" : HEAT[h] } as CSSProperties}>
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <span className="num text-2xl font-semibold leading-none" style={{ fontFamily: "var(--font-display, var(--font-sans))" }}>
                          {multipleText(rung.multiple)}
                        </span>
                        <span>
                          <strong className={`font-semibold ${playIndex === i ? nb.marker : ""}`}>{componentName(sweep.design, rung.component)}</strong> {rung.what}
                        </span>
                        <span className={nb.heat} title={h === null ? "Heat unavailable" : `Heat ${h}: ${HEAT_WORDS[h]}`}>
                          {h ?? "?"}
                          <span className="sr-only">{h === null ? " heat unavailable" : ` heat, ${HEAT_WORDS[h]}`}</span>
                        </span>
                        {playIndex === i && <span className="text-xs font-medium">▶ on the board</span>}
                      </div>
                      <details className="text-sm">
                        <summary className="inline-flex min-h-6 cursor-pointer items-center font-medium">Why?</summary>
                        <p className={`${nb.note} mt-1`}>{rung.why}</p>
                      </details>
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-muted">Try:</span> {rung.remedy.suggestion}
                        {status ? (
                          <span className={`${nb.stamp} ${status.verified ? "text-success" : "text-warning"}`}>{status.verified ? "✓ verified" : "✕ not verified"}</span>
                        ) : (
                          <span className={`${nb.stamp} text-muted`}>suggestion</span>
                        )}
                      </div>
                      {status && <p className={nb.note}>{status.label}: {status.detail}</p>}
                      {remedy ? (
                        <button type="button" className="btn justify-self-start" disabled={busy !== null} onClick={() => tryRemedy(rung, sweep)}>
                          Try it: {remedy.label} at {multipleText(rung.multiple)}
                        </button>
                      ) : (
                        <p className="text-xs text-muted">No automatic variant for this suggestion; change the design and sweep again.</p>
                      )}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </Figure>
      )}

      {diff && <WhatIfTable diff={diff} design={diff.design} />}
    </section>
  );
}

// ---------- pieces ----------

const formatUsd = (n: number) => formatUsdEstimate(n).replace(" (estimate)", "");

function Stat({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={nb.stat}>
      <dt className="text-xs uppercase tracking-wider text-muted">{label}</dt>
      <dd className={nb.statValue}>{children}</dd>
      {hint && <dd className="text-xs text-muted">{hint}</dd>}
    </div>
  );
}

function Disabled() {
  return <span className="text-sm font-normal text-muted">⊘ disabled — see below</span>;
}

function Percentile({ result }: { result: ScaleResult }) {
  const { p50, p99 } = result.metrics.successLatency;
  if (p50 === null || p99 === null) return <span className="text-sm font-normal text-muted">unavailable in Scale mode</span>;
  return (
    <>
      {formatDuration(p50)} / {formatDuration(p99)}
      {result.confidence === "low-confidence" && <span className="ml-2 align-middle text-xs font-normal text-warning">! low-confidence</span>}
    </>
  );
}

function HeatLegend() {
  return (
    <span className="ml-auto flex items-center gap-1 text-xs text-muted" aria-label="Heat scale: 0 idle to 4 overflowing">
      <span aria-hidden>cool</span>
      {HEAT.map((c, i) => (
        <span key={i} aria-hidden className={nb.heat} style={{ "--rung-heat": c } as CSSProperties}>
          {i}
        </span>
      ))}
      <span aria-hidden>hot</span>
    </span>
  );
}

function DisabledList({ predictions }: { predictions: ScaleResult["fidelity"]["predictions"] }) {
  const off = (Object.keys(predictions) as Prediction[]).flatMap((p) => {
    const s = predictions[p];
    return s.enabled ? [] : [{ p, reasons: s.reasons }];
  });
  if (!off.length) return null;
  return (
    <div className="grid gap-1.5 border-l-2 border-dashed border-border pl-3 text-sm">
      <p className="font-medium">Predictions the fidelity check disabled</p>
      <ul className="grid gap-1">
        {off.map(({ p, reasons }) => (
          <li key={p}>
            <span aria-hidden>⊘ </span>
            <strong className="font-medium">{PREDICTION_NAMES[p]}</strong> <span className="text-muted">— {reasons.join(" ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NodeTable({ run, enabled }: { run: Run; enabled: (p: Prediction) => boolean }) {
  const reasons = [...new Set(run.result.nodes.flatMap((n) => (n.unavailableReason ? [n.unavailableReason] : [])))];
  const off = <span className="text-muted">disabled</span>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="mb-2 text-left font-medium">Per node and link</caption>
        <thead className="text-left text-xs uppercase tracking-wider text-muted">
          <tr>
            {["Component", "Utilisation", "Backlog", "Drops", "Latency p99", "Cache hit rate"].map((h) => (
              <th key={h} scope="col" className="px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.result.nodes.map((n) => {
            const kind = run.design.nodes.find((d) => d.id === n.nodeId)?.kind;
            const h = heatBucket(n.utilisation + (n.arrivals > 0 ? Math.min(1, n.drops / n.arrivals) : 0));
            return (
              <tr key={n.nodeId} className="border-t border-dashed border-border">
                <th scope="row" className="px-2 py-1.5 text-left font-normal">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: kind ? `var(--kind-${kind}, var(--text-muted))` : "transparent", border: kind ? undefined : "1px solid var(--border)" }} />
                    {componentName(run.design, n.nodeId)}
                  </span>
                </th>
                <td className="num px-2 py-1.5">
                  {enabled("utilisation") ? (
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="relative h-1.5 w-14 rounded-full bg-surface-2">
                        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(1, n.utilisation) * 100}%`, background: HEAT[h] }} />
                      </span>
                      {formatPercent(n.utilisation)}
                      {n.utilisation >= 0.95 ? <span className="text-danger">✕ saturated</span> : n.utilisation >= 0.8 ? <span className="text-warning">! high</span> : null}
                    </span>
                  ) : (
                    off
                  )}
                </td>
                <td className="num px-2 py-1.5">{enabled("backlog") ? formatNumber(n.backlog, 1) : off}</td>
                <td className="num px-2 py-1.5">{enabled("drops") ? formatNumber(n.drops, 0) : off}</td>
                <td className="num px-2 py-1.5">
                  {!enabled("latency") ? off : n.latency.p99 !== null ? formatDuration(n.latency.p99) : (
                    <span className="text-muted">
                      unavailable{n.unavailableReason && <sup> [{reasons.indexOf(n.unavailableReason) + 1}]</sup>}
                    </span>
                  )}
                </td>
                <td className="num px-2 py-1.5">{!n.cache ? "—" : !enabled("hitRate") ? off : n.cache.hitRate === null ? "unavailable" : formatPercent(n.cache.hitRate)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {reasons.length > 0 && (
        <ol className="mt-2 grid gap-0.5 text-xs text-muted">
          {reasons.map((r, i) => (
            <li key={r}>
              [{i + 1}] {r}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** One cell per level: done (with steady/unstable mark), running, or pending. */
function LevelStrip({ sweep, running }: { sweep: Sweep; running: boolean }) {
  const done = sweep.levels.length;
  return (
    <div className="grid gap-1.5">
      <p className="text-sm">
        {sweep.kind === "independent" ? "Independent levels" : "Continuous ramp"}
        {running && (
          <>
            {" — "}
            <span className="num">
              level {Math.min(done + 1, sweep.n)} of {sweep.n}
            </span>
            {done > 0 && <span className="text-muted"> ({done} completed, kept if you cancel)</span>}
          </>
        )}
      </p>
      <progress aria-label="Completed sweep levels" className="h-2 w-full accent-[var(--accent)]" value={done} max={sweep.n} />
      <ol className="grid gap-1" style={{ gridTemplateColumns: `repeat(${sweep.n}, minmax(0, 1fr))` }} aria-label="Sweep levels">
        {Array.from({ length: sweep.n }, (_, i) => {
          const level = sweep.levels[i];
          const h = level?.result.fidelity.predictions.utilisation.enabled ? heatBucket(Math.max(0, ...Object.values(heatOf(sweep.design, level.result)))) : null;
          const state = level ? (level.state === "steady" ? "steady" : "unstable") : running && i === done ? "running" : "pending";
          return (
            <li
              key={i}
              className={`grid h-9 place-items-center rounded-sm border text-xs font-medium ${state === "running" ? "animate-pulse border-fg" : "border-border"}`}
              style={h !== null ? { background: HEAT[h], color: "var(--bg)", borderColor: "transparent" } : undefined}
              title={level ? `${multipleText(level.multiple)}: ${level.state}` : state}
            >
              <span aria-hidden>{level ? (level.state === "steady" ? "✓" : "~") : state === "running" ? "…" : ""}</span>
              <span className="sr-only">
                Level {i + 1}: {level ? `${multipleText(level.multiple)}, ${level.state}, ${h === null ? "heat disabled" : `heat ${h}`}` : state}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted">✓ steady · ~ unstable, no steady state · colour = hottest node</p>
    </div>
  );
}

function SweepView({ sweep, design }: { sweep: Sweep; design: Design }) {
  const timely = (l: SweepLevel) => (l.result.fidelity.predictions.timelySuccess.enabled ? l.result.metrics.estimatedTimelySuccessRatio : null);
  const util = (l: SweepLevel) => (l.result.fidelity.predictions.utilisation.enabled ? Math.max(0, ...l.result.nodes.filter((n) => design.nodes.some((d) => d.id === n.nodeId)).map((n) => n.utilisation)) : null);
  const heat = (l: SweepLevel) => heatBucket(Math.max(0, ...Object.values(heatOf(design, l.result))));
  const ticks = [1, 10, 100, 1000].filter((m) => m <= Math.max(...sweep.levels.map((l) => l.multiple)) * 1.001);
  const breaking = sweep.levels.find((l) => (timely(l) ?? 1) < 0.99 || (util(l) ?? 0) >= 0.95);
  return (
    <Chart
      title={`Timely-success and busiest node by load (${sweep.kind === "independent" ? "independent levels" : "continuous ramp"})`}
      series={[
        { name: "Timely-success", stroke: "var(--text)", points: sweep.levels.map((l) => ({ x: Math.log10(l.multiple), y: timely(l), label: multipleText(l.multiple) })) },
        {
          name: "Busiest node",
          stroke: "var(--ink-2, var(--text-muted))",
          dash: "6 4",
          points: sweep.levels.map((l) => ({ x: Math.log10(l.multiple), y: util(l), label: multipleText(l.multiple), fill: HEAT[heat(l)], note: `heat ${heat(l)}, ${HEAT_WORDS[heat(l)]}` })),
        },
      ]}
      mark={breaking ? { x: Math.log10(breaking.multiple), label: `breaking point ≈ ${multipleText(breaking.multiple)}` } : undefined}
      xTicks={ticks.map((m) => ({ x: Math.log10(m), label: `${m}×` }))}
      formatY={(y) => formatPercent(y, 0)}
      table={{
        head: ["Load", "State", "Timely-success", "Busiest node", "Bottleneck"],
        rows: sweep.levels.map((l) => [
          multipleText(l.multiple),
          l.state === "steady" ? "✓ steady" : "! unstable — no steady state",
          timely(l) === null ? (l.result.fidelity.predictions.timelySuccess.enabled ? "n/a" : "disabled") : formatPercent(timely(l)!),
          util(l) === null ? "disabled" : `${formatPercent(util(l)!)} (heat ${heat(l)})`,
          l.result.bottleneck ? componentName(design, l.result.bottleneck) : "none",
        ]),
      }}
    />
  );
}

