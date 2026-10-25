"use client";

import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { downloadBackup, restoreFromFile } from "@/components/lesson/progress";
import { setPref, usePref } from "@/components/ui/shell";

function Radios<T extends string>({
  legend,
  hint,
  value,
  options,
  onChange,
}: {
  legend: string;
  hint: string;
  value: T | null;
  options: { value: T; label: string; detail: string; icon: string }[];
  onChange: (v: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="border-t border-rule py-6">
      <legend className="float-left w-full font-display text-2xl">{legend}</legend>
      {hint && <p className="clear-left mb-4 pt-1 text-sm text-muted">{hint}</p>}
      {!hint && <div className="clear-left mb-3" />}
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-rule p-3 has-[:checked]:border-fg has-[:checked]:bg-surface-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-1 size-4 accent-[var(--accent)] focus-visible:outline-none" />
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-md border border-rule bg-surface-2 text-lg">
              {o.icon}
            </span>
            <span>
              <span className="block font-medium">{o.label}</span>
              <span className="block text-sm text-muted">{o.detail}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-rule py-6" aria-label={title}>
      <h2 className="font-display text-2xl">{title}</h2>
      {children}
    </section>
  );
}

// Analytics is opt-in until the pre-launch privacy review (PLAN §15). No provider is wired yet.
const ANALYTICS_KEY = "analytics";
const analyticsListeners = new Set<() => void>();
function readAnalytics() {
  try {
    return localStorage.getItem(ANALYTICS_KEY) === "on";
  } catch {
    return false;
  }
}

export function SettingsForm() {
  const motion = usePref("motion");
  const theme = usePref("theme");
  const analytics = useSyncExternalStore(
    (cb) => (analyticsListeners.add(cb), () => analyticsListeners.delete(cb)),
    readAnalytics,
    () => false,
  );
  const [status, setStatus] = useState<string | null>(null);
  const fileId = useId();
  const resetId = useId();
  const [resetText, setResetText] = useState("");

  return (
    <div className="mt-10 grid gap-6">
      <Radios
        legend="Motion"
        hint=""
        value={motion}
        onChange={(v) => setPref("motion", v)}
        options={[
          { value: "system", label: "System", detail: "Follows your OS", icon: "◐" },
          { value: "full", label: "Full", detail: "All movement", icon: "≋" },
          { value: "reduced", label: "Reduced", detail: "Crossfades only", icon: "≈" },
          { value: "off", label: "Off", detail: "No animation", icon: "▬" },
        ]}
      />
      <Radios
        legend="Theme"
        hint=""
        value={theme}
        onChange={(v) => setPref("theme", v)}
        options={[
          { value: "system", label: "System", detail: "Match your OS", icon: "◐" },
          { value: "light", label: "Paper", detail: "Default", icon: "☐" },
          { value: "dark", label: "Slate", detail: "Chalkboard", icon: "■" },
        ]}
      />

      <Section title="Analytics">
        <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={analytics}
            onChange={(e) => {
              try {
                localStorage.setItem(ANALYTICS_KEY, e.target.checked ? "on" : "off");
              } catch {
                /* storage blocked: stays off */
              }
              analyticsListeners.forEach((l) => l());
            }}
            className="mt-1 size-4 accent-[var(--accent)]"
          />
          <span>
            <span className="block font-medium">Share anonymous usage events</span>
            <span className="block text-sm text-muted">Off by default. Never includes your designs or text.</span>
          </span>
        </label>
      </Section>

      <Section title="Your data">
        <p className="mt-1 text-sm text-muted">Stored in this browser. Sign in (Account) to sync across devices.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn"
            onClick={() =>
              downloadBackup().then(
                () => setStatus("Backup downloaded."),
                (e: Error) => setStatus(`Export failed: ${e.message}`),
              )
            }
          >
            Export backup
          </button>
          <label htmlFor={fileId} className="btn cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent">
            Import backup
            <input
              id={fileId}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                restoreFromFile(file).then(
                  () => setStatus("Backup merged into this device's data."),
                  (err: Error) => setStatus(`Import failed: ${err.message}`),
                );
              }}
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label htmlFor={resetId} className="text-sm text-muted">
            Type <span className="font-mono text-fg">RESET ALL DATA</span> to erase everything (a backup downloads first):
          </label>
          <input
            id={resetId}
            value={resetText}
            onChange={(e) => setResetText(e.target.value)}
            autoComplete="off"
            className="field min-w-0 max-w-full bg-surface-2 text-sm"
          />
          <button
            type="button"
            className="btn text-danger"
            disabled={resetText !== "RESET ALL DATA"}
            onClick={() =>
              import("@/lib/persistence")
                .then((m) => m.resetAllData(resetText))
                .then(
                  () => {
                    setResetText("");
                    setStatus("All data erased. A backup was downloaded first.");
                  },
                  (err: Error) => setStatus(`Reset failed: ${err.message}`),
                )
            }
          >
            Reset all data
          </button>
        </div>
        <p role="status" className="mt-3 min-h-5 text-sm text-muted">
          {status}
        </p>
      </Section>
    </div>
  );
}
