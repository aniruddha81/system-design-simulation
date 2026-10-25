import type { Metadata } from "next";
import Link from "next/link";
import { fmtMoney, fmtMs } from "@/components/sandbox/units";
import { challenges } from "@/content/challenges";
import { ChallengeStars } from "./stars";

export const metadata: Metadata = {
  title: "Challenges",
  description:
    "Graded system-design challenges: meet the SLOs, survive the failure, stay on budget.",
};

function Chip({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <li className="num inline-flex items-center gap-1.5 rounded-full border border-rule bg-surface-2 px-2.5 py-0.5 text-xs">
      <span aria-hidden>{icon}</span>
      {children}
    </li>
  );
}

export default function ChallengesPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:py-14">
      <h1 className="font-display text-4xl leading-tight tracking-tight sm:text-5xl">Challenges</h1>
      <p className="mt-3 text-lg text-ink-2">Meet the SLOs, survive the failure, stay on budget.</p>
      <ul className="mt-8 grid gap-4 sm:grid-cols-2">
        {challenges.map((c) => (
          <li key={c.id} className="relative flex flex-col gap-3 rounded-md border border-rule bg-surface p-5 transition-colors focus-within:border-accent hover:border-accent">
            <div className="flex items-start justify-between gap-3">
              <h2 className="font-display text-xl leading-snug tracking-tight">
                <Link href={`/challenges/${c.id}`} className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                  {c.title}
                </Link>
              </h2>
              <ChallengeStars id={c.id} />
            </div>
            <ul className="mt-auto flex flex-wrap gap-1.5" aria-label="Pass bar">
              {c.spec.slos.map((s) =>
                s.kind === "goodput" ? (
                  <Chip key="g" icon="✓">
                    goodput ≥ {(s.min * 100).toFixed(0)}%
                  </Chip>
                ) : (
                  <Chip key={s.percentile} icon="⏱">
                    {s.percentile} &lt; {fmtMs(s.maxUs)}
                  </Chip>
                ),
              )}
              <Chip icon="$">{fmtMoney(c.spec.budgetPerMonth)}/mo</Chip>
              {c.spec.invariants.length > 0 && (
                <Chip icon="⚑">
                  {c.spec.invariants.length} invariant{c.spec.invariants.length === 1 ? "" : "s"}
                </Chip>
              )}
              <Chip icon="⚡">{c.spec.scenario.chaos.length} failure{c.spec.scenario.chaos.length === 1 ? "" : "s"}</Chip>
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
