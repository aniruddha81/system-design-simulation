"use client";
import "@xyflow/react/dist/style.css";
import {
  Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useReactFlow, type NodeChange,
} from "@xyflow/react";
import { useRef, useState } from "react";
import type { ComponentKind, Design, NodeId } from "@/engine/types";
import { useRun } from "@/lib/run-manager";
import { AnnotationLayer, type Tool } from "./Annotations";
import {
  edgeTypes, NODE_H, NODE_W, nodeTypes, type ComponentFlowNode, type Look, type NodeHealth, type SketchFlowEdge,
} from "./board-elements";
import { addNode, brokenRefs, connect, distToSegment, insertOnEdge, updateNode } from "./design-ops";
import { useAnnotations, useDesign, useDesignApi } from "./design-store";
import { KIND_COLOR } from "./kinds";
import { DRAG_MIME, Library } from "./Library";
import { PacketOverlay } from "./PacketOverlay";
import styles from "./sandbox.module.css";

const GRID = 16;
const snap = (v: number) => Math.round(v / GRID) * GRID;

const TOOLS: { tool: Tool; key: string; label: string; icon: string }[] = [
  { tool: "select", key: "v", label: "Select", icon: "M5 3l13 8-6 1.5L9 19z" },
  { tool: "hand", key: "h", label: "Hand (pan)", icon: "M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5V4a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3.5 14a1.5 1.5 0 0 1 2.4-1.8L8 14" },
  { tool: "connect", key: "a", label: "Arrow (connect two components)", icon: "M4 20 20 4m0 0h-8m8 0v8" },
  { tool: "pen", key: "p", label: "Pen", icon: "M4 20l4-1 11-11-3-3L5 16zM14 6l3 3" },
  { tool: "text", key: "t", label: "Text", icon: "M5 6V4h14v2M12 4v16m-3 0h6" },
  { tool: "note", key: "n", label: "Sticky note", icon: "M5 4h14v10l-6 6H5zM13 20v-6h6" },
];

export type DeleteRequest = { nodeIds?: NodeId[]; edgeIds?: string[] };

