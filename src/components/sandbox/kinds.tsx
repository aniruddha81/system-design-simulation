import type { ComponentKind } from "@/engine/types";
import { KIND_LABEL } from "./design-ops";

export const KINDS: ComponentKind[] = ["client", "loadBalancer", "service", "cache", "database", "rateLimiter"];

/** Identity hue per kind; always paired with an icon and a text label (never colour alone). */
export const KIND_COLOR: Record<ComponentKind, string> = {
  client: "oklch(0.72 0.06 250)",
  loadBalancer: "oklch(0.72 0.14 295)",
  service: "oklch(0.74 0.13 235)",
  cache: "oklch(0.8 0.14 75)",
  database: "oklch(0.75 0.11 175)",
  rateLimiter: "oklch(0.74 0.15 350)",
};

export const KIND_BLURB: Record<ComponentKind, string> = {
  client: "Generates the scenario's traffic and sends it to one entry point.",
  loadBalancer: "Spreads requests across the services it can call; health-checks them.",
  service: "Runs your route program for each endpoint.",
  cache: "Fast key-value store with limited memory and eviction.",
  database: "Source of truth. Slower reads and writes, limited workers.",
  rateLimiter: "Admits up to a rate, rejects the excess with 429.",
};

const PATHS: Record<ComponentKind, React.ReactNode> = {
  client: (<><rect x="2.5" y="3" width="15" height="10" rx="1.5" /><path d="M7 17h6M10 13v4" /></>),
  loadBalancer: (<><circle cx="4" cy="10" r="2" /><path d="M6 10h3m0 0 7-6m-7 6h7m-7 0 7 6" /></>),
  service: (<><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M7 8h6M7 12h4" /></>),
  cache: <path d="M11 2 4 11h5l-1 7 7-9h-5l1-7Z" />,
  database: (<><ellipse cx="10" cy="5" rx="6" ry="2.5" /><path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" /></>),
  rateLimiter: (<><path d="M3.5 14a6.5 6.5 0 1 1 13 0" /><path d="m10 14 3.5-4" /></>),
};

export function KindIcon({ kind, size = 18 }: { kind: ComponentKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[kind]}
    </svg>
  );
}

export { KIND_LABEL };
