import type { ComponentKind } from "@/engine/types";
import { KIND_LABEL } from "./design-ops";

export const KINDS: ComponentKind[] = [
  "client", "dns", "cdn", "loadBalancer", "apiGateway", "rateLimiter", "circuitBreaker", "service", "worker", "autoscaler",
  "cache", "database", "kvStore", "objectStore", "searchIndex", "dedupStore", "queue",
];

export type KindCategory = "Traffic" | "Edge" | "Compute" | "Storage" | "Messaging" | "Resilience";
export const KIND_CATEGORY: Record<ComponentKind, KindCategory> = {
  client: "Traffic", dns: "Edge", cdn: "Edge", loadBalancer: "Edge", apiGateway: "Edge", rateLimiter: "Resilience",
  circuitBreaker: "Resilience", service: "Compute", worker: "Compute", autoscaler: "Compute", cache: "Storage",
  database: "Storage", kvStore: "Storage", objectStore: "Storage", searchIndex: "Storage", dedupStore: "Storage", queue: "Messaging",
};

/** Outline shape per kind, so identity never rests on colour alone (legend: colour + icon + shape + label). */
export type KindShape = "rect" | "cylinder" | "hexagon" | "pill" | "parallelogram" | "octagon";
export const KIND_SHAPE: Record<ComponentKind, KindShape> = {
  client: "pill", dns: "hexagon", cdn: "hexagon", loadBalancer: "hexagon", apiGateway: "hexagon",
  rateLimiter: "octagon", circuitBreaker: "octagon", service: "rect", worker: "rect", autoscaler: "rect",
  cache: "cylinder", database: "cylinder", kvStore: "cylinder", objectStore: "cylinder", searchIndex: "cylinder", dedupStore: "cylinder",
  queue: "parallelogram",
};

const CATEGORY_FALLBACK: Record<KindCategory, string> = {
  Traffic: "var(--text-muted)", Edge: "var(--accent)", Compute: "var(--accent)", Storage: "var(--accent-2)",
  Messaging: "var(--warning)", Resilience: "var(--danger)",
};

/** Identity colour per kind (theme token --kind-<kind>); always paired with an icon, a shape and a text label. */
export const KIND_COLOR = Object.fromEntries(
  (Object.keys(KIND_CATEGORY) as ComponentKind[]).map((k) => [k, `var(--kind-${k}, ${CATEGORY_FALLBACK[KIND_CATEGORY[k]]})`]),
) as Record<ComponentKind, string>;

export const KIND_BLURB: Record<ComponentKind, string> = {
  client: "Generates the scenario's traffic and sends it to one entry point.",
  dns: "Resolves a name to its primary record, failing over to the next.",
  cdn: "Edge cache per region; misses go to its single origin.",
  loadBalancer: "Spreads requests across the services it can call; health-checks them.",
  apiGateway: "Auth latency and request-size limits, then passes requests on.",
  rateLimiter: "Admits up to a rate, rejects the excess with 429.",
  circuitBreaker: "Fails fast with 503 while its downstream keeps failing.",
  service: "Runs your route program for each endpoint.",
  worker: "Consumes a queue and runs a route per message.",
  autoscaler: "Adds or removes workers on its targets (not in the request path).",
  cache: "Fast key-value store with limited memory and eviction.",
  database: "Source of truth. Replicas, replication lag, failover.",
  kvStore: "Consistent-hash ring with N/R/W quorums.",
  objectStore: "Durable, slow, priced per request and per GB.",
  searchIndex: "Eventually consistent copy of a source store.",
  dedupStore: "Remembers idempotency keys so retries apply once.",
  queue: "Accepts messages now; workers process them later.",
};

