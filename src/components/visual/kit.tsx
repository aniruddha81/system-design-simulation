import type { ReactNode } from "react";

// Visual kit for lessons, case studies and pages: show the idea, keep the prose short.
// Server components, no client JS: animation is SVG/CSS only and stops under prefers-reduced-motion.
// Colours come from the theme tokens; meaning is never colour alone (label + shape + icon glyph).

export const KINDS = ["client", "loadBalancer", "service", "cache", "database", "rateLimiter", "dns", "cdn", "apiGateway", "kvStore", "queue", "worker", "objectStore", "searchIndex", "dedupStore", "autoscaler", "circuitBreaker"] as const;
export type Kind = (typeof KINDS)[number];
export const TONES = ["ok", "warn", "bad", "info", "muted"] as const;
export type Tone = (typeof TONES)[number];

const GLYPH: Record<Kind, string> = { client: "◉", loadBalancer: "⇄", service: "⬢", cache: "⚡", database: "⛁", rateLimiter: "⧗", dns: "◎", cdn: "◈", apiGateway: "⛩", kvStore: "▤", queue: "≡", worker: "⚙", objectStore: "▣", searchIndex: "⌕", dedupStore: "⧉", autoscaler: "⇕", circuitBreaker: "⏻" };
const TONE_VAR: Record<Tone, string> = { ok: "var(--success)", warn: "var(--warning)", bad: "var(--danger)", info: "var(--accent-2)", muted: "var(--text-muted)" };
const TONE_GLYPH: Record<Tone, string> = { ok: "✓", warn: "!", bad: "✕", info: "i", muted: "·" };

function Figure({ title, children, caption }: { title: string; children: ReactNode; caption?: string }) {
  return (
    <figure role="group" aria-label={title} className="my-6 border-y-2 border-rule bg-surface p-4 sm:p-5">
      {children}
      {caption ? <figcaption className="mt-3 text-sm text-muted">{caption}</figcaption> : null}
    </figure>
  );
}

export type FlowNode = { id: string; label: string; kind: Kind; /** 0-100, left to right */ x: number; /** 0-100, top to bottom */ y: number; note?: string };
export type FlowEdge = { from: string; to: string; label?: string; dashed?: boolean };

const W = 640;
const NW = 112;
const NH = 44;

