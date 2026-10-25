import type { Metadata } from "next";
import Link from "next/link";
import { HeroFigure } from "@/components/landing/hero-figure";
import { Journey } from "@/components/landing/journey";
import { arrowHead, sketch, Strokes } from "@/components/ui/sketch";
import { challenges } from "@/content/challenges";
import type { ChallengeSpec } from "@/engine/types";
import { formatDuration, formatPercent } from "@/lib/format";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

const CACHING_LESSON = "/learn/building-blocks/caching";
const CHALLENGE = "/challenges/cache-aside-recovery";

type Pillar = { title: string; href: string; body: string; glyph: string[] };

const PILLARS: Pillar[] = [
  {
    title: "Learn",
    href: "/learn",
    body: "Short steps, each with a question to answer.",
    glyph: [...sketch.path("M4 10 C12 7 18 8 22 12 C26 8 32 7 40 10 L40 34 C32 31 26 32 22 36 C18 32 12 31 4 34 Z", 101), ...sketch.line(22, 12, 22, 36, 102)],
  },
  {
    title: "Simulate",
    href: "/sandbox",
    body: "Sketch a system, add traffic, kill a node.",
    glyph: [...sketch.rect(3, 17, 11, 10, 111), ...sketch.rect(30, 6, 11, 10, 112), ...sketch.rect(30, 28, 11, 10, 113), ...sketch.path("M14 22 C22 22 22 11 30 11 M14 22 C22 22 22 33 30 33", 114)],
  },
  {
    title: "Practice",
    href: "/challenges",
    body: "A fixed pass bar and a verdict that says why.",
    glyph: [...sketch.ellipse(22, 22, 36, 36, 121), ...sketch.ellipse(22, 22, 20, 20, 122), ...sketch.line(22, 22, 40, 4, 123)],
  },
  {
    title: "Interview",
    href: "/interview",
    body: "Timed mocks on twenty-six case studies.",
    glyph: [...sketch.path("M3 6 L28 6 L28 22 L12 22 L6 28 L7 22 L3 22 Z", 131), ...sketch.path("M33 15 L41 15 L41 32 L37 32 L38 38 L31 32 L18 32 L18 27", 132)],
  },
  {
    title: "Reference",
    href: "/reference",
    body: "Latency numbers, nines, capacity maths.",
    glyph: [
      ...sketch.rect(2, 15, 40, 14, 141),
      ...[8, 14, 20, 26, 32, 38].flatMap((x, i) => sketch.line(x, 15, x, i % 2 ? 20 : 23, 142 + i, { roughness: 0.5 })),
    ],
  },
];

