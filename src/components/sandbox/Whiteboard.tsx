"use client";
import "@xyflow/react/dist/style.css";
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useConnection, useReactFlow, ViewportPortal, type NodeChange,
} from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import type { ComponentKind, Design, GroupSpec, NodeId } from "@/engine/types";
import { useRun } from "@/lib/run-manager";
import { AnnotationLayer, type Tool } from "./Annotations";
import {
  edgeTypes, NODE_H, NODE_W, nodeTypes, type BoardNode, type Look, type NodeHealth, type SketchFlowEdge,
} from "./board-elements";
import {
  addNode, alignNodes, brokenRefs, connect, copySelection, distributeNodes, distToSegment, elementName, groupOf, hasParam, insertOnEdge,
  KIND_LABEL, nextId, parseClip, pasteClip, placeNames, updateNode, type Align,
} from "./design-ops";
import { selectedNodeIds, useAnnotations, useDesign, useDesignApi } from "./design-store";
import { KIND_COLOR, KINDS, KindSwatch } from "./kinds";
import { DRAG_MIME, dragging, Library, setDragging } from "./Library";
import { PacketOverlay } from "./PacketOverlay";
import styles from "./sandbox.module.css";

const GRID = 16;
const snap = (v: number) => Math.round(v / GRID) * GRID;
const FRAME_PAD = { x: 28, top: 44, bottom: 28 };

const TOOLS: { tool: Tool; key: string; label: string; icon: string }[] = [
  { tool: "select", key: "v", label: "Select", icon: "M5 3l13 8-6 1.5L9 19z" },
  { tool: "hand", key: "h", label: "Hand (pan)", icon: "M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5V4a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.5 14a1.5 1.5 0 0 1 2.4-1.8L8 14" },
  { tool: "connect", key: "a", label: "Arrow (connect two components)", icon: "M4 20 20 4m0 0h-8m8 0v8" },
  { tool: "pen", key: "p", label: "Pen", icon: "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3" },
  { tool: "text", key: "t", label: "Text", icon: "M5 6V4h14v2M12 4v16m-3 0h6" },
  { tool: "note", key: "n", label: "Sticky note", icon: "M5 4h14v10l-6 6H5zM13 20v-6h6" },
];
const ALIGN: { how: Align; label: string; icon: string }[] = [
  { how: "left", label: "Align left", icon: "M4 3v18M8 7h10M8 15h6" },
  { how: "centerX", label: "Align centres horizontally", icon: "M12 3v18M6 7h12M8 15h8" },
  { how: "right", label: "Align right", icon: "M20 3v18M6 7h10M10 15h6" },
  { how: "top", label: "Align top", icon: "M3 4h18M7 8v10M15 8v6" },
  { how: "middle", label: "Align middles", icon: "M3 12h18M7 6v12M15 8v8" },
  { how: "bottom", label: "Align bottom", icon: "M3 20h18M7 6v10M15 10v6" },
];

export type DeleteRequest = { nodeIds?: NodeId[]; edgeIds?: string[] };

/** Bounding box of nodes (absolute), padded for a frame. */
function frameAround(nodes: { position: { x: number; y: number } }[]) {
  const xs = nodes.map((n) => n.position.x), ys = nodes.map((n) => n.position.y);
  const x = Math.min(...xs) - FRAME_PAD.x, y = Math.min(...ys) - FRAME_PAD.top;
  return { position: { x, y }, size: { w: Math.max(...xs) + NODE_W + FRAME_PAD.x - x, h: Math.max(...ys) + NODE_H + FRAME_PAD.bottom - y } };
}

/** Frames hug their members again after a layout change. */
function refitGroups(d: Design): Design {
  if (!d.groups?.length) return d;
  return { ...d, groups: d.groups.map((g) => {
    const members = d.nodes.filter((n) => groupOf(d.groups!, n)?.id === g.id);
    return members.length ? { ...g, ...frameAround(members) } : g;
  }) };
}

/** Layered left-to-right layout with elkjs, loaded only when asked for. */
async function autoLayout(d: Design): Promise<Design> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const g = await new ELK().layout({
    id: "root",
    layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "48", "elk.layered.spacing.nodeNodeBetweenLayers": "96" },
    children: d.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges: d.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  });
  const pos = new Map((g.children ?? []).map((c) => [c.id, { x: snap(c.x ?? 0), y: snap(c.y ?? 0) }]));
  return refitGroups({ ...d, nodes: d.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })) });
}

