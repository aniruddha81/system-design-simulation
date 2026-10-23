import type { Metadata } from "next";
import { Suspense } from "react";
import { SandboxEditor } from "@/components/sandbox/EditorLoader";
import { EDITOR_FRAME, EditorSkeleton } from "@/components/sandbox/EditorSkeleton";

export const metadata: Metadata = { title: "Sandbox draft", robots: { index: false, follow: false } };

// Draft ids are local to the browser, so the param is runtime data: read it inside Suspense
// and let the static shell carry a CLS-safe skeleton.
export default function DraftPage({ params }: PageProps<"/sandbox/[designId]">) {
  return (
    <div className={EDITOR_FRAME}>
      <Suspense fallback={<EditorSkeleton />}>
        {params.then(({ designId }) => <SandboxEditor designId={designId} />)}
      </Suspense>
    </div>
  );
}
