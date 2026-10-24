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
    return localStorage.getItem(key) ?? memory[key] ?? (key === "theme" ? "light" : "system");
  } catch {
    return memory[key] ?? (key === "theme" ? "light" : "system"); // storage blocked
  }
}

function applyPrefs() {
  const d = document.documentElement;
  const t = read("theme");
  // Paper is the default; an explicit System preference follows the OS.
  d.setAttribute("data-theme", t === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : t);
  const m = read("motion");
  if (m === "system") d.removeAttribute("data-motion");
  else d.setAttribute("data-motion", m);
}

function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-motion", "data-pref-rev"] });
  return () => mo.disconnect();
}

/** The stored preference (Paper for theme, System for motion when unset); null during server render. */
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
  // Notebook divider tabs: the current tab is cut from the page itself and joins it.
  return (
    <ul className="flex flex-wrap items-end gap-0.5 text-[0.9375rem] scrollbar-none">
      {NAV.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <li key={href} className="flex">
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className="relative -mb-px flex min-h-10 items-center whitespace-nowrap rounded-t-md border border-b-0 border-transparent px-3.5 pt-0.5 text-ink-2 transition-colors hover:bg-[color-mix(in_oklab,var(--highlight-mark)_45%,transparent)] hover:text-fg aria-[current=page]:border-rule aria-[current=page]:bg-bg aria-[current=page]:font-medium aria-[current=page]:text-fg aria-[current=page]:before:absolute aria-[current=page]:before:-inset-x-px aria-[current=page]:before:-top-px aria-[current=page]:before:h-0.75 aria-[current=page]:before:rounded-t-md aria-[current=page]:before:bg-accent aria-[current=page]:hover:bg-bg"
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
    () => true,
  );
  const next = resolvedLight ? "dark" : "light";
  const nextName = THEME_NAME[next];
  // A two-position slide switch: Paper | Slate. The knob sits under the current theme.
  return (
    <button
      type="button"
      className="group relative grid h-8 shrink-0 grid-cols-2 items-center rounded-[var(--radius)] border border-rule bg-surface p-0.5 text-[0.8125rem] font-medium"
      onClick={() => setPref("theme", next)}
      aria-label={`Switch to ${nextName} theme`}
      title={theme === "system" ? `Following your system theme. Switch to ${nextName}` : `Switch to ${nextName} theme`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-[var(--radius-sm)] bg-fg transition-transform duration-300 ease-[var(--ease-out)] ${resolvedLight ? "" : "translate-x-full"}`}
      />
      <span aria-hidden className={`relative px-2.5 transition-colors ${resolvedLight ? "text-bg" : "text-muted group-hover:text-fg"}`}>
        Paper
      </span>
      <span aria-hidden className={`relative px-2.5 transition-colors ${resolvedLight ? "text-muted group-hover:text-fg" : "text-bg"}`}>
        Slate
      </span>
    </button>
  );
}

/** Display names for the stored theme values (kept as light/dark for saved preferences). */
export const THEME_NAME = { light: "Paper", dark: "Slate" } as const;