export function Whiteboard(props: {
  runKey: string;
  allowedKinds?: ComponentKind[];
  look: Look;
  setLook: (l: Look) => void;
  reducedMotion: boolean;
  notify: (msg: string) => void;
  openInspector: () => void;
  requestDelete: (r: DeleteRequest) => void;
  /** Scale-mode heat per node, painted during failure-ladder playback. */
  heat: Record<NodeId, number> | null;
}) {
  const { runKey, look, setLook, notify } = props;
  const design = useDesign((s) => s.design);
  const selection = useDesign((s) => s.selection);
  const multi = useDesign((s) => s.multi);
  const rewritten = useDesign((s) => s.rewritten);
  const api = useDesignApi();
  const run = useRun(runKey);
  const rf = useReactFlow();
  const [, annotations] = useAnnotations();
  const [tool, setTool] = useState<Tool>("select");
  const [connectFrom, setConnectFrom] = useState<NodeId | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Narrow boards start with the library folded so the drawing stays visible.
  const [showLibrary, setShowLibrary] = useState(() => (typeof matchMedia === "function" ? !matchMedia("(max-width: 1023px)").matches : true));
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [drop, setDrop] = useState<{ x: number; y: number; edgeId?: string; ok?: boolean; text?: string } | null>(null);
  const [laying, setLaying] = useState(false);
  const pickerRef = useRef<HTMLDialogElement>(null);
  const gesture = useRef(0);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const commit = api.getState().commit;
  const select = api.getState().select;
  const sel = new Set(selectedNodeIds({ multi, selection }));
  const groups = design.groups ?? [];

  function markFresh(ids: string[]) {
    setFresh(new Set(ids));
    clearTimeout(freshTimer.current);
    freshTimer.current = setTimeout(() => setFresh(new Set()), 900);
  }
  useEffect(() => () => clearTimeout(freshTimer.current), []);

  // ---- run overlay data ----
  const live = run.status === "running" || run.status === "paused";
  const utilOf = (id: string): number | undefined =>
    live ? run.snapshot?.nodeUtil[id] : run.result?.nodes.find((n) => n.nodeId === id)?.utilisation;
  const healthOf = (id: string): NodeHealth | undefined => (live ? run.snapshot?.nodeState[id] : undefined);
  const flagged = new Set(brokenRefs(design).map((r) => r.owner));
  const rewrittenOwners = new Set(rewritten.map((r) => r.owner));

  const parentOf = new Map(design.nodes.map((n) => [n.id, groupOf(groups, n)]));
  const nodes: BoardNode[] = [
    ...groups.map((g): BoardNode => ({
      id: g.id, type: "group", position: g.position, width: g.size.w, height: g.size.h, zIndex: 0,
      selected: selection?.kind === "group" && selection.id === g.id, dragHandle: undefined,
      ariaLabel: `${g.kind} frame ${g.name}`,
      data: { group: g, look, members: design.nodes.filter((n) => parentOf.get(n.id)?.id === g.id).length },
    })),
    ...design.nodes.map((n): BoardNode => {
      const parent = parentOf.get(n.id);
      return {
        id: n.id, type: "component", width: NODE_W, height: NODE_H, zIndex: 1,
        // Controlled updates must retain measured dimensions or React Flow discards the handle bounds.
        measured: { width: NODE_W, height: NODE_H },
        parentId: parent?.id,
        position: parent ? { x: n.position.x - parent.position.x, y: n.position.y - parent.position.y } : n.position,
        selected: sel.has(n.id),
        ariaLabel: `${n.label}, ${KIND_LABEL[n.kind]}${healthOf(n.id) === "down" ? ", down" : ""}${sel.has(n.id) && sel.size > 1 ? ", in selection" : ""}`,
        data: {
          spec: n, look, util: utilOf(n.id), health: healthOf(n.id), flagged: flagged.has(n.id),
          heat: props.heat?.[n.id], fresh: fresh.has(n.id), rewritten: rewrittenOwners.has(n.id),
        },
      };
    }),
  ];
  const edges: SketchFlowEdge[] = design.edges.map((e) => ({
    id: e.id, source: e.from, target: e.to, type: "sketch", zIndex: 1,
    data: { look, fresh: fresh.has(e.id), live: run.status === "running", insert: drop?.edgeId === e.id ? { ok: !!drop.ok, text: drop.text ?? "" } : undefined },
    selected: selection?.kind === "edge" && selection.id === e.id,
    ariaLabel: `${label(design, e.from)} may call ${label(design, e.to)}`,
  }));

  function onNodesChange(changes: NodeChange<BoardNode>[]) {
    const d0 = api.getState().design;
    const selects = changes.filter((c) => c.type === "select");
    if (selects.length) {
      const next = new Set(selectedNodeIds(api.getState()));
      for (const c of selects) if (c.type === "select" && d0.nodes.some((n) => n.id === c.id)) {
        if (c.selected) next.add(c.id);
        else next.delete(c.id);
      }
      api.getState().setMulti([...next]);
    }
    const moves = changes.filter((c) => c.type === "position" && c.position);
    const sizes = changes.filter((c) => c.type === "dimensions" && "resizing" in c && c.resizing && c.dimensions);
    if (moves.length === 0 && sizes.length === 0) return;
    commit((d) => {
      let out = d;
      for (const c of moves) {
        if (c.type !== "position" || !c.position) continue;
        const g = out.groups?.find((x) => x.id === c.id);
        if (g) {
          // Resizing from the left/top moves only the frame; dragging the frame carries its members along.
          const dx = c.position.x - g.position.x, dy = c.position.y - g.position.y;
          out = { ...out, groups: out.groups!.map((x) => (x.id === g.id ? { ...x, position: c.position! } : x)) };
          if ("dragging" in c && c.dragging !== undefined)
            out = { ...out, nodes: out.nodes.map((n) => (groupOf(d.groups ?? [], n)?.id === g.id ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n)) };
          continue;
        }
        if (!("dragging" in c) || c.dragging === undefined) continue; // parent-resize compensation, not a user move
        const node = out.nodes.find((n) => n.id === c.id);
        const parent = node && groupOf(d.groups ?? [], node);
        const abs = parent ? { x: c.position.x + parent.position.x, y: c.position.y + parent.position.y } : c.position;
        out = updateNode(out, c.id, (n) => ({ ...n, position: { x: abs.x, y: abs.y } }));
      }
      return out;
    }, `drag:${gesture.current}`);
  }

  /** Dropping components inside a frame moves them to that region/zone. */
  function settleIntoFrames(ids: string[]) {
    const d = api.getState().design;
    if (!d.groups?.length) return;
    commit((x) => {
      let out = x;
      for (const id of ids) {
        const n = out.nodes.find((m) => m.id === id);
        if (!n || !hasParam(n, "region")) continue;
        const c = { x: n.position.x + NODE_W / 2, y: n.position.y + NODE_H / 2 };
        for (const g of d.groups!) {
          const inside = c.x > g.position.x && c.x < g.position.x + g.size.w && c.y > g.position.y && c.y < g.position.y + g.size.h;
          const key = g.kind === "zone" ? "zone" : "region";
          if (inside && g.name && (n.params as Record<string, unknown>)[key] !== g.name)
            out = updateNode(out, id, (m) => ({ ...m, params: { ...m.params, [key]: g.name } }) as typeof m);
        }
      }
      return out;
    }, `drag:${gesture.current}`);
  }

  /** Why a port-to-port link would be refused, in words (shown at the cursor while dragging). */
  function refusal(from: NodeId, to: NodeId) {
    return connect(api.getState().design, from, to).error;
  }

  function doConnect(from: NodeId, to: NodeId) {
    const r = connect(api.getState().design, from, to);
    if (r.error) return notify(r.error);
    commit(() => r.design);
    markFresh([r.design.edges.at(-1)!.id]);
    notify(`Connected ${label(design, from)} → ${label(design, to)}`);
  }

  function edgeAt(center: { x: number; y: number }): string | undefined {
    const zoom = rf.getViewport().zoom;
    let hit: string | undefined;
    let best = 22 / zoom;
    for (const e of design.edges) {
      const a = design.nodes.find((n) => n.id === e.from), b = design.nodes.find((n) => n.id === e.to);
      if (!a || !b) continue;
      const dist = distToSegment(center, { x: a.position.x + NODE_W, y: a.position.y + NODE_H / 2 }, { x: b.position.x, y: b.position.y + NODE_H / 2 });
      if (dist < best) [best, hit] = [dist, e.id];
    }
    return hit;
  }

  function addAt(kind: ComponentKind, center: { x: number; y: number }) {
    const pos = { x: snap(center.x - NODE_W / 2), y: snap(center.y - NODE_H / 2) };
    // Dropped onto a connection? Apply an insertion rule (one undo step) or reject with a reason.
    const hit = edgeAt(center);
    if (hit) {
      const r = insertOnEdge(design, hit, kind, pos);
      if ("error" in r) return notify(r.error);
      commit(() => r.design);
      api.getState().setRewritten(r.rewritten);
      select({ kind: "node", id: r.insertedId });
      const before = new Set([...design.nodes.map((n) => n.id), ...design.edges.map((e) => e.id)]);
      markFresh([...r.design.nodes.map((n) => n.id), ...r.design.edges.map((e) => e.id)].filter((id) => !before.has(id)));
      const reused = design.nodes.some((n) => n.id === r.insertedId);
      const n = r.rewritten.length;
      return notify(`${reused ? `Using the existing ${elementName(design, r.insertedId)}` : `Inserted ${KIND_LABEL[kind].toLowerCase()}`}: ${n} route${n === 1 ? "" : "s"} rewritten — highlighted for review in the inspector.`);
    }
    const r = addNode(design, kind, pos);
    commit(() => r.design);
    select({ kind: "node", id: r.id });
    markFresh([r.id]);
  }

  function viewportCenter() {
    const el = document.querySelector(`[data-board="${runKey}"]`)?.getBoundingClientRect();
    return el ? rf.screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 }) : { x: 0, y: 0 };
  }

  function paste(text: string, offset = { x: 32, y: 32 }) {
    const clip = parseClip(text, KINDS);
    if (!clip) return false;
    const r = pasteClip(api.getState().design, clip, offset);
    if ("error" in r) return notify(r.error), true;
    commit(() => r.design);
    api.getState().setMulti(r.ids);
    markFresh(r.ids);
    notify(`Pasted ${r.ids.length} component${r.ids.length === 1 ? "" : "s"} with new ids; routes now point at the copies.`);
    return true;
  }

  const duplicate = () => {
    const ids = selectedNodeIds(api.getState());
    if (ids.length) paste(JSON.stringify(copySelection(api.getState().design, ids)));
  };
  const align = (how: Align) => commit((d) => refitGroups(alignNodes(d, [...sel], how)));
  const distribute = (axis: "x" | "y") => commit((d) => refitGroups(distributeNodes(d, [...sel], axis)));

  async function tidy() {
    setLaying(true);
    try {
      const next = await autoLayout(api.getState().design);
      commit(() => next);
      requestAnimationFrame(() => rf.fitView({ padding: { top: "72px", left: showLibrary ? "296px" : "40px", right: "40px", bottom: "40px" }, duration: props.reducedMotion ? 0 : 400 }));
      notify("Laid out left to right. Undo restores the previous positions.");
    } catch (e) {
      notify(`Auto-layout failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLaying(false);
    }
  }

  function addFrame() {
    const d = api.getState().design;
    const members = d.nodes.filter((n) => sel.has(n.id) && hasParam(n, "region"));
    const first = members[0]?.params as { region?: string } | undefined;
    const name = first?.region ?? placeNames(d).regions[0] ?? "us-east-1";
    const c = viewportCenter();
    const box = members.length ? frameAround(members) : { position: { x: snap(c.x - 260), y: snap(c.y - 160) }, size: { w: 520, h: 320 } };
    const g: GroupSpec = { id: nextId((d.groups ?? []).map((x) => x.id), "frame"), kind: "region", name, ...box };
    commit((x) => ({ ...x, groups: [...(x.groups ?? []), g] }));
    select({ kind: "group", id: g.id });
    notify(`Added a region frame “${name}”. Components in that region sit inside it; rename it or switch it to a zone in the inspector.`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable=true], dialog") || e.altKey) return;
    const k = e.key.toLowerCase();
    const s = api.getState().selection;
    if (e.metaKey || e.ctrlKey) {
      if (k === "a") api.getState().setMulti(api.getState().design.nodes.map((n) => n.id));
      else if (k === "d") duplicate();
      else return;
      e.preventDefault();
      return;
    }
    const toolHit = TOOLS.find((x) => x.key === k);
    const focusedId = t.closest(".react-flow__node")?.getAttribute("data-id");
    if (toolHit) {
      setTool(toolHit.tool);
      setConnectFrom(null);
    } else if (k === " " && focusedId && api.getState().design.nodes.some((n) => n.id === focusedId)) {
      const next = new Set(selectedNodeIds(api.getState()));
      if (next.has(focusedId)) next.delete(focusedId);
      else next.add(focusedId);
      api.getState().setMulti([...next]);
    } else if (sel.size > 0 && k.startsWith("arrow")) {
      const step = e.shiftKey ? GRID * 4 : GRID;
      const [dx, dy] = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k]!;
      commit((d) => ({ ...d, nodes: d.nodes.map((n) => (sel.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n)) }), `nudge:${[...sel].join(",")}`);
    } else if (k === "enter" && (s || sel.size)) {
      props.openInspector();
    } else if (k === "c" && s?.kind === "node") {
      pickerRef.current?.showModal();
    } else if (k === "f") {
      addFrame();
    } else if (k === "l") {
      void tidy();
    } else if ((k === "delete" || k === "backspace") && (s || sel.size)) {
      if (sel.size > 0) props.requestDelete({ nodeIds: [...sel] });
      else if (s?.kind === "edge") props.requestDelete({ edgeIds: [s.id] });
      else if (s?.kind === "group") { commit((d) => ({ ...d, groups: (d.groups ?? []).filter((g) => g.id !== s.id) })); select(null); }
    } else if (k === "escape") {
      setTool("select");
      setConnectFrom(null);
      select(null);
    } else return;
    e.preventDefault();
  }

  const selectedNode = selection?.kind === "node" ? design.nodes.find((n) => n.id === selection.id) : undefined;
  const pickable = selectedNode ? design.nodes.filter((n) => n.id !== selectedNode.id && n.kind !== "client" && !design.edges.some((e) => e.from === selectedNode.id && e.to === n.id)) : [];
  const iconBtn = "relative grid size-8 place-items-center rounded-(--radius-sm) text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:opacity-40";
  const textBtn = "h-8 rounded-(--radius-sm) px-2 text-xs text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:opacity-40";

  return (
    <div
      data-board={runKey}
      data-connecting={connecting || tool === "connect" || undefined}
      data-dropping={(drop && !drop.edgeId) || undefined}
      className={`${styles.board} relative h-full min-h-0 w-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent)`}
      tabIndex={0}
      aria-label="Whiteboard. Shortcuts: V select, H pan, A connect, P pen, T text, N note, F frame, L auto-layout. Arrow keys move the selection, Space adds the focused component to it, Ctrl+A selects all, Ctrl+D duplicates, Ctrl+C and Ctrl+V copy and paste, Enter opens the inspector, C connects, Delete removes."
      onKeyDown={onKeyDown}
      onCopy={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        const ids = selectedNodeIds(api.getState());
        if (!ids.length) return;
        e.clipboardData.setData("text/plain", JSON.stringify(copySelection(api.getState().design, ids)));
        e.preventDefault();
        notify(`Copied ${ids.length} component${ids.length === 1 ? "" : "s"}. Paste here or into another design.`);
      }}
      onPaste={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea")) return;
        if (paste(e.clipboardData.getData("text/plain"))) e.preventDefault();
      }}
      onFocus={(e) => {
        const id = (e.target as HTMLElement).closest(".react-flow__node")?.getAttribute("data-id");
        const st = api.getState();
        if (id && st.selection?.id !== id && !st.multi.includes(id)) select(design.groups?.some((g) => g.id === id) ? { kind: "group", id } : { kind: "node", id });
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
        const x = snap(p.x - NODE_W / 2), y = snap(p.y - NODE_H / 2);
        const edgeId = dragging.kind ? edgeAt(p) : undefined;
        if (drop && drop.x === x && drop.y === y && drop.edgeId === edgeId) return;
        let verdict: { ok?: boolean; text?: string } = {};
        if (edgeId && dragging.kind) {
          const r = insertOnEdge(design, edgeId, dragging.kind, { x, y });
          verdict = "error" in r ? { ok: false, text: r.error } : { ok: true, text: `Insert ${KIND_LABEL[dragging.kind].toLowerCase()} here (${r.rewritten.length} route${r.rewritten.length === 1 ? "" : "s"} rewritten)` };
        }
        setDrop({ x, y, edgeId, ...verdict });
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={(e) => {
        setDrop(null);
        const kind = e.dataTransfer.getData(DRAG_MIME) as ComponentKind;
        setDragging(null);
        if (!kind) return;
        e.preventDefault();
        addAt(kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      <ReactFlow<BoardNode, SketchFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={(c) => doConnect(c.source, c.target)}
        isValidConnection={(c) => !refusal(c.source, c.target)}
        connectionRadius={36}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={(_, c) => {
          setConnecting(false);
          if (c.isValid !== false || !c.toNode || !c.fromNode) return;
          const [s, t] = c.fromHandle?.type === "target" ? [c.toNode.id, c.fromNode.id] : [c.fromNode.id, c.toNode.id];
          notify(refusal(s, t) ?? INPUT_HINT);
        }}
        onNodeDragStart={() => gesture.current++}
        onNodeDragStop={(_, n, dragged) => {
          settleIntoFrames(dragged.filter((x) => x.type === "component").map((x) => x.id).concat(n.type === "component" ? [n.id] : []));
          api.getState().endGesture();
        }}
        onNodeClick={(e, n) => {
          if (n.type === "group") return select({ kind: "group", id: n.id });
          if (tool === "connect") {
            if (!connectFrom) return setConnectFrom(n.id);
            doConnect(connectFrom, n.id);
            setConnectFrom(null);
            return;
          }
          if (e.shiftKey || e.metaKey || e.ctrlKey) return; // multi-select handled through select changes
          select({ kind: "node", id: n.id });
        }}
        onNodeDoubleClick={() => props.openInspector()}
        onEdgeClick={(_, e) => select({ kind: "edge", id: e.id })}
        onPaneClick={() => {
          select(null);
          setConnectFrom(null);
        }}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={["Shift", "Meta", "Control"]}
        disableKeyboardA11y
        snapToGrid
        snapGrid={[GRID, GRID]}
        nodesDraggable={tool === "select"}
        nodesConnectable={tool === "select" || tool === "connect"}
        elementsSelectable={tool !== "hand"}
        panOnDrag={tool === "hand" || tool === "select" || tool === "connect"}
        panOnScroll
        fitView
        fitViewOptions={{ padding: { top: "72px", left: showLibrary ? "296px" : "40px", right: "40px", bottom: "40px" }, maxZoom: 1.1 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        {/* Engineer's notebook: fine grid with a heavier rule every 5 squares. */}
        <Background id="minor" variant={BackgroundVariant.Lines} gap={GRID} lineWidth={1} color="var(--grid-ink, var(--grid-line))" />
        <Background id="major" variant={BackgroundVariant.Lines} gap={GRID * 5} lineWidth={1} color="var(--grid-ink-major, var(--grid-line))" />
        {design.nodes.length > 0 && (
          <MiniMap<BoardNode> className="max-md:hidden!" pannable zoomable nodeColor={(n) => (n.type === "component" ? KIND_COLOR[n.data.spec.kind] : "transparent")} nodeStrokeWidth={0} ariaLabel="Minimap" />
        )}
        <Controls showInteractive={false} position="bottom-left" style={{ left: showLibrary ? 268 : 12 }} />
        <ConnectionHint refusal={refusal} />
        <AnnotationLayer tool={tool} onDone={() => setTool("select")} />
        {drop && !drop.edgeId && (
          <ViewportPortal>
            <div className={`${styles.ghost} pointer-events-none absolute`} style={{ transform: `translate(${drop.x}px, ${drop.y}px)`, width: NODE_W, height: NODE_H }}>
              {dragging.kind && (
                <>
                  <KindSwatch kind={dragging.kind} size={30} />
                  <span className="text-[13px] font-medium leading-tight text-(--text)">Drop to add {KIND_LABEL[dragging.kind].toLowerCase()}</span>
                </>
              )}
            </div>
          </ViewportPortal>
        )}
      </ReactFlow>
      <PacketOverlay runKey={runKey} reducedMotion={props.reducedMotion} />

      {/* Floating tool palette */}
      {/* Centred in the free strip beside the library; scrolls sideways when the board is narrow. */}
      <div
        className="pointer-events-none absolute left-3 right-3 top-16 z-20 flex justify-center md:left-(--lib) md:top-3"
        style={{ ["--lib" as string]: showLibrary ? "17.5rem" : "11rem" }}
      >
      <div role="toolbar" aria-label="Board tools" className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-(--radius) border border-(--border) bg-(--surface) p-1 shadow-(--elev-2)">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            type="button"
            aria-pressed={tool === t.tool}
            title={`${t.label} — ${t.key.toUpperCase()}`}
            aria-label={`${t.label} (${t.key.toUpperCase()})`}
            onClick={() => {
              setTool(t.tool);
              setConnectFrom(null);
            }}
            className={`${iconBtn} aria-pressed:bg-[color-mix(in_oklab,var(--accent)_22%,transparent)] aria-pressed:text-(--text)`}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.icon} /></svg>
            <span className="absolute bottom-0 right-0.5 text-[8px] leading-none opacity-60" aria-hidden="true">{t.key.toUpperCase()}</span>
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-(--border)" aria-hidden="true" />
        <button type="button" className={textBtn} onClick={addFrame} title="Region / zone frame — F">▢ Frame</button>
        <button type="button" className={textBtn} onClick={() => void tidy()} disabled={laying || design.nodes.length < 2} title="Auto-layout — L">{laying ? "Laying out…" : "⇶ Tidy"}</button>
        <button type="button" onClick={() => annotations.set(annotations.get().filter((a) => a.type !== "stroke"))} className={textBtn}>Clear ink</button>
        <button type="button" onClick={() => setLook(look === "sketch" ? "clean" : "sketch")} aria-label={`Look: ${look}. Switch to ${look === "sketch" ? "clean" : "sketch"}`} className={textBtn}>
          {look === "sketch" ? "✎ Sketch" : "▭ Clean"}
        </button>
      </div>
      </div>

      {/* Selection toolbar: align / distribute / duplicate */}
      {sel.size >= 2 && (
        <div role="toolbar" aria-label={`${sel.size} components selected`} className="absolute left-1/2 top-16 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-(--radius) border border-(--accent) max-md:top-28 bg-(--surface) p-1 shadow-(--elev-2)">
          <span className="px-2 text-xs text-(--text)">{sel.size} selected</span>
          {ALIGN.map((a) => (
            <button key={a.how} type="button" className={iconBtn} onClick={() => align(a.how)} aria-label={a.label} title={a.label}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d={a.icon} /></svg>
            </button>
          ))}
          <button type="button" className={textBtn} disabled={sel.size < 3} onClick={() => distribute("x")} title="Distribute horizontally">↔ Space</button>
          <button type="button" className={textBtn} disabled={sel.size < 3} onClick={() => distribute("y")} title="Distribute vertically">↕ Space</button>
          <button type="button" className={textBtn} onClick={duplicate} title="Duplicate — Ctrl+D">Duplicate</button>
          <button type="button" className={textBtn} onClick={() => api.getState().setMulti([])}>Clear</button>
        </div>
      )}

      {tool === "connect" && (
        <p role="status" className="absolute left-1/2 top-16 z-20 -translate-x-1/2 rounded-full max-md:top-28 border border-(--border) bg-(--surface) px-3 py-1 text-xs text-(--text)">
          {connectFrom ? `From ${label(design, connectFrom)} — now pick the component it calls` : "Pick the caller, then the component it calls"}
        </p>
      )}

      {/* Library */}
      <div className="absolute bottom-3 left-3 top-3 z-20 flex w-64 flex-col rounded-(--radius) border border-(--border) bg-(--surface) shadow-(--elev-2) data-[collapsed]:bottom-auto data-[collapsed]:w-40" data-collapsed={!showLibrary || undefined}>
        <button
          type="button"
          aria-expanded={showLibrary}
          onClick={() => setShowLibrary(!showLibrary)}
          className="flex h-10 shrink-0 items-center justify-between px-3 text-sm font-medium text-(--text) hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)"
        >
          Components <span aria-hidden="true" className="text-(--text-muted)">{showLibrary ? "−" : "+"}</span>
        </button>
        {showLibrary && (
          <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
            <Library allowed={props.allowedKinds} onAdd={(k) => addAt(k, viewportCenter())} />
            <p className="mt-2 shrink-0 border-t border-(--border) px-1 pt-2 text-[11px] leading-snug text-(--text-muted)">
              Drop on a connection to insert in between. Ctrl+K searches.
            </p>
          </div>
        )}
      </div>

      {design.nodes.length === 0 && !drop && (
        <div className={`pointer-events-none absolute inset-0 z-10 grid place-items-center p-6 ${showLibrary ? "md:pl-72" : ""}`}>
          <div className="relative max-w-sm text-center">
            {showLibrary && (
              <svg className="absolute -left-28 top-2 hidden overflow-visible md:block" width="96" height="60" viewBox="0 0 96 60" fill="none" aria-hidden="true" style={{ stroke: "var(--accent-2)" }}>
                <path d="M92 40 C70 52 34 50 8 18" strokeWidth="1.8" strokeLinecap="round" pathLength={1} className="draw-on" />
                <path d="M7 31 L8 18 L20 22" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
            <p className="font-mono text-[11px] uppercase tracking-wider text-(--accent)">Fig. 0 · a blank page</p>
            <p className="mt-2 font-(family-name:--font-display) text-2xl leading-tight text-(--text)">
              Every system starts with a <span className="marker">client</span>.
            </p>
            <p className="mt-2 text-sm leading-relaxed text-(--ink-2,var(--text))">
              Drag one from Components, add a service, then pull an arrow from the client&apos;s right-hand dot to the service.
            </p>
            {(!props.allowedKinds || props.allowedKinds.includes("client")) && (
              <button
                type="button"
                onClick={() => addAt("client", viewportCenter())}
                className="pointer-events-auto mt-4 h-9 rounded-(--radius-sm) border border-(--rule,var(--border)) bg-(--surface) px-3.5 text-sm font-medium text-(--text) shadow-(--elev-1) hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)"
              >
                + Add a client for me
              </button>
            )}
          </div>
        </div>
      )}

      {/* C: connect the selected node via a target picker (keyboard path for port-to-port drags) */}
      <dialog
        ref={pickerRef}
        aria-label="Connect to"
        className="m-auto w-72 rounded-(--radius) border border-(--border) bg-(--surface) p-0 text-(--text) backdrop:bg-[color-mix(in_oklab,var(--bg)_50%,transparent)]"
      >
        <form method="dialog" className="flex flex-col gap-1 p-3">
          <p className="mb-1 text-sm">{selectedNode ? <><strong>{selectedNode.label}</strong> may call…</> : "Select a component first"}</p>
          {pickable.map((n) => (
            <button
              key={n.id}
              value={n.id}
              onClick={() => selectedNode && doConnect(selectedNode.id, n.id)}
              className="flex h-8 items-center gap-2 rounded-(--radius-sm) px-2 text-left text-sm hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)"
            >
              {n.label} <span className="text-xs text-(--text-muted)">{KIND_LABEL[n.kind]}</span>
            </button>
          ))}
          {selectedNode && pickable.length === 0 && <p className="text-xs text-(--text-muted)">No unconnected components left.</p>}
          <button value="" className="mt-2 h-8 rounded-(--radius-sm) border border-(--border) text-sm hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)">Cancel</button>
        </form>
      </dialog>
    </div>
  );
}

function label(d: Design, id: NodeId) {
  return d.nodes.find((n) => n.id === id)?.label ?? id;
}

const INPUT_HINT = "Arrows end on a component's left-hand dot (its input).";

/** While dragging a connection over a component that can't accept it, say why at the cursor. */
function ConnectionHint({ refusal }: { refusal: (from: NodeId, to: NodeId) => string | undefined }) {
  const c = useConnection();
  if (!c.inProgress || !c.toNode || c.isValid !== false) return null;
  const [s, t] = c.fromHandle.type === "target" ? [c.toNode.id, c.fromNode.id] : [c.fromNode.id, c.toNode.id];
  return (
    <ViewportPortal>
      <p
        role="status"
        className="pointer-events-none absolute z-50 max-w-60 rounded-(--radius-sm) border border-(--danger) bg-(--surface) px-2.5 py-1.5 text-xs font-medium text-(--danger) shadow-(--elev-2)"
        style={{ transform: `translate(${c.to.x + 14}px, ${c.to.y + 14}px)` }}
      >
        ✕ {refusal(s, t) ?? INPUT_HINT}
      </p>
    </ViewportPortal>
  );
}
