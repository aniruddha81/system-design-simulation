import type { Metadata } from "next";
import { loadLessons } from "@/lib/content/loader";
import { TRACKS } from "@/lib/content/schema";
import { templates } from "@/lib/content/variants";
import { challenges } from "@/content/challenges";
import { ProgressView, type LessonSummary } from "./progress-view";

export const metadata: Metadata = {
  title: "Progress",
  description: "Lessons completed and mastered, track placement checks, and the objectives due for review. Stored on this device; sign in to sync.",
  robots: { index: false },
};

export default function ProgressPage() {
  const lessons: LessonSummary[] = loadLessons().map((l) => ({
    id: l.id,
    track: l.track,
    trackTitle: TRACKS.find((t) => t.id === l.track)?.title,
    title: l.title,
    href: `/learn/${l.track}/${l.slug}`,
    steps: l.stepIds,
    objectives: l.objectives.map((o) => ({
      ...o,
      step: Object.values(templates).find((t) => t.objective === o.id)?.step,
    })),
  }));
  return (
    <div className="mx-auto max-w-4xl px-4 pb-20 pt-12">
      <h1 className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">Progress</h1>
      <p className="mt-3 text-muted">Saved on this device. Sign in to sync.</p>
      <ProgressView lessons={lessons} challenges={challenges.map((c) => ({ id: c.id, title: c.title }))} />
    </div>
  );
}
