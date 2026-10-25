import { arrowHead, sketch, Strokes } from "@/components/ui/sketch";
import { traceRequest } from "@/engine";
import { cacheAsideDesign } from "@/engine/fixtures";
import { formatDuration } from "@/lib/format";
import { JourneyScroller } from "./journey-scroller";

// §1 Life of a request. The drawing is computed here; the client only scrubs it.
// Server-side timings are the engine's own trace of one cold read and one warm read of user:42.

type Stop = "browser" | "dns" | "cdn" | "lb" | "svc" | "cache" | "db";
type Pt = [number, number];
type Layout = { id: "wide" | "tall"; vb: Pt; box: Pt; font: [number, number]; at: Record<Stop, Pt> };

const WIDE: Layout = {
  id: "wide",
  vb: [750, 540],
  box: [140, 70],
  font: [17, 12.5],
  at: { dns: [90, 90], browser: [90, 270], cdn: [280, 270], lb: [470, 270], svc: [660, 270], cache: [660, 90], db: [660, 450] },
};
const TALL: Layout = {
  id: "tall",
  vb: [360, 312],
  box: [100, 54],
  font: [14.5, 11],
  at: { browser: [60, 40], dns: [180, 40], cache: [300, 40], cdn: [60, 150], lb: [180, 150], svc: [300, 150], db: [300, 260] },
};

const LABEL: Record<Stop, [string, string]> = {
  browser: ["Browser", "GET /users/42"],
  dns: ["DNS", "resolver"],
  cdn: ["CDN edge", "pass-through"],
  lb: ["LB", "round robin"],
  svc: ["svc-1", "cache-aside"],
  cache: ["Cache", "user:42"],
  db: ["Database", "5 workers"],
};
const KIND: Record<Stop, string> = {
  browser: "text-(--kind-client)",
  dns: "text-(--kind-dns)",
  cdn: "text-(--kind-cdn)",
  lb: "text-(--kind-loadBalancer)",
  svc: "text-(--kind-service)",
  cache: "text-(--kind-cache)",
  db: "text-(--kind-database)",
};

/** Edges, with the beat at which the request first crosses each one. */
const EDGES: [Stop, Stop, number][] = [
  ["browser", "dns", 1],
  ["browser", "cdn", 2],
  ["cdn", "lb", 3],
  ["lb", "svc", 4],
  ["svc", "cache", 4],
  ["svc", "db", 5],
];

/** The stops the packet visits in each beat. Beat 7 is a second, warm read. */
const ROUTE: Stop[][] = [
  [],
  ["browser", "dns", "browser"],
  ["browser", "cdn"],
  ["cdn", "lb"],
  ["lb", "svc", "cache"],
  ["cache", "svc", "db"],
  ["db", "svc", "cache", "svc", "lb", "cdn", "browser"],
  ["browser", "cdn", "lb", "svc", "cache", "svc", "lb", "cdn", "browser"],
];
const FOCUS: Stop[] = ["browser", "dns", "cdn", "lb", "cache", "db", "browser", "cache"];

/** Where a line from a box's centre towards another point leaves the box. */
function exit([x1, y1]: Pt, [x2, y2]: Pt, [w, h]: Pt, pad = 4): Pt {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.min(dx ? (w / 2 + pad) / Math.abs(dx) : Infinity, dy ? (h / 2 + pad) / Math.abs(dy) : Infinity);
  return [x1 + dx * t, y1 + dy * t];
}

function trace() {
  const miss = traceRequest(cacheAsideDesign, "get", "user:42", 7);
  const hit = traceRequest(cacheAsideDesign, "get", "user:42", 7, [{ endpointId: "get", key: "user:42" }]);
  const service = (id: string) => miss.spans.filter((s) => s.nodeId === id && s.kind === "service");
  const [lb] = service("lb"), [get, set] = service("cache"), [db] = service("db");
  return { lbEnd: lb.endUs, getEnd: get.endUs, dbUs: db.endUs - db.startUs, dbEnd: db.endUs, setEnd: set.endUs, total: miss.totalUs, hit: hit.totalUs, ops: [...miss.dataOps, ...hit.dataOps] };
}

