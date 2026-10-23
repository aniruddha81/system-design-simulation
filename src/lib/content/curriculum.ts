export type DagNode = { id: string; requires: string[] };

/**
 * Validates the prerequisite DAG (every prerequisite exists, no cycles) and returns
 * a topological order plus each node's depth (longest prerequisite chain).
 */
export function buildDag<T extends DagNode>(nodes: T[]): { order: T[]; depth: Map<string, number> } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new Error("Duplicate lesson id in curriculum");
  for (const n of nodes) {
    for (const r of n.requires) if (!byId.has(r)) throw new Error(`Lesson "${n.id}" requires unknown lesson "${r}"`);
  }

  const depth = new Map<string, number>();
  const order: T[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (n: T, path: string[]): number => {
    const s = state.get(n.id);
    if (s === "done") return depth.get(n.id)!;
    if (s === "visiting") throw new Error(`Prerequisite cycle: ${[...path, n.id].join(" → ")}`);
    state.set(n.id, "visiting");
    let d = 0;
    for (const r of n.requires) d = Math.max(d, visit(byId.get(r)!, [...path, n.id]) + 1);
    state.set(n.id, "done");
    depth.set(n.id, d);
    order.push(n);
    return d;
  };
  for (const n of nodes) visit(n, []);
  return { order, depth };
}
