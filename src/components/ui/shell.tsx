"use client";

import { MotionConfig } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

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
  try {
    if (localStorage.getItem("projector") === "true") d.setAttribute("data-projector", "true");
    else d.removeAttribute("data-projector");
  } catch {
    /* ignore */
  }
}

function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-motion", "data-projector", "data-pref-rev"] });
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

const PRIMARY_NAV = [
  { href: "/learn", label: "Learn" },
  { href: "/sandbox", label: "Sandbox" },
  { href: "/challenges", label: "Challenges" },
  { href: "/case-studies", label: "Case studies" },
  { href: "/interview", label: "Interview" },
  { href: "/progress", label: "Progress" },
] as const;

const MORE_NAV = [
  { href: "/teach", label: "Teach", hint: "Classroom demos & homework links" },
  { href: "/reference", label: "Reference", hint: "Latency numbers & calculators" },
  { href: "/settings", label: "Settings", hint: "Theme, motion & backups" },
] as const;

const ALL_NAV = [...PRIMARY_NAV, ...MORE_NAV] as const;

function useAutoCloseDetails(pathname: string) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    ref.current?.removeAttribute("open");
  }, [pathname]);
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (ref.current?.hasAttribute("open") && !ref.current.contains(e.target as Node)) {
        ref.current.removeAttribute("open");
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && ref.current?.hasAttribute("open")) {
        ref.current.removeAttribute("open");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);
  return ref;
}

/** Static list (Suspense fallback while the pathname is unknown during prerender). */
export function NavList({ pathname = "" }: { pathname?: string }) {
  const detailsRef = useAutoCloseDetails(pathname);
  const activeMore = MORE_NAV.find(({ href }) => pathname === href || pathname.startsWith(`${href}/`));

  // Single-row centered navigation pills + "More" dropdown for extra options.
  return (
    <ul className="flex flex-nowrap items-center justify-center gap-1 text-[0.875rem] leading-none">
      {PRIMARY_NAV.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <li key={href} className="flex shrink-0 items-center">
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className="relative flex h-8 items-center whitespace-nowrap rounded-[var(--radius)] border border-transparent px-2.5 text-ink-2 transition-colors hover:bg-[color-mix(in_oklab,var(--highlight-mark)_45%,transparent)] hover:text-fg aria-[current=page]:border-rule aria-[current=page]:bg-surface aria-[current=page]:font-medium aria-[current=page]:text-fg"
            >
              {label}
            </Link>
          </li>
        );
      })}
      <li className="flex shrink-0 items-center">
        <details ref={detailsRef} className="group relative">
          <summary
            data-active={activeMore ? "true" : undefined}
            className="relative flex h-8 cursor-pointer list-none items-center gap-1 whitespace-nowrap rounded-[var(--radius)] border border-transparent px-2.5 text-ink-2 transition-colors hover:bg-[color-mix(in_oklab,var(--highlight-mark)_45%,transparent)] hover:text-fg data-[active=true]:border-rule data-[active=true]:bg-surface data-[active=true]:font-medium data-[active=true]:text-fg [&::-webkit-details-marker]:hidden"
          >
            <span>{activeMore ? activeMore.label : "More"}</span>
            <svg
              aria-hidden
              viewBox="0 0 12 12"
              className="size-3 text-muted transition-transform duration-150 group-open:rotate-180"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
            </svg>
          </summary>
          <div className="absolute right-0 top-full z-50 mt-1.5 w-60 rounded-[var(--radius)] border border-rule bg-surface p-1.5 shadow-e3">
            {MORE_NAV.map(({ href, label, hint }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => detailsRef.current?.removeAttribute("open")}
                  className="flex flex-col rounded-[var(--radius-sm)] px-3 py-2 transition-colors hover:bg-surface-2 aria-[current=page]:bg-surface-2"
                >
                  <span className="flex items-center justify-between text-sm font-medium text-fg">
                    <span>{label}</span>
                    {active && <span aria-hidden className="text-xs text-accent">●</span>}
                  </span>
                  <span className="text-xs text-muted">{hint}</span>
                </Link>
              );
            })}
          </div>
        </details>
      </li>
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

function MobileMenuInner({ pathname = "" }: { pathname?: string }) {
  const detailsRef = useAutoCloseDetails(pathname);
  const current = ALL_NAV.find(({ href }) => pathname === href || pathname.startsWith(`${href}/`));

  return (
    <details ref={detailsRef} className="group relative lg:hidden">
      <summary
        aria-label="Open navigation menu"
        className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-[var(--radius)] border border-rule bg-surface px-2.5 text-xs font-medium text-fg transition-colors hover:border-fg [&::-webkit-details-marker]:hidden"
      >
        <span className="min-[400px]:hidden">Menu</span>
        <span className="hidden min-[400px]:inline">{current ? current.label : "Menu"}</span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="size-3 text-muted transition-transform duration-150 group-open:rotate-180"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
        </svg>
      </summary>
      <div className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded-[var(--radius)] border border-rule bg-surface p-1.5 shadow-e3">
        <div className="grid gap-0.5">
          {PRIMARY_NAV.map(({ href, label }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                onClick={() => detailsRef.current?.removeAttribute("open")}
                className="flex items-center justify-between rounded-[var(--radius-sm)] px-3 py-2 text-sm font-medium text-fg transition-colors hover:bg-surface-2 aria-[current=page]:bg-surface-2 aria-[current=page]:text-accent"
              >
                <span>{label}</span>
                {active && <span aria-hidden className="text-xs text-accent">●</span>}
              </Link>
            );
          })}
        </div>
        <div className="my-1 border-t border-border" />
        <div className="grid gap-0.5">
          {MORE_NAV.map(({ href, label, hint }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                onClick={() => detailsRef.current?.removeAttribute("open")}
                className="flex flex-col rounded-[var(--radius-sm)] px-3 py-1.5 transition-colors hover:bg-surface-2 aria-[current=page]:bg-surface-2"
              >
                <span className="flex items-center justify-between text-sm font-medium text-fg">
                  <span>{label}</span>
                  {active && <span aria-hidden className="text-xs text-accent">●</span>}
                </span>
                <span className="text-[11px] text-muted">{hint}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </details>
  );
}

function ActiveMobileMenu() {
  return <MobileMenuInner pathname={usePathname()} />;
}

export function MobileNavMenu() {
  return (
    <Suspense fallback={<MobileMenuInner />}>
      <ActiveMobileMenu />
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
      className="group relative grid h-8 shrink-0 grid-cols-2 items-center rounded-[var(--radius)] border border-rule bg-surface p-0.5 text-xs font-medium sm:text-[0.8125rem]"
      onClick={() => setPref("theme", next)}
      aria-label={`Paper Slate. Switch to ${nextName} theme`}
      title={theme === "system" ? `Following your system theme. Switch to ${nextName}` : `Switch to ${nextName} theme`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-[var(--radius-sm)] bg-fg transition-transform duration-300 ease-[var(--ease-out)] ${resolvedLight ? "" : "translate-x-full"}`}
      />
      <span aria-hidden className={`relative px-2 transition-colors sm:px-2.5 ${resolvedLight ? "text-bg" : "text-muted group-hover:text-fg"}`}>
        Paper
      </span>{" "}
      <span aria-hidden className={`relative px-2 transition-colors sm:px-2.5 ${resolvedLight ? "text-muted group-hover:text-fg" : "text-bg"}`}>
        Slate
      </span>
    </button>
  );
}

/** Display names for the stored theme values (kept as light/dark for saved preferences). */
export const THEME_NAME = { light: "Paper", dark: "Slate" } as const;
