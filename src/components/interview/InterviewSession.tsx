"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CaseStudy } from "@/content/case-studies";
import type { ComponentKind, Design } from "@/engine/types";

export function secondsRemaining(deadline: number, now: number) {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export type ComponentDiffRow = {
  kind: ComponentKind;
  learner: number;
  reference: number;
  delta: number;
};

export function diffComponentKinds(learner: Pick<Design, "nodes">, reference: Pick<Design, "nodes">): ComponentDiffRow[] {
  const counts = new Map<ComponentKind, { learner: number; reference: number }>();
  for (const n of learner.nodes) {
    const prev = counts.get(n.kind) ?? { learner: 0, reference: 0 };
    counts.set(n.kind, { ...prev, learner: prev.learner + 1 });
  }
  for (const n of reference.nodes) {
    const prev = counts.get(n.kind) ?? { learner: 0, reference: 0 };
    counts.set(n.kind, { ...prev, reference: prev.reference + 1 });
  }
  return Array.from(counts.entries())
    .map(([kind, { learner: l, reference: r }]) => ({ kind, learner: l, reference: r, delta: l - r }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

function readSavedSession(storageKey: string): { notes: Record<string, string>; ratings: Record<string, number> } {
  try {
    if (typeof localStorage === "undefined") return { notes: {}, ratings: {} };
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { notes: {}, ratings: {} };
    const parsed = JSON.parse(raw) as { notes?: Record<string, string>; ratings?: Record<string, number> };
    return { notes: parsed.notes ?? {}, ratings: parsed.ratings ?? {} };
  } catch {
    return { notes: {}, ratings: {} };
  }
}

export function InterviewSession({ study: c }: { study: CaseStudy }) {
  const storageKey = `interview-session:${c.id}`;
  const [stage, setStage] = useState(0);
  const [duration, setDuration] = useState(45);
  const [remaining, setRemaining] = useState(45 * 60);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [finished, setFinished] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>(() => readSavedSession(storageKey).notes);
  const [ratings, setRatings] = useState<Record<string, number>>(() => readSavedSession(storageKey).ratings);
  const [learnerDesign, setLearnerDesign] = useState<Pick<Design, "nodes">>({ nodes: [{ id: "client", kind: "client", label: "Clients", position: { x: 0, y: 0 }, params: { entry: "lb" } }] });
  const current = c.rubric[stage];

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ notes, ratings }));
    } catch {
      /* Best-effort session persistence */
    }
  }, [storageKey, notes, ratings]);

  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => {
      const left = secondsRemaining(deadline, Date.now());
      setRemaining(left);
      if (!left) setDeadline(null);
    }, 250);
    return () => clearInterval(timer);
  }, [deadline]);

  useEffect(() => {
    if (!finished) return;
    void import("@/lib/persistence")
      .then(({ openStore }) => openStore())
      .then(async (store) => {
        const designs = await store.designs.list();
        const match = designs.find((d) => d.id.includes(c.id) || d.design.name.toLowerCase().includes(c.title.toLowerCase()));
        if (match) setLearnerDesign(match.design);
        await store.progress.upsert({
          schemaVersion: 1,
          revision: 0,
          itemId: `interview:${c.id}`,
          kind: "lesson",
          completedAt: Date.now(),
        });
      })
      .catch(() => {});
  }, [finished, c.id, c.title]);

  const diffRows = diffComponentKinds(learnerDesign, c.design);
  const button = "min-h-10 rounded-sm border border-rule px-3 hover:bg-surface-2 disabled:opacity-50";
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/interview" className="inline-block min-h-6 text-muted underline">
        All interviews
      </Link>
      <h1 className="mt-4 font-display text-4xl">{c.title}</h1>
      <p className="mt-3 text-muted">{c.summary}</p>
      <p className="mt-3 text-sm text-muted">
        Notes and self-ratings save locally in this browser (`localStorage`), and completing self-assessment records `interview:{c.id}` in your progress store.
      </p>
      <section aria-label="Interview timer" className="mt-6 flex flex-wrap items-center gap-3 border-y border-rule py-4">
        <label>
          Duration{" "}
          <select
            aria-label="Interview duration"
            className="min-h-10 border border-rule bg-surface px-2"
            value={duration}
            onChange={(e) => {
              const minutes = Number(e.target.value);
              setDuration(minutes);
              setRemaining(minutes * 60);
              setDeadline(null);
            }}
          >
            <option value={45}>45 minutes</option>
            <option value={60}>60 minutes</option>
            <option value={0}>Untimed</option>
          </select>
        </label>
        {duration > 0 && (
          <>
            <span className="font-mono" role="timer" aria-label="Time remaining">
              {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
            </span>
            <button
              type="button"
              className={button}
              disabled={!remaining || finished}
              onClick={() => {
                if (deadline !== null) {
                  setRemaining(secondsRemaining(deadline, Date.now()));
                  setDeadline(null);
                } else setDeadline(Date.now() + remaining * 1000);
              }}
            >
              {deadline === null ? "Start / resume" : "Pause"}
            </button>
            <button
              type="button"
              className={button}
              disabled={finished}
              onClick={() => {
                setRemaining((s) => s + 300);
                if (deadline !== null) setDeadline(deadline + 300_000);
              }}
            >
              Add 5 minutes
            </button>
            {!remaining && <p role="status">Time is up. Extend the timer or continue untimed; your work stays available.</p>}
          </>
        )}
      </section>
      <h2 className="mt-8 font-display text-2xl">Requirements checklist</h2>
      <div className="mt-3 grid gap-2">
        {[...c.requirements.functional, ...c.requirements.nonFunctional].map((r) => (
          <label key={r} className="flex min-h-6 items-start gap-3">
            <input type="checkbox" className="mt-1 size-5 shrink-0" />
            {r}
          </label>
        ))}
      </div>
      <details className="mt-5">
        <summary className="min-h-6 cursor-pointer">Clarifying questions</summary>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          {c.clarifyingQuestions.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      </details>
      <div className="mt-6 flex flex-wrap gap-4">
        <Link href={`/sandbox?case=${c.id}&practice=1`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center underline">
          Open a practice canvas (new tab)
        </Link>
        <Link href="/reference" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center underline">
          Estimation calculators (new tab)
        </Link>
      </div>
      {!finished ? (
        <section className="mt-8" aria-labelledby="stage-title">
          <nav aria-label="Interview stages" className="flex flex-wrap gap-2">
            {c.rubric.map((r, i) => (
              <button
                key={r.stage}
                type="button"
                aria-current={stage === i ? "step" : undefined}
                className={`${button} capitalize aria-[current=step]:bg-surface-2`}
                onClick={() => setStage(i)}
              >
                {i + 1}. {r.stage}
              </button>
            ))}
          </nav>
          <h2 id="stage-title" className="mt-6 font-display text-2xl capitalize">
            {current.stage}
          </h2>
          <p className="mt-2 text-muted">
            Suggested time: about {duration ? Math.round(duration / c.rubric.length) : 6} minutes. {current.descriptors[3]}
          </p>
          {current.stage === "deep dive" && (
            <ul className="mt-3 list-disc space-y-2 pl-5">
              {c.failureScenarios.map((f) => (
                <li key={f.id}>
                  <span className="font-medium">{f.title}:</span> {f.explanation}{" "}
                  <Link href={`/sandbox?case=${c.id}&scenario=${f.id}`} target="_blank" rel="noopener noreferrer" className="underline">
                    Run scenario
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <label className="mt-4 block" htmlFor="interview-notes">
            Notes for {current.stage}
          </label>
          <textarea
            id="interview-notes"
            rows={8}
            className="mt-2 w-full rounded-sm border border-rule bg-surface p-3"
            value={notes[current.stage] ?? ""}
            onChange={(e) => setNotes({ ...notes, [current.stage]: e.target.value })}
          />
          <button
            type="button"
            className={`${button} mt-4`}
            onClick={() => {
              if (stage < c.rubric.length - 1) setStage(stage + 1);
              else {
                setFinished(true);
                setDeadline(null);
              }
            }}
          >
            {stage < c.rubric.length - 1 ? "Next stage" : "Finish and self-assess"}
          </button>
        </section>
      ) : (
        <section className="mt-8 space-y-8">
          <div>
            <h2 className="font-display text-2xl">Self-assessment</h2>
            {c.rubric.map((r) => (
              <fieldset key={r.stage} className="mt-5 border-t border-rule py-4">
                <legend className="px-1 font-medium capitalize">{r.stage}</legend>
                {notes[r.stage] && <p className="mb-3 whitespace-pre-wrap text-muted">{notes[r.stage]}</p>}
                {r.descriptors.map((d, i) => (
                  <label key={d} className="mt-2 flex min-h-6 items-start gap-3">
                    <input
                      type="radio"
                      name={`rating-${r.stage}`}
                      value={i + 1}
                      checked={ratings[r.stage] === i + 1}
                      onChange={() => setRatings({ ...ratings, [r.stage]: i + 1 })}
                      className="mt-1 size-5 shrink-0"
                    />
                    {i + 1}. {d}
                  </label>
                ))}
              </fieldset>
            ))}
          </div>

          <div className="border-t border-rule pt-6">
            <h2 className="font-display text-2xl">Component diff (learner vs reference)</h2>
            <table className="mt-3 w-full text-left text-sm">
              <thead>
                <tr className="border-b border-rule text-muted">
                  <th className="py-2 pr-4 font-normal">Component kind</th>
                  <th className="py-2 pr-4 text-right font-normal">Learner</th>
                  <th className="py-2 pr-4 text-right font-normal">Reference</th>
                  <th className="py-2 text-right font-normal">Delta</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule font-mono">
                {diffRows.map((row) => (
                  <tr key={row.kind}>
                    <td className="py-2 pr-4">{row.kind}</td>
                    <td className="py-2 pr-4 text-right">{row.learner}</td>
                    <td className="py-2 pr-4 text-right">{row.reference}</td>
                    <td className="py-2 text-right">{row.delta > 0 ? `+${row.delta}` : row.delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="border-t border-rule pt-6">
            <h2 className="font-display text-2xl">Reference trade-offs &amp; alternatives</h2>
            <ul className="mt-3 list-disc space-y-2 pl-5">
              {c.alternatives.map((alt) => (
                <li key={alt.title}>
                  <span className="font-medium">{alt.title}:</span> {alt.tradeoffs}
                </li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-4">
              <Link href={`/case-studies/${c.id}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center underline">
                Full worked reference (new tab)
              </Link>
              <Link href={`/sandbox?case=${c.id}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center underline">
                Open reference in sandbox (new tab)
              </Link>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
