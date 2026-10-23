"use client";

import Link from "next/link";
import { ids, isCompleted, useProgress } from "./progress";

type Prereq = { id: string; title: string; href?: string };

/** Nothing is hard-locked (PLAN §2): a soft notice for prerequisites not yet completed. */
export function PrereqNotice({ requires }: { requires: Prereq[] }) {
  const progress = useProgress();
  if (!progress) return null;
  const missing = requires.filter((r) => !isCompleted(progress, ids.lesson(r.id)));
  if (missing.length === 0) return null;
  return (
    <aside role="note" className="mb-8 flex gap-3 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm">
      <span aria-hidden className="font-bold text-warning">
        !
      </span>
      <p>
        <strong className="font-semibold">You may be missing </strong>
        {missing.map((r, i) => (
          <span key={r.id}>
            {i > 0 && (i === missing.length - 1 ? " and " : ", ")}
            {r.href ? (
              <Link href={r.href} className="underline underline-offset-4">
                {r.title}
              </Link>
            ) : (
              <>
                {r.title} <span className="text-muted">(planned)</span>
              </>
            )}
          </span>
        ))}
        . You can continue anyway; the <Link href="/reference" className="underline underline-offset-4">reference</Link> covers the essentials.
      </p>
    </aside>
  );
}

/** Completion state for a lesson on the curriculum map: text and icon, never colour alone. */
export function LessonBadge({ lessonId }: { lessonId: string }) {
  const progress = useProgress();
  const rec = progress?.get(ids.lesson(lessonId));
  if (!rec) return null;
  if ((rec.mastery ?? 0) >= 0.8) return <span className="text-xs font-medium text-success">★ Mastered</span>;
  if (rec.completedAt !== undefined) return <span className="text-xs font-medium text-accent-2">✓ Completed</span>;
  return null;
}
