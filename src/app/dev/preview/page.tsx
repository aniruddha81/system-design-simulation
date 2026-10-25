import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { widgetSchemas } from "@/lib/content/schema";

export const metadata: Metadata = {
  title: "Author preview",
  robots: { index: false, follow: false },
};

export default function PreviewIndex() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Author preview</h1>
      <p className="my-4">
        Open a lesson widget to step through its seeded example. ModelQuestion
        includes a selector for every focused model.
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {[...Object.keys(widgetSchemas), "ScalePanel"].map((id) => (
          <li key={id}>
            <Link
              className="inline-flex min-h-9 items-center underline"
              href={`/dev/preview/${id}`}
            >
              {id}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
