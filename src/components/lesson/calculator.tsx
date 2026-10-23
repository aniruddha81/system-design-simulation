"use client";

import { useId, useState } from "react";
import { formatDuration, formatPercent, formatRps } from "@/lib/format";
import { useStepDone } from "./stepper";

const CACHE_US = 500;
const DB_US = 5000;

function Slider({ label, value, min, max, step, onChange, display }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string }) {
  const id = useId();
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm text-muted">
          {label}
        </label>
        <span className="num text-sm text-fg">{display}</span>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-valuetext={display} className="w-full" />
    </div>
  );
}

/** Calculator (activity C): request rate × miss rate = database load. */
export function HitRateCalculator() {
  const done = useStepDone();
  const [rps, setRps] = useState(20000);
  const [hit, setHit] = useState(0.9);
  const [capacity, setCapacity] = useState(5000);
  const touch = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    done();
  };

  const dbRps = rps * (1 - hit);
  const util = dbRps / capacity;
  const overloaded = util > 1;
  const meanUs = hit * CACHE_US + (1 - hit) * (CACHE_US + DB_US);
  const lower = Math.max(0, hit - 0.01);
  const sensitivity = hit < 1 ? (1 - lower) / (1 - hit) - 1 : 0;

  return (
    <div role="group" aria-label="Hit rate calculator" className="panel my-6 grid gap-6 p-5 sm:grid-cols-[1fr_1.1fr] sm:p-6">
      <div className="grid content-start gap-5">
        <Slider label="Read requests" value={rps} min={1000} max={100000} step={1000} onChange={touch(setRps)} display={formatRps(rps)} />
        <Slider label="Cache hit rate" value={Math.round(hit * 100)} min={0} max={99} step={1} onChange={touch((v: number) => setHit(v / 100))} display={formatPercent(hit, 0)} />
        <Slider label="Database capacity" value={capacity} min={1000} max={20000} step={500} onChange={touch(setCapacity)} display={formatRps(capacity)} />
      </div>
      <div className="grid content-start gap-4 rounded-md bg-surface-2 p-4">
        <div>
          <p className="text-sm text-muted">Database load</p>
          <output className="num block text-3xl font-semibold tracking-tight">{formatRps(dbRps)}</output>
        </div>
        <div aria-hidden className="relative h-3 rounded-full bg-bg">
          <div
            className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ${overloaded ? "bg-danger" : util > 0.8 ? "bg-warning" : "bg-accent-2"}`}
            style={{ width: `${Math.min(util / 1.5, 1) * 100}%` }}
          />
          <div className="absolute inset-y-[-4px] w-0.5 bg-fg" style={{ left: `${100 / 1.5}%` }} title="Capacity" />
        </div>
        <p className={`flex items-center gap-2 text-sm font-medium ${overloaded ? "text-danger" : util > 0.8 ? "text-warning" : "text-success"}`}>
          <span aria-hidden>{overloaded ? "✕" : util > 0.8 ? "!" : "✓"}</span>
          {overloaded ? `Overloaded: ${formatPercent(util, 0)} of capacity` : util > 0.8 ? `Near saturation: ${formatPercent(util, 0)} of capacity` : `Within capacity: ${formatPercent(util, 0)}`}
        </p>
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-muted">Mean read latency</dt>
            <dd className="num text-fg">{formatDuration(meanUs)}</dd>
          </div>
          <div>
            <dt className="text-muted">If hit rate drops 1 point</dt>
            <dd className="num text-fg">{hit > 0 ? `DB load +${formatPercent(sensitivity, 0)}` : "n/a"}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted">
          Assumes a {formatDuration(CACHE_US)} cache lookup and a {formatDuration(DB_US)} database read; a miss pays both.
        </p>
      </div>
    </div>
  );
}
