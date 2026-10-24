import type { Metadata } from "next";
import Link from "next/link";
import { HeroDiagram } from "@/components/ui/hero-diagram";
import { arrowHead, sketch, Strokes } from "@/components/ui/sketch";
import { challenges } from "@/content/challenges";
import type { ChallengeSpec } from "@/engine/types";
import { formatDuration, formatPercent } from "@/lib/format";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

const CACHING_LESSON = "/learn/building-blocks/caching";
const CHALLENGE = "/challenges/cache-aside-recovery";

type Pillar = { title: string; href?: string; body: string; glyph: string[] };

const PILLARS: Pillar[] = [
  {
    title: "Learn",
    href: "/learn",
    body: "Short steps, each with something to answer, calculate or reorder. Mastery checks draw fresh variants you have not seen.",
    glyph: [...sketch.path("M4 10 C12 7 18 8 22 12 C26 8 32 7 40 10 L40 34 C32 31 26 32 22 36 C18 32 12 31 4 34 Z", 101), ...sketch.line(22, 12, 22, 36, 102)],
  },
  {
    title: "Simulate",
    href: "/sandbox",
    body: "Sketch a system on a whiteboard, send it traffic, kill a node, and read latency, errors and saturation as they happen.",
    glyph: [...sketch.rect(3, 17, 11, 10, 111), ...sketch.rect(30, 6, 11, 10, 112), ...sketch.rect(30, 28, 11, 10, 113), ...sketch.path("M14 22 C22 22 22 11 30 11 M14 22 C22 22 22 33 30 33", 114)],
  },
  {
    title: "Practice",
    href: "/challenges",
    body: "Challenges with a pass bar, a reproducible seed, and a verdict that says exactly which check failed and why.",
    glyph: [...sketch.ellipse(22, 22, 36, 36, 121), ...sketch.ellipse(22, 22, 20, 20, 122), ...sketch.line(22, 22, 40, 4, 123)],
  },
  {
    title: "Interview",
    body: "Mock interviews built on the case studies, with a timer and a rubric. In preparation for a later release.",
    glyph: [...sketch.path("M3 6 L28 6 L28 22 L12 22 L6 28 L7 22 L3 22 Z", 131), ...sketch.path("M33 15 L41 15 L41 32 L37 32 L38 38 L31 32 L18 32 L18 27", 132)],
  },
  {
    title: "Reference",
    href: "/reference",
    body: "Latency numbers, availability nines and capacity estimates, with the units spelled out.",
    glyph: [
      ...sketch.rect(2, 15, 40, 14, 141),
      ...[8, 14, 20, 26, 32, 38].flatMap((x, i) => sketch.line(x, 15, x, i % 2 ? 20 : 23, 142 + i, { roughness: 0.5 })),
    ],
  },
];

const STEPS = [
  { href: CACHING_LESSON, title: "Learn caching", body: "Why hit rate comes from key skew, how it sets database load, and why a cold cache can cause a stampede." },
  { href: "/sandbox?template=cache-aside", title: "Build cache-aside", body: "Wire a load balancer, two services, a cache and a database. Drive Zipf traffic and watch the cache warm." },
  { href: CHALLENGE, title: "Survive a cache restart", body: "The cache node restarts empty mid-run. Keep reads fast and successful while the database takes the misses." },
];

const INVARIANT_TEXT: Record<string, string> = {
  duplicateEffect: "No write takes effect twice",
  ackedWriteLost: "No acknowledged write is lost",
  staleRead: "No stale reads",
  oversell: "Nothing is oversold",
  uniquenessViolated: "Unique keys stay unique",
  splitBrainWrite: "No split-brain writes",
  orderingViolated: "Order is preserved",
};

/** The challenge's real pass bar, read from its spec. */
function passBar(spec: ChallengeSpec): { check: string; bar: string }[] {
  return [
    ...spec.slos.map((s) =>
      s.kind === "goodput"
        ? { check: "Goodput", bar: `≥ ${formatPercent(s.min, 0)}` }
        : { check: `${s.percentile} latency of successes`, bar: `≤ ${formatDuration(s.maxUs)}` },
    ),
    ...spec.invariants.map((i) => ({ check: INVARIANT_TEXT[i] ?? i, bar: "0 violations" })),
    { check: "Monthly cost", bar: `≤ $${spec.budgetPerMonth}` },
  ];
}

