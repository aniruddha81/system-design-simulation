import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChallengeEditor } from "@/components/sandbox/EditorLoader";
import { EDITOR_FRAME } from "@/components/sandbox/EditorSkeleton";
import { KIND_LABEL } from "@/components/sandbox/design-ops";
import { describeArrival } from "@/components/sandbox/scenario-ops";
import { fmtMoney, fmtMs } from "@/components/sandbox/units";
import { Stats } from "@/components/visual/kit";
import { challenges, getChallenge } from "@/content/challenges";

export function generateStaticParams() {
  return challenges.map((c) => ({ id: c.id }));
}

export async function generateMetadata({ params }: PageProps<"/challenges/[id]">): Promise<Metadata> {
  const c = getChallenge((await params).id);
  return c ? { title: c.title, description: c.brief[0] } : {};
}

export default async function ChallengePage({ params }: PageProps<"/challenges/[id]">) {
  const c = getChallenge((await params).id);
  if (!c) notFound();
  const { spec } = c;
  const s = spec.scenario;
  const arrival = s.workload.arrival;
  return (
    <>
      <header className="mx-auto w-full max-w-5xl px-4 pb-6 pt-10">
        <p className="text-xs font-medium uppercase tracking-wider text-(--accent)">Challenge</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-(--text) sm:text-4xl">{c.title}</h1>
        <div className="mt-3 flex max-w-3xl flex-col gap-2 text-(--text-muted)">
          {c.brief.map((p, i) => <p key={i}>{p}</p>)}
        </div>
        <Stats
          title="Pass bar"
          items={[
            ...spec.slos.map((slo) =>
              slo.kind === "goodput"
                ? { label: "Goodput", value: `≥ ${(slo.min * 100).toFixed(1)}%`, sub: "every seed", tone: "ok" as const }
                : { label: `Success ${slo.percentile}`, value: `< ${fmtMs(slo.maxUs)}`, sub: "every seed", tone: "ok" as const },
            ),
            { label: "Budget", value: `${fmtMoney(spec.budgetPerMonth)}/mo`, sub: `★★ at ≤ ${fmtMoney(spec.budgetPerMonth * 0.8)}`, tone: "warn" as const },
            { label: "Traffic", value: describeArrival(arrival), sub: `deadline ${fmtMs(s.workload.deadlineUs)}`, tone: "info" as const },
            ...s.chaos.map((e) => ({ label: `Failure · ${e.target}`, value: e.kind, sub: `at t = ${fmtMs(e.atUs)}`, tone: "bad" as const })),
          ]}
          caption={`★★★ adds ${spec.variantChaos.length} variant failure timeline${spec.variantChaos.length === 1 ? "" : "s"}.`}
        />
        <ul className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Allowed components and invariants">
          {spec.allowedKinds.map((k) => (
            <li key={k} className="rounded-full border border-rule bg-surface px-2.5 py-0.5">
              {KIND_LABEL[k]}
            </li>
          ))}
          {spec.invariants.map((i) => (
            <li key={i} className="num rounded-full border border-danger px-2.5 py-0.5">
              <span aria-hidden>⚑ </span>
              {i}
            </li>
          ))}
        </ul>
      </header>
      <div className={`${EDITOR_FRAME} border-t border-(--border)`}>
        <ChallengeEditor challengeId={c.id} />
      </div>
    </>
  );
}
