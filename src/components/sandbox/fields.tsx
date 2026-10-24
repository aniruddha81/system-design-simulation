"use client";
// Typed, unit-aware form primitives shared by the inspector, route, data-model and scenario editors (§8).
import { useId, useState } from "react";
import type { Dist, KeyDist } from "@/engine/types";
import { DEFAULT_UNIT, parseUnit, toUnit, type UnitKind } from "./units";

export const inputCls =
  "h-8 w-full rounded-(--radius-sm) border border-(--border) bg-(--bg) px-2 text-sm text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent) aria-invalid:border-(--danger)";
export const smallBtn =
  "grid h-7 min-w-7 place-items-center rounded-(--radius-sm) px-1.5 text-xs text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:opacity-40";
export const btn =
  "h-8 rounded-(--radius-sm) border border-(--border) px-3 text-sm text-(--text) hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:opacity-40";
export const sectionTitle = "text-xs font-medium uppercase tracking-wider text-(--text-muted)";

export function UnitField({ label, value, kind, unit = DEFAULT_UNIT[kind], optional, onCommit, hint, max, maxError, slider }: {
  label: string; value: number | undefined; kind: UnitKind; unit?: string; optional?: boolean; hint?: string;
  /** Values above max are rejected inline (last valid value kept). */
  max?: number; maxError?: string;
  /** Range slider beside the box (in the display unit); edits during a run go live (§5.7). */
  slider?: [number, number];
  onCommit: (v: number | undefined) => void;
}) {
  const fmt = (v: number | undefined) => (v === undefined ? "" : toUnit(v, kind, unit));
  const [text, setText] = useState(fmt(value));
  const [synced, setSynced] = useState(value);
  const [error, setError] = useState<string | null>(null);
  if (value !== synced) {
    // External change (undo, insertion rule, slider): show the new value.
    setSynced(value);
    setText(fmt(value));
    setError(null);
  }
  const id = useId();
  function commit() {
    if (optional && text.trim() === "") return onCommit(undefined);
    const r = parseUnit(text, kind, unit);
    if (!r.ok) return setError(r.error); // keep the last valid value in the design
    if (max !== undefined && r.value > max) return setError(maxError ?? `At most ${fmt(max)} ${unit}`);
    setError(null);
    if (r.value === value) setText(fmt(value));
    else onCommit(r.value);
  }
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr] items-start gap-x-3 gap-y-1">
      <label htmlFor={id} className="pt-1.5 text-xs text-(--text-muted)">{label}</label>
      <div>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              id={id}
              value={text}
              inputMode="decimal"
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-err` : undefined}
              placeholder={optional ? "none" : undefined}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              className={`${inputCls} pr-12 tabular-nums`}
            />
            {unit && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-(--text-muted)">{unit}</span>}
          </div>
          {slider && (
            <input
              type="range"
              aria-label={`${label} slider`}
              min={slider[0]}
              max={slider[1]}
              value={Math.min(slider[1], Math.max(slider[0], Number(fmt(value) || 0)))}
              onChange={(e) => {
                const r = parseUnit(e.target.value, kind, unit);
                if (r.ok) onCommit(r.value);
              }}
              className="h-6 w-24 shrink-0 accent-(--accent)"
            />
          )}
        </div>
        {error ? (
          <p id={`${id}-err`} className="mt-1 text-xs text-(--danger)">⚠ {error}. Kept {fmt(value) || "none"} {unit}.</p>
        ) : hint ? <p className="mt-1 text-xs text-(--text-muted)">{hint}</p> : null}
      </div>
    </div>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-x-3">
      <span className="text-xs text-(--text-muted)">{label}</span>
      {children}
    </label>
  );
}

export function Check({ label, checked, onChange }: { label: React.ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-7 items-center gap-2 text-sm text-(--text)">
      <input type="checkbox" className="size-4 accent-(--accent)" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Select<T extends string>({ label, value, options, onChange, className = "" }: {
  label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; className?: string;
}) {
  return (
    <select aria-label={label} className={`${inputCls} ${className}`} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
    </select>
  );
}

export function DistField({ label, value, onCommit }: { label: string; value: Dist; onCommit: (d: Dist) => void }) {
  const center = value.kind === "constant" ? value.us : value.kind === "exponential" ? value.meanUs : value.kind === "lognormal" ? value.medianUs : value.buckets[0]?.us ?? 1000;
  return (
    <fieldset className="flex flex-col gap-2 rounded-(--radius-sm) border border-(--border) p-2.5">
      <legend className="px-1 text-xs text-(--text)">{label}</legend>
      <Row label="Shape">
        <select
          className={inputCls}
          value={value.kind}
          onChange={(e) => {
            const k = e.target.value as Dist["kind"];
            onCommit(k === "constant" ? { kind: k, us: center } : k === "exponential" ? { kind: k, meanUs: center } : k === "lognormal" ? { kind: k, medianUs: center, sigma: 0.5 } : { kind: k, buckets: [{ us: center, weight: 1 }] });
          }}
        >
          <option value="constant">Constant</option>
          <option value="exponential">Exponential</option>
          <option value="lognormal">Log-normal (long tail)</option>
          <option value="empirical">Empirical</option>
        </select>
      </Row>
      {value.kind === "constant" && <UnitField label="Time" kind="duration" value={value.us} onCommit={(v) => onCommit({ ...value, us: Math.max(1, v!) })} />}
      {value.kind === "exponential" && <UnitField label="Mean" kind="duration" value={value.meanUs} onCommit={(v) => onCommit({ ...value, meanUs: Math.max(1, v!) })} />}
      {value.kind === "lognormal" && (
        <>
          <UnitField label="Median" kind="duration" value={value.medianUs} onCommit={(v) => onCommit({ ...value, medianUs: Math.max(1, v!) })} />
          <UnitField label="Spread σ" kind="number" value={value.sigma} hint="0 = no variation, 1 = heavy tail" onCommit={(v) => onCommit({ ...value, sigma: v! })} />
        </>
      )}
      {value.kind === "empirical" && <p className="text-xs text-(--text-muted)">{value.buckets.length} buckets (edit by importing a design file).</p>}
    </fieldset>
  );
}

const KEY_KINDS = [["uniform", "Uniform"], ["zipf", "Zipf (skewed)"], ["hotspot", "Hotspot (one hot key)"], ["sequential", "Sequential"]] as const;

/** Key distribution editor, used by workloads and dataset generators. */
export function KeyDistField({ label, value, onCommit }: { label: string; value: KeyDist; onCommit: (k: KeyDist) => void }) {
  return (
    <fieldset className="flex flex-col gap-2 rounded-(--radius-sm) border border-(--border) p-2.5">
      <legend className="px-1 text-xs text-(--text)">{label}</legend>
      <Row label="Distribution">
        <Select
          label={`${label} distribution`}
          value={value.kind}
          options={KEY_KINDS}
          onChange={(k) => onCommit(k === "zipf" ? { kind: k, n: value.n, s: 1.1 } : k === "hotspot" ? { kind: k, n: value.n, hotFraction: 0.3 } : { kind: k, n: value.n })}
        />
      </Row>
      <UnitField label="Distinct keys" kind="count" value={value.n} onCommit={(n) => onCommit({ ...value, n: Math.max(1, n!) })} />
      {value.kind === "zipf" && <UnitField label="Skew s" kind="number" value={value.s} hint="1.0–1.3 is typical; higher = hotter head" onCommit={(s) => onCommit({ ...value, s: s! })} />}
      {value.kind === "hotspot" && <UnitField label="Hot key share" kind="fraction" value={value.hotFraction} onCommit={(f) => onCommit({ ...value, hotFraction: f! })} />}
    </fieldset>
  );
}
