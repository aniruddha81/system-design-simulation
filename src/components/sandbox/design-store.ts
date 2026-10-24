"use client";
// Per-editor stores. One instance per mounted editor (not module-level), because Activity can keep
// several sandbox/challenge routes alive at once.
import { createContext, useContext } from "react";
import { createStore, useStore } from "zustand";
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

export type Selection = { kind: "node" | "edge" | "group"; id: string } | null;

export type DesignState = History & {
  selection: Selection;
  /** Multi-selected nodes (box select, shift-click, Ctrl+A); align/distribute/copy act on these. */
  multi: NodeId[];
  /** Routes rewritten by an insertion rule, highlighted for review (§8A.5). */
  rewritten: { owner: NodeId; endpointId: string }[];
  commit: (fn: (d: Design) => Design, key?: string) => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;
  select: (s: Selection) => void;
  setMulti: (ids: NodeId[]) => void;
  setRewritten: (r: DesignState["rewritten"]) => void;
};

export function createDesignStore(initial: Design) {
  return createStore<DesignState>()((set, get) => ({
    design: initial, past: [], future: [], lastKey: null, selection: null, multi: [], rewritten: [],
    commit: (fn, key) => set(pushHistory(get(), fn(get().design), key ?? null)),
    endGesture: () => set({ lastKey: null }),
    undo: () => set(undoHistory(get())),
    redo: () => set(redoHistory(get())),
    select: (selection) => set({ selection, multi: [] }),
    setMulti: (multi) => set({ multi, selection: multi.length === 1 ? { kind: "node", id: multi[0] } : multi.length ? null : get().selection }),
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

/** Nodes the board actions apply to: the multi-selection, else the single selected node. */
export function selectedNodeIds(s: Pick<DesignState, "multi" | "selection">): NodeId[] {
  return s.multi.length ? s.multi : s.selection?.kind === "node" ? [s.selection.id] : [];
}

// ---------- annotations: Design.annotations, excluded from designHash (§8A.5) ----------

export type Annotation =
  | { id: string; type: "stroke"; points: [number, number, number][]; color: string }
  | { id: string; type: "text" | "note"; x: number; y: number; text: string };

const LEGACY_KEY = (designId: string) => `sds:annotations:${designId}`;

/** P1 kept annotations in localStorage. Read them once so the editor can move them into the design. */
export function legacyAnnotations(designId: string): Annotation[] | null {
  try {
    const items = JSON.parse(localStorage.getItem(LEGACY_KEY(designId)) ?? "null");
    return Array.isArray(items) && items.length ? items : null;
  } catch {
    return null;
  }
}

export function dropLegacyAnnotations(designId: string) {
  try {
    localStorage.removeItem(LEGACY_KEY(designId));
  } catch {}
}

/** Annotation items plus a setter; edits are design commits (undoable), keyed so typing coalesces. */
export function useAnnotations() {
  const items = useDesign((s) => s.design.annotations) as Annotation[] | undefined;
  const api = useDesignApi();
  const set = (next: Annotation[], key?: string) => api.getState().commit((d) => ({ ...d, annotations: next }), key);
  const get = () => (api.getState().design.annotations ?? []) as Annotation[];
  return [items ?? [], { get, set }] as const;
}
