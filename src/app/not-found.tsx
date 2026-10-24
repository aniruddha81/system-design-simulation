import type { Metadata } from "next";
import Link from "next/link";
import { loadLessons } from "@/lib/content/loader";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

export default function NotFound() {
  const live = loadLessons();
  const places = [
    { href: "/learn", title: "Curriculum", body: "Every track and lesson, ordered by prerequisites" },
    { href: "/reference", title: "Reference", body: "Latency numbers and estimation calculators" },
    { href: "/sandbox", title: "Sandbox", body: "Build and run a system" },
    { href: "/challenges", title: "Challenges", body: "Graded scenarios with explained verdicts" },
  ];
  return (
    <div className="mx-auto max-w-3xl px-4 py-20">
      <p className="font-mono text-sm text-accent">404</p>
      <h1 className="mt-2 font-display text-4xl leading-tight tracking-tight sm:text-5xl">A page missing from the notebook.</h1>
      <p className="mt-4 text-lg text-muted">
        The page may have moved, or the link has a typo. Use Search in the navigation to find a lesson or design.
      </p>

      <h2 className="mt-12 font-display text-2xl">Lessons</h2>
      <ul className="mt-3 grid gap-2">
        {live.map((l) => (
          <li key={l.id}>
            <Link href={`/learn/${l.track}/${l.slug}`} className="block border-t border-rule py-4 hover:text-accent">
              <span className="font-medium">{l.title}</span>
              {l.description && <span className="mt-1 block text-sm text-muted">{l.description}</span>}
            </Link>
          </li>
        ))}
      </ul>

      <h2 className="mt-10 font-display text-2xl">Elsewhere</h2>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {places.map((p) => (
          <li key={p.href}>
            <Link href={p.href} className="block h-full border-t border-rule py-4 hover:text-accent">
              <span className="font-medium">{p.title}</span>
              <span className="mt-1 block text-sm text-muted">{p.body}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
