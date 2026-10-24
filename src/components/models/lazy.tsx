"use client";

import { useEffect, useState, type ComponentType } from "react";

type AnyProps = Record<string, unknown>;
type Registry = Record<string, ComponentType<AnyProps>>;

let cached: Registry | null = null;

function makeLazyModel(name: string) {
  function LazyModel(props: AnyProps) {
    const [Comp, setComp] = useState<ComponentType<AnyProps> | null>(() => (cached ? cached[name] : null));
    useEffect(() => {
      if (Comp) return;
      let alive = true;
      import("./index").then((mod) => {
        cached = mod as unknown as Registry;
        if (alive) setComp(() => cached![name]);
      });
      return () => {
        alive = false;
      };
    }, [Comp]);
    if (!Comp) return <div className="my-6 min-h-48 rounded-md border border-rule bg-surface p-5 text-sm text-muted">Loading interactive model…</div>;
    return <Comp {...props} />;
  }
  LazyModel.displayName = name;
  return LazyModel;
}

export const HashRingPlayer = makeLazyModel("HashRingPlayer");
export const IsolationPlayer = makeLazyModel("IsolationPlayer");
export const ModelQuestion = makeLazyModel("ModelQuestion");
export const RaftPlayer = makeLazyModel("RaftPlayer");
export const ClocksPlayer = makeLazyModel("ClocksPlayer");
export const TwoPhasePlayer = makeLazyModel("TwoPhasePlayer");
export const GossipPlayer = makeLazyModel("GossipPlayer");
export const QuorumPlayer = makeLazyModel("QuorumPlayer");
export const CrdtPlayer = makeLazyModel("CrdtPlayer");
export const MatchingPlayer = makeLazyModel("MatchingPlayer");
export const SpatialPlayer = makeLazyModel("SpatialPlayer");
export const SketchesPlayer = makeLazyModel("SketchesPlayer");
export const WindowingPlayer = makeLazyModel("WindowingPlayer");
