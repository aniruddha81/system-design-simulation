import type { Metadata } from "next";
import Link from "next/link";
import { caseStudies } from "@/content/case-studies";
import { referenceDesigns } from "@/content/reference-designs";

export const metadata: Metadata = { title: "Case studies", description: "Worked system designs, runnable failures and illustrative planet-scale references." };

export default function CaseStudiesPage() {
  return <div className="mx-auto max-w-4xl px-4 py-10">
    <h1 className="font-display text-4xl">Case studies</h1>
    <p className="mt-4 text-muted">Work through requirements, estimates and trade-offs, then run the failure scenarios.</p>
    <ul className="mt-8 divide-y divide-rule">{caseStudies.map((c) => <li key={c.id} className="py-5">
      <Link href={`/case-studies/${c.id}`} className="font-display text-2xl underline decoration-border underline-offset-4 hover:text-accent">{c.title}</Link>
      <p className="mt-2 text-muted">{c.summary}</p>
    </li>)}</ul>
    <h2 className="mt-12 font-display text-3xl">Planet-scale references</h2>
    <p className="mt-3 text-muted">Illustrative models with stated assumptions. Scale mode estimates load; correctness stays unknown.</p>
    <ul className="mt-5 divide-y divide-rule">{referenceDesigns.map((r) => <li key={r.id} className="py-4">
      <Link href={`/sandbox?ref=${r.id}`} className="inline-block min-h-6 underline hover:text-accent">{r.title} — open in Scale mode</Link>
    </li>)}</ul>
  </div>;
}
