"use client";

import { bloomStatistics, countMinBounds, countMinEstimate, createSketchModel, hllStatistics, type SketchState } from "@/models";
import { FocusedPlayer, ModelTable } from "./FocusedPlayer";

const model = createSketchModel({ bloomBits: 64, bloomHashes: 3, width: 12, depth: 3, hllPrecision: 4 });
const percent = (v: number) => `${(v * 100).toFixed(2)}%`;
const summary = (s: SketchState) => { const b = bloomStatistics(s), h = hllStatistics(s); return `${s.total} updates, ${s.counts.length} distinct keys. Bloom ${s.bits.filter(Boolean).length}/${s.bits.length} bits set; measured false positives ${b.probes ? percent(b.measured) : "not measured"}, theoretical ${percent(b.theoretical)}. HLL ${h.estimate.toFixed(2)} vs actual ${h.actual}, relative error ${percent(h.relativeError)}, standard error ${percent(h.standardError)}.`; };

export function SketchesPlayer({ seed = 1 }: { seed?: number }) {
  return <FocusedPlayer model={model} seed={seed} no="M11" title="Probabilistic structures, measured against truth" summary={summary}>{p => {
    const s = p.state, b = bloomStatistics(s), h = hllStatistics(s), bounds = countMinBounds(s);
    return <>
      <p className="text-sm">Small teaching structures expose collisions: {s.bits.length} Bloom bits, {s.config.depth} × {s.config.width} count-min cells, {s.registers.length} HLL registers. Outlined cells changed in the latest step.</p>
      <section aria-label="Bloom bit array"><h3 className="mb-2 font-medium">Bloom bit array</h3>
        <div className="grid grid-cols-8 gap-1 sm:grid-cols-16">{s.bits.map((bit, i) => <span key={i} className="num border p-1 text-center text-xs" style={{ background: bit ? "var(--surface-2)" : "var(--surface)", borderColor: p.previous && bit !== p.previous.bits[i] ? "var(--accent)" : "var(--border)" }} title={`Bit ${i}: ${bit}`} aria-label={`Bit ${i}: ${bit}`}>{bit}</span>)}</div>
      </section>
      <ModelTable caption="Count-min counter matrix · column indices start at zero" headers={["Row", ...s.table[0].map((_, i) => String(i))]} rows={s.table.map((row, i) => [i, ...row.map((count, j) => <span key={j} className={p.previous && count !== p.previous.table[i][j] ? "marker" : ""}>{count}</span>)])} />
      <ModelTable caption="HyperLogLog registers" headers={["Register", "Leading-zero rank"]} rows={s.registers.map((rank, i) => [i, rank])} />
      <ModelTable caption="Measured versus theoretical error" headers={["Structure", "Measured", "Prediction / bound"]} rows={[
        ["Bloom false-positive rate", b.probes ? `${percent(b.measured)} across ${b.probes} absent probes` : "No absent probes yet", percent(b.theoretical)],
        ["Count-min additive error", Math.max(0, ...s.counts.map(([key, count]) => countMinEstimate(s, key) - count)), `≤ ${bounds.additiveError.toFixed(2)} per key with probability ≥ ${percent(1 - bounds.delta)}`],
        ["HLL relative error", `${percent(h.relativeError)} (${h.estimate.toFixed(2)} estimated / ${h.actual} actual)`, `${percent(h.standardError)} standard error`],
      ]} />
      <p className="text-sm text-muted">Statistical predictions describe distributions across hashes; a single seeded run can exceed them. Exact counts are retained only as a teaching reference.</p>
      <ModelTable caption="Per-key count estimates" headers={["Key", "Actual", "Estimate", "Overcount"]} rows={s.counts.map(([key, count]) => [key, count, countMinEstimate(s, key), countMinEstimate(s, key) - count])} />
    </>;
  }}</FocusedPlayer>;
}