export function Whiteboard(props: {
  runKey: string;
  allowedKinds?: ComponentKind[];
  look: Look;
  setLook: (l: Look) => void;
  reducedMotion: boolean;
  notify: (msg: string) => void;
  openInspector: () => void;
  requestDelete: (r: DeleteRequest) => void;
}) {
  const { runKey, look, setLook, notify } = props;
  const design = useDesign((s) => s.design);
  const selection = useDesign((s) => s.selection);
  const api = useDesignApi();
  const run = useRun(runKey);
  const rf = useReactFlow();
  const [, annotations] = useAnnotations();
  const [tool, setTool] = useState<Tool>("select");
  const [connectFrom, setConnectFrom] = useState<NodeId | null>(null);
  const [showLibrary, setShowLibrary] = useState(true);
  const pickerRef = useRef<HTMLDialogElement>(null);
  const gesture = useRef(0);

  const commit = api.getState().commit;
  const select = api.getState().select;

  // ---- run overlay data ----
  const live = run.status === "running" || run.status === "paused";
  const utilOf = (id: string): number | undefined =>
    live ? run.snapshot?.nodeUtil[id] : run.result?.nodes.find((n) => n.nodeId === id)?.utilisation;
  const healthOf = (id: string): NodeHealth | undefined => (live ? run.snapshot?.nodeState[id] : undefined);
  const flagged = new Set(brokenRefs(design).map((r) => r.owner));

  const nodes: ComponentFlowNode[] = design.nodes.map((n) => ({
    id: n.id, type: "component", position: n.position, width: NODE_W, height: NODE_H,
    selected: selection?.kind === "node" && selection.id === n.id,
    ariaLabel: `${n.label}, ${n.kind}${healthOf(n.id) === "down" ? ", down" : ""}`,
    data: { spec: n, look, util: utilOf(n.id), health: healthOf(n.id), flagged: flagged.has(n.id) },
  }));
  const edges: SketchFlowEdge[] = design.edges.map((e) => ({
    id: e.id, source: e.from, target: e.to, type: "sketch", data: { look },
    selected: selection?.kind === "edge" && selection.id === e.id,
    ariaLabel: `${label(design, e.from)} may call ${label(design, e.to)}`,
  }));

  function onNodesChange(changes: NodeChange<ComponentFlowNode>[]) {
    const moves = changes.filter((c) => c.type === "position" && c.position);
    if (moves.length === 0) return;
    commit((d) => moves.reduce((acc, c) => (c.type === "position" && c.position
      ? updateNode(acc, c.id, (n) => ({ ...n, position: { x: c.position!.x, y: c.position!.y } }))
      : acc), d), `drag:${gesture.current}`);
  }

  function doConnect(from: NodeId, to: NodeId) {
    const r = connect(api.getState().design, from, to);
    if (r.error) return notify(r.error);
    commit(() => r.design);
    notify(`Connected ${label(design, from)} → ${label(design, to)}`);
  }

  function addAt(kind: ComponentKind, center: { x: number; y: number }) {
    const pos = { x: snap(center.x - NODE_W / 2), y: snap(center.y - NODE_H / 2) };
    // Dropped onto a connection? Apply an insertion rule (one undo step) or reject with a reason.
    const zoom = rf.getViewport().zoom;
    let hit: { id: string } | undefined;
    let best = 18 / zoom;
    for (const e of design.edges) {
      const a = design.nodes.find((n) => n.id === e.from), b = design.nodes.find((n) => n.id === e.to);
      if (!a || !b) continue;
      const dist = distToSegment(center, { x: a.position.x + NODE_W, y: a.position.y + NODE_H / 2 }, { x: b.position.x, y: b.position.y + NODE_H / 2 });
      if (dist < best) [best, hit] = [dist, e];
    }
    if (hit) {
      const r = insertOnEdge(design, hit.id, kind, pos);
      if ("error" in r) return notify(r.error);
      commit(() => r.design);
      api.getState().setRewritten(r.rewritten);
      if (r.cacheId) select({ kind: "node", id: r.cacheId });
      return notify(`Inserted a cache: ${r.rewritten.length} route${r.rewritten.length === 1 ? "" : "s"} rewritten to cache-aside — review them in the inspector.`);
    }
    const r = addNode(design, kind, pos);
    commit(() => r.design);
    select({ kind: "node", id: r.id });
  }

  function viewportCenter() {
    const el = document.querySelector(`[data-board="${runKey}"]`)?.getBoundingClientRect();
    return el ? rf.screenToFlowPosition({ x: el.left + el.width / 2, y: el.top + el.height / 2 }) : { x: 0, y: 0 };
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable=true], dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const sel = api.getState().selection;
    const toolHit = TOOLS.find((x) => x.key === k);
    if (toolHit) {
      setTool(toolHit.tool);
      setConnectFrom(null);
    } else if (sel?.kind === "node" && k.startsWith("arrow")) {
      const step = e.shiftKey ? GRID * 4 : GRID;
      const [dx, dy] = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k]!;
      commit((d) => updateNode(d, sel.id, (n) => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } })), `nudge:${sel.id}`);
    } else if (k === "enter" && sel) {
      props.openInspector();
    } else if (k === "c" && sel?.kind === "node") {
      pickerRef.current?.showModal();
    } else if ((k === "delete" || k === "backspace") && sel) {
      props.requestDelete(sel.kind === "node" ? { nodeIds: [sel.id] } : { edgeIds: [sel.id] });
    } else if (k === "escape") {
      setTool("select");
      setConnectFrom(null);
      select(null);
    } else return;
    e.preventDefault();
  }

  const selectedNode = selection?.kind === "node" ? design.nodes.find((n) => n.id === selection.id) : undefined;
  const pickable = selectedNode ? design.nodes.filter((n) => n.id !== selectedNode.id && n.kind !== "client" && !design.edges.some((e) => e.from === selectedNode.id && e.to === n.id)) : [];

  return (
    <div
      data-board={runKey}
      className={`${styles.board} relative h-full min-h-0 w-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent)`}
      tabIndex={0}
      aria-label="Whiteboard. Shortcuts: V select, H pan, A connect, P pen, T text, N note. Arrow keys move the selected component, Enter opens the inspector, C connects it, Delete removes it."
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        const id = (e.target as HTMLElement).closest(".react-flow__node")?.getAttribute("data-id");
        if (id && api.getState().selection?.id !== id) select({ kind: "node", id });
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const kind = e.dataTransfer.getData(DRAG_MIME) as ComponentKind;
        if (!kind) return;
        e.preventDefault();
        addAt(kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      <ReactFlow<ComponentFlowNode, SketchFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onConnect={(c) => doConnect(c.source, c.target)}
        onNodeDragStart={() => gesture.current++}
        onNodeDragStop={() => api.getState().endGesture()}
        onNodeClick={(_, n) => {
          if (tool === "connect") {
            if (!connectFrom) return setConnectFrom(n.id);
            doConnect(connectFrom, n.id);
            setConnectFrom(null);
            return;
          }
          select({ kind: "node", id: n.id });
        }}
        onNodeDoubleClick={() => props.openInspector()}
        onEdgeClick={(_, e) => select({ kind: "edge", id: e.id })}
        onPaneClick={() => {
          select(null);
          setConnectFrom(null);
        }}
        deleteKeyCode={null}
        disableKeyboardA11y
        snapToGrid
        snapGrid={[GRID, GRID]}
        nodesDraggable={tool === "select"}
        nodesConnectable={tool === "select" || tool === "connect"}
        elementsSelectable={tool !== "hand"}
        panOnDrag={tool === "hand" || tool === "select" || tool === "connect"}
        panOnScroll
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={GRID * 2} size={1.4} />
        <MiniMap pannable zoomable nodeColor={(n) => KIND_COLOR[(n as ComponentFlowNode).data.spec.kind]} nodeStrokeWidth={0} ariaLabel="Minimap" />
        <Controls showInteractive={false} position="bottom-left" style={{ left: showLibrary ? 252 : 12 }} />
        <AnnotationLayer tool={tool} onDone={() => setTool("select")} />
      </ReactFlow>
      <PacketOverlay runKey={runKey} reducedMotion={props.reducedMotion} />

      {/* Floating tool palette */}
      <div role="toolbar" aria-label="Board tools" className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-(--radius) border border-(--border) bg-(--surface) p-1 shadow-lg">
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
            className="relative grid size-8 place-items-center rounded-(--radius-sm) text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent) aria-pressed:bg-[color-mix(in_oklab,var(--accent)_22%,transparent)] aria-pressed:text-(--text)"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.icon} /></svg>
            <span className="absolute bottom-0 right-0.5 text-[8px] leading-none opacity-60" aria-hidden="true">{t.key.toUpperCase()}</span>
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-(--border)" aria-hidden="true" />
        <button
          type="button"
          onClick={() => annotations.setState({ items: annotations.getState().items.filter((a) => a.type !== "stroke") })}
          className="h-8 rounded-(--radius-sm) px-2 text-xs text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent)"
        >
          Clear ink
        </button>
        <button
          type="button"
          onClick={() => setLook(look === "sketch" ? "clean" : "sketch")}
          aria-label={`Look: ${look}. Switch to ${look === "sketch" ? "clean" : "sketch"}`}
          className="h-8 rounded-(--radius-sm) px-2 text-xs text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent)"
        >
          {look === "sketch" ? "✎ Sketch" : "▭ Clean"}
        </button>
      </div>

      {tool === "connect" && (
        <p role="status" className="absolute left-1/2 top-16 z-20 -translate-x-1/2 rounded-full border border-(--border) bg-(--surface) px-3 py-1 text-xs text-(--text)">
          {connectFrom ? `From ${label(design, connectFrom)} — now pick the component it calls` : "Pick the caller, then the component it calls"}
        </p>
      )}

      {/* Library */}
      <div className="absolute left-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-60 flex-col rounded-(--radius) border border-(--border) bg-(--surface) shadow-lg">
        <button
          type="button"
          aria-expanded={showLibrary}
          onClick={() => setShowLibrary(!showLibrary)}
          className="flex h-9 items-center justify-between px-3 text-xs font-medium uppercase tracking-wider text-(--text-muted) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent)"
        >
          Components <span aria-hidden="true">{showLibrary ? "−" : "+"}</span>
        </button>
        {showLibrary && (
          <div className="min-h-0 overflow-hidden px-2 pb-2">
            <Library allowed={props.allowedKinds} onAdd={(k) => addAt(k, viewportCenter())} />
          </div>
        )}
      </div>

      {design.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="max-w-xs text-center text-sm text-(--text-muted)">
            Drag a component from the library, or press one to drop it here. Start with a <strong className="text-(--text)">Client</strong>.
          </p>
        </div>
      )}

      {/* C: connect the selected node via a target picker (keyboard path for port-to-port drags) */}
      <dialog
        ref={pickerRef}
        aria-label="Connect to"
        className="m-auto w-72 rounded-(--radius) border border-(--border) bg-(--surface) p-0 text-(--text) backdrop:bg-black/50"
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
              {n.label} <span className="text-xs text-(--text-muted)">{n.kind}</span>
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
