"use client";
// Client wrapper: the editor (React Flow, Worker, IndexedDB) is browser-only, so it loads with ssr:false
// behind a skeleton sized like the real thing (no layout shift).
import dynamic from "next/dynamic";
import { getChallenge } from "@/content/challenges";
import { cachingScenario } from "@/engine/fixtures";
import { EditorSkeleton } from "./EditorSkeleton";

const Editor = dynamic(() => import("./Editor"), { ssr: false, loading: () => <EditorSkeleton /> });

export function SandboxEditor({ designId }: { designId: string }) {
  return <Editor designId={designId} scenario={cachingScenario} />;
}

export function ChallengeEditor({ challengeId }: { challengeId: string }) {
  const challenge = getChallenge(challengeId)!;
  return <Editor designId={`challenge-${challenge.id}`} scenario={challenge.spec.scenario} fallback={challenge.start} challenge={challenge} />;
}
