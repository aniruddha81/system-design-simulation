"use client";

import Link from "next/link";
import { ids, isCompleted, useProgress } from "@/components/lesson/progress";
import { formatPercent } from "@/lib/format";

export type LessonSummary = {
  id: string;
  title: string;
  href: string;
  steps: string[];
  objectives: { id: string; text: string; step?: string }[];
};

const MASTERED = 0.8;

export function ProgressView({ lessons }: { lessons: LessonSummary[] }) {
  const progress = useProgress();
  if (!progress) return <p className="mt-10 text-muted" role="status">Loading progress…</p>;

  const rows = lessons.map((l) => {
    const rec = progress.get(ids.lesson(l.id));
    const stepsDone = l.steps.filter((s) => isCompleted(progress, ids.step(l.id, s))).length;
    return { ...l, rec, stepsDone, mastered: (rec?.mastery ?? 0) >= MASTERED, completed: rec?.completedAt !== undefined };
  });
  // ponytail: review queue = objectives last scored below 80%; SM-2 scheduling (store.reviews) when it joins the contract.
  const due = lessons.flatMap((l) =>
    l.objectives
      .map((o) => ({ lesson: l, objective: o, rec: progress.get(ids.objective(l.id, o.id)) }))
      .filter((x) => x.rec?.mastery !== undefined && x.rec.mastery < MASTERED),
  );

  const stats = [
    { label: "Completed", value: rows.filter((r) => r.completed).length, icon: "✓" },
    { label: "Mastered", value: rows.filter((r) => r.mastered).length, icon: "★" },
    { label: "Tested out", value: 0, icon: "⇥", note: "Placement checks arrive with Track 0" },
    { label: "Due for review", value: due.length, icon: "↻" },
  ];

  return (
    <div className="mt-10 grid gap-12">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="panel p-4">
            <dt className="flex items-center gap-2 text-sm text-muted">
              <span aria-hidden>{s.icon}</span>
              {s.label}
            </dt>
            <dd className="num mt-1 text-3xl font-semibold">{s.value}</dd>
            {s.note && <dd className="mt-1 text-xs text-muted">{s.note}</dd>}
          </div>
        ))}
      </dl>

      <section aria-labelledby="review">
        <h2 id="review" className="mb-4 text-xl font-semibold">
          Review queue
        </h2>
        {due.length === 0 ? (
          <p className="text-muted">Nothing due. Objectives you miss in a mastery check land here.</p>
        ) : (
          <ul className="grid gap-2">
            {due.map(({ lesson, objective, rec }) => (
              <li key={`${lesson.id}/${objective.id}`} className="panel flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="font-medium">{objective.text}</p>
                  <p className="text-sm text-muted">
                    {lesson.title}, last score <span className="num">{formatPercent(rec!.mastery!, 0)}</span>
                  </p>
                </div>
                <Link href={`${lesson.href}${objective.step ? `#step-${objective.step}` : ""}`} className="btn">
                  Review
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="lessons">
        <h2 id="lessons" className="mb-4 text-xl font-semibold">
          Lessons
        </h2>
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li key={r.id} className="panel flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <Link href={r.href} className="font-medium underline-offset-4 hover:underline">
                  {r.title}
                </Link>
                <p className="text-sm text-muted">
                  <span className="num">{r.stepsDone}</span> of <span className="num">{r.steps.length}</span> steps
                  {r.rec?.mastery !== undefined && (
                    <>
                      , best mastery check <span className="num">{formatPercent(r.rec.mastery, 0)}</span>
                    </>
                  )}
                </p>
              </div>
              <span className={`text-sm font-medium ${r.mastered ? "text-success" : r.completed ? "text-accent-2" : "text-muted"}`}>
                {r.mastered ? "★ Mastered" : r.completed ? "✓ Completed" : r.stepsDone > 0 ? "◐ In progress" : "○ Not started"}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