const STEPS = [
  { href: CACHING_LESSON, title: "Learn caching", body: "Hit rate, database load, cold-cache stampede." },
  { href: "/sandbox?template=cache-aside", title: "Build cache-aside", body: "Wire it up. Drive traffic. Watch the cache warm." },
  { href: CHALLENGE, title: "Survive a cache restart", body: "The cache restarts empty. Keep reads fast." },
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
      <section aria-labelledby="hero-title" className="mx-auto max-w-6xl px-4 pb-24 pt-10 md:pt-14 lg:pb-36">
        <h1 id="hero-title" className="font-display text-[2.35rem] font-[360] leading-[0.98] tracking-[-0.032em] sm:text-7xl lg:text-[6.1rem]">
          Learn system design by <em className="marker marker-draw">running it.</em>
        </h1>
        <div className="mt-10 grid grid-cols-1 items-start gap-x-12 gap-y-12 lg:mt-14 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
          <div className="min-w-0 lg:pt-2">
            <p className="max-w-[34rem] text-lg leading-relaxed text-ink-2 lg:text-[1.1875rem]">
              Lessons, a simulator and graded challenges, all in your browser.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href={CACHING_LESSON} className="btn btn-primary h-12 px-5 text-base">
                Start the caching lesson
              </Link>
              <Link href="/sandbox" className="btn h-12 px-5 text-base">
                Open the sandbox
              </Link>
              <Link
                href={CHALLENGE}
                className="group inline-flex min-h-12 items-center gap-1.5 px-2 font-medium text-accent underline decoration-1 underline-offset-4 hover:decoration-2"
              >
                Try the challenge
                <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                  →
                </span>
              </Link>
            </div>
            <p aria-hidden className="margin-note mt-12 hidden items-start gap-2 text-lg lg:flex">
              go on, take the cache down
              <svg viewBox="0 0 120 50" className="mt-1 h-12 w-28 overflow-visible">
                <Strokes d={sketch.path("M2 30 C34 44 78 40 114 6", 51, { roughness: 0.7 })} strokeWidth="1.5" draw={1.6} />
                <Strokes d={arrowHead(100, 12, 114, 6, 52, 8)} strokeWidth="1.5" draw={2.2} />
              </svg>
            </p>
          </div>
          <HeroFigure />
        </div>
      </section>

      {/* ---- §1 Life of a request: scroll-scrubbed trace ---- */}
      <section aria-labelledby="journey-title" className="border-t border-border">
        <div className="mx-auto max-w-6xl px-4 py-20 lg:py-28">
          <div className="mb-12 flex flex-wrap items-end justify-between gap-x-10 gap-y-4 lg:mb-16">
            <div>
              <h2 id="journey-title" className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">
                <span className="sec">§1</span>Life of a request
              </h2>
              <p className="mt-4 max-w-[48ch] text-lg leading-relaxed text-ink-2">
                One read, browser to database and back.
              </p>
            </div>
            <p className="margin-note text-lg">Scroll to trace user:42.</p>
          </div>
          <Journey />
        </div>
      </section>

      {/* ---- §2 Contents: the five pillars ---- */}
      <section aria-labelledby="contents" className="border-t border-border bg-surface">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 py-20 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16 lg:py-28">
          <div className="min-w-0 lg:sticky lg:top-28 lg:self-start">
            <h2 id="contents" className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">
              <span className="sec">§2</span>Five ways in
            </h2>
            <p className="mt-5 max-w-sm text-lg leading-relaxed text-ink-2">Each part stands alone.</p>
          </div>
          <ol className="min-w-0 border-t-2 border-fg">
            {PILLARS.map((p) => (
              <li key={p.title} className="border-b border-border">
                <Link href={p.href} className="block transition-colors hover:bg-[color-mix(in_oklab,var(--highlight-mark)_22%,transparent)]">
                  <span className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 py-6 sm:grid-cols-[3.5rem_minmax(0,1fr)] sm:gap-x-6">
                    <svg aria-hidden viewBox="0 0 44 44" className="row-span-2 size-10 overflow-visible text-ink-2 sm:size-14">
                      <Strokes d={p.glyph} strokeWidth="1.5" />
                    </svg>
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1">
                      <span className="font-display text-[1.5rem] leading-none tracking-tight sm:text-[2rem]">{p.title}</span>
                      <span aria-hidden className="leader min-w-3" />
                      <span className="font-mono text-xs text-accent sm:text-sm">{p.href}</span>
                    </span>
                    <span className="col-start-2 max-w-[52ch] leading-relaxed text-ink-2">{p.body}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ---- §3 The first path, drawn as a route ---- */}
      <section aria-labelledby="path" className="paper-grid border-y border-border">
        <div className="mx-auto max-w-6xl px-4 py-20 lg:py-28">
          <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
            <h2 id="path" className="max-w-2xl font-display text-4xl leading-tight tracking-tight sm:text-5xl">
              <span className="sec">§3</span>Your first path: keep a database alive
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
                      <Strokes
                        d={sketch.line(4, 6, 196, 6, 210 + i, { roughness: 1.4 })}
                        strokeWidth="1.5"
                        strokeDasharray="6 7"
                        vectorEffect="non-scaling-stroke"
                        className="text-rule"
                      />
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

      {/* ---- §4 The verdict, as an inspection slip ---- */}
      <section aria-labelledby="verdict" className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-4 py-20 lg:grid-cols-2 lg:gap-20 lg:py-28">
        <div className="min-w-0">
          <h2 id="verdict" className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">
            <span className="sec">§4</span>How a verdict reads
          </h2>
          <p className="mt-5 max-w-[46ch] text-lg leading-relaxed text-ink-2">
            Fixed pass bar, fixed seeds, every check explained.
          </p>
          <Link href={CHALLENGE} className="btn mt-8 h-12 px-5 text-base">
            Attempt this challenge
          </Link>
        </div>
        <figure className="min-w-0">
          <div className="panel relative px-5 pb-6 pt-5 shadow-e2 sm:px-8">
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
            <span className="stamp absolute -top-4 right-3 bg-surface text-[0.8rem] text-success sm:right-4">Passed ★★★</span>
          </div>
          <figcaption className="figcap mt-3">
            <b>Fig. 3</b>The first challenge&apos;s pass bar.
          </figcaption>
        </figure>
      </section>
    </>
  );
}
