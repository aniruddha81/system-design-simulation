"use client";
// Per-editor stores. One instance per mounted editor (not module-level), because Activity can keep
// several sandbox/challenge routes alive at once.
import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import type { Design, NodeId } from "@/engine/types";

const MAX_HISTORY = 200;

export type History = { design: Design; past: Design[]; future: Design[]; lastKey: string | null };

/** Push `next` onto history. Commits sharing a non-null key with the previous one coalesce into one undo step. */
export function pushHistory(h: History, next: Design, key: string | null = null): History {
  if (next === h.design) return h;
  if (key !== null && key === h.lastKey) return { ...h, design: next, future: [] };
  return { design: next, past: [...h.past, h.design].slice(-MAX_HISTORY), future: [], lastKey: key };
}

export function undoHistory(h: History): History {
  const prev = h.past.at(-1);
  return prev ? { design: prev, past: h.past.slice(0, -1), future: [h.design, ...h.future], lastKey: null } : h;
}

export function redoHistory(h: History): History {
  const [next, ...future] = h.future;
  return next ? { design: next, past: [...h.past, h.design], future, lastKey: null } : h;
}

export type Selection = { kind: "node" | "edge"; id: string } | null;

export type DesignState = History & {
  selection: Selection;
  /** Routes rewritten by an insertion rule, highlighted for review (§8A.5). */
  rewritten: { owner: NodeId; endpointId: string }[];
  commit: (fn: (d: Design) => Design, key?: string) => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  select: (s: Selection) => void;
  setRewritten: (r: DesignState["rewritten"]) => void;
};

export function createDesignStore(initial: Design) {
  return createStore<DesignState>()((set, get) => ({
    design: initial, past: [], future: [], lastKey: null, selection: null, rewritten: [],
    commit: (fn, key) => set(pushHistory(get(), fn(get().design), key ?? null)),
    endGesture: () => set({ lastKey: null }),
    undo: () => set(undoHistory(get())),
    redo: () => set(redoHistory(get())),
    select: (selection) => set({ selection }),
    setRewritten: (rewritten) => set({ rewritten }),
  }));
}

export type DesignStore = ReturnType<typeof createDesignStore>;
export const DesignCtx = createContext<DesignStore | null>(null);

export function useDesign<T>(sel: (s: DesignState) => T): T {
  const store = useContext(DesignCtx);
  if (!store) throw new Error("useDesign outside DesignCtx");
  return useStore(store, sel);
}

export function useDesignApi(): DesignStore {
  const store = useContext(DesignCtx);
  if (!store) throw new Error("useDesignApi outside DesignCtx");
  return store;
}

// ---------- annotations: separate layer, never part of the Design or its hash (§8A.5) ----------

export type Annotation =
  | { id: string; type: "stroke"; points: [number, number, number][]; color: string }
  | { id: string; type: "text" | "note"; x: number; y: number; text: string };

export type AnnotationState = { items: Annotation[] };

// ponytail: annotations persist in localStorage per design; DesignRecord (W2) has no field for them yet.
export function createAnnotationStore(designId: string): StoreApi<AnnotationState> {
  const key = `sds:annotations:${designId}`;
  let items: Annotation[] = [];
  try {
    items = JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {}
  const store = createStore<AnnotationState>()(() => ({ items }));
  store.subscribe((s) => {
    try {
      localStorage.setItem(key, JSON.stringify(s.items));
    } catch {}
  });
  return store;
}

export const AnnotationCtx = createContext<StoreApi<AnnotationState> | null>(null);

export function useAnnotations() {
  const store = useContext(AnnotationCtx);
  if (!store) throw new Error("useAnnotations outside AnnotationCtx");
  return [useStore(store, (s) => s.items), store] as const;
}
