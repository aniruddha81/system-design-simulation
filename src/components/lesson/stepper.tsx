"use client";

import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";
import { ids, saveProgress, useProgress } from "./progress";

type LessonCtx = {
  lessonId: string;
  revision: number;
  stepIds: string[];
  current: number;
  focusKey: number;
  done: Set<string>;
  markDone: (stepId: string) => void;
};
const Lesson = createContext<LessonCtx | null>(null);
const StepId = createContext<string | null>(null);

export function useLesson(): LessonCtx {
  const ctx = use(Lesson);
  if (!ctx) throw new Error("Lesson widgets must be inside <LessonStepper>");
  return ctx;
}

/** Marks the enclosing step's interaction as complete (unlocks Continue). */
export function useStepDone(): () => void {
  const { markDone } = useLesson();
  const stepId = use(StepId);
  return () => {
    if (stepId) markDone(stepId);
  };
}

/** Brilliant-style stepper: one step at a time; progress keyed by stable stepId. */
export function LessonStepper({
  lessonId,
  revision,
  stepIds,
  stepTitles,
  children,
}: {
  lessonId: string;
  revision: number;
  stepIds: string[];
  stepTitles: string[];
  children: ReactNode;
}) {
  const progress = useProgress();
  const [localDone, setLocalDone] = useState<Set<string>>(() => new Set());
  const [chosen, setChosen] = useState<number | null>(null);
  const [focusKey, setFocusKey] = useState(0);

  // Stored progress only counts steps that still exist (removed steps drop out).
  const done = new Set(localDone);
  for (const s of stepIds) if (progress?.get(ids.step(lessonId, s))?.completedAt !== undefined) done.add(s);
  const firstOpen = stepIds.findIndex((s) => !done.has(s));
  const reachable = firstOpen === -1 ? stepIds.length - 1 : firstOpen;
  const current = Math.min(chosen ?? reachable, reachable);
  const finished = firstOpen === -1;

  const goTo = (index: number) => {
    setChosen(Math.max(0, Math.min(index, stepIds.length - 1)));
    setFocusKey((k) => k + 1);
  };

  // Remediation links point at #step-<id>.
  useEffect(() => {
    const onHash = () => {
      const i = stepIds.indexOf(location.hash.replace(/^#step-/, ""));
      if (i >= 0) {
        setChosen(i);
        setFocusKey((k) => k + 1);
      }
    };
    onHash();
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [stepIds]);

  const markDone = (stepId: string) => {
    if (done.has(stepId)) return;
    setChosen((c) => c ?? current); // pin the resume point so finishing a step never auto-advances
    const now = Date.now();
    setLocalDone((prev) => new Set(prev).add(stepId));
    void saveProgress({ itemId: ids.step(lessonId, stepId), kind: "step", completedAt: now }, revision);
    if (stepIds.every((s) => s === stepId || done.has(s))) {
      void saveProgress({ itemId: ids.lesson(lessonId), kind: "lesson", completedAt: now }, revision);
    }
  };

  const stepDone = done.has(stepIds[current]);
  const last = current === stepIds.length - 1;

  return (
    <Lesson value={{ lessonId, revision, stepIds, current, focusKey, done, markDone }}>
      <nav aria-label="Lesson steps" className="mb-8 border-t-2 border-fg pt-5">
        <p className="mb-3 text-sm text-muted">
          Step <span className="num text-fg">{current + 1}</span> of <span className="num">{stepIds.length}</span>
          {finished && <span className="ml-3 font-medium text-success">✓ Lesson complete</span>}
        </p>
        <ol className="flex flex-wrap gap-2">
          {stepIds.map((s, i) => (
            <li key={s} className="min-w-8 flex-1">
              <button
                type="button"
                onClick={() => goTo(i)}
                disabled={i > reachable}
                aria-current={i === current ? "step" : undefined}
                aria-label={`Step ${i + 1}: ${stepTitles[i]}${done.has(s) ? " (done)" : i > reachable ? " (locked)" : ""}`}
                className="group flex h-8 w-full items-center justify-center border border-rule font-mono text-xs disabled:cursor-not-allowed aria-[current=step]:border-2 aria-[current=step]:border-fg aria-[current=step]:bg-surface-2"
              >
                <span
                  className={`transition-colors ${
                    i === current ? "font-semibold text-accent" : done.has(s) ? "text-accent-2" : "text-muted group-enabled:group-hover:text-fg"
                  }`}
                >
                  <span aria-hidden>{done.has(s) ? "✓" : i + 1}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {children}

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <button type="button" className="btn btn-ghost" onClick={() => goTo(current - 1)} disabled={current === 0}>
          Back
        </button>
        {!stepDone && <p className="text-sm text-muted">Answer this step to continue.</p>}
        {last ? (
          <p className={`text-sm font-medium ${finished ? "text-success" : "text-muted"}`}>
            {finished ? "✓ Lesson complete. Progress saved on this device." : "Last step"}
          </p>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => goTo(current + 1)} disabled={!stepDone}>
            Continue
          </button>
        )}
      </div>
    </Lesson>
  );
}

export function Step({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  const { stepIds, current, focusKey, done } = useLesson();
  const index = stepIds.indexOf(id);
  const isCurrent = index === current;
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (isCurrent && focusKey > 0) {
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ block: "nearest" });
    }
  }, [isCurrent, focusKey]);

  return (
    <section id={`step-${id}`} hidden={!isCurrent} aria-labelledby={`step-${id}-title`} className="scroll-mt-24">
      <StepId value={id}>
        <h2 id={`step-${id}-title`} ref={heading} tabIndex={-1} className="mb-5 font-display text-3xl tracking-tight outline-none sm:text-4xl">
          {title}
          {done.has(id) && <span className="sr-only"> (done)</span>}
        </h2>
        <div className="prose-lesson">{children}</div>
      </StepId>
    </section>
  );
}
