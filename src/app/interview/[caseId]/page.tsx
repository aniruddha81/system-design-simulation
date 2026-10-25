import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { caseStudies, getCaseStudy } from "@/content/case-studies";
import { InterviewSession } from "@/components/interview/InterviewSession";

type Props = { params: Promise<{ caseId: string }> };
export function generateStaticParams() {
  return caseStudies.map((c) => ({ caseId: c.id }));
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const c = getCaseStudy((await params).caseId);
  return c ? { title: `Interview: ${c.title}`, robots: { index: false } } : {};
}
export default async function InterviewPage({ params }: Props) {
  const c = getCaseStudy((await params).caseId);
  if (!c) notFound();
  return <InterviewSession key={c.id} study={c} />;
}
