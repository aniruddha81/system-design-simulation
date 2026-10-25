import Link from "next/link";
import { DesignFlow, EstimateTiles } from "@/components/interview/StudyVisuals";
import { Compare } from "@/components/visual/kit";
import type { CaseStudy } from "@/content/case-studies";

export function CaseStudyView({ study: c }: { study: CaseStudy }) {
  return <article className="mx-auto max-w-3xl px-4 py-10 [&_h2]:mt-10 [&_h2]:font-display [&_h2]:text-2xl [&_h3]:mt-5 [&_h3]:font-medium [&_p]:mt-3 [&_p]:leading-relaxed [&_ul]:mt-3 [&_ul]:space-y-2 [&_li]:min-w-0 [&_.num]:break-words">
    <Link href="/case-studies" className="inline-block min-h-6 text-muted underline">All case studies</Link>
    <h1 className="mt-5 font-display text-4xl">{c.title}</h1>
    <p className="text-muted">{c.summary}</p>
    <div className="mt-5 flex flex-wrap gap-4">
      <Link href={`/sandbox?case=${c.id}`} className="inline-flex min-h-10 items-center rounded-sm bg-accent px-4 text-accent-ink">Open reference design</Link>
      <Link href={`/learn/case-studies/${c.id}`} className="inline-flex min-h-10 items-center underline">Interactive lesson</Link>
      <Link href={`/interview/${c.id}`} className="inline-flex min-h-10 items-center underline">Practice an interview</Link>
    </div>
    <DesignFlow design={c.design} />
    <nav aria-label="Design stages" className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {c.rubric.map((r, i) => <Link key={r.stage} href={`#${r.stage.replaceAll(" ", "-")}`} className="flex min-h-10 items-center gap-2 border-b-2 border-rule py-2 capitalize"><span className="grid size-7 shrink-0 place-items-center rounded-full border border-rule font-mono text-xs">{i + 1}</span>{r.stage}</Link>)}
    </nav>
    <h2 id="requirements">Requirements</h2>
    <h3>Functional</h3><ul className="flex list-none flex-wrap gap-2 pl-0">{c.requirements.functional.map((s) => <li className="rounded-sm border border-rule bg-surface px-3 py-2" key={s}>{s}</li>)}</ul>
    <h3>Non-functional</h3><ul className="flex list-none flex-wrap gap-2 pl-0">{c.requirements.nonFunctional.map((s) => <li className="rounded-sm border border-rule bg-surface px-3 py-2" key={s}>{s}</li>)}</ul>
    <h2 id="estimates">Worked estimates</h2>
    <EstimateTiles estimates={c.estimates} />
    <h2 id="api">API</h2>{c.api.map((a) => <details key={a.signature} className="mt-4 border-t border-rule pt-4">
      <summary className="min-h-6 cursor-pointer break-words font-mono text-sm">{a.signature}</summary><p>Request: {a.request}</p><p>Response: {a.response}</p>{a.notes && <p className="text-muted">{a.notes}</p>}
    </details>)}
    <h2 id="data-model">Data model</h2><ul>{c.dataModel.entities.map((e) => <li key={e.name}><span className="font-mono">{e.name}</span> — store: {e.store}</li>)}</ul>
    {c.dataModel.notes.map((s) => <p key={s}>{s}</p>)}
    <h2 id="high-level">High-level design</h2><p>Trace permitted calls in the architecture above, then open the reference canvas to inspect routing.</p>
    <h2 id="deep-dive">Deep dives</h2>{c.deepDives.map((d) => <details key={d.title} className="mt-3 border-t border-rule py-3"><summary className="min-h-6 cursor-pointer font-medium">{d.title}</summary><p>{d.body}</p></details>)}
    <h2>Failure scenarios</h2>{c.failureScenarios.map((f) => <section key={f.id} className="mt-5 border-t border-rule pt-3">
      <h3>{f.title}</h3><details className="mt-3"><summary className="min-h-6 cursor-pointer">Scenario and expected result</summary><p>{f.explanation}</p><p className="text-muted">Expected: {f.expect}</p></details>
      <Link href={`/sandbox?case=${c.id}&scenario=${f.id}`} className="mt-3 inline-block min-h-6 underline hover:text-accent">Open this scenario</Link>
    </section>)}
    <h2>Alternative designs</h2>{c.alternatives.map((a, i) => <section key={a.title}><Compare title={a.title} sides={[{ title: "Reference", points: ["Inspect the architecture above and run the same scenario."] }, { title: a.title, points: [a.tradeoffs] }]} />{a.design && <Link href={`/sandbox?case=${c.id}&alt=${i}`} className="mt-3 inline-block min-h-6 underline hover:text-accent">Open this alternative</Link>}</section>)}
    <h2>Clarifying questions</h2><ul>{c.clarifyingQuestions.map((s) => <li key={s}>{s}</li>)}</ul>
    <h2>Common mistakes</h2><ul>{c.commonMistakes.map((s) => <li key={s}>{s}</li>)}</ul>
    <h2 id="wrap-up">Self-assessment rubric</h2>{c.rubric.map((r) => <details key={r.stage} className="mt-3 border-t border-rule py-3"><summary className="min-h-6 cursor-pointer capitalize">{r.stage} / levels 1-4</summary><ol className="mt-3 grid gap-2 sm:grid-cols-2">{r.descriptors.map((d, i) => <li className="border border-rule bg-surface p-3" key={d}><span className="mb-2 grid grid-cols-4 gap-1" aria-hidden="true">{[0, 1, 2, 3].map((level) => <span key={level} className="h-2 border border-rule" style={{ background: level <= i ? "var(--accent-2)" : "var(--surface-2)" }} />)}</span><span className="font-mono">{i + 1}/4</span> {d}</li>)}</ol></details>)}
  </article>;
}
