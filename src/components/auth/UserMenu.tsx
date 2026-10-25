"use client";

import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { useSyncState } from "./sync-status";

const DOT = { off: "bg-muted", idle: "bg-success", syncing: "bg-warning animate-pulse", error: "bg-danger" } as const;
const LABEL = { off: "not syncing", idle: "synced", syncing: "syncing", error: "sync failed" } as const;

/** Header entry: "Sign in" when signed out, an initial with a sync-status dot when signed in. */
export function UserMenu() {
  const { data, isPending } = useSession();
  const sync = useSyncState();
  if (isPending) return <span aria-hidden className="size-9" />;
  if (!data) return <Link href="/account" className="btn btn-ghost min-h-9 px-3 text-sm">Sign in</Link>;
  return (
    <Link href="/account" aria-label={`Account, ${LABEL[sync.phase]}`} className="relative grid size-9 place-items-center rounded-full border border-rule bg-surface font-medium uppercase">
      {data.user.name.slice(0, 1) || "?"}
      <span aria-hidden className={`absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-surface-2 ${DOT[sync.phase]}`} />
    </Link>
  );
}