export function Journey() {
  const t = trace();
  const d = formatDuration;
  const times = ["browser", "browser", "browser", d(t.lbEnd), d(t.getEnd), d(t.dbEnd), d(t.total), d(t.hit)];
  const notes: { beat: number; text: string; tone: "a" | "b"; wide: [number, number, "start" | "end"] }[] = [
    { beat: 1, text: "where is the API?", tone: "b", wide: [176, 84, "start"] },
    { beat: 2, text: "personal, so pass it on", tone: "b", wide: [212, 346, "start"] },
    { beat: 3, text: "round robin → svc-1", tone: "b", wide: [402, 346, "start"] },
    { beat: 4, text: `MISS user:42 · ${d(t.getEnd)}`, tone: "a", wide: [574, 72, "end"] },
    { beat: 5, text: `${d(t.dbUs)} in the database`, tone: "a", wide: [574, 456, "end"] },
    { beat: 6, text: "SET user:42", tone: "b", wide: [574, 102, "end"] },
    { beat: 7, text: `HIT · ${d(t.hit)} end to end`, tone: "b", wide: [574, 132, "end"] },
  ];
  const faster = Math.round(t.total / t.hit);

  const steps = [
    {
      kicker: "Browser",
      title: "Someone opens their profile",
      body: "One read, GET /users/42. Scroll to send it.",
    },
    {
      kicker: "DNS",
      title: "First, an address",
      body: "The browser asks a resolver where the API lives.",
    },
    {
      kicker: "CDN edge",
      title: "The edge cannot answer this one",
      body: "A profile is personal, so the edge passes it on.",
    },
    {
      kicker: "Load balancer",
      title: "Pick a service",
      body: `Round robin picks svc-1. ${d(t.lbEnd)} on the server so far.`,
    },
    {
      kicker: "Cache",
      title: "Ask the cache first. Miss.",
      body: "svc-1 asks the cache for user:42. Nobody has read it lately.",
    },
    {
      kicker: "Database",
      title: "The slow part",
      body: `The read takes ${d(t.dbUs)}. Five workers; extra reads queue.`,
    },
    {
      kicker: "Response",
      title: "Fill the cache, then answer",
      body: `svc-1 fills the cache and replies. ${d(t.total)} on the server.`,
    },
    {
      kicker: "The next read",
      title: `A hit, ${faster}× faster`,
      body: `Served from cache in ${d(t.hit)}. The database never hears.`,
    },
  ];

  return (
    <JourneyScroller
      stage={
        <figure>
          <div className="panel paper-grid overflow-hidden p-3 sm:p-5">
            <Drawing layout={WIDE} notes={notes} times={times} className="hidden w-full md:block" />
            <Drawing layout={TALL} notes={notes} times={times} className="block w-full md:hidden" />
          </div>
          <figcaption className="figcap mt-3 hidden md:block">
            <b>Fig. 2</b>Cold read, then warm. {t.ops.join(", ")}.
          </figcaption>
        </figure>
      }
    >
      {steps.map((s, i) => (
        <li key={s.title} data-step={i} className="relative pb-[30vh] pl-5 last:pb-[18vh] md:pb-[42vh] md:pl-7 md:last:pb-[24vh]">
          <span aria-hidden data-step-rule className="absolute inset-y-0 left-0 w-0.5 origin-top bg-border" />
          <span aria-hidden data-step-ink className="absolute inset-y-0 left-0 w-0.5 origin-top bg-accent" />
          <p className="flex items-baseline gap-3 font-mono text-[0.8125rem] text-muted">
            <span className="text-accent">{s.kicker}</span>
            <span className="num">{i < 3 ? "before the data centre" : times[i]}</span>
          </p>
          <h3 className="mt-2 font-display text-[1.75rem] leading-tight tracking-tight md:text-[2.125rem]">{s.title}</h3>
          <p className="mt-3 max-w-[44ch] text-[1.0625rem] leading-relaxed text-ink-2">{s.body}</p>
        </li>
      ))}
    </JourneyScroller>
  );
}

