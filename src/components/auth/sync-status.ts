import { useSyncExternalStore } from "react";
import type { SyncResult } from "@/lib/cloud-sync/sync";

export type SyncState = { phase: "off" | "idle" | "syncing" | "error"; at?: number; last?: SyncResult };
let state: SyncState = { phase: "off" };
const subs = new Set<() => void>();

export const setSyncState = (next: SyncState) => {
  state = next;
  subs.forEach((f) => f());
};
export const useSyncState = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state,
    () => state,
  );
