"use client";

import { useSyncExternalStore } from "react";

/** The motion level in force: the saved setting, or the OS preference when it is System. */
export type MotionLevel = "full" | "reduced" | "off";

const QUERY = "(prefers-reduced-motion: reduce)";

function read(): MotionLevel {
  const saved = document.documentElement.getAttribute("data-motion");
  if (saved === "full" || saved === "reduced" || saved === "off") return saved;
  return matchMedia(QUERY).matches ? "reduced" : "full";
}

function subscribe(onChange: () => void) {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  const mq = matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => {
    mo.disconnect();
    mq.removeEventListener("change", onChange);
  };
}

/** null during server render and hydration, so nothing animates before the setting is known. */
export function useMotionLevel(): MotionLevel | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
