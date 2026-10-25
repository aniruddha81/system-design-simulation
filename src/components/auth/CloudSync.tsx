"use client";

import { useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import { setSyncState } from "./sync-status";

let running = false;
export let syncRequest: () => void = () => {};

/** Mounted once in the layout. Syncs on sign-in, on local edits (debounced), when back online and every minute. Renders nothing. */
export function CloudSync() {
  const { data } = useSession();
  const userId = data?.user.id;

  useEffect(() => {
    if (!userId) {
      setSyncState({ phase: "off" });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dead = false;
    let cleanup = () => {};
    // Signed-out visitors never download the sync/persistence/zod code.
    void Promise.all([import("@/lib/cloud-sync/sync"), import("@/lib/persistence")]).then(([{ syncNow }, { onExternalChange, openStore }]) => {
    if (dead) return;
    const run = async () => {
      if (running || dead || !navigator.onLine) return;
      running = true;
      setSyncState({ phase: "syncing" });
      try {
        const store = await openStore();
        if (store.readOnly) return setSyncState({ phase: "off" });
        const last = await syncNow(store, userId);
        if (!dead) setSyncState({ phase: "idle", at: Date.now(), last });
      } catch {
        if (!dead) setSyncState({ phase: "error" });
      } finally {
        running = false;
      }
    };
    const soon = (ms = 3000) => {
      clearTimeout(timer);
      timer = setTimeout(run, ms);
    };
    syncRequest = () => soon(0);
    soon(0);
    // A sync's own writes also fire change events; the second pass finds nothing new and stops.
    const off = onExternalChange(() => soon());
    const interval = setInterval(() => soon(0), 60_000);
    const online = () => soon(0);
    addEventListener("online", online);
    const hide = () => document.visibilityState === "hidden" && soon(0);
    document.addEventListener("visibilitychange", hide);
    cleanup = () => {
      clearTimeout(timer);
      clearInterval(interval);
      off();
      removeEventListener("online", online);
      document.removeEventListener("visibilitychange", hide);
    };
    });
    return () => {
      dead = true;
      cleanup();
    };
  }, [userId]);

  return null;
}
