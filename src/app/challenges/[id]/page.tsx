import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChallengeEditor } from "@/components/sandbox/EditorLoader";
import { EDITOR_FRAME } from "@/components/sandbox/EditorSkeleton";
import { KIND_LABEL } from "@/components/sandbox/design-ops";
import { fmtMoney, fmtMs } from "@/components/sandbox/units";
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
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-(--text)">{c.title}</h1>
        <div className="mt-3 flex max-w-3xl flex-col gap-2 text-(--text-muted)">
          {c.brief.map((p, i) => <p key={i}>{p}</p>)}
        </div>
        <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-(--radius) border border-(--border) bg-(--surface) p-3">
            <dt className="text-xs uppercase tracking-wider text-(--text-muted)">SLOs (every seed)</dt>
            {spec.slos.map((slo, i) => (
              <dd key={i} className="mt-1 text-(--text)">
                {slo.kind === "goodput" ? `Goodput ≥ ${(slo.min * 100).toFixed(1)}%` : `Success ${slo.percentile} < ${fmtMs(slo.maxUs)}`}
              </dd>
            ))}
          </div>
          <div className="rounded-(--radius) border border-(--border) bg-(--surface) p-3">
            <dt className="text-xs uppercase tracking-wider text-(--text-muted)">Budget</dt>
            <dd className="mt-1 text-(--text)">{fmtMoney(spec.budgetPerMonth)} / month</dd>
            <dd className="text-xs text-(--text-muted)">★★ at ≤ {fmtMoney(spec.budgetPerMonth * 0.8)}</dd>
          </div>
          <div className="rounded-(--radius) border border-(--border) bg-(--surface) p-3">
            <dt className="text-xs uppercase tracking-wider text-(--text-muted)">Traffic</dt>
            <dd className="mt-1 text-(--text)">{arrival.rps.toLocaleString("en")} req/s ({arrival.kind})</dd>
            <dd className="text-xs text-(--text-muted)">{Object.entries(s.workload.mix).map(([k, w]) => `${k} ${Math.round(w * 100)}%`).join(" · ")} · deadline {fmtMs(s.workload.deadlineUs)}</dd>
          </div>
          <div className="rounded-(--radius) border border-(--border) bg-(--surface) p-3">
            <dt className="text-xs uppercase tracking-wider text-(--text-muted)">Chaos</dt>
            {s.chaos.map((e) => (
              <dd key={e.id} className="mt-1 text-(--text)">{e.kind} <span className="font-mono text-xs">{e.target}</span> at t = {fmtMs(e.atUs)}</dd>
            ))}
            <dd className="text-xs text-(--text-muted)">★★★ adds {spec.variantChaos.length} variant timeline{spec.variantChaos.length === 1 ? "" : "s"}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-(--text-muted)">
          Allowed components: {spec.allowedKinds.map((k) => KIND_LABEL[k]).join(", ")}. Invariants: {spec.invariants.join(", ")}. Seeds: {spec.seeds.join(", ")}.
        </p>
      </header>
      <div className={`${EDITOR_FRAME} border-t border-(--border)`}>
        <ChallengeEditor challengeId={c.id} />
      </div>
    </>
  );
}