/** Architecture diagram: typed nodes, labelled arrows, packets flowing along edges, failed nodes marked. */
export function Flow({ title, nodes, edges, failed = [], hot = [], height = 240, caption }: { title: string; nodes: FlowNode[]; edges: FlowEdge[]; failed?: string[]; hot?: string[]; height?: number; caption?: string }) {
  const pos = new Map(nodes.map((n) => [n.id, { x: 40 + (n.x / 100) * (W - 80), y: 28 + (n.y / 100) * (height - 56) }]));
  const uid = title.replace(/\W+/g, "");
  return (
    <Figure title={title} caption={caption}>
      <svg viewBox={`0 0 ${W} ${height}`} className="h-auto w-full" role="img" aria-label={`${title}: ${nodes.map((n) => n.label).join(", ")}`}>
        <defs>
          <marker id={`ar-${uid}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 1 L9 5 L0 9 z" fill="var(--ink-2)" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const t = Math.min(NW / 2 / Math.max(Math.abs(dx), 1e-6), NH / 2 / Math.max(Math.abs(dy), 1e-6));
          const x1 = a.x + dx * t;
          const y1 = a.y + dy * t;
          const x2 = b.x - dx * t;
          const y2 = b.y - dy * t;
          const dead = failed.includes(e.to) || failed.includes(e.from);
          const path = `M${x1} ${y1} L${x2} ${y2}`;
          return (
            <g key={i}>
              <path d={path} stroke={dead ? "var(--danger)" : "var(--ink-2)"} strokeWidth="1.6" strokeDasharray={e.dashed || dead ? "5 4" : undefined} fill="none" markerEnd={`url(#ar-${uid})`} />
              {!dead && (
                <circle r="3.2" fill="var(--accent)" className="flow-packet">
                  <animateMotion dur={`${1.6 + (i % 3) * 0.4}s`} repeatCount="indefinite" path={path} begin={`${(i % 4) * 0.3}s`} />
                </circle>
              )}
              {e.label ? (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" fontSize="11" fill="var(--text-muted)" stroke="var(--surface)" strokeWidth="3" paintOrder="stroke">
                  {e.label}
                </text>
              ) : null}
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          const bad = failed.includes(n.id);
          const warm = hot.includes(n.id);
          const color = bad ? "var(--danger)" : warm ? "var(--warning)" : `var(--kind-${n.kind})`;
          return (
            <g key={n.id} transform={`translate(${p.x - NW / 2} ${p.y - NH / 2})`}>
              <rect width={NW} height={NH} rx="7" fill="var(--bg)" stroke={color} strokeWidth={bad || warm ? 2.6 : 1.8} strokeDasharray={bad ? "5 3" : undefined} />
              <rect width="30" height={NH} rx="7" fill={color} />
              <text x="15" y={NH / 2 + 5} textAnchor="middle" fontSize="15" fill="var(--bg)" aria-hidden>
                {bad ? "✕" : GLYPH[n.kind]}
              </text>
              <text x="36" y={n.note ? 19 : NH / 2 + 4} fontSize="12" fontWeight="600" fill="var(--text)">
                {n.label}
              </text>
              {n.note ? (
                <text x="36" y="34" fontSize="10.5" fill="var(--text-muted)">
                  {n.note}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </Figure>
  );
}

export type BarItem = { label: string; value: number; /** shown after the number, e.g. "ms" */ unit?: string; tone?: Tone };

/** Horizontal bars for comparing magnitudes. `log` spreads values that span orders of magnitude (latency numbers). */
export function Bars({ title, items, log = false, caption }: { title: string; items: BarItem[]; log?: boolean; caption?: string }) {
  const scale = (v: number) => (log ? Math.log10(Math.max(v, 1e-9)) : v);
  const lo = log ? Math.min(...items.map((i) => scale(i.value))) - 0.3 : 0;
  const hi = Math.max(...items.map((i) => scale(i.value)));
  const pct = (v: number) => Math.max(3, ((scale(v) - lo) / Math.max(hi - lo, 1e-9)) * 100);
  return (
    <Figure title={title} caption={caption}>
      <ul className="grid gap-2">
        {items.map((i) => (
          <li key={i.label} className="grid grid-cols-[minmax(6rem,28%)_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate">{i.label}</span>
            <span aria-hidden className="h-3.5 rounded-sm bg-surface-2">
              <span className="block h-full rounded-sm" style={{ width: `${pct(i.value)}%`, background: TONE_VAR[i.tone ?? "info"] }} />
            </span>
            <span className="num whitespace-nowrap text-muted">
              {i.value.toLocaleString("en-US")}
              {i.unit ? ` ${i.unit}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {log ? <p className="mt-2 text-xs text-muted">Log scale: each gridline step is 10×.</p> : null}
    </Figure>
  );
}

export type StatItem = { label: string; value: string; sub?: string; tone?: Tone };

/** Big-number tiles. Tone adds an icon glyph as well as colour. */
export function Stats({ title, items, caption }: { title: string; items: StatItem[]; caption?: string }) {
  return (
    <Figure title={title} caption={caption}>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
        {items.map((i) => (
          <li key={i.label} className="rounded-md bg-surface-2 p-3" style={{ borderLeft: `4px solid ${TONE_VAR[i.tone ?? "info"]}` }}>
            <p className="text-xs uppercase tracking-wide text-muted">{i.label}</p>
            <p className="num text-2xl font-semibold tracking-tight">
              <span aria-hidden className="mr-1 text-base" style={{ color: TONE_VAR[i.tone ?? "info"] }}>
                {TONE_GLYPH[i.tone ?? "info"]}
              </span>
              {i.value}
            </p>
            {i.sub ? <p className="text-xs text-muted">{i.sub}</p> : null}
          </li>
        ))}
      </ul>
    </Figure>
  );
}

export type SeqMessage = { from: string; to: string; label: string; lost?: boolean; tone?: Tone };

/** Sequence diagram: who sends what to whom, in order. A lost message ends in an ✕. */
export function Sequence({ title, actors, messages, caption }: { title: string; actors: string[]; messages: SeqMessage[]; caption?: string }) {
  const gap = (W - 80) / Math.max(actors.length - 1, 1);
  const ax = (a: string) => 40 + actors.indexOf(a) * gap;
  const top = 36;
  const row = 34;
  const h = top + messages.length * row + 16;
  return (
    <Figure title={title} caption={caption}>
      <svg viewBox={`0 0 ${W} ${h}`} className="h-auto w-full" role="img" aria-label={`${title}: ${messages.map((m) => `${m.from} to ${m.to}: ${m.label}`).join("; ")}`}>
        <defs>
          <marker id={`sq-${title.replace(/\W+/g, "")}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 1 L9 5 L0 9 z" fill="var(--ink-2)" />
          </marker>
        </defs>
        {actors.map((a) => (
          <g key={a}>
            <text x={ax(a)} y="16" textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--text)">
              {a}
            </text>
            <line x1={ax(a)} x2={ax(a)} y1="24" y2={h - 6} stroke="var(--rule)" strokeDasharray="3 4" />
          </g>
        ))}
        {messages.map((m, i) => {
          const y = top + i * row + 10;
          const x1 = ax(m.from);
          const x2 = m.lost ? x1 + (ax(m.to) - x1) * 0.62 : ax(m.to);
          const c = TONE_VAR[m.tone ?? (m.lost ? "bad" : "muted")];
          return (
            <g key={i}>
              <line x1={x1} x2={x2} y1={y} y2={y} stroke={m.lost ? c : "var(--ink-2)"} strokeWidth="1.6" strokeDasharray={m.lost ? "5 3" : undefined} markerEnd={m.lost ? undefined : `url(#sq-${title.replace(/\W+/g, "")})`} />
              {m.lost ? (
                <text x={x2 + 4} y={y + 4} fontSize="14" fill={c}>
                  ✕
                </text>
              ) : null}
              <text x={(x1 + x2) / 2} y={y - 5} textAnchor="middle" fontSize="11" fill={m.tone ? c : "var(--text)"} stroke="var(--surface)" strokeWidth="3" paintOrder="stroke">
                {m.label}
              </text>
            </g>
          );
        })}
      </svg>
    </Figure>
  );
}

export type TimelineEvent = { at: string; label: string; tone?: Tone };

/** Left-to-right timeline of what happens when. */
export function Timeline({ title, events, caption }: { title: string; events: TimelineEvent[]; caption?: string }) {
  return (
    <Figure title={title} caption={caption}>
      <ol className="grid auto-cols-fr grid-flow-col gap-0 overflow-x-auto">
        {events.map((e, i) => (
          <li key={i} className="relative min-w-[6.5rem] px-1 pt-5 text-center">
            <span aria-hidden className="absolute left-0 right-0 top-2 h-0.5 bg-rule" />
            <span aria-hidden className="absolute left-1/2 top-0 grid h-4 w-4 -translate-x-1/2 place-items-center rounded-full text-[10px] font-bold text-bg" style={{ background: TONE_VAR[e.tone ?? "info"] }}>
              {TONE_GLYPH[e.tone ?? "info"]}
            </span>
            <p className="num text-xs text-muted">{e.at}</p>
            <p className="text-sm">{e.label}</p>
          </li>
        ))}
      </ol>
    </Figure>
  );
}

export type CompareSide = { title: string; points: string[]; tone?: Tone };

/** Two or three options side by side, a few words per point. */
export function Compare({ title, sides, caption }: { title: string; sides: CompareSide[]; caption?: string }) {
  return (
    <Figure title={title} caption={caption}>
      <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        {sides.map((s) => (
          <section key={s.title} className="rounded-md bg-surface-2 p-3" style={{ borderTop: `4px solid ${TONE_VAR[s.tone ?? "info"]}` }}>
            <h4 className="mb-1 text-sm font-semibold">{s.title}</h4>
            <ul className="grid gap-1 text-sm text-muted">
              {s.points.map((p) => (
                <li key={p}>
                  <span aria-hidden className="mr-1.5">
                    ▸
                  </span>
                  {p}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Figure>
  );
}
