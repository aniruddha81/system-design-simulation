import type { Metadata } from "next";
import { TrackMap, type MapTrack } from "@/components/lesson/track-map";
import { loadCurriculum, loadLessons } from "@/lib/content/loader";
import { TRACKS } from "@/lib/content/schema";

export const metadata: Metadata = {
  title: "Learn",
  description: "The curriculum map: seven tracks from foundations to interview craft, ordered by prerequisites.",
  alternates: { canonical: "/learn" },
};

export default function LearnPage() {
  const { lessons, depth } = loadCurriculum();
  const titles = new Map(lessons.map((l) => [l.id, l.title]));
  const steps = new Map(loadLessons().map((l) => [l.id, l.stepIds]));
  const tracks: MapTrack[] = TRACKS.map((t) => {
    const inTrack = lessons.filter((l) => l.track === t.id);
    return {
      id: t.id,
      n: t.n,
      title: t.title,
      planned: inTrack.filter((l) => l.status !== "live").length,
      lessons: inTrack
        .filter((l) => l.status === "live" && l.slug)
        .map((l) => ({
          id: l.id,
          slug: l.slug!,
          title: l.title,
          minutes: l.estimatedMinutes ?? 0,
          depth: depth.get(l.id)!,
          needs: l.requires.map((r) => titles.get(r) ?? r),
          steps: steps.get(l.id) ?? [],
        }))
        .sort((a, b) => a.depth - b.depth || a.title.localeCompare(b.title)),
    };
  });
  const live = tracks.reduce((a, t) => a + t.lessons.length, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-12">
      <header className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">Curriculum</h1>
          <p className="mt-3 text-lg text-ink-2">Each tier builds on the one above. Nothing is locked.</p>
        </div>
        <p className="num rounded-md border border-rule bg-surface px-3 py-1.5 text-sm">
          <span aria-hidden>▤ </span>
          {live} lessons · {tracks.length} tracks
        </p>
      </header>
      <TrackMap tracks={tracks} />
    </div>
  );
}
