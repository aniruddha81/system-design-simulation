import type { CSSProperties } from "react";
import { HeroLive } from "./hero-live";
import { arrowHead, sketch, Strokes } from "./sketch";

// Fig. 1 on the home page: a cache-aside system drawn in coloured pencil, with requests
// travelling along the edges. Geometry is fixed, so every stroke is computed at build time.
type Box = { x: number; y: number; w: number; h: number };
const N = {
  clients: { x: 10, y: 150, w: 94, h: 62 },
  lb: { x: 138, y: 150, w: 94, h: 62 },
  a: { x: 270, y: 54, w: 102, h: 60 },
  b: { x: 270, y: 250, w: 102, h: 60 },
  cache: { x: 420, y: 30, w: 128, h: 64 },
  db: { x: 420, y: 234, w: 128, h: 100 },
} satisfies Record<string, Box>;

const EDGES = {
  in: "M106 181 L136 181",
  la: "M234 172 C254 172 248 84 268 84",
  lb: "M234 190 C254 190 248 280 268 280",
  ac: "M374 76 C396 76 398 60 418 60",
  bc: "M374 266 C404 260 392 82 418 76",
  ad: "M374 94 C402 102 392 262 418 266",
  bd: "M374 290 C394 290 398 292 418 292",
} as const;
const END: Record<keyof typeof EDGES, [number, number, number, number]> = {
  in: [126, 181, 136, 181],
  la: [256, 84, 268, 84],
  lb: [256, 280, 268, 280],
  ac: [406, 61, 418, 60],
  bc: [406, 77, 418, 76],
  ad: [408, 265, 418, 266],
  bd: [408, 292, 418, 292],
};

const CYL = `M${N.db.x} 248 A64 14 0 0 1 ${N.db.x + 128} 248 L${N.db.x + 128} 320 A64 14 0 0 1 ${N.db.x} 320 Z`;
const CYL_LIP = `M${N.db.x} 248 A64 14 0 0 0 ${N.db.x + 128} 248`;

function Packet({ edge, dur, delay, className }: { edge: keyof typeof EDGES; dur: number; delay: number; className?: string }) {
  const style = { offsetPath: `path("${EDGES[edge]}")`, offsetRotate: "0deg", "--dur": `${dur}s`, "--delay": `${delay}s` } as CSSProperties;
  return <circle r="3.6" className={`motion-only ${className ?? ""}`} style={style} />;
}

function Label({ box, title, sub, subDown }: { box: Box; title: string; sub: string; subDown?: string }) {
  const x = box.x + 12;
  return (
    <>
      <text x={x} y={box.y + 26} className="fill-fg text-[16px] font-semibold">
        {title}
      </text>
      <text x={x} y={box.y + 45} className={`fill-muted font-mono text-[12px] ${subDown ? "group-data-[down=true]:hidden" : ""}`}>
        {sub}
      </text>
      {subDown && (
        <text x={x} y={box.y + 45} className="hidden fill-danger font-mono text-[12px] font-medium group-data-[down=true]:inline">
          {subDown}
        </text>
      )}
    </>
  );
}

