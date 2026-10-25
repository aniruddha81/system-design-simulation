"use client";

import Link from "next/link";
import { Ring, RingText } from "./ring";
import { ids, isCompleted, useProgress, type Progress } from "./progress";

export type MapLesson = { id: string; slug: string; title: string; minutes: number; depth: number; needs: string[]; steps: string[] };
export type MapTrack = { id: string; n: number; title: string; lessons: MapLesson[]; planned: number };

const MASTERED = 0.8;
type State = "mastered" | "done" | "started" | "new";
const GLYPH: Record<State, string> = { mastered: "★", done: "✓", started: "◐", new: "○" };
const LABEL: Record<State, string> = { mastered: "Mastered", done: "Completed", started: "In progress", new: "Not started" };
const TONE: Record<State, string> = { mastered: "var(--success)", done: "var(--accent-2)", started: "var(--accent)", new: "var(--rule)" };

function state(p: Progress | null, l: MapLesson): { s: State; frac: number } {
  const rec = p?.get(ids.lesson(l.id));
  const done = l.steps.filter((x) => isCompleted(p, ids.step(l.id, x))).length;
  const frac = l.steps.length ? done / l.steps.length : 0;
  if ((rec?.mastery ?? 0) >= MASTERED) return { s: "mastered", frac: 1 };
  if (rec?.completedAt !== undefined) return { s: "done", frac: 1 };
  return { s: done > 0 ? "started" : "new", frac };
}

/** Curriculum as a map: a ring per track, then tiers of lesson tiles (a tier builds on the one above it). */
export function TrackMap({ tracks }: { tracks: MapTrack[] }) {
  const progress = useProgress();
  const summary = tracks.map((t) => {
    const st = t.lessons.map((l) => state(progress, l));
    const finished = st.filter((x) => x.s === "done" || x.s === "mastered").length;
    return { t, st, finished, total: t.lessons.length };
  });

  return (
    <>
      <nav aria-label="Tracks" className="paper-grid mb-12 border-y border-rule py-5">
        <ol className="flex flex-wrap items-start gap-x-2 gap-y-4">
          {summary.map(({ t, finished, total }, i) => (
            <li key={t.id} className="flex items-center gap-2">
              <a href={`#track-${t.id}`} className="grid w-[5.5rem] justify-items-center gap-1 rounded-md p-1 text-center hover:bg-surface">
                <Ring value={total ? finished / total : 0} size={52} stroke={6}>
                  <RingText size={52} fontSize={12}>
                    {t.n}
                  </RingText>
                </Ring>
                <span className="text-xs leading-tight">{t.title}</span>
                <span className="num text-xs text-muted">
                  {finished}/{total}
                </span>
              </a>
              {i < summary.length - 1 && (
                <span aria-hidden className="mb-8 hidden text-rule sm:block">
                  ⟶
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <ol className="grid gap-12">
        {summary.map(({ t, st, finished, total }) => {
          const tiers = [...new Set(t.lessons.map((l) => l.depth))].sort((a, b) => a - b);
          const minutes = t.lessons.reduce((a, l) => a + l.minutes, 0);
          return (
            <li key={t.id} id={`track-${t.id}`} aria-labelledby={`h-${t.id}`} className="scroll-mt-24">
              <div className="mb-5 flex flex-wrap items-center gap-4 border-b-2 border-fg pb-3">
                <Ring value={total ? finished / total : 0} size={56} stroke={6} label={`${finished} of ${total} lessons completed`}>
                  <RingText size={56} fontSize={13}>
                    {finished}/{total}
                  </RingText>
                </Ring>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs text-accent">Track {t.n}</p>
                  <h2 id={`h-${t.id}`} className="font-display text-2xl leading-tight tracking-tight">
                    {t.title}
                  </h2>
                </div>
                <p className="num flex gap-3 text-sm text-muted">
                  <span>{total} lessons</span>
                  <span>~{minutes} min</span>
                </p>
              </div>
              <div className="paper-grid grid gap-0 rounded-md border border-border p-3 sm:p-4">
                {tiers.map((d, ti) => (
                  <div key={d}>
                    {ti > 0 && (
                      <svg aria-hidden viewBox="0 0 24 20" className="mx-auto my-1 h-5 w-6 text-rule">
                        <path d="M12 0v14M6 9l6 7 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" />
                      </svg>
                    )}
                    <ul className="flex flex-wrap justify-center gap-2" aria-label={`Tier ${ti + 1}`}>
                      {t.lessons.flatMap((l, i) =>
                        l.depth !== d ? (
                          []
                        ) : (
                          <li key={l.id}>
                            <Link
                              href={`/learn/${t.id}/${l.slug}`}
                              title={l.needs.length ? `Builds on ${l.needs.join(", ")}` : undefined}
                              className="flex min-h-14 w-[9.5rem] items-center gap-2 rounded-md border border-rule bg-surface p-2 transition-colors hover:bg-[color-mix(in_oklab,var(--highlight-mark)_30%,var(--surface))] sm:w-[11rem]"
                            >
                              <Ring value={st[i].frac} size={32} stroke={4} tone={TONE[st[i].s]}>
                                <RingText size={32} fontSize={12}>
                                  {GLYPH[st[i].s]}
                                </RingText>
                              </Ring>
                              <span className="min-w-0">
                                <span className="block text-sm font-medium leading-tight">{l.title}</span>
                                <span className="num block text-xs text-muted">
                                  {l.minutes} min<span className="sr-only">, {LABEL[st[i].s]}</span>
                                </span>
                              </span>
                            </Link>
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                ))}
                {t.planned > 0 && <p className="num mt-3 text-center text-xs text-muted">+{t.planned} planned</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