function Drawing({
  layout: L,
  notes,
  times,
  className,
}: {
  layout: Layout;
  notes: { beat: number; text: string; tone: "a" | "b"; wide: [number, number, "start" | "end"] }[];
  times: string[];
  className: string;
}) {
  const [bw, bh] = L.box;
  const seed = L.id === "wide" ? 300 : 400;
  const stops = Object.keys(L.at) as Stop[];
  const wide = L.id === "wide";
  const center = (s: Stop): Pt => L.at[s];
  const tall = !wide;

  return (
    <svg
      viewBox={`0 0 ${L.vb[0]} ${L.vb[1]}`}
      data-layout={L.id}
      role="img"
      aria-label="A request's path: browser, DNS, CDN edge, load balancer, service, cache miss, database, and back."
      className={className}
      style={{ fontFamily: "var(--font-sans)" }}
    >
      {/* Edges: a pencil guide, then the ink that appears once the request has crossed it. */}
      {EDGES.map(([a, b, beat], i) => {
        const p = exit(center(a), center(b), L.box), q = exit(center(b), center(a), L.box);
        const line = sketch.line(p[0], p[1], q[0], q[1], seed + i, { roughness: 0.9 });
        const head = arrowHead(p[0], p[1], q[0], q[1], seed + 20 + i, wide ? 9 : 7);
        return (
          <g key={`${a}-${b}`}>
            <Strokes d={line} strokeWidth="1.3" strokeDasharray="4 5" className="text-rule" />
            <g data-from={beat}>
              <Strokes d={[...line, ...head]} strokeWidth={wide ? 1.8 : 1.5} className={b === "db" ? "text-accent" : b === "cache" ? "text-accent-2" : "text-ink-2"} />
            </g>
          </g>
        );
      })}

      {/* The requests, drawn beneath the boxes so they vanish into each component. */}
      <circle data-packet="cold" cx={center("browser")[0]} cy={center("browser")[1]} r={wide ? 7 : 5.5} className="fill-accent" />
      <circle data-packet="warm" cx={center("browser")[0]} cy={center("browser")[1]} r={wide ? 7 : 5.5} className="fill-accent-2" />

      {stops.map((s, i) => {
        const [cx, cy] = center(s), x = cx - bw / 2, y = cy - bh / 2;
        const shape =
          s === "db"
            ? [...sketch.path(`M${x} ${y + 8} A${bw / 2} 9 0 0 1 ${x + bw} ${y + 8} L${x + bw} ${y + bh - 6} A${bw / 2} 9 0 0 1 ${x} ${y + bh - 6} Z`, seed + 40 + i), ...sketch.path(`M${x} ${y + 8} A${bw / 2} 9 0 0 0 ${x + bw} ${y + 8}`, seed + 50)]
            : sketch.rect(x, y, bw, bh, seed + 40 + i);
        const [t, sub] = LABEL[s];
        const tx = x + (wide ? 14 : 9);
        return (
          <g key={s}>
            <rect x={x} y={y} width={bw} height={bh} rx="3" className="fill-surface" />
            {s === "db" && (
              <g data-only="5">
                <Strokes d={sketch.hatch(`M${x} ${y + 8} L${x + bw} ${y + 8} L${x + bw} ${y + bh - 6} L${x} ${y + bh - 6} Z`, seed + 60, { hachureGap: 5 })} strokeWidth="1" className="text-(--heat-3) opacity-60" />
              </g>
            )}
            <rect data-focus={FOCUS.map((f, b) => (f === s ? b : -1)).filter((b) => b >= 0).join(" ")} x={x + 4} y={y + (s === "db" ? 13 : 6)} width={bw - 8} height={bh - (s === "db" ? 22 : 12)} rx="2" className="fill-(--highlight-mark) opacity-0" />
            <Strokes d={shape} strokeWidth={wide ? 1.8 : 1.5} className={KIND[s]} />
            <text x={tx} y={cy + (wide ? -3 : -2)} className="fill-fg font-semibold" style={{ fontSize: L.font[0] }}>
              {t}
            </text>
            <text x={tx} y={cy + (wide ? 17 : 14)} className="fill-muted font-mono" style={{ fontSize: L.font[1] }}>
              {sub}
            </text>
          </g>
        );
      })}

      {/* Margin notes beside the stops (wide); a single log line under the drawing (tall). */}
      <g style={{ fontFamily: "var(--font-display)", fontStyle: "italic", fontVariationSettings: '"SOFT" 100, "WONK" 1' }}>
        {notes.map((n) => (
          <text
            key={n.beat}
            data-only={n.beat}
            x={wide ? n.wide[0] : 4}
            y={wide ? n.wide[1] : L.vb[1] - 8}
            textAnchor={wide ? n.wide[2] : "start"}
            className={n.tone === "a" ? "fill-accent" : "fill-accent-2"}
            style={{ fontSize: wide ? 17 : 15, opacity: tall && n.beat !== 7 ? 0 : undefined }}
          >
            {n.text}
          </text>
        ))}
      </g>

      {wide && (
        <g className="font-mono" style={{ fontSize: 12.5 }}>
          <text x="20" y="520" className="fill-muted">
            server time
          </text>
          {times.map((v, b) => (
            <text key={b} data-only={b} x="112" y="520" className="num fill-fg" style={{ opacity: b === 7 ? undefined : 0 }}>
              {b < 3 ? "—" : v}
            </text>
          ))}
        </g>
      )}

      {/* Packet routes, one per beat (invisible guides for the scrubbed motion). */}
      <g fill="none" stroke="none">
        {ROUTE.map((r, b) =>
          r.length ? <path key={b} data-seg={b} d={r.map((s, i) => `${i ? "L" : "M"}${center(s)[0]} ${center(s)[1]}`).join(" ")} /> : null,
        )}
      </g>
    </svg>
  );
}
