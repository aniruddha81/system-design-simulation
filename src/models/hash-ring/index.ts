import type { Model, Script, Violation } from "../types";
import { hash32 } from "../random";

export type HashRingAction =
  | { type: "addNode"; node: string }
  | { type: "removeNode"; node: string }
  | { type: "setVnodes"; count: number }
  | { type: "addKeys"; keys: string[] };

export interface RingPosition { position: number; node: string; vnode: number }
export interface HashRingState {
  seed: number;
  nodes: string[];
  vnodes: number;
  keys: string[];
  ring: RingPosition[];
  ownership: Record<string, string>;
  load: Record<string, number>;
  movedKeys: string[];
  previousOwnership: Record<string, string>;
}
export interface HashRingOptions { nodes?: string[]; vnodes?: number; keys?: string[] }

function unusedName(existing: string[], prefix: string): string {
  let name = `${prefix}-${existing.length}`;
  while (existing.includes(name)) name += "-new";
  return name;
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function owner(ring: RingPosition[], key: string, seed: number): string {
  const position = hash32(`key:${key}`, seed);
  let low = 0, high = ring.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ring[mid].position < position) low = mid + 1;
    else high = mid;
  }
  return ring[low % ring.length].node;
}

function place(seed: number, nodes: string[], vnodes: number, keys: string[], previousOwnership: Record<string, string>): HashRingState {
  if (!Number.isSafeInteger(seed)) throw new Error("Seed must be a safe integer");
  if (!Number.isInteger(vnodes) || vnodes < 1 || vnodes > 1024) throw new Error("Use 1..1024 virtual nodes per node");
  if (nodes.some(node => typeof node !== "string" || !node.length)) throw new Error("Use named nodes");
  if (keys.some(key => typeof key !== "string")) throw new Error("Use string keys");
  nodes = [...new Set(nodes)].sort(compare);
  keys = [...new Set(keys)].sort(compare);
  if (!nodes.length || nodes.length > 128) throw new Error("Use 1..128 named nodes");
  if (keys.length > 10000) throw new Error("Use at most 10000 string keys");
  const ring = nodes.flatMap(node => Array.from({ length: vnodes }, (_, vnode) => ({
    node, vnode, position: hash32(`node:${node}:${vnode}`, seed),
  }))).sort((a, b) => a.position - b.position || compare(a.node, b.node) || a.vnode - b.vnode);
  const ownership = Object.fromEntries(keys.map(key => [key, owner(ring, key, seed)]));
  const load = Object.fromEntries(nodes.map(node => [node, 0]));
  for (const node of Object.values(ownership)) load[node]++;
  const movedKeys = keys.filter(key => Object.hasOwn(previousOwnership, key) && previousOwnership[key] !== ownership[key]);
  return { seed, nodes, vnodes, keys, ring, ownership, load, movedKeys, previousOwnership: { ...previousOwnership } };
}

export const hashRingScenarios: Script<HashRingAction>[] = [
  { name: "add a node", description: "Only keys in the new node's ring intervals move.", actions: [{ type: "addNode", node: "D" }] },
  { name: "remove a node", description: "Only keys owned by the removed node move.", actions: [{ type: "removeNode", node: "B" }] },
  { name: "skew without vnodes vs with vnodes", description: "Compare per-node load at one and 128 virtual nodes; improvement is statistical, not guaranteed for every seed.", actions: [{ type: "setVnodes", count: 1 }, { type: "setVnodes", count: 128 }] },
];

export function createHashRingModel(options: HashRingOptions = {}): Model<HashRingState, HashRingAction> {
  const nodes = [...(options.nodes ?? ["A", "B", "C"])];
  const keys = [...(options.keys ?? Array.from({ length: 1000 }, (_, i) => `key-${i}`))];
  const vnodes = options.vnodes ?? 32;
  return {
    init: seed => place(seed, nodes, vnodes, keys, {}),
    actions: state => [
      ...(state.nodes.length < 128 ? [{ type: "addNode" as const, node: unusedName(state.nodes, "node") }] : []),
      ...(state.nodes.length > 1 ? state.nodes.map(node => ({ type: "removeNode" as const, node })) : []),
      ...[1, 32, 128].filter(count => count !== state.vnodes).map(count => ({ type: "setVnodes" as const, count })),
      ...(state.keys.length < 10000 ? [{ type: "addKeys" as const, keys: [unusedName(state.keys, "key")] }] : []),
    ],
    step(state, action) {
      switch (action.type) {
        case "addNode": return place(state.seed, [...state.nodes, action.node], state.vnodes, state.keys, state.ownership);
        case "removeNode": return place(state.seed, state.nodes.filter(node => node !== action.node), state.vnodes, state.keys, state.ownership);
        case "setVnodes": return place(state.seed, state.nodes, action.count, state.keys, state.ownership);
        case "addKeys": return place(state.seed, state.nodes, state.vnodes, [...state.keys, ...action.keys], state.ownership);
      }
    },
    invariants: hashRingInvariants,
    scenarios: hashRingScenarios.map(script => ({ ...script, actions: script.actions.map(action => ({ ...action })) })),
  };
}

export function hashRingInvariants(state: HashRingState): Violation[] {
  const issues: Violation[] = [];
  if (!state.ring.length || state.keys.length !== Object.keys(state.ownership).length || state.keys.some(key => !Object.hasOwn(state.ownership, key) || !state.nodes.includes(state.ownership[key]) || state.ownership[key] !== owner(state.ring, key, state.seed))) {
    issues.push({ code: "singleOwnership", message: "Every key must have exactly its clockwise ring owner." });
  }
  const expected = state.keys.filter(key => Object.hasOwn(state.previousOwnership, key) && state.previousOwnership[key] !== state.ownership[key]);
  if (JSON.stringify(expected) !== JSON.stringify(state.movedKeys)) issues.push({ code: "movedKeys", message: "Moved keys must be exactly the existing keys whose owner changed." });
  if (state.nodes.some(node => state.load[node] !== Object.values(state.ownership).filter(owner => owner === node).length)) issues.push({ code: "load", message: "Per-node load must match ownership." });
  return issues;
}

export function loadStandardDeviation(state: HashRingState): number {
  const loads = Object.values(state.load);
  const mean = state.keys.length / loads.length;
  return Math.sqrt(loads.reduce((sum, load) => sum + (load - mean) ** 2, 0) / loads.length);
}

/** Sorted node indices model hash(key) % N, including index shifts on removal. */
export function compareModuloHashing(keys: string[], beforeNodes: string[], afterNodes: string[], seed = 0) {
  if (!beforeNodes.length || !afterNodes.length) throw new Error("Both modulo configurations need a node");
  const ownership = (nodes: string[]) => {
    const sorted = [...new Set(nodes)].sort(compare);
    return Object.fromEntries([...new Set(keys)].map(key => [key, sorted[hash32(`key:${key}`, seed) % sorted.length]]));
  };
  const before = ownership(beforeNodes), after = ownership(afterNodes);
  const movedKeys = Object.keys(before).filter(key => before[key] !== after[key]);
  return { before, after, movedKeys, movedCount: movedKeys.length };
}
