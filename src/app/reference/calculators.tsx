"use client";

import { useId, useState } from "react";
import { Bars } from "@/components/visual/kit";
import { formatBandwidth, formatBytes, formatDuration, formatNumber, formatRps } from "@/lib/format";

function NumberField({ label, value, onChange, unit, step = "any", min = 0 }: { label: string; value: number; onChange: (v: number) => void; unit?: string; step?: string; min?: number }) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm text-muted">
        {label}
      </label>
      <div className="flex items-center rounded-md border border-rule bg-surface focus-within:outline-2 focus-within:outline-accent">
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

function Result({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="rounded-md border-l-4 border-accent-2 bg-surface-2 p-3">
      <dt className="text-xs uppercase tracking-wide text-muted">
        <span aria-hidden className="mr-1.5">
          {icon}
        </span>
        {label}
      </dt>
      <dd className="num mt-1 text-xl text-fg">{value}</dd>
    </div>
  );
}

const YEAR_US = 365.25 * 86400e6;
const PRESETS = [99, 99.9, 99.95, 99.99, 99.999];

export function NinesCalculator() {
  const [availability, setAvailability] = useState(99.9);
  const valid = availability >= 0 && availability <= 100;
  const down = (1 - availability / 100) * YEAR_US;
  const minutes = (1 - availability / 100) * 365.25 * 1440;
  return (
    <div className="grid gap-6">
      <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
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
        <dl aria-live="polite" className="grid grid-cols-2 content-start gap-3">
          {valid ? (
            <>
              <Result icon="◷" label="Per year" value={formatDuration(down)} />
              <Result icon="◷" label="Per 30 days" value={formatDuration((down * 30) / 365.25)} />
              <Result icon="◷" label="Per week" value={formatDuration((down * 7) / 365.25)} />
              <Result icon="◷" label="Per day" value={formatDuration(down / 365.25)} />
            </>
          ) : (
            <div className="col-span-2">
              <dt className="sr-only">Error</dt>
              <dd className="py-2 text-sm text-danger">Enter a percentage between 0 and 100.</dd>
            </div>
          )}
        </dl>
      </div>
      <Bars
        title="Downtime per year by target"
        log
        items={[
          ...PRESETS.map((p) => ({ label: `${p}%`, value: Math.round((1 - p / 100) * 365.25 * 1440 * 100) / 100, unit: "min", tone: "info" as const })),
          ...(valid && minutes > 0 && !PRESETS.includes(availability) ? [{ label: `${availability}% (yours)`, value: Math.round(minutes * 100) / 100, unit: "min", tone: "warn" as const }] : []),
        ]}
        caption="Short runs are not yearly SLA attainment."
      />
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
      <dl aria-live="polite" className="grid grid-cols-2 content-start gap-3">
        {ok ? (
          <>
            <Result icon="∑" label="Requests / day" value={formatNumber(perDay, 0)} />
            <Result icon="~" label="Average load" value={formatRps(avg)} />
            <Result icon="▲" label="Peak load" value={formatRps(peakRps)} />
            <Result icon="⇄" label="Peak bandwidth" value={formatBandwidth(peakRps * payload)} />
            <Result icon="+" label="New data / day" value={formatBytes(storedPerDay)} />
            <Result icon="▤" label={`Stored, ${formatNumber(retention, 0)} days`} value={formatBytes(total)} />
          </>
        ) : (
          <div className="col-span-2">
              <dt className="sr-only">Error</dt>
              <dd className="py-2 text-sm text-danger">Every input must be a number of zero or more.</dd>
            </div>
        )}
      </dl>
    </div>
  );
}
