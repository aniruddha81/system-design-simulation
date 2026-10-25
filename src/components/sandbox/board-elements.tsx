"use client";
// React Flow node + edge renderers. Bodies are drawn with rough.js, seeded per element id so the
// sketch never jitters between renders. Each kind has its own silhouette (see KIND_SHAPE).
import {
  BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, NodeResizer, Position, type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import rough from "roughjs";
import type { GroupSpec, NodeSpec } from "@/engine/types";
import { useDesignApi } from "./design-store";
import { KIND_COLOR, KIND_LABEL, KIND_SHAPE, KindIcon, shapePath } from "./kinds";
import styles from "./sandbox.module.css";

export const NODE_W = 176;
export const NODE_H = 76;

export type Look = "sketch" | "clean";
export type NodeHealth = "up" | "degraded" | "gray" | "down" | "restarting";
export type ComponentNodeData = {
  spec: NodeSpec; look: Look; util?: number; health?: NodeHealth; flagged?: boolean;
  /** Scale-mode failure-ladder heat (0..1+), painted while the Scale tab plays a rung. */
  heat?: number;
  issues?: string[];
  onInspect?: () => void;
  /** Just added: plays the entrance once. */
  fresh?: boolean;
  /** A route here was rewritten by an insertion rule and awaits review. */
  rewritten?: boolean;
};
export type ComponentFlowNode = Node<ComponentNodeData, "component">;
export type GroupFlowNode = Node<{ group: GroupSpec; look: Look; members: number }, "group">;
export type BoardNode = ComponentFlowNode | GroupFlowNode;
/** insert: a component is being dragged over this edge; ok = an insertion rule applies. */
export type SketchEdgeData = { look: Look; fresh?: boolean; live?: boolean; insert?: { ok: boolean; text: string } };
export type SketchFlowEdge = Edge<SketchEdgeData, "sketch">;

const gen = rough.generator();

export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 2147483646 + 1;
}

const nodeShapes = new Map<string, { outline: string[]; fill: string[] }>();
export function nodeShape(id: string, d: string) {
  const cacheKey = `${id}|${d}`;
  let s = nodeShapes.get(cacheKey);
  if (!s) {
    const seed = seedOf(id);
    const toD = (x: ReturnType<typeof gen.path>) => gen.toPaths(x).map((p) => p.d);
    s = {
      outline: toD(gen.path(d, { seed, roughness: 1, bowing: 1, strokeWidth: 1.6 })),
      fill: toD(gen.path(d, { seed, stroke: "none", fill: "x", fillStyle: "hachure", hachureGap: 8, hachureAngle: -41, fillWeight: 0.9 })),
    };
    nodeShapes.set(cacheKey, s);
  }
  return s;
}

const HEAT_FALLBACK = ["var(--success)", "var(--success)", "var(--warning)", "var(--warning)", "var(--danger)"];
/** Utilisation / Scale heat on the theme's 5-step ramp (--heat-0 … --heat-4). */
export const heatColor = (h: number) => {
  const i = h >= 0.9 ? 4 : h >= 0.7 ? 3 : h >= 0.5 ? 2 : h >= 0.25 ? 1 : 0;
  return `var(--heat-${i}, ${HEAT_FALLBACK[i]})`;
};
const HEALTH_TEXT: Record<NodeHealth, string> = { up: "", degraded: "Slow", gray: "Flaky", down: "Down", restarting: "Restarting" };

