"use client";

import { MotionConfig } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";

// UI preferences live on <html data-theme / data-motion>, set before paint by the inline
// script in layout.tsx (keep the two in sync) and persisted in localStorage.
export type Theme = "system" | "dark" | "light";
export type Motion = "system" | "full" | "reduced" | "off";
type Key = "theme" | "motion";

const memory: Partial<Record<Key, string>> = {};
function read(key: Key): string {
  try {
    return localStorage.getItem(key) ?? memory[key] ?? "system";
  } catch {
    return memory[key] ?? "system"; // storage blocked
  }
}

function applyPrefs() {
  const d = document.documentElement;
  const t = read("theme");
  d.setAttribute("data-theme", t === "system" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : t);
  const m = read("motion");
  if (m === "system") d.removeAttribute("data-motion");
  else d.setAttribute("data-motion", m);
}

function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-motion", "data-pref-rev"] });
  return () => mo.disconnect();
}

/** The stored preference ("system" when unset); null during server render. */
export function usePref<K extends Key>(key: K): (K extends "theme" ? Theme : Motion) | null {
  return useSyncExternalStore(subscribe, () => read(key) as K extends "theme" ? Theme : Motion, () => null);
}

export function setPref(key: Key, value: string) {
  memory[key] = value;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage blocked: the choice lasts for this page only. */
  }
  applyPrefs();
  // Theme "system" -> "system" with an unchanged OS theme mutates nothing; nudge subscribers anyway.
  document.documentElement.setAttribute("data-pref-rev", String(Date.now()));
}

export function Providers({ children }: { children: ReactNode }) {
  // React's dev remount resets <html> attributes; re-apply (no-op in production).
  useLayoutEffect(applyPrefs, []);
  // Full-height tools (sandbox editor) size themselves with calc(100dvh - var(--app-header-h)).
  useLayoutEffect(() => {
    const header = document.querySelector("header");
    if (!header) return;
    const ro = new ResizeObserver(() =>
      document.documentElement.style.setProperty("--app-header-h", `${header.getBoundingClientRect().height}px`),
    );
    ro.observe(header);
    return () => ro.disconnect();
  }, []);
  const motion = usePref("motion");
  const reducedMotion = motion === "full" ? "never" : motion === "reduced" || motion === "off" ? "always" : "user";
  return <MotionConfig reducedMotion={reducedMotion}>{children}</MotionConfig>;
}

const NAV = [
  { href: "/learn", label: "Learn" },
  { href: "/sandbox", label: "Sandbox" },
  { href: "/challenges", label: "Challenges" },
  { href: "/reference", label: "Reference" },
  { href: "/progress", label: "Progress" },
  { href: "/settings", label: "Settings" },
] as const;

/** Static list (Suspense fallback while the pathname is unknown during prerender). */
export function NavList({ pathname = "" }: { pathname?: string }) {
  return (
    <ul className="flex items-center gap-1 overflow-x-auto text-sm [scrollbar-width:none]">
      {NAV.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <li key={href}>
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className="relative flex min-h-9 items-center whitespace-nowrap rounded-md px-3 text-muted transition-colors hover:text-fg aria-[current=page]:text-fg aria-[current=page]:after:absolute aria-[current=page]:after:inset-x-3 aria-[current=page]:after:-bottom-px aria-[current=page]:after:h-0.5 aria-[current=page]:after:rounded-full aria-[current=page]:after:bg-accent"
            >
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function ActiveNavList() {
  return <NavList pathname={usePathname()} />;
}

/** usePathname is request data under cacheComponents, so the active state streams in. */
export function NavLinks() {
  return (
    <Suspense fallback={<NavList />}>
      <ActiveNavList />
    </Suspense>
  );
}

export function ThemeToggle() {
  const theme = usePref("theme");
  const resolvedLight = useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.theme === "light",
    () => false,
  );
  const next = resolvedLight ? "dark" : "light";
  return (
    <button
      type="button"
      className="btn btn-ghost size-9 min-h-9 p-0"
      onClick={() => setPref("theme", next)}
      aria-label={`Switch to ${next} theme`}
      title={theme === "system" ? `Following system theme. Switch to ${next}` : `Switch to ${next} theme`}
    >
      <svg aria-hidden viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.75">
        {resolvedLight ? (
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" strokeLinejoin="round" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
          </>
        )}
      </svg>
    </button>
  );
}
