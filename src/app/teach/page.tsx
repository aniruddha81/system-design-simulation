import type { Metadata } from "next";
import { Suspense } from "react";
import { loadLessons } from "@/lib/content/loader";
import { challenges } from "@/content/challenges";
import { caseStudies } from "@/content/case-studies";
import { TeachStudio, type AssignableItem } from "./teach-studio";

export const metadata: Metadata = {
  title: "Teach & Classroom Studio",
  description:
    "Run live system design lectures in Projector Mode, walk through curated failure-mode demos, build shareable zero-backend homework links, and verify student completion receipts.",
};

export default function TeachPage() {
  const lessons = loadLessons();
  const catalog: AssignableItem[] = [
    ...lessons.map((l) => ({
      key: `lesson:${l.id}`,
      id: l.id,
      kind: "lesson" as const,
      title: l.title,
      subtitle: `${l.track} · ${l.estimatedMinutes} min`,
      href: `/learn/${l.track}/${l.slug}`,
    })),
    ...challenges.map((c) => ({
      key: `challenge:${c.id}`,
      id: c.id,
      kind: "challenge" as const,
      title: c.title,
      subtitle: `Graded challenge · ${c.spec.invariants.join(", ") || "SLO + budget"}`,
      href: `/challenges/${c.id}`,
    })),
    ...caseStudies.map((cs) => ({
      key: `case-study:${cs.id}`,
      id: cs.id,
      kind: "case-study" as const,
      title: cs.title,
      subtitle: `Case study · ${cs.summary}`,
      href: `/case-studies/${cs.id}`,
      interviewHref: `/interview/${cs.id}`,
    })),
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-12">
      <div className="max-w-3xl">
        <p className="font-mono text-xs uppercase tracking-widest text-accent">
          Instructor &amp; Classroom Mode
        </p>
        <h1 className="mt-2 font-display text-4xl leading-tight tracking-tight sm:text-5xl">
          Teach system design with live simulations.
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-2">
          Built for university courses, engineering bootcamps, and study groups.
          Present interactive failure modes on a lecture hall projector, share
          zero-backend assignment links, and verify student completion receipts
          locally in your browser.
        </p>
      </div>

      <Suspense
        fallback={
          <p className="mt-10 text-muted" role="status">
            Loading classroom studio…
          </p>
        }
      >
        <TeachStudio catalog={catalog} />
      </Suspense>
    </div>
  );
}