export function ComponentNode({ data, selected }: NodeProps<ComponentFlowNode>) {
  const { spec, look, util, health = "up", flagged } = data;
  const api = useDesignApi();
  const apiSelect = () => { api.getState().select({ kind: "node", id: spec.id }); data.onInspect?.(); };
  const color = KIND_COLOR[spec.kind];
  const down = health === "down";
  const stroke = down ? "var(--danger)" : selected ? "var(--accent)" : color;
  const outlinePath = shapePath(KIND_SHAPE[spec.kind], NODE_W, NODE_H, 3);
  const sketch = look === "sketch" ? nodeShape(spec.id, outlinePath) : null;
  const scaled = data.heat != null;
  const heat = scaled ? data.heat! : util ?? null;
  const bar = heat == null ? null : Math.min(1, heat);
  const heatText = heat == null ? "" : `${Math.round(heat * 100)}% ${scaled ? "Scale heat" : "utilisation"}. ${heat > 1 ? "Overloaded" : heat >= 0.9 ? "Near saturation" : "Within capacity"}.`;
  const tint = `color-mix(in oklab, ${color} ${selected ? 16 : 10}%, var(--surface))`;
  return (
    // Handles stay mounted (React Flow measures them once); only the inner layer is keyed on health,
    // so the shake replays each time the node goes down.
    <div
      className={`${styles.node} ${data.fresh ? styles.pop : ""} relative`}
      data-selected={selected || undefined}
      style={{ width: NODE_W, height: NODE_H, ["--kind" as string]: color }}
    >
      <Handle type="target" position={Position.Left} />
      <div key={health} className={`absolute inset-0 ${down ? styles.shake : ""}`}>
      <svg className="pointer-events-none absolute inset-0 overflow-visible" width={NODE_W} height={NODE_H} aria-hidden="true">
        <path d={outlinePath} className={styles.nodeBody} style={{ fill: tint }} />
        {scaled && <path d={outlinePath} style={{ fill: heatColor(heat!) }} opacity={Math.min(0.5, 0.14 + 0.32 * Math.min(1, heat!))} />}
        {sketch ? (
          <>
            <g style={{ stroke: color }} opacity={0.16}>{sketch.fill.map((d, i) => <path key={i} d={d} fill="none" />)}</g>
            <g style={{ stroke }} strokeWidth={down || selected ? 2.3 : 1.5} fill="none">{sketch.outline.map((d, i) => <path key={i} d={d} />)}</g>
          </>
        ) : (
          <path d={outlinePath} fill="none" style={{ stroke }} strokeWidth={down || selected ? 2 : 1.25} />
        )}
        {down && <path d={outlinePath} style={{ fill: "var(--danger)" }} opacity={0.14} className={styles.pulse} />}
      </svg>
      <div className="relative flex h-full flex-col justify-center gap-1.5 pl-4 pr-5">
        <div className="flex items-center gap-2.5">
          <span
            className="grid size-8 shrink-0 place-items-center rounded-[9px]"
            style={{ color, background: `color-mix(in oklab, ${color} 18%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 35%, transparent)` }}
          >
            <KindIcon kind={spec.kind} size={17} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold leading-tight text-(--text)">{spec.label}</span>
            <span className="block truncate text-[11px] leading-tight text-(--text-muted)">
              {KIND_LABEL[spec.kind]}
              {flagged && <span className="text-(--warning)" title="A route here needs attention"> · ⚠ route</span>}
              {data.rewritten && !flagged && <span className="text-(--accent)" title="Routes rewritten — review in the inspector"> · ✎ rewritten</span>}
            </span>
          </span>
        </div>
        {bar != null && (
          <div className="flex items-center gap-2" role="img" aria-label={heatText} title={heatText}>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-(--surface-2)">
              <div className="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${bar * 100}%`, background: heatColor(heat!) }} />
            </div>
            <span className="text-[10px] tabular-nums text-(--text-muted)">{Math.round(heat! * 100)}%{scaled ? " heat" : ""}</span>
          </div>
        )}
      </div>
      {health !== "up" && (
        <span
          className="absolute -top-2.5 right-3 rounded-full border px-1.5 py-px text-[10px] font-semibold"
          style={{ background: "var(--bg)", color: down ? "var(--danger)" : "var(--warning)", borderColor: "currentColor" }}
        >
          {down ? "✕ " : "△ "}{HEALTH_TEXT[health]}
        </span>
      )}
      </div>
      {!!data.issues?.length && <button type="button"
        className="nodrag nopan absolute -top-3 -left-2 grid min-h-6 min-w-6 place-items-center rounded-full border border-(--danger) bg-(--surface) px-1 text-xs font-bold text-(--danger) focus-visible:outline-2 focus-visible:outline-(--accent)"
        aria-label={`${spec.label}: ${data.issues.join("; ")}. Inspect component`}
        title={data.issues.join("\n")}
        onClick={(e) => { e.stopPropagation(); apiSelect(); }}
      >! {data.issues.length}</button>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function SketchEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps<SketchFlowEdge>) {
  const [bezier, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const insert = data?.insert;
  const color = insert ? (insert.ok ? "var(--success)" : "var(--danger)") : selected ? "var(--accent)" : "color-mix(in oklab, var(--text-muted) 80%, transparent)";
  const width = selected || insert ? 2.2 : 1.5;
  const draw = data?.fresh ? styles.drawIn : "";
  const angle = Math.atan2(targetY - sourceY, targetX - sourceX);
  const sketch = data?.look === "sketch";
  const headAngle = sketch ? angle : 0; // the bezier ends horizontally into a left handle
  const head = `M${targetX - 10 * Math.cos(headAngle - 0.45)},${targetY - 10 * Math.sin(headAngle - 0.45)} L${targetX - 1.5},${targetY} L${targetX - 10 * Math.cos(headAngle + 0.45)},${targetY - 10 * Math.sin(headAngle + 0.45)}`;
  const seed = seedOf(id);
  const paths = sketch ? gen.toPaths(gen.line(sourceX, sourceY, targetX - 2, targetY, { seed, roughness: 1, bowing: 1.5 })).map((p) => p.d) : [bezier];
  return (
    <>
      <BaseEdge id={id} path={sketch ? `M${sourceX},${sourceY} L${targetX},${targetY}` : bezier} style={{ stroke: "transparent" }} interactionWidth={22} />
      {insert && <path d={sketch ? `M${sourceX},${sourceY} L${targetX},${targetY}` : bezier} fill="none" style={{ stroke: color }} strokeWidth={10} strokeLinecap="round" opacity={0.22} pointerEvents="none" />}
      <g style={{ stroke: color }} strokeWidth={width} fill="none" strokeLinecap="round" strokeLinejoin="round" pointerEvents="none">
        {paths.map((d, i) => <path key={i} d={d} pathLength={1} className={draw} />)}
        <path d={head} className={draw} pathLength={1} />
      </g>
      {data?.fresh && <circle cx={targetX - 2} cy={targetY} r={7} fill="none" strokeWidth={2} style={{ stroke: "var(--accent-2)" }} className={`${styles.ripple} motion-only`} pointerEvents="none" />}
      {data?.live && !insert && (
        <path d={sketch ? `M${sourceX},${sourceY} L${targetX},${targetY}` : bezier} fill="none" className={styles.flow} style={{ stroke: "var(--accent)" }} strokeWidth={1.5} pointerEvents="none" />
      )}
      {insert && (
        <EdgeLabelRenderer>
          <span
            className="pointer-events-none absolute z-30 max-w-56 -translate-x-1/2 -translate-y-[calc(100%+10px)] rounded-full border bg-(--surface) px-2.5 py-1 text-center text-[11px] font-medium shadow-lg"
            style={{ left: labelX, top: labelY, color, borderColor: color }}
          >
            {insert.ok ? "＋ " : "✕ "}{insert.text}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Region / zone frame: a React Flow parent node; members are the components placed in that region or zone. */
export function GroupNode({ data, selected, width, height }: NodeProps<GroupFlowNode>) {
  const { group, look, members } = data;
  const api = useDesignApi();
  const w = width ?? group.size.w, h = height ?? group.size.h;
  const zone = group.kind === "zone";
  const color = zone ? "var(--accent-2)" : "var(--text-muted)";
  const outline = look === "sketch"
    ? gen.toPaths(gen.rectangle(2, 2, w - 4, h - 4, { seed: seedOf(group.id), roughness: 0.8, strokeLineDash: zone ? [6, 6] : [12, 6] })).map((p) => p.d)
    : null;
  return (
    <div className="relative h-full w-full" aria-label={`${zone ? "Zone" : "Region"} ${group.name}, ${members} components`}>
      <NodeResizer
        isVisible={selected}
        minWidth={NODE_W + 32}
        minHeight={NODE_H + 48}
        color="var(--accent)"
        onResize={(_, p) => api.getState().commit((d) => ({ ...d, groups: (d.groups ?? []).map((g) => (g.id === group.id ? { ...g, position: { x: p.x, y: p.y }, size: { w: p.width, h: p.height } } : g)) }), `resize:${group.id}`)}
        onResizeEnd={() => api.getState().endGesture()}
      />
      <svg className="pointer-events-none absolute inset-0 overflow-visible" width={w} height={h} aria-hidden="true">
        <rect x={0} y={0} width={w} height={h} rx={16} style={{ fill: color }} opacity={zone ? 0.05 : 0.035} />
        {outline ? (
          <g style={{ stroke: selected ? "var(--accent)" : color }} strokeWidth={1.3} fill="none" opacity={0.85}>{outline.map((d, i) => <path key={i} d={d} />)}</g>
        ) : (
          <rect x={1} y={1} width={w - 2} height={h - 2} rx={16} fill="none" style={{ stroke: selected ? "var(--accent)" : color }} strokeDasharray={zone ? "6 6" : "12 6"} strokeWidth={1.25} />
        )}
      </svg>
      <span className="absolute left-3.5 top-2.5 flex items-center gap-1.5 text-xs font-medium" style={{ color }}>
        <span aria-hidden="true">{zone ? "◇" : "▢"}</span>
        {zone ? "Zone" : "Region"} <span className="font-mono">{group.name || "unnamed"}</span>
        <span className="text-(--text-muted)">({members})</span>
      </span>
    </div>
  );
}

export const nodeTypes = { component: ComponentNode, group: GroupNode };
export const edgeTypes = { sketch: SketchEdge };
