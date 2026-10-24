import { notFound } from "next/navigation";
import { getLesson } from "@/lib/content/loader";
import { TRACKS } from "@/lib/content/schema";
import { imageSize, notebookImage } from "@/lib/search/notebook-image";

export const alt = "An interactive system design lesson — System Design Simulator";
export const size = imageSize;
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ track: string; lesson: string }> }) {
  const { track, lesson: slug } = await params;
  const lesson = getLesson(track, slug);
  if (!lesson) notFound();
  const trackInfo = TRACKS.find((entry) => entry.id === lesson.track)!;
  return notebookImage(lesson.title, lesson.description, `Track ${trackInfo.n} / ${trackInfo.title}`);
}