export default function Home() {
  const challenge = challenges[0];
  return (
    <>
      {/* ---- Hero: the promise and Fig. 1 ---- */}
      <section className="mx-auto grid max-w-6xl items-center gap-x-12 gap-y-10 px-4 pb-20 pt-12 md:pt-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:pb-28">
        <div className="relative">
          <h1 className="font-display text-[2.75rem] font-[380] leading-[1.02] tracking-[-0.025em] sm:text-6xl lg:text-[4.25rem]">
            Learn system design by{" "}
            <em className="marker marker-draw">running it.</em>
          </h1>
          <p className="mt-7 max-w-[34rem] text-lg leading-relaxed text-ink-2">
            Lessons with a question in every step, a simulator you can push until it breaks, and challenges graded with explained verdicts.
            Everything runs in your browser.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link href={CACHING_LESSON} className="btn btn-primary h-12 px-5 text-base">
              Start the caching lesson
            </Link>
            <Link href="/sandbox" className="btn h-12 px-5 text-base">
              Open the sandbox
            </Link>
            <Link href={CHALLENGE} className="group inline-flex min-h-12 items-center gap-1.5 px-2 font-medium text-accent underline decoration-1 underline-offset-4 hover:decoration-2">
              Try the challenge
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </Link>
          </div>
          <p aria-hidden className="margin-note mt-10 hidden items-center gap-2 text-lg lg:flex">
            go on, take the cache down
            <svg viewBox="0 0 90 40" className="h-10 w-24 overflow-visible">
              <Strokes d={sketch.path("M2 24 C26 34 54 32 82 12", 51, { roughness: 0.7 })} strokeWidth="1.5" draw={1.6} />
              <Strokes d={arrowHead(70, 18, 82, 12, 52, 8)} strokeWidth="1.5" draw={2.2} />
            </svg>
          </p>
        </div>
        <HeroDiagram />
      </section>

      {/* ---- §1 Contents: the five pillars ---- */}
      <section aria-labelledby="contents" className="border-t border-border bg-surface">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16 lg:py-28">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <h2 id="contents" className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">
              <span className="sec">§1</span>Five ways in
            </h2>
            <p className="mt-5 max-w-sm text-lg leading-relaxed text-ink-2">
              Each part stands alone. Together they take you from a number on a page to a system you have broken and fixed yourself.
            </p>
          </div>
          <ol className="border-t-2 border-fg">
            {PILLARS.map((p) => {
              const inner = (
                <span className="grid grid-cols-[2.75rem_1fr] gap-x-4 gap-y-2 py-6 sm:grid-cols-[3.5rem_1fr] sm:gap-x-6">
                  <svg aria-hidden viewBox="0 0 44 44" className="row-span-2 size-11 overflow-visible text-ink-2 sm:size-14">
                    <Strokes d={p.glyph} strokeWidth="1.5" />
                  </svg>
                  <span className="flex items-baseline">
                    <span className="font-display text-[1.75rem] leading-none tracking-tight sm:text-[2rem]">{p.title}</span>
                    <span aria-hidden className="leader" />
                    {p.href ? <span className="font-mono text-sm text-accent">{p.href}</span> : <span className="stamp stamp-sm text-muted">In preparation</span>}
                  </span>
                  <span className="col-start-2 max-w-[52ch] leading-relaxed text-ink-2">{p.body}</span>
                </span>
              );
              return (
                <li key={p.title} className="border-b border-border">
                  {p.href ? (
                    <Link href={p.href} className="block transition-colors hover:bg-[color-mix(in_oklab,var(--highlight-mark)_22%,transparent)]">
                      {inner}
                    </Link>
                  ) : (
                    <div>{inner}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {/* ---- §2 The first path, drawn as a route ---- */}
      <section aria-labelledby="path" className="paper-grid border-y border-border">
        <div className="mx-auto max-w-6xl px-4 py-20 lg:py-28">
          <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
            <h2 id="path" className="max-w-2xl font-display text-4xl leading-tight tracking-tight sm:text-5xl">
              <span className="sec">§2</span>Your first path: keep a database alive
            </h2>
            <p className="margin-note text-lg">Three steps, about an hour.</p>
          </div>
          <ol className="mt-14 grid gap-10 md:grid-cols-3 md:gap-6">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative">
                <div aria-hidden className="mb-5 flex items-center gap-3">
                  <svg viewBox="0 0 48 48" className="size-12 shrink-0 overflow-visible">
                    <Strokes d={sketch.ellipse(24, 24, 42, 40, 200 + i)} strokeWidth="1.8" className={i === 2 ? "text-accent" : "text-fg"} />
                    <text x="24" y="31" textAnchor="middle" className="fill-fg font-display text-[22px] italic">
                      {i + 1}
                    </text>
                  </svg>
                  {i < STEPS.length - 1 && (
                    <svg viewBox="0 0 200 12" preserveAspectRatio="none" className="hidden h-3 flex-1 overflow-visible md:block">
                      <Strokes d={sketch.line(4, 6, 196, 6, 210 + i, { roughness: 1.4 })} strokeWidth="1.5" strokeDasharray="6 7" vectorEffect="non-scaling-stroke" className="text-rule" />
                    </svg>
                  )}
                </div>
                <Link href={s.href} className="group block">
                  <h3 className="font-display text-2xl tracking-tight group-hover:text-accent">
                    {s.title}
                    <span aria-hidden className="ml-1.5 inline-block text-accent transition-transform group-hover:translate-x-1">
                      →
                    </span>
                  </h3>
                  <p className="mt-2 max-w-[38ch] leading-relaxed text-ink-2">{s.body}</p>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---- §3 The verdict, as an inspection slip ---- */}
      <section aria-labelledby="verdict" className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 lg:grid-cols-2 lg:gap-20 lg:py-28">
        <div>
          <h2 id="verdict" className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">
            <span className="sec">§3</span>How a verdict reads
          </h2>
          <p className="mt-5 max-w-[46ch] text-lg leading-relaxed text-ink-2">
            Every challenge has a fixed pass bar and fixed seeds, so any result can be reproduced. The verdict lists each check and says exactly which one
            failed, and why.
          </p>
          <Link href={CHALLENGE} className="btn mt-8 h-12 px-5 text-base">
            Attempt this challenge
          </Link>
        </div>
        <figure>
          <div className="panel relative px-6 pb-6 pt-5 shadow-e2 sm:px-8">
            <div className="flex items-baseline justify-between gap-4 border-b-2 border-fg pb-3">
              <p className="font-mono text-xs text-muted">Inspection slip</p>
              <p className="font-mono text-xs text-muted">{challenge.id}</p>
            </div>
            <p className="mt-4 max-w-[22ch] font-display text-2xl leading-snug tracking-tight">{challenge.title}</p>
            <table className="mt-5 w-full text-left text-[0.9375rem]">
              <caption className="sr-only">Pass bar</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Must be</th>
                </tr>
              </thead>
              <tbody className="ruled">
                {passBar(challenge.spec).map((r) => (
                  <tr key={r.check}>
                    <th scope="row" className="pr-4 font-normal">
                      <span aria-hidden className="mr-2 text-success">
                        ✓
                      </span>
                      {r.check}
                    </th>
                    <td className="num whitespace-nowrap text-right">{r.bar}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span className="stamp absolute -top-4 right-4 bg-surface text-[0.8rem] text-success sm:-right-5">Passed ★★★</span>
          </div>
          <figcaption className="figcap mt-3">
            <b>Fig. 2</b>The pass bar for the first challenge. Three stars means the design also holds when the failure comes at a different moment.
          </figcaption>
        </figure>
      </section>
    </>
  );
}
