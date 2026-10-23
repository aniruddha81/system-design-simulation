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
      <header className="mb-12 max-w-2xl">
        <h1 className="text-4xl font-semibold tracking-tight">Curriculum</h1>
        <p className="mt-4 text-lg leading-relaxed text-muted">
          Lessons are ordered by what they build on. Nothing is locked: if you skip ahead, the lesson tells you what you may be missing.
        </p>
        <p className="mt-3 text-sm text-muted">
          <span className="num text-fg">{live}</span> of <span className="num">{lessons.length}</span> lessons are live. The rest are planned and marked as such.
        </p>
      </header>

      <ol className="grid gap-12">
        {TRACKS.map((track) => {
          const inTrack = lessons
            .filter((l) => l.track === track.id)
            .sort((a, b) => depth.get(a.id)! - depth.get(b.id)! || a.title.localeCompare(b.title));
          return (
            <li key={track.id} aria-labelledby={`track-${track.id}`} className="grid gap-4 md:grid-cols-[12rem_1fr] md:gap-8">
              <div>
                <p className="num text-sm text-muted">Track {track.n}</p>
                <h2 id={`track-${track.id}`} className="text-xl font-semibold tracking-tight">
                  {track.title}
                </h2>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {inTrack.map((l) => {
                  const body = (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="font-medium leading-snug">{l.title}</h3>
                        {l.status === "live" ? (
                          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">Live</span>
                        ) : (
                          <span className="shrink-0 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted">Planned</span>
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
                          className="panel block h-full p-4 shadow-e2 transition-colors hover:border-accent"
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className="h-full rounded-[var(--radius-lg)] border border-dashed border-border p-4 opacity-75">{body}</div>
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