const PATHS: Record<ComponentKind, React.ReactNode> = {
  client: (<><rect x="2.5" y="3" width="15" height="10" rx="1.5" /><path d="M7 17h6M10 13v4" /></>),
  dns: (<><circle cx="10" cy="10" r="7" /><path d="M3 10h14M10 3c2.5 2.5 2.5 11.5 0 14M10 3c-2.5 2.5-2.5 11.5 0 14" /></>),
  cdn: (<><circle cx="10" cy="10" r="2.5" /><circle cx="3.5" cy="4" r="1.5" /><circle cx="16.5" cy="4" r="1.5" /><circle cx="3.5" cy="16" r="1.5" /><circle cx="16.5" cy="16" r="1.5" /><path d="m5 5.3 3.2 3M15 5.3l-3.2 3M5 14.7l3.2-3M15 14.7l-3.2-3" /></>),
  loadBalancer: (<><circle cx="4" cy="10" r="2" /><path d="M6 10h3m0 0 7-6m-7 6h7m-7 0 7 6" /></>),
  apiGateway: (<><path d="M3 17V8l7-5 7 5v9" /><path d="M7 17v-5h6v5" /></>),
  rateLimiter: (<><path d="M3.5 14a6.5 6.5 0 1 1 13 0" /><path d="m10 14 3.5-4" /></>),
  circuitBreaker: (<><path d="M2 10h5M13 10h5" /><path d="m7 10 5-4" /><circle cx="7" cy="10" r="1" /><circle cx="13" cy="10" r="1" /></>),
  service: (<><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M7 8h6M7 12h4" /></>),
  worker: (<><circle cx="10" cy="10" r="3" /><path d="M10 2v3M10 15v3M2 10h3M15 10h3M4.3 4.3l2.1 2.1M13.6 13.6l2.1 2.1M4.3 15.7l2.1-2.1M13.6 6.4l2.1-2.1" /></>),
  autoscaler: (<><path d="M3 13h4v4H3zM8 9h4v8H8zM13 5h4v12h-4z" /><path d="m3 9 4-4 3 2 6-5" /></>),
  cache: <path d="M11 2 4 11h5l-1 7 7-9h-5l1-7Z" />,
  database: (<><ellipse cx="10" cy="5" rx="6" ry="2.5" /><path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5" /></>),
  kvStore: (<><circle cx="10" cy="10" r="6.5" /><circle cx="10" cy="3.5" r="1.3" /><circle cx="16.2" cy="12" r="1.3" /><circle cx="4.2" cy="13" r="1.3" /></>),
  objectStore: (<><path d="M3 6l7-3.5L17 6v8l-7 3.5L3 14z" /><path d="M3 6l7 3.5L17 6M10 9.5v8" /></>),
  searchIndex: (<><circle cx="8.5" cy="8.5" r="5" /><path d="m12.5 12.5 4.5 4.5" /></>),
  dedupStore: (<><rect x="3" y="5" width="9" height="11" rx="1.5" /><path d="M8 3h7.5A1.5 1.5 0 0 1 17 4.5V13" /><path d="m5.5 10.5 1.8 1.8 3-3.3" /></>),
  queue: (<><rect x="2" y="6" width="16" height="8" rx="1" /><path d="M6 6v8M10 6v8M14 6v8" /></>),
};

export function KindIcon({ kind, size = 18 }: { kind: ComponentKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[kind]}
    </svg>
  );
}

/** Outline points for a shape in a w×h box (used by the board, the legend swatch and the SVG export). */
export function shapePath(shape: KindShape, w: number, h: number, inset = 0): string {
  const [l, t, r, b] = [inset, inset, w - inset, h - inset];
  const c = Math.min(14, (b - t) / 3);
  switch (shape) {
    case "rect": return `M${l + 6},${t} H${r - 6} Q${r},${t} ${r},${t + 6} V${b - 6} Q${r},${b} ${r - 6},${b} H${l + 6} Q${l},${b} ${l},${b - 6} V${t + 6} Q${l},${t} ${l + 6},${t} Z`;
    case "pill": { const rr = (b - t) / 2; return `M${l + rr},${t} H${r - rr} A${rr},${rr} 0 0 1 ${r - rr},${b} H${l + rr} A${rr},${rr} 0 0 1 ${l + rr},${t} Z`; }
    case "hexagon": return `M${l + c},${t} H${r - c} L${r},${(t + b) / 2} L${r - c},${b} H${l + c} L${l},${(t + b) / 2} Z`;
    case "octagon": return `M${l + c},${t} H${r - c} L${r},${t + c} V${b - c} L${r - c},${b} H${l + c} L${l},${b - c} V${t + c} Z`;
    case "parallelogram": return `M${l + c},${t} H${r} L${r - c},${b} H${l} Z`;
    case "cylinder": { const e = Math.min(8, (b - t) / 6); return `M${l},${t + e} A${(r - l) / 2},${e} 0 0 1 ${r},${t + e} V${b - e} A${(r - l) / 2},${e} 0 0 1 ${l},${b - e} Z M${l},${t + e} A${(r - l) / 2},${e} 0 0 0 ${r},${t + e}`; }
  }
}

/** Swatch with colour, shape and icon; pair it with the text label. */
export function KindSwatch({ kind, size = 28 }: { kind: ComponentKind; size?: number }) {
  const color = KIND_COLOR[kind];
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size, color }}>
      <svg className="absolute inset-0" width={size} height={size} aria-hidden="true">
        <path d={shapePath(KIND_SHAPE[kind], size, size, 1.5)} fill={`color-mix(in oklab, ${color} 12%, transparent)`} stroke={color} strokeWidth={1.25} />
      </svg>
      <span className="relative"><KindIcon kind={kind} size={Math.round(size * 0.55)} /></span>
    </span>
  );
}

/** Legend: colour + icon + shape + label for each kind present. */
export function Legend({ kinds }: { kinds: ComponentKind[] }) {
  if (kinds.length === 0) return null;
  return (
    <ul aria-label="Legend" className="flex flex-wrap gap-x-3 gap-y-1.5">
      {kinds.map((k) => (
        <li key={k} className="flex items-center gap-1.5 text-[11px] text-(--text-muted)">
          <KindSwatch kind={k} size={22} />
          {KIND_LABEL[k]}
        </li>
      ))}
    </ul>
  );
}

export { KIND_LABEL };
