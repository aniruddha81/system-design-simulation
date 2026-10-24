import { notFound } from "next/navigation";
import { getCaseStudy } from "@/content/case-studies";
import { imageSize, notebookImage } from "@/lib/search/notebook-image";

export const alt = "A worked system design case study — System Design Simulator";
export const size = imageSize;
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const study = getCaseStudy(id);
  if (!study) notFound();
  return notebookImage(study.title, study.summary, "Track 5 / Case studies");
}
