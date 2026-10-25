"use client";

import { useEffect, useState } from "react";
import { exportBackup, openStore } from "@/lib/persistence";

/** PLAN §11: when browser storage is unavailable the app runs from memory. Say so on every page, with a way out. */
export function StorageBanner() {
  const [reason, setReason] = useState<string>();
  useEffect(() => {
    openStore().then(
      (s) => setReason(s.persistent ? undefined : (s.fallbackReason ?? "Storage unavailable; progress will not be saved.")),
      () => setReason("Storage unavailable; progress will not be saved."),
    );
  }, []);
  if (!reason) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule bg-surface-2 px-4 py-2 text-sm">
      <span><span aria-hidden>! </span>{reason.includes("will not be saved") ? "Progress will not be saved: storage is blocked in this browser." : reason}</span>
      <button
        type="button"
        className="btn min-h-8"
        onClick={async () => {
          try {
            const url = URL.createObjectURL(await exportBackup());
            Object.assign(document.createElement("a"), { href: url, download: "system-design-backup.json" }).click();
            URL.revokeObjectURL(url);
          } catch {
            /* nothing to export when storage never opened */
          }
        }}
      >
        Export backup
      </button>
    </div>
  );
}
