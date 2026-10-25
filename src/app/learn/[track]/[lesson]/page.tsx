import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LessonStepper } from "@/components/lesson/stepper";
import { PrereqNotice } from "@/components/lesson/status";
import { getLesson, loadCurriculum, loadLessons } from "@/lib/content/loader";
import { SITE_URL, TRACKS } from "@/lib/content/schema";

export function generateStaticParams() {
  return loadLessons().map((l) => ({ track: l.track, lesson: l.slug }));
}

export async function generateMetadata({ params }: PageProps<"/learn/[track]/[lesson]">): Promise<Metadata> {
  const { track, lesson: slug } = await params;
  const lesson = getLesson(track, slug);
  if (!lesson) return {};
  const url = `/learn/${track}/${slug}`;
  return {
    title: lesson.title,
    description: lesson.description,
    alternates: { canonical: url },
    openGraph: { title: lesson.title, description: lesson.description, type: "article", url },
  };
}

export default async function LessonPage({ params }: PageProps<"/learn/[track]/[lesson]">) {
  const { track, lesson: slug } = await params;
  const lesson = getLesson(track, slug);
  if (!lesson) notFound();
  const { default: Content } = await import(`../../../../../content/en/${track}/${slug}.mdx`);

  const trackInfo = TRACKS.find((t) => t.id === lesson.track)!;
  const { lessons } = loadCurriculum();
  const requires = lesson.requires.map((id) => {
    const l = lessons.find((x) => x.id === id)!;
    return { id, title: l.title, href: l.slug ? `/learn/${l.track}/${l.slug}` : undefined };
  });

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "LearningResource",
    name: lesson.title,
    description: lesson.description,
    url: `${SITE_URL}/learn/${track}/${slug}`,
    inLanguage: "en",
    learningResourceType: "Interactive lesson",
    educationalLevel: "Intermediate",
    isAccessibleForFree: true,
    timeRequired: `PT${lesson.estimatedMinutes}M`,
    teaches: lesson.objectives.map((o) => o.text),
    dateModified: lesson.lastReviewed,
    isPartOf: { "@type": "Course", name: `Track ${trackInfo.n}: ${trackInfo.title}` },
    citation: lesson.sources.map((s) => ({ "@type": "CreativeWork", name: s.title, url: s.url, author: s.authors })),
  };

  return (
    <article className="mx-auto max-w-3xl px-4 pb-20 pt-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />

      <nav aria-label="Breadcrumb" className="mb-6 text-sm text-muted">
        <ol className="flex flex-wrap gap-x-2">
          <li>
            <Link href="/learn" className="hover:text-fg">
              Learn
            </Link>
            <span aria-hidden className="ml-2">/</span>
          </li>
          <li>
            Track {trackInfo.n}: {trackInfo.title}
          </li>
        </ol>
      </nav>

      <header className="mb-10">
        <h1 className="font-display text-4xl tracking-tight sm:text-5xl sm:leading-[1.1]">{lesson.title}</h1>
        <p className="mt-4 max-w-[60ch] text-lg leading-relaxed text-ink-2">{lesson.description}</p>
        <p className="num mt-4 flex flex-wrap gap-2 text-sm">
          <span className="rounded-full border border-rule bg-surface px-3 py-0.5">
            <span aria-hidden>◷ </span>
            {lesson.estimatedMinutes} min
          </span>
          <span className="rounded-full border border-rule bg-surface px-3 py-0.5">
            <span aria-hidden>▤ </span>
            {lesson.stepIds.length} steps
          </span>
        </p>
        <details className="mt-6 border-y border-rule py-5 [&[open]>summary]:mb-3" open>
          <summary className="min-h-6 cursor-pointer font-medium">By the end you can</summary>
          <ul className="grid gap-2 text-[0.9375rem] text-muted">
            {lesson.objectives.map((o) => (
              <li key={o.id} className="flex gap-2.5">
                <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-accent-2" />
                {o.text}
              </li>
            ))}
          </ul>
        </details>
      </header>

      <PrereqNotice requires={requires} />

      <LessonStepper lessonId={lesson.id} revision={lesson.revision} stepIds={lesson.stepIds} stepTitles={lesson.stepTitles}>
        <Content />
      </LessonStepper>

      <footer className="mt-16 grid gap-10 border-t border-border pt-10 text-[0.9375rem]">
        <section aria-labelledby="limitations">
          <h2 id="limitations" className="mb-3 font-display text-2xl">
            What this lesson simplifies
          </h2>
          <ul className="grid gap-2 text-muted">
            {lesson.limitations.map((l) => (
              <li key={l} className="flex gap-2.5">
                <span aria-hidden className="text-warning">
                  ≈
                </span>
                {l}
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="sources">
          <h2 id="sources" className="mb-3 font-display text-2xl">
            Sources
          </h2>
          <ol className="grid list-decimal gap-2 pl-5 text-muted marker:text-muted">
            {lesson.sources.map((s) => (
              <li key={s.url}>
                {s.authors && <>{s.authors}. </>}
                <a href={s.url} className="text-fg underline underline-offset-4 hover:text-accent" target="_blank" rel="noopener noreferrer">
                  {s.title}
                </a>
                {s.year && <>, {s.year}</>}.
              </li>
            ))}
          </ol>
        </section>
        <p className="text-sm text-muted">
          Reviewed by {lesson.reviewedBy} on <time dateTime={lesson.lastReviewed}>{lesson.lastReviewed}</time>. Revision {lesson.revision}.
        </p>
      </footer>
    </article>
  );
}
