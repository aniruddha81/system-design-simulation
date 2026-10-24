import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { adoptUserNodes, ConnectionMode, getEdgePosition, Position } from "@xyflow/system";
import type { InternalNode, ReactFlowProps } from "@xyflow/react";
import { expect, it, vi } from "vitest";
import { cacheAsideDesign } from "@/engine/fixtures";
import type { Design } from "@/engine/types";
import { NODE_H, NODE_W, type BoardNode, type SketchFlowEdge } from "./board-elements";
import { createDesignStore, DesignCtx } from "./design-store";
import { addNode } from "./design-ops";
import { KINDS } from "./kinds";
import { Whiteboard } from "./Whiteboard";

const capture = vi.hoisted(() => ({ props: {} as ReactFlowProps<BoardNode, SketchFlowEdge> }));
vi.mock("@xyflow/react", async (original) => ({
  ...await original<typeof import("@xyflow/react")>(),
  useReactFlow: () => ({}),
  ReactFlow: (props: ReactFlowProps<BoardNode, SketchFlowEdge>) => { capture.props = props; return null; },
}));
vi.mock("@/lib/run-manager", () => ({ useRun: () => ({ status: "idle" }) }));
vi.mock("./PacketOverlay", () => ({ PacketOverlay: () => null }));

function board(design: Design) {
  const store = createDesignStore(design);
  renderToStaticMarkup(createElement(DesignCtx, { value: store }, createElement(Whiteboard, {
    runKey: design.id, look: "sketch", setLook: vi.fn(), reducedMotion: true,
    notify: vi.fn(), openInspector: vi.fn(), requestDelete: vi.fn(), heat: null,
  })));
  return capture.props;
}

it("keeps every edge drawable across controlled updates, grouping and reload", () => {
  const lookup = new Map<string, InternalNode<BoardNode>>();
  const parents = new Map();
  let design = structuredClone(cacheAsideDesign);
  for (const kind of KINDS) if (!design.nodes.some((n) => n.kind === kind)) {
    const added = addNode(design, kind, { x: 1200, y: design.nodes.length * 100 });
    design = added.design;
    if (kind !== "autoscaler") design.edges.push({ ...design.edges[0], id: `to-${added.id}`, from: "svc1", to: added.id });
  }
  const check = (d: Design) => {
    const { nodes = [], edges = [] } = board(d);
    if (d.groups?.length) expect(nodes.some((n) => n.parentId === "region-frame")).toBe(true);
    adoptUserNodes(nodes, lookup, parents);
    for (const edge of edges) {
      const position = getEdgePosition({
        id: edge.id, sourceNode: lookup.get(edge.source)!, targetNode: lookup.get(edge.target)!,
        sourceHandle: null, targetHandle: null, connectionMode: ConnectionMode.Strict,
      });
      expect(position, edge.id).not.toBeNull();
      expect(Object.values(position!).filter((v) => typeof v === "number").every(Number.isFinite)).toBe(true);
    }
  };
  const measure = (d: Design) => {
    const { nodes = [] } = board(d);
    adoptUserNodes(nodes, lookup, parents);
    // The DOM observer supplies these bounds once. Data/selection edits do not resize a node.
    for (const node of lookup.values()) if (node.type === "component") {
      node.measured = { width: NODE_W, height: NODE_H };
      node.internals.handleBounds = {
        source: [{ id: null, nodeId: node.id, type: "source", position: Position.Right, x: NODE_W - 7, y: NODE_H / 2 - 7, width: 14, height: 14 }],
        target: [{ id: null, nodeId: node.id, type: "target", position: Position.Left, x: -7, y: NODE_H / 2 - 7, width: 14, height: 14 }],
      };
    }
  };
  measure(design);
  check(design);
  design.nodes = design.nodes.map((n) => ({ ...n, label: `${n.label} edited`, position: { x: n.position.x + 16, y: n.position.y + 32 } }));
  check(design);
  design.groups = [{ id: "region-frame", kind: "region", name: design.nodes.find((n) => n.kind === "database")!.params.region, position: { x: 0, y: 0 }, size: { w: 1200, h: 800 } }];
  check(design);
  lookup.clear();
  parents.clear();
  const reloaded = JSON.parse(JSON.stringify(design)) as Design;
  measure(reloaded);
  check(reloaded);
});
