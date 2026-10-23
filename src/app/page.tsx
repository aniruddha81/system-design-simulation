import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

const CACHING_LESSON = "/learn/building-blocks/caching";
const CHALLENGE = "/challenges/cache-aside-recovery";

const PILLARS = [
  { title: "Learn", href: "/learn", body: "Short steps, each with something to answer, calculate or reorder. Mastery checks draw fresh variants you have not seen." },
  { title: "Simulate", href: "/sandbox", body: "Sketch a system on a whiteboard, send it traffic, kill a node, and read latency, errors and saturation as they happen." },
  { title: "Practice", href: "/challenges", body: "Challenges with a pass bar, a reproducible seed, and a verdict that says exactly which check failed and why." },
  { title: "Reference", href: "/reference", body: "Latency numbers, availability nines and capacity estimates, with the units spelled out." },
];

export default function Home() {
  return (
    <>
      <section className="blueprint relative overflow-hidden border-b border-border">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 md:grid-cols-[1.05fr_1fr] md:py-24">
          <div>
            <h1 className="text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">Learn system design by running it.</h1>
            <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-muted">
              Lessons with a question in every step, a simulator you can push until it breaks, and challenges graded with explained verdicts.
              Everything runs in your browser.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link href={CACHING_LESSON} className="btn btn-primary h-11 px-5">
                Start the caching lesson
              </Link>
              <Link href="/sandbox" className="btn h-11 px-5">
                Open the sandbox
              </Link>
              <Link href={CHALLENGE} className="btn btn-ghost h-11 px-5">
                Try the challenge
              </Link>
            </div>
          </div>
          <HeroDiagram />
        </div>
      </section>

      <section aria-labelledby="path" className="mx-auto max-w-6xl px-4 py-20">
        <h2 id="path" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Your first path: keep a database alive
        </h2>
        <p className="mt-3 max-w-2xl text-muted">Three steps, about an hour. Each one uses what the last one taught.</p>
        <ol className="mt-10 grid gap-px overflow-hidden rounded-[var(--radius-lg)] border border-border bg-border md:grid-cols-3">
          {[
            { href: CACHING_LESSON, title: "Learn caching", body: "Why hit rate comes from key skew, how it sets database load, and why a cold cache can cause a stampede." },
            { href: "/sandbox?template=cache-aside", title: "Build cache-aside", body: "Wire a load balancer, two services, a cache and a database. Drive Zipf traffic and watch the cache warm." },
            { href: CHALLENGE, title: "Survive a cache restart", body: "The cache node restarts empty mid-run. Keep reads fast and successful while the database takes the misses." },
          ].map((s, i) => (
            <li key={s.title} className="bg-surface">
              <Link href={s.href} className="group flex h-full flex-col gap-3 p-6 transition-colors hover:bg-surface-2">
                <span className="num text-sm text-accent">Step {i + 1}</span>
                <span className="text-lg font-semibold group-hover:text-accent">{s.title}</span>
                <span className="text-[0.9375rem] leading-relaxed text-muted">{s.body}</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="pillars" className="border-t border-border">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <h2 id="pillars" className="sr-only">
            What is inside
          </h2>
          <ul className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {PILLARS.map((p) => (
              <li key={p.title} className="border-l-2 border-accent/50 pl-5">
                <Link href={p.href} className="text-lg font-semibold hover:text-accent">
                  {p.title}
                </Link>
                <p className="mt-2 text-[0.9375rem] leading-relaxed text-muted">{p.body}</p>
              </li>
            ))}
          </ul>
          <p className="mt-12 text-sm text-muted">Mock interviews built on the case studies are planned for a later release.</p>
        </div>
      </section>
    </>
  );
}

function HeroDiagram() {
  const node = "fill-[var(--surface)] stroke-[var(--border)]";
  const label = "fill-[var(--text)] text-[13px] font-medium";
  const sub = "fill-[var(--text-muted)] text-[11px]";
  const flow = "[stroke-dasharray:3_9] [animation:flow_0.9s_linear_infinite]";
  return (
    <figure className="panel relative p-4 shadow-e3 sm:p-6">
      <svg
        viewBox="0 0 440 300"
        role="img"
        aria-labelledby="hero-diagram-title"
        className="w-full"
        style={{ fontFamily: "var(--font-sans)" }}
      >
        <title id="hero-diagram-title">
          A cache-aside system: clients reach a load balancer, two services read from a cache, and misses fall through to the database.
        </title>
        <defs>
          <linearGradient id="hero-flow" x1="0" x2="1">
            <stop offset="0" stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--accent-2)" />
          </linearGradient>
        </defs>
        <g fill="none" stroke="url(#hero-flow)" strokeWidth="2" strokeLinecap="round" className={flow}>
          <path d="M84 150 H128" />
          <path d="M196 140 C214 140 214 88 236 88" />
          <path d="M196 160 C214 160 214 212 236 212" />
          <path d="M304 88 C326 88 330 70 348 70" />
          <path d="M304 212 C326 212 330 82 348 82" />
        </g>
        <g fill="none" stroke="var(--warning)" strokeWidth="1.5" strokeLinecap="round" className="[stroke-dasharray:2_7] [animation:flow_1.6s_linear_infinite]">
          <path d="M304 96 C330 120 326 226 348 230" />
          <path d="M304 220 C326 222 330 230 348 236" />
        </g>
        {[
          { x: 16, y: 126, w: 68, t: "Clients", s: "20k rps" },
          { x: 128, y: 126, w: 68, t: "LB", s: "round robin" },
          { x: 236, y: 64, w: 68, t: "svc-a", s: "cache-aside" },
          { x: 236, y: 188, w: 68, t: "svc-b", s: "cache-aside" },
          { x: 348, y: 52, w: 76, t: "Cache", s: "hit 94%" },
          { x: 348, y: 210, w: 76, t: "Database", s: "1.2k rps" },
        ].map((n) => (
          <g key={n.t}>
            <rect x={n.x} y={n.y} width={n.w} height={48} rx={10} className={node} strokeWidth="1.25" />
            <text x={n.x + 12} y={n.y + 21} className={label}>
              {n.t}
            </text>
            <text x={n.x + 12} y={n.y + 37} className={sub}>
              {n.s}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-2">
          <span aria-hidden className="h-0.5 w-5 rounded bg-accent-2" /> Hits served by the cache
        </span>
        <span className="flex items-center gap-2">
          <span aria-hidden className="h-0.5 w-5 rounded bg-warning" /> Misses fall through to the database
        </span>
      </figcaption>
    </figure>
  );
}
