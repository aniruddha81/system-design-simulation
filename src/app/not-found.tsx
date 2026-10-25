import type { Metadata } from "next";
import Link from "next/link";
import { loadLessons } from "@/lib/content/loader";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
};

const PLACES = [
  { href: "/learn", title: "Curriculum", icon: "▤" },
  { href: "/reference", title: "Reference", icon: "∑" },
  { href: "/sandbox", title: "Sandbox", icon: "⬢" },
  { href: "/challenges", title: "Challenges", icon: "★" },
];

export default function NotFound() {
  const live = loadLessons();
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <svg aria-hidden viewBox="0 0 120 80" className="mb-6 h-20 w-30 text-ink-2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 8h58l14 14v50H20z" />
        <path d="M78 8v14h14" />
        <path d="M32 40l8 8M40 40l-8 8M60 40l8 8M68 40l-8 8" className="text-accent" stroke="var(--accent)" />
        <path d="M34 62q8-8 16 0t16 0" strokeDasharray="3 4" />
      </svg>
      <p className="font-mono text-sm text-accent">404</p>
      <h1 className="mt-2 font-display text-4xl leading-tight tracking-tight sm:text-5xl">A page missing from the notebook.</h1>

      <h2 className="mt-10 font-display text-2xl">Go to</h2>
      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {PLACES.map((p) => (
          <li key={p.href}>
            <Link href={p.href} className="grid h-full min-h-20 place-items-center gap-1 rounded-md border border-rule bg-surface p-3 text-center hover:bg-surface-2">
              <span aria-hidden className="text-2xl text-accent-2">
                {p.icon}
              </span>
              <span className="font-medium">{p.title}</span>
            </Link>
          </li>
        ))}
      </ul>

      <h2 className="mt-10 font-display text-2xl">Lessons</h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {live.map((l) => (
          <li key={l.id}>
            <Link href={`/learn/${l.track}/${l.slug}`} className="inline-flex min-h-9 items-center rounded-full border border-rule bg-surface px-3 text-sm hover:bg-surface-2">
              {l.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
