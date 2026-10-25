import type { Metadata } from "next";
import Link from "next/link";
import { challenges } from "@/content/challenges";

export const metadata: Metadata = {
  title: "Challenges",
  description:
    "Graded system-design challenges: meet the SLOs, survive the failure, stay on budget.",
};

export default function ChallengesPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:py-14">
      <h1 className="text-3xl font-semibold tracking-tight text-(--text)">
        Challenges
      </h1>
      <p className="mt-2 max-w-2xl text-muted">
        Each challenge is graded on five seeds: every SLO on every seed, no
        invariant broken, under budget.
      </p>
      <ul className="mt-8 grid gap-3">
        {challenges.map((c) => (
          <li key={c.id}>
            <Link
              href={`/challenges/${c.id}`}
              className="block rounded-(--radius) border border-border bg-surface p-5 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span className="block font-medium text-(--text)">{c.title}</span>
              <span className="mt-1 block text-sm text-muted">
                {c.brief[0]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
