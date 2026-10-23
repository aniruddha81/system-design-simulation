"use client";

import { useId, useState } from "react";
import { formatBandwidth, formatBytes, formatDuration, formatNumber, formatRps } from "@/lib/format";

function NumberField({ label, value, onChange, unit, step = "any", min = 0 }: { label: string; value: number; onChange: (v: number) => void; unit?: string; step?: string; min?: number }) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm text-muted">
        {label}
      </label>
      <div className="flex items-center rounded-md border border-border bg-bg focus-within:border-accent">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.valueAsNumber)}
          className="field w-full min-w-0 border-0 bg-transparent focus-visible:outline-none"
        />
        {unit && <span className="shrink-0 pr-3 text-sm text-muted">{unit}</span>}
      </div>
    </div>
  );
}

function Result({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="num text-right text-fg">{value}</dd>
    </div>
  );
}

const YEAR_US = 365.25 * 86400e6;
const PRESETS = [99, 99.9, 99.95, 99.99, 99.999];

export function NinesCalculator() {
  const [availability, setAvailability] = useState(99.9);
  const valid = availability >= 0 && availability <= 100;
  const down = (1 - availability / 100) * YEAR_US;
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div className="grid content-start gap-4">
        <NumberField label="Availability" value={availability} onChange={setAvailability} unit="%" step="0.001" />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Common targets">
          {PRESETS.map((p) => (
            <button key={p} type="button" className="btn min-h-9 px-3 text-sm" aria-pressed={availability === p} onClick={() => setAvailability(p)}>
              {p}%
            </button>
          ))}
        </div>
      </div>
      <dl aria-live="polite" className="rounded-md bg-surface-2 px-4 py-2">
        {valid ? (
          <>
            <Result label="Downtime per year" value={formatDuration(down)} />
            <Result label="Per 30-day month" value={formatDuration((down * 30) / 365.25)} />
            <Result label="Per week" value={formatDuration((down * 7) / 365.25)} />
            <Result label="Per day" value={formatDuration(down / 365.25)} />
          </>
        ) : (
          <p className="py-2 text-sm text-danger">Enter a percentage between 0 and 100.</p>
        )}
      </dl>
    </div>
  );
}

export function EstimationCalculator() {
  const [dau, setDau] = useState(10_000_000);
  const [perUser, setPerUser] = useState(20);
  const [peak, setPeak] = useState(3);
  const [payload, setPayload] = useState(2000);
  const [writeShare, setWriteShare] = useState(10);
  const [retention, setRetention] = useState(365);
  const [replicas, setReplicas] = useState(3);

  const perDay = dau * perUser;
  const avg = perDay / 86400;
  const peakRps = avg * peak;
  const writesPerDay = perDay * (writeShare / 100);
  const storedPerDay = writesPerDay * payload;
  const total = storedPerDay * retention * replicas;
  const ok = [dau, perUser, peak, payload, writeShare, retention, replicas].every((n) => Number.isFinite(n) && n >= 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumberField label="Daily active users" value={dau} onChange={setDau} step="1" />
        <NumberField label="Requests per user per day" value={perUser} onChange={setPerUser} />
        <NumberField label="Peak-to-average ratio" value={peak} onChange={setPeak} unit="×" />
        <NumberField label="Payload per request" value={payload} onChange={setPayload} unit="bytes" step="1" />
        <NumberField label="Requests that write" value={writeShare} onChange={setWriteShare} unit="%" />
        <NumberField label="Retention" value={retention} onChange={setRetention} unit="days" step="1" />
        <NumberField label="Replication factor" value={replicas} onChange={setReplicas} unit="copies" step="1" min={1} />
      </div>
      <dl aria-live="polite" className="content-start rounded-md bg-surface-2 px-4 py-2">
        {ok ? (
          <>
            <Result label="Requests per day" value={formatNumber(perDay, 0)} />
            <Result label="Average load" value={formatRps(avg)} />
            <Result label="Peak load" value={formatRps(peakRps)} />
            <Result label="Peak bandwidth" value={formatBandwidth(peakRps * payload)} />
            <Result label="New data per day" value={formatBytes(storedPerDay)} />
            <Result label={`Stored after ${formatNumber(retention, 0)} days`} value={formatBytes(total)} />
          </>
        ) : (
          <p className="py-2 text-sm text-danger">Every input must be a number of zero or more.</p>
        )}
      </dl>
    </div>
  );
}
