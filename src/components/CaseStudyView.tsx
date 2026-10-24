import Link from "next/link";
import type { CaseStudy } from "@/content/case-studies";

export function CaseStudyView({ study: c }: { study: CaseStudy }) {
  return <article className="mx-auto max-w-3xl px-4 py-10 [&_h2]:mt-10 [&_h2]:font-display [&_h2]:text-2xl [&_h3]:mt-5 [&_h3]:font-medium [&_p]:mt-3 [&_p]:leading-relaxed [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
    <Link href="/case-studies" className="inline-block min-h-6 text-muted underline">All case studies</Link>
    <h1 className="mt-5 font-display text-4xl">{c.title}</h1>
    <p className="text-muted">{c.summary}</p>
    <div className="mt-5 flex flex-wrap gap-4">
      <Link href={`/sandbox?case=${c.id}`} className="inline-flex min-h-10 items-center rounded-sm bg-accent px-4 text-accent-ink">Open reference design</Link>
      <Link href={`/learn/case-studies/${c.id}`} className="inline-flex min-h-10 items-center underline">Interactive lesson</Link>
      <Link href={`/interview/${c.id}`} className="inline-flex min-h-10 items-center underline">Practice an interview</Link>
    </div>
    <h2>Requirements</h2>
    <h3>Functional</h3><ul>{c.requirements.functional.map((s) => <li key={s}>{s}</li>)}</ul>
    <h3>Non-functional</h3><ul>{c.requirements.nonFunctional.map((s) => <li key={s}>{s}</li>)}</ul>
    <h2>Worked estimates</h2>
    <dl className="mt-3 divide-y divide-rule">{c.estimates.map((e) => <div key={e.label} className="py-4">
      <dt className="font-medium">{e.label}</dt><dd className="mt-2 break-words font-mono text-sm">{e.formula} = {e.result}</dd>
      {e.note && <dd className="mt-2 text-sm text-muted">{e.note}</dd>}
    </div>)}</dl>
    <h2>API</h2>{c.api.map((a) => <div key={a.signature} className="mt-4 border-t border-rule pt-4">
      <h3 className="break-words font-mono text-sm">{a.signature}</h3><p>Request: {a.request}</p><p>Response: {a.response}</p>{a.notes && <p className="text-muted">{a.notes}</p>}
    </div>)}
    <h2>Data model</h2><ul>{c.dataModel.entities.map((e) => <li key={e.name}><span className="font-mono">{e.name}</span> — store: {e.store}</li>)}</ul>
    {c.dataModel.notes.map((s) => <p key={s}>{s}</p>)}
    <h2>High-level design</h2><p>{c.design.nodes.map((n) => `${n.label} (${n.kind})`).join("; ")}. Open the design to inspect its connections and route programs.</p>
    <h2>Deep dives</h2>{c.deepDives.map((d) => <section key={d.title}><h3>{d.title}</h3><p>{d.body}</p></section>)}
    <h2>Failure scenarios</h2>{c.failureScenarios.map((f) => <section key={f.id} className="mt-5 border-t border-rule pt-3">
      <h3>{f.title}</h3><p>{f.explanation}</p><p className="text-muted">Expected: {f.expect}</p>
      <Link href={`/sandbox?case=${c.id}&scenario=${f.id}`} className="mt-3 inline-block min-h-6 underline hover:text-accent">Open this scenario</Link>
    </section>)}
    <h2>Alternative designs</h2>{c.alternatives.map((a, i) => <section key={a.title}><h3>{a.title}</h3><p>{a.tradeoffs}</p>{a.design && <Link href={`/sandbox?case=${c.id}&alt=${i}`} className="mt-3 inline-block min-h-6 underline hover:text-accent">Open this alternative</Link>}</section>)}
    <h2>Clarifying questions</h2><ul>{c.clarifyingQuestions.map((s) => <li key={s}>{s}</li>)}</ul>
    <h2>Common mistakes</h2><ul>{c.commonMistakes.map((s) => <li key={s}>{s}</li>)}</ul>
    <h2>Self-assessment rubric</h2>{c.rubric.map((r) => <section key={r.stage}><h3 className="capitalize">{r.stage}</h3><ol className="mt-3 list-decimal space-y-2 pl-5">{r.descriptors.map((d) => <li key={d}>{d}</li>)}</ol></section>)}
  </article>;
}
