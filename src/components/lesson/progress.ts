"use client";

// The only module that talks to persistence (W2 contract in docs/WORKSTREAMS.md).
import { useEffect, useState } from "react";
import type { ProgressRecord, ReviewRecord } from "@/lib/persistence";

export type ProgressKind = ProgressRecord["kind"];
export type Progress = Map<string, ProgressRecord>;
export type Reviews = Map<string, ReviewRecord>;
export type ReviewsSnapshot = { items: Reviews; now: number };

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
    if (item.kind === "objective" && item.mastery !== undefined) {
      const quality = Math.max(0, Math.min(5, Math.round(item.mastery * 5)));
      await store.reviews.record(item.itemId, quality);
    }
  } catch (error) {
    console.error("Could not save progress", error);
  } finally {
    localChanges.dispatchEvent(new Event("change"));
  }
}

/** Mark all lessons in a track as tested out (contentRevision: 0) when a learner passes its placement check. */
export async function saveTrackPlacement(lessonIds: string[]): Promise<void> {
  try {
    const { openStore } = await loadPersistence();
    const store = await openStore();
    const now = Date.now();
    for (const lessonId of lessonIds) {
      await store.progress.upsert({
        schemaVersion: 1,
        revision: 0,
        itemId: ids.lesson(lessonId),
        kind: "lesson",
        completedAt: now,
        mastery: 1,
        contentRevision: 0,
      });
    }
  } catch (error) {
    console.error("Could not save track placement", error);
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

/** All SM-2 review records keyed by itemId with load timestamp; null until loaded. */
export function useReviews(): ReviewsSnapshot | null {
  const [records, setRecords] = useState<ReviewsSnapshot | null>(null);
  useEffect(() => {
    let live = true;
    let off = () => {};
    const load = () =>
      loadPersistence()
        .then(({ openStore }) => openStore())
        .then((store) => store.reviews.all())
        .then(
          (all) => live && setRecords({ items: new Map(all.map((r) => [r.itemId, r])), now: Date.now() }),
          () => live && setRecords({ items: new Map(), now: Date.now() }),
        );
    void load();
    localChanges.addEventListener("change", load);
    void loadPersistence().then(({ onExternalChange }) => {
      if (!live) return;
      off = onExternalChange((e) => {
        if (e.store === "reviews" || e.store === "restore") void load();
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
