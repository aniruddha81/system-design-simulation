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
  if (isPending) return <span aria-hidden className="size-8 sm:w-[4.3rem]" />;
  if (!data)
    return (
      <Link href="/account" aria-label="Sign in" className="grid size-8 whitespace-nowrap place-items-center rounded-full border border-rule bg-surface sm:w-auto sm:rounded-[var(--radius)] sm:px-3 sm:text-[0.8125rem] sm:font-medium">
        <svg aria-hidden viewBox="0 0 24 24" className="size-5 sm:hidden" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="12" cy="8.5" r="3.5" />
          <path d="M5 20c.8-3.6 3.5-5.5 7-5.5s6.2 1.9 7 5.5" />
        </svg>
        <span className="hidden whitespace-nowrap sm:inline">Sign in</span>
      </Link>
    );
  return (
    <Link href="/account" aria-label={`Account, ${LABEL[sync.phase]}`} className="relative grid size-8 place-items-center rounded-full border border-rule bg-surface text-[0.8125rem] font-medium uppercase">
      {data.user.name.slice(0, 1) || "?"}
      <span aria-hidden className={`absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-surface-2 ${DOT[sync.phase]}`} />
    </Link>
  );
}
