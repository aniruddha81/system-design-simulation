import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { widgetSchemas } from "@/lib/content/schema";
import { Preview } from "./preview";

// Author preview (PLAN §9): development only, never indexed.
const IDS = [...Object.keys(widgetSchemas), "ScalePanel"];

// A dev tool: blocking navigation is fine, so opt out of instant-navigation validation.
export const instant = false;

export const metadata: Metadata = { title: "Author preview", robots: { index: false, follow: false } };

export function generateStaticParams() {
  return IDS.map((id) => ({ id }));
}

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { id } = await params;
  if (!IDS.includes(id)) notFound();
  return <Preview id={id} ids={IDS} />;
}
