import type { Metadata } from "next";
import Link from "next/link";
import { caseStudies } from "@/content/case-studies";

export const metadata: Metadata = { title: "Interview practice", description: "Practice system design with staged prompts and a self-assessment rubric." };
export default function InterviewPage() {
  return <div className="mx-auto max-w-3xl px-4 py-10">
    <h1 className="font-display text-4xl">Interview practice</h1>
    <p className="mt-4 text-muted">Choose a case, work through the stages, and assess your design against the rubric. Pause or work untimed whenever you need.</p>
    <ul className="mt-8 divide-y divide-rule">{caseStudies.map((c) => <li key={c.id} className="py-5"><Link href={`/interview/${c.id}`} className="inline-block min-h-6 font-display text-2xl underline hover:text-accent">{c.title}</Link><p className="mt-2 text-muted">{c.summary}</p></li>)}</ul>
  </div>;
}
