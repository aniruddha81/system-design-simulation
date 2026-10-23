"use client";
// Submit + verdict report (PLAN §7). Grading runs K seeds in a worker, never on the main thread.
import { useState } from "react";
import type { Challenge } from "@/content/challenges";
import type { Design, GradeReport, Scenario } from "@/engine/types";
import { openStore } from "@/lib/persistence";
import { runTask } from "@/lib/run-manager";
import { elementName } from "./design-ops";
import { fmtMoney, fmtMs, fmtPct } from "./units";

const VERDICT = {
  pass: { icon: "✓", text: "Passed", color: "var(--success)" },
  fail: { icon: "✕", text: "Not yet", color: "var(--danger)" },
  inconclusive: { icon: "?", text: "Inconclusive", color: "var(--warning)" },
};

export function ChallengePanel({ challenge, design, blocked, onReplay }: {
  challenge: Challenge;
  design: Design;
  blocked: string | null;
  onReplay: (input: { scenario: Scenario; seed: number }) => void;
}) {
  const [report, setReport] = useState<GradeReport | null>(null);
  const [grading, setGrading] = useState<null | (() => void)>(null);
  const [error, setError] = useState<string | null>(null);
  const [hintsShown, setHintsShown] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const name = (id: string) => elementName(design, id);

  async function submit() {
    setError(null);
    setSaved(null);
    const task = runTask<GradeReport>({ type: "grade", design, challenge: challenge.spec });
    setGrading(() => task.cancel);
    try {
      const r = await task.promise;
      setReport(r);
      if (r.verdict === "pass") {
        try {
          const store = await openStore();
          await store.progress.upsert({ schemaVersion: 1, revision: 0, itemId: `challenge:${challenge.id}`, kind: "challenge", stars: r.stars, completedAt: Date.now() });
          setSaved("Progress saved.");
        } catch (e) {
          setSaved(`Progress not saved: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      if ((e as Error).message !== "Cancelled") setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGrading(null);
    }
  }

  const hints = report?.hints ?? challenge.hints;
  const worst = report?.perSeed.find((s) => s.failures.length) ?? report?.perSeed[0];
  const bn = worst?.result.bottleneck;
  const v = report ? VERDICT[report.verdict] : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!!blocked || !!grading}
          title={blocked ?? undefined}
          onClick={() => void submit()}
          className="h-9 rounded-(--radius-sm) bg-(--accent) px-4 text-sm font-semibold text-(--bg) hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent) disabled:opacity-40"
        >
          {grading ? "Grading 5 seeds…" : "Submit for grading"}
        </button>
        {grading && <button type="button" onClick={grading} className="h-9 rounded-(--radius-sm) border border-(--border) px-3 text-sm hover:bg-(--surface-2)">Cancel</button>}
      </div>
      {blocked && <p className="text-xs text-(--text-muted)">{blocked}</p>}
      <p role="status" className="sr-only">{grading ? "Grading" : report && v ? `${v.text}, ${report.stars} of 3 stars` : ""}</p>
      {error && <p className="text-sm text-(--danger)">✕ {error}</p>}

      {report && v && (
        <section aria-label="Verdict" className="flex flex-col gap-4 rounded-(--radius) border p-3" style={{ borderColor: v.color }}>
          <header className="flex items-center gap-3">
            <span className="text-xl font-semibold" style={{ color: v.color }}>{v.icon} {v.text}</span>
            <span className="ml-auto text-lg tracking-widest" aria-label={`${report.stars} of 3 stars`}>
              {[1, 2, 3].map((i) => <span key={i} style={{ color: i <= report.stars ? "var(--warning)" : "var(--border)" }}>★</span>)}
            </span>
          </header>
          <p className="text-xs text-(--text-muted)">
            Cost {fmtMoney(report.costPerMonth)}/mo of {fmtMoney(challenge.spec.budgetPerMonth)} budget
            {report.costPerMonth <= 0.8 * challenge.spec.budgetPerMonth ? " (≤ 80%: eligible for ★★)" : ""}. ★★★ also requires passing the variant chaos set.
          </p>
          {saved && <p className="text-xs text-(--text-muted)">{saved}</p>}
          {report.perSeed.length === 0 && (
            <p className="text-sm">The design was not run: it is invalid, uses a component this challenge does not allow, or asks for an invariant the grader cannot certify yet.</p>
          )}
          {report.perSeed.length > 0 && (
            <table className="w-full text-xs tabular-nums">
              <caption className="mb-1 text-left text-xs font-medium uppercase tracking-wider text-(--text-muted)">Per seed</caption>
              <thead><tr className="text-left text-(--text-muted)"><th className="py-1 font-medium">Seed</th><th className="py-1 font-medium">Goodput</th><th className="py-1 font-medium">p99</th><th className="py-1 font-medium">Result</th></tr></thead>
              <tbody>
                {report.perSeed.map((s, i) => (
                  <tr key={i} className="border-t border-(--border) align-top">
                    <td className="py-1.5 pr-2">{s.seed}{i >= challenge.spec.seeds.length ? " (variant chaos)" : ""}</td>
                    <td className="py-1.5 pr-2">{fmtPct(s.result.metrics.goodput, 2)}</td>
                    <td className="py-1.5 pr-2">{fmtMs(s.result.metrics.successLatency.p99)}</td>
                    <td className="py-1.5">
                      {s.failures.length === 0 ? (
                        <span className="text-(--success)">✓ met</span>
                      ) : (
                        <>
                          <ul className="mb-1 flex flex-col gap-0.5 text-(--danger)">{s.failures.map((f, j) => <li key={j}>✕ {f}</li>)}</ul>
                          <button type="button" onClick={() => onReplay({ scenario: { ...challenge.spec.scenario, chaos: s.result.runKey.chaosTimeline }, seed: s.result.runKey.seed })} className="text-(--accent) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-(--accent)">
                            ▶ Replay this failure
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {bn && (
            <p className="text-sm">
              ◎ Bottleneck{worst?.failures.length ? " in the first failing seed" : ""}: <strong>{name(bn.nodeId)}</strong> — {fmtPct(bn.utilisation, 0)} busy, queue growth {bn.queueGrowth.toFixed(1)}/s
              {bn.retryAmplification != null ? `, retry amplification ${bn.retryAmplification.toFixed(2)}×` : ""}.
            </p>
          )}
        </section>
      )}

      {(report?.verdict !== "pass" || hintsShown > 0) && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-(--text-muted)">Hints</h3>
          <ol className="flex flex-col gap-2 text-sm">
            {hints.slice(0, hintsShown).map((h, i) => (
              <li key={i} className="rounded-(--radius-sm) bg-(--bg) p-2"><span className="text-(--text-muted)">Hint {i + 1}. </span>{h}</li>
            ))}
          </ol>
          {hintsShown < 3 && (
            <button type="button" onClick={() => setHintsShown(hintsShown + 1)} className="h-8 self-start rounded-(--radius-sm) border border-(--border) px-3 text-sm hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)">
              {hintsShown === 0 ? "Show a hint" : hintsShown === 1 ? "Show a bigger hint" : "Show the answer outline"}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
