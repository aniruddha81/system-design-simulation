"use client";
// Client wrapper: the editor (React Flow, Worker, IndexedDB) is browser-only, so it loads with ssr:false
// behind a skeleton sized like the real thing (no layout shift).
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { getChallenge } from "@/content/challenges";
import { cachingScenario } from "@/engine/fixtures";
import type { ReferenceDesign } from "@/content/reference-designs";
import type { Scenario } from "@/engine/types";
import { EditorSkeleton } from "./EditorSkeleton";

const Editor = dynamic(() => import("./Editor"), { ssr: false, loading: () => <EditorSkeleton /> });

type ResolvedRequest = {
  scenario: Scenario;
  initialTab: "inspect" | "scale";
  reference?: ReferenceDesign;
} | null;

export function SandboxEditor({ designId }: { designId: string }) {
  const [state, setState] = useState<{ ready: boolean; error?: string; request?: ResolvedRequest }>(() => {
    if (typeof location === "undefined") return { ready: true };
    const q = new URLSearchParams(location.search);
    return { ready: !q.has("ref") && !q.has("case") };
  });

  useEffect(() => {
    if (state.ready) return;
    let alive = true;
    import("./open-design")
      .then(({ resolveDesignRequest }) => {
        if (!alive) return;
        try {
          setState({ ready: true, request: resolveDesignRequest(new URLSearchParams(location.search)) });
        } catch (e) {
          setState({ ready: true, error: e instanceof Error ? e.message : "Couldn't open that design." });
        }
      })
      .catch((e) => {
        if (alive) setState({ ready: true, error: e instanceof Error ? e.message : "Couldn't open that design." });
      });
    return () => {
      alive = false;
    };
  }, [state.ready]);

  if (!state.ready) return <EditorSkeleton />;
  if (state.error) return <p role="alert" className="p-6">{state.error}</p>;
  return <Editor designId={designId} scenario={state.request?.scenario ?? cachingScenario} initialTab={state.request?.initialTab} reference={state.request?.reference} />;
}

export function ChallengeEditor({ challengeId }: { challengeId: string }) {
  const challenge = getChallenge(challengeId)!;
  return <Editor designId={`challenge-${challenge.id}`} scenario={challenge.spec.scenario} fallback={challenge.start} challenge={challenge} />;
}