export function HeroDiagram() {
  const box = (b: Box, seed: number) => sketch.rect(b.x, b.y, b.w, b.h, seed);
  const edge = (k: keyof typeof EDGES, seed: number) => [...sketch.path(EDGES[k], seed, { roughness: 0.8 }), ...arrowHead(...END[k], seed + 1)];
  const note = { fontFamily: "var(--font-display)", fontStyle: "italic", fontVariationSettings: '"SOFT" 100, "WONK" 1' } satisfies CSSProperties;

  return (
    <HeroLive>
      <svg viewBox="0 0 560 372" role="img" aria-labelledby="fig1-title" className="block w-full" style={{ fontFamily: "var(--font-sans)" }}>
        <title id="fig1-title">
          A cache-aside system: clients reach a load balancer, two services read from a cache, and misses fall through to the database.
        </title>

        {/* Edges: pencil lines, drawn on first. */}
        <g strokeWidth="1.4">
          <Strokes d={edge("in", 11)} draw={0.5} className="text-ink-2" />
          <Strokes d={edge("la", 12)} draw={0.7} className="text-ink-2" />
          <Strokes d={edge("lb", 13)} draw={0.75} className="text-ink-2" />
          <Strokes d={edge("ac", 14)} draw={0.95} className="text-accent-2 group-data-[down=true]:opacity-30" />
          <Strokes d={edge("bc", 15)} draw={1} className="text-accent-2 group-data-[down=true]:opacity-30" />
          <Strokes d={edge("ad", 16)} draw={1.1} className="text-accent" strokeDasharray="5 5" />
          <Strokes d={edge("bd", 17)} draw={1.15} className="text-accent" strokeDasharray="5 5" />
        </g>

        {/* Database load, shaded in pencil: cool when the cache absorbs reads, hot when it is gone. */}
        <Strokes d={sketch.hatch(CYL, 41)} strokeWidth="0.9" className="text-(--heat-1) opacity-70 group-data-[down=true]:hidden" />
        <Strokes d={sketch.hatch(CYL, 42, { hachureGap: 3.5 })} strokeWidth="1" className="hidden text-(--heat-4) opacity-80 group-data-[down=true]:inline" />

        {/* Components in their coloured pencils. */}
        <g strokeWidth="1.7">
          <Strokes d={sketch.rect(N.clients.x + 5, N.clients.y - 5, N.clients.w, N.clients.h, 3)} className="text-(--kind-client) opacity-50" />
          <rect x={N.clients.x + 1} y={N.clients.y + 1} width={N.clients.w - 2} height={N.clients.h - 2} className="fill-surface" />
          <Strokes d={box(N.clients, 4)} draw={0} className="text-(--kind-client)" />
          <Strokes d={box(N.lb, 5)} draw={0.15} className="text-(--kind-loadBalancer)" />
          <Strokes d={box(N.a, 6)} draw={0.3} className="text-(--kind-service)" />
          <Strokes d={box(N.b, 7)} draw={0.35} className="text-(--kind-service)" />
          <Strokes d={box(N.cache, 8)} draw={0.45} className="text-(--kind-cache) group-data-[down=true]:opacity-40" />
          <Strokes d={[...sketch.path(CYL, 9), ...sketch.path(CYL_LIP, 10)]} draw={0.55} className="text-(--kind-database)" />
        </g>

        <Label box={N.clients} title="Clients" sub="20k reads/s" />
        <Label box={N.lb} title="LB" sub="round robin" />
        <Label box={N.a} title="svc-a" sub="cache-aside" />
        <Label box={N.b} title="svc-b" sub="cache-aside" />
        <Label box={N.cache} title="Cache" sub="hit rate 94%" subDown="unavailable" />
        <rect x={N.db.x + 8} y={N.db.y + 39} width={N.db.w - 16} height="44" rx="2" className="fill-surface" />
        <Label box={{ ...N.db, y: N.db.y + 30 }} title="Database" sub="1.2k reads/s" subDown="20k reads/s" />

        {/* The cache, crossed out when killed. */}
        <g className="hidden group-data-[down=true]:inline">
          <Strokes
            d={[...sketch.line(N.cache.x - 6, N.cache.y - 6, N.cache.x + N.cache.w + 6, N.cache.y + N.cache.h + 6, 21), ...sketch.line(N.cache.x + N.cache.w + 6, N.cache.y - 6, N.cache.x - 6, N.cache.y + N.cache.h + 6, 22)]}
            draw={0}
            strokeWidth="2.6"
            className="text-accent"
          />
        </g>

        {/* Margin notes in a second pen. */}
        <g style={note} className="text-[15px]">
          <g className="group-data-[down=true]:hidden">
            <text x="250" y="24" className="fill-accent-2">
              hot keys stay warm
            </text>
            <Strokes d={sketch.path("M378 30 C394 34 402 40 412 46", 31, { roughness: 0.6 })} strokeWidth="1.3" className="text-accent-2" />
            <Strokes d={arrowHead(402, 40, 412, 46, 32, 7)} strokeWidth="1.3" className="text-accent-2" />
          </g>
          <g className="hidden group-data-[down=true]:inline">
            <text x="244" y="24" className="fill-accent">
              cache offline
            </text>
          </g>
          <text x="236" y="358" className="fill-accent">
            misses fall through
          </text>
          <Strokes d={sketch.path("M372 350 C392 348 404 340 414 330", 33, { roughness: 0.6 })} strokeWidth="1.3" className="text-accent" />
          <Strokes d={arrowHead(405, 340, 414, 330, 34, 7)} strokeWidth="1.3" className="text-accent" />
        </g>

        {/* Requests in flight (hidden when motion is reduced or off). */}
        <g className="fill-ink-2">
          {[0, -0.4, -0.8].map((d) => (
            <Packet key={d} edge="in" dur={1.2} delay={d} />
          ))}
          {[0, -0.65].map((d) => (
            <Packet key={`a${d}`} edge="la" dur={1.3} delay={d} />
          ))}
          {[-0.3, -0.95].map((d) => (
            <Packet key={`b${d}`} edge="lb" dur={1.3} delay={d} />
          ))}
        </g>
        <g className="fill-accent-2 group-data-[down=true]:hidden">
          {[0, -0.5].map((d) => (
            <Packet key={`ac${d}`} edge="ac" dur={1} delay={d} />
          ))}
          {[-0.25, -0.75].map((d) => (
            <Packet key={`bc${d}`} edge="bc" dur={1} delay={d} />
          ))}
        </g>
        <g className="fill-accent">
          <Packet edge="ad" dur={1.8} delay={-0.6} />
          <Packet edge="bd" dur={1.8} delay={-1.3} />
          {[0, -0.3, -0.55, -0.8].map((d) => (
            <Packet key={`x${d}`} edge={d > -0.5 ? "ad" : "bd"} dur={1.1} delay={d} className="hidden group-data-[down=true]:inline" />
          ))}
        </g>
      </svg>
    </HeroLive>
  );
}
