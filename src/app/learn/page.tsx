import type { Metadata } from "next";
import Link from "next/link";
import { LessonBadge } from "@/components/lesson/status";
import { loadCurriculum } from "@/lib/content/loader";
import { TRACKS } from "@/lib/content/schema";

export const metadata: Metadata = {
  title: "Learn",
  description: "The curriculum map: seven tracks from foundations to interview craft, ordered by prerequisites.",
  alternates: { canonical: "/learn" },
};

export default function LearnPage() {
  const { lessons, depth } = loadCurriculum();
  const titles = new Map(lessons.map((l) => [l.id, l.title]));
  const live = lessons.filter((l) => l.status === "live").length;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-12">
      <header className="mb-12 max-w-2xl border-b-2 border-fg pb-8">
        <h1 className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">Curriculum</h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-2">
          Lessons are ordered by what they build on. Nothing is locked: if you skip ahead, the lesson tells you what you may be missing.
        </p>
        <p className="mt-3 text-sm text-muted">
          <span className="num text-fg">{live}</span> of <span className="num">{lessons.length}</span> lessons are live. The rest are planned and marked as such.
        </p>
      </header>

      <ol className="grid gap-14">
        {TRACKS.map((track) => {
          const inTrack = lessons
            .filter((l) => l.track === track.id)
            .sort((a, b) => depth.get(a.id)! - depth.get(b.id)! || a.title.localeCompare(b.title));
          return (
            <li key={track.id} aria-labelledby={`track-${track.id}`} className="grid gap-4 md:grid-cols-[12rem_1fr] md:gap-8">
              <div>
                <p className="mb-2 font-mono text-sm text-accent">Track {track.n}</p>
                <h2 id={`track-${track.id}`} className="font-display text-2xl leading-tight tracking-tight">
                  {track.title}
                </h2>
              </div>
              <ul className="grid gap-x-6 sm:grid-cols-2">
                {inTrack.map((l) => {
                  const body = (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="font-medium leading-snug">{l.title}</h3>
                        {l.status === "live" ? (
                          <span className="shrink-0 text-xs font-medium text-accent-2">Live</span>
                        ) : (
                          <span className="shrink-0 text-xs text-muted">Planned</span>
                        )}
                      </div>
                      {l.requires.length > 0 && (
                        <p className="mt-2 text-sm text-muted">Builds on {l.requires.map((r) => titles.get(r)).join(", ")}</p>
                      )}
                      {l.status === "live" && (
                        <p className="mt-3 flex items-center justify-between text-sm text-muted">
                          <span>
                            <span className="num">{l.estimatedMinutes}</span> min
                          </span>
                          <LessonBadge lessonId={l.id} />
                        </p>
                      )}
                    </>
                  );
                  return (
                    <li key={l.id}>
                      {l.status === "live" ? (
                        <Link
                          href={`/learn/${l.track}/${l.slug}`}
                          className="block h-full border-t border-rule py-5 transition-colors hover:bg-surface"
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className="h-full border-t border-border py-5">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
