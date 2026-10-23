import type { Design } from "../../engine/types";
import type { DesignRecord } from "./schemas";
import { openStore, type Store } from "./store";

export type SaveStatus = "saved" | "saving" | "error";
export type Autosave = {
  readonly status: SaveStatus;
  readonly error: unknown;
  schedule(design: Design | DesignRecord): void;
  flush(): Promise<void>;
  retry(): Promise<void>;
  subscribe(callback: (status: SaveStatus) => void): () => void;
  dispose(): void;
};

export function autosave(designId: string, options: { store?: Store; onStatusChange?: (status: SaveStatus) => void } = {}): Autosave {
  let status: SaveStatus = "saved";
  let error: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Design | DesignRecord | undefined;
  let active: Promise<void> | undefined;
  let disposed = false;
  let baseline: DesignRecord | undefined;
  const listeners = new Set<(status: SaveStatus) => void>();
  if (options.onStatusChange) listeners.add(options.onStatusChange);
  const ready = (async () => {
    const store = options.store ?? await openStore();
    baseline = await store.designs.get(designId);
    return store;
  })();
  // Opening a store can fail before the first edit; flush reports that failure.
  void ready.catch(() => {});
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (status === "saved") return;
    event.preventDefault();
    event.returnValue = "";
  };
  if (typeof window !== "undefined") window.addEventListener("beforeunload", beforeUnload);
  function update(next: SaveStatus) {
    status = next;
    for (const listener of listeners) listener(status);
  }
  async function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (active) { await active; if (pending && status !== "error") await flush(); return; }
    if (!pending || disposed) return;
    const value = pending;
    pending = undefined;
    update("saving");
    active = (async () => {
      try {
        const store = await ready;
        const now = Date.now();
        const record: DesignRecord = "design" in value ? value : {
          schemaVersion: 1, id: designId, design: value, revision: baseline?.revision ?? 0,
          restoreGeneration: baseline?.restoreGeneration, createdAt: baseline?.createdAt ?? now, updatedAt: now,
        };
        baseline = await store.designs.put(record, record.revision);
        error = undefined;
        update(pending ? "saving" : "saved");
      } catch (caught) {
        pending ??= value;
        error = caught;
        update("error");
      }
    })();
    await active;
    active = undefined;
  }
  return {
    get status() { return status; },
    get error() { return error; },
    schedule(value) {
      if (disposed) return;
      const id = "design" in value ? value.design.id : value.id;
      if (id !== designId) throw new Error("Autosave design ID does not match.");
      pending = structuredClone(value);
      error = undefined;
      update("saving");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, 800);
    },
    flush,
    async retry() { if (active) await active; await flush(); },
    subscribe(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (typeof window !== "undefined") window.removeEventListener("beforeunload", beforeUnload);
      listeners.clear();
    },
  };
}
