import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CaseStudyView } from "@/components/CaseStudyView";
import { caseStudies, getCaseStudy } from "@/content/case-studies";

type Props = { params: Promise<{ id: string }> };
export function generateStaticParams() { return caseStudies.map((c) => ({ id: c.id })); }
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const c = getCaseStudy((await params).id);
  return c ? { title: c.title, description: c.summary, alternates: { canonical: `/case-studies/${c.id}` } } : {};
}
export default async function CaseStudyPage({ params }: Props) {
  const c = getCaseStudy((await params).id);
  if (!c) notFound();
  return <CaseStudyView study={c} />;
}
