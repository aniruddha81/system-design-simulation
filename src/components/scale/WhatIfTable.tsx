import { Figure, nb } from "@/components/models/notebook";
import type { Prediction, WhatIfResult } from "@/engine/scale";
import type { Design } from "@/engine/types";
import { formatDuration, formatNumber, formatPercent, formatRps, formatUsdEstimate } from "@/lib/format";
import { componentName, rungKey } from "./plan";

function valueAt(object: object, path: string): number | null {
  let value: unknown = object;
  for (const key of path.split(".")) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null;
  return typeof value === "number" ? value : null;
}

const words = (path: string) => path.replaceAll(".", " / ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
const predictionFor = (path: string): Prediction =>
  path === "estimatedTimelySuccessRatio" ? "timelySuccess"
  : /latency|timeout|lag|timeTo90/i.test(path) ? "latency"
  : /cache/.test(path) ? "hitRate"
  : /cost/.test(path) ? "cost"
  : /drops|failed/.test(path) ? "drops"
  : /backlog|queue|depth/i.test(path) ? "backlog"
  : "utilisation";

const format = (path: string, n: number) =>
  /latency|timeout|lag|timeTo90/i.test(path) && !path.endsWith("Fraction") ? formatDuration(n)
  : /ratio|availability|fraction|hitRate|utilisation/i.test(path) ? formatPercent(n)
  : /cost/.test(path) ? formatUsdEstimate(n).replace(" (estimate)", "")
  : /perSec/i.test(path) ? formatRps(n)
  : formatNumber(n, 2);

type Row = { name: string; a: string; b: string; delta: string };

/** Use the engine's complete diff inventory, including optional cache, queue and replica metrics. */
export function whatIfRows(result: WhatIfResult, design: Design): Row[] {
  const rows: Row[] = [];
  const add = (name: string, path: string, left: object, right: object) => {
    const prediction = predictionFor(path);
    const va = valueAt(left, path), vb = valueAt(right, path);
    const enabledA = result.a.fidelity.predictions[prediction].enabled, enabledB = result.b.fidelity.predictions[prediction].enabled;
    const delta = va !== null && vb !== null && enabledA && enabledB ? vb - va : null;
    rows.push({
      name,
      a: !enabledA ? "disabled" : va === null ? "unavailable" : format(path, va),
      b: !enabledB ? "disabled" : vb === null ? "unavailable" : format(path, vb),
      delta: delta === null ? "unavailable" : delta === 0 ? "±0" : `${delta > 0 ? "+" : "−"}${/ratio|availability|fraction|hitRate|utilisation/i.test(path) ? `${(Math.abs(delta) * 100).toFixed(1)} pp` : format(path, Math.abs(delta))}`,
    });
  };
  for (const path of Object.keys(result.deltas)) add(words(path), path, result.a.metrics, result.b.metrics);
  for (const [id, deltas] of Object.entries(result.nodeDeltas)) {
    const a = result.a.nodes.find((n) => n.nodeId === id), b = result.b.nodes.find((n) => n.nodeId === id);
    for (const path of Object.keys(deltas)) add(`${componentName(design, id)} (${id}): ${words(path)}`, path, a ?? {}, b ?? {});
  }
  return rows;
}

export function WhatIfTable({ diff, design }: { diff: { label: string; multiple: number; result: WhatIfResult }; design: Design }) {
  const { a, b, ladder } = diff.result;
  const rows = whatIfRows(diff.result, design);
  const keys = [...new Set([...ladder.a, ...ladder.b].map(rungKey))];
  return (
    <Figure className="" no="S5" title={`What-if: ${diff.label}`} note={`Both designs at ${formatNumber(diff.multiple, 1)}× the selected load. Correctness remains unknown.`}>
      <p>
        <span className={`${nb.stamp} ${ladder.improved ? "text-success" : "text-warning"}`}>
          {ladder.improved ? "✓ ladder improved" : "✕ ladder did not improve"}
        </span>
      </p>
      {(a.outcome !== "finished" || b.outcome !== "finished") && <p className="text-warning">! An estimate stopped early; no remedy is verified.</p>}
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Every metric: current design, what-if design and change</caption>
          <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
            <tr>
              {["Metric", "Current", "What-if", "Δ"].map((h, i) => (
                <th key={h} scope="col" className={`px-2 py-1.5 font-medium ${i > 0 ? "text-right" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-t border-dashed border-border">
                <th scope="row" className="px-2 py-1.5 text-left font-normal">{row.name}</th>
                {[row.a, row.b, row.delta].map((v, i) => <td key={i} className="num px-2 py-1.5 text-right">{v}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="mb-2 text-left font-medium">Failure ladder: {ladder.a.length} → {ladder.b.length} rungs (Δ {ladder.b.length - ladder.a.length})</caption>
          <thead className="text-left text-muted">
            <tr>{["Failure", "Current", "What-if", "Change"].map((h) => <th key={h} scope="col" className="px-2 py-1.5 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const left = ladder.a.find((r) => rungKey(r) === key), right = ladder.b.find((r) => rungKey(r) === key), rung = left ?? right!;
              return (
                <tr key={key} className="border-t border-dashed border-border">
                  <th scope="row" className="px-2 py-1.5 text-left font-normal">{componentName(design, rung.component)}: {rung.what}</th>
                  <td className="px-2 py-1.5">{left ? "present" : "absent"}</td>
                  <td className="px-2 py-1.5">{right ? "present" : "absent"}</td>
                  <td className="px-2 py-1.5">{left && right ? "unchanged" : left ? "removed" : "added"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!keys.length && <p className="text-sm text-muted">No failures predicted in either design.</p>}
      </div>
      {[{ label: "Current", result: a }, { label: "What-if", result: b }].map(({ label, result }) => {
        const reasons = [...new Set(Object.values(result.fidelity.predictions).flatMap((p) => p.enabled ? [] : p.reasons))];
        return <p key={label} className={nb.note}>{label}: {reasons.join(" ")}</p>;
      })}
    </Figure>
  );
}
