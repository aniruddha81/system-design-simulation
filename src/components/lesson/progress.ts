"use client";

// The only module that talks to persistence (W2 contract in docs/WORKSTREAMS.md).
import { useEffect, useState } from "react";
import type { ProgressRecord } from "@/lib/persistence";

export type ProgressKind = ProgressRecord["kind"];
export type Progress = Map<string, ProgressRecord>;

export const ids = {
  lesson: (lessonId: string) => `lesson:${lessonId}`,
  step: (lessonId: string, stepId: string) => `step:${lessonId}/${stepId}`,
  objective: (lessonId: string, objectiveId: string) => `objective:${lessonId}/${objectiveId}`,
};

const localChanges = new EventTarget();
const loadPersistence = () => import("@/lib/persistence");

/** Upsert merges per item by max (completedAt, mastery), so saves never lower progress. */
export async function saveProgress(
  item: { itemId: string; kind: ProgressKind; completedAt?: number; mastery?: number },
  contentRevision: number,
): Promise<void> {
  try {
    const { openStore } = await loadPersistence();
    const store = await openStore();
    await store.progress.upsert({ schemaVersion: 1, revision: 0, contentRevision, ...item });
  } catch (error) {
    console.error("Could not save progress", error);
  } finally {
    localChanges.dispatchEvent(new Event("change"));
  }
}

/** All progress records keyed by itemId; null until loaded. Updates on local and cross-tab changes. */
export function useProgress(): Progress | null {
  const [records, setRecords] = useState<Progress | null>(null);
  useEffect(() => {
    let live = true;
    let off = () => {};
    const load = () =>
      loadPersistence()
        .then(({ openStore }) => openStore())
        .then((store) => store.progress.all())
        .then(
          (all) => live && setRecords(new Map(all.map((r) => [r.itemId, r]))),
          () => live && setRecords(new Map()),
        );
    void load();
    localChanges.addEventListener("change", load);
    void loadPersistence().then(({ onExternalChange }) => {
      if (!live) return;
      off = onExternalChange((e) => {
        if (e.store === "progress" || e.store === "restore") void load();
      });
    });
    return () => {
      live = false;
      localChanges.removeEventListener("change", load);
      off();
    };
  }, []);
  return records;
}

export const isCompleted = (p: Progress | null, itemId: string) => p?.get(itemId)?.completedAt !== undefined;

export async function downloadBackup(): Promise<void> {
  const { exportBackup } = await loadPersistence();
  const blob = await exportBackup();
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: `system-design-backup-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(url);
}

export async function restoreFromFile(file: File): Promise<void> {
  const { restoreBackup } = await loadPersistence();
  await restoreBackup(file, "merge");
  localChanges.dispatchEvent(new Event("change"));
}
