"use client";
// React Flow node + edge renderers. Bodies are drawn with rough.js, seeded per element id so the
// sketch never jitters between renders.
import { BaseEdge, getBezierPath, Handle, Position, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import rough from "roughjs";
import type { NodeSpec } from "@/engine/types";
import { KIND_COLOR, KIND_LABEL, KindIcon } from "./kinds";
import styles from "./sandbox.module.css";

export const NODE_W = 176;
export const NODE_H = 76;

export type Look = "sketch" | "clean";
export type NodeHealth = "up" | "degraded" | "gray" | "down" | "restarting";
export type ComponentNodeData = { spec: NodeSpec; look: Look; util?: number; health?: NodeHealth; flagged?: boolean };
export type ComponentFlowNode = Node<ComponentNodeData, "component">;
export type SketchFlowEdge = Edge<{ look: Look }, "sketch">;

const gen = rough.generator();

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 2147483646 + 1;
}

const nodeShapes = new Map<string, { outline: string[]; fill: string[] }>();
function nodeShape(id: string) {
  let s = nodeShapes.get(id);
  if (!s) {
    const seed = seedOf(id);
    const toD = (d: ReturnType<typeof gen.rectangle>) => gen.toPaths(d).map((p) => p.d);
    s = {
      outline: toD(gen.rectangle(3, 3, NODE_W - 6, NODE_H - 6, { seed, roughness: 1.1, bowing: 1.2, strokeWidth: 1.6 })),
      fill: toD(gen.rectangle(3, 3, NODE_W - 6, NODE_H - 6, { seed, stroke: "none", fill: "x", fillStyle: "hachure", hachureGap: 7, hachureAngle: -41, fillWeight: 1 })),
    };
    nodeShapes.set(id, s);
  }
  return s;
}

const HEALTH_TEXT: Record<NodeHealth, string> = { up: "", degraded: "Slow", gray: "Flaky", down: "Down", restarting: "Restarting" };

export function ComponentNode({ data, selected }: NodeProps<ComponentFlowNode>) {
  const { spec, look, util, health = "up", flagged } = data;
  const color = KIND_COLOR[spec.kind];
  const down = health === "down";
  const stroke = down ? "var(--danger)" : selected ? "var(--accent)" : color;
  const shape = look === "sketch" ? nodeShape(spec.id) : null;
  const heat = util == null ? null : Math.min(1, util);
  const heatColor = heat == null ? "" : heat >= 0.9 ? "var(--danger)" : heat >= 0.7 ? "var(--warning)" : "var(--success)";
  return (
    // key on health so the shake replays each time the node goes down
    <div key={health} className={`relative ${down ? styles.shake : ""}`} style={{ width: NODE_W, height: NODE_H }}>
      <svg className="pointer-events-none absolute inset-0 overflow-visible" width={NODE_W} height={NODE_H} aria-hidden="true">
        {shape ? (
          <>
            <g style={{ stroke: color }} opacity={0.22}>{shape.fill.map((d, i) => <path key={i} d={d} fill="none" />)}</g>
            {selected && <rect x={-3} y={-3} width={NODE_W + 6} height={NODE_H + 6} rx={12} fill="none" style={{ stroke: "var(--accent)" }} strokeOpacity={0.35} strokeWidth={6} />}
            <g style={{ stroke: stroke }} strokeWidth={down || selected ? 2.4 : 1.6} fill="none">{shape.outline.map((d, i) => <path key={i} d={d} />)}</g>
          </>
        ) : (
          <rect x={1} y={1} width={NODE_W - 2} height={NODE_H - 2} rx={10} style={{ fill: "var(--surface)", stroke }} strokeWidth={down || selected ? 2 : 1.25} />
        )}
        {down && <rect x={0} y={0} width={NODE_W} height={NODE_H} rx={10} style={{ fill: "var(--danger)" }} opacity={0.14} className={styles.pulse} />}
      </svg>
      <Handle type="target" position={Position.Left} aria-label={`Connect into ${spec.label}`} />
      <div className="relative flex h-full flex-col justify-center gap-1 px-3.5">
        <div className="flex items-center gap-2">
          <span style={{ color }} className="shrink-0"><KindIcon kind={spec.kind} /></span>
          <span className="truncate text-[13px] font-medium text-(--text)">{spec.label}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-(--text-muted)">
          <span>{KIND_LABEL[spec.kind]}</span>
          {heat != null && <span className="ml-auto tabular-nums">{Math.round(heat * 100)}% busy</span>}
          {flagged && <span className="ml-auto text-(--warning)" title="A route here needs attention">⚠ route</span>}
        </div>
        {heat != null && (
          <div className="h-1 overflow-hidden rounded-full bg-(--surface-2)" aria-hidden="true">
            <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${heat * 100}%`, background: heatColor }} />
          </div>
        )}
      </div>
      {health !== "up" && (
        <span
          className="absolute -top-2.5 right-2 rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide"
          style={{ background: "var(--bg)", color: down ? "var(--danger)" : "var(--warning)", borderColor: "currentColor" }}
        >
          {down ? "✕ " : "△ "}{HEALTH_TEXT[health]}
        </span>
      )}
      <Handle type="source" position={Position.Right} aria-label={`Connect from ${spec.label}`} />
    </div>
  );
}

export function SketchEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps<SketchFlowEdge>) {
  const [bezier] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const color = selected ? "var(--accent)" : "var(--text-muted)";
  const angle = Math.atan2(targetY - sourceY, targetX - sourceX);
  const head = (a: number) => `${targetX - 10 * Math.cos(a)},${targetY - 10 * Math.sin(a)}`;
  if (data?.look !== "sketch") {
    return (
      <>
        <BaseEdge id={id} path={bezier} style={{ stroke: color, strokeWidth: selected ? 2 : 1.5 }} interactionWidth={20} />
        {/* bezier ends horizontally into a left handle */}
        <path d={`M${head(-0.45)} L${targetX},${targetY} L${head(0.45)}`} fill="none" style={{ stroke: color }} strokeWidth={1.5} />
      </>
    );
  }
  const seed = seedOf(id);
  const line = gen.toPaths(gen.line(sourceX, sourceY, targetX - 2, targetY, { seed, roughness: 1, bowing: 1.5 }));
  const arrow = gen.toPaths(gen.linearPath(
    [[targetX - 10 * Math.cos(angle - 0.45), targetY - 10 * Math.sin(angle - 0.45)], [targetX - 2, targetY], [targetX - 10 * Math.cos(angle + 0.45), targetY - 10 * Math.sin(angle + 0.45)]],
    { seed, roughness: 0.8 },
  ));
  return (
    <>
      <BaseEdge id={id} path={`M${sourceX},${sourceY} L${targetX},${targetY}`} style={{ stroke: "transparent" }} interactionWidth={20} />
      <g style={{ stroke: color }} strokeWidth={selected ? 2.2 : 1.5} fill="none" pointerEvents="none">
        {[...line, ...arrow].map((p, i) => <path key={i} d={p.d} />)}
      </g>
    </>
  );
}

export const nodeTypes = { component: ComponentNode };
export const edgeTypes = { sketch: SketchEdge };
