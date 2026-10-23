import { createHashRingModel, type HashRingAction } from ".";
import { random } from "../random";

export interface HashRingVariant {
  id: string;
  seed: number;
  prompt: string;
  nodes: string[];
  vnodes: number;
  keys: string[];
  action: HashRingAction;
}

export function generateHashRingVariant(seed: number): HashRingVariant {
  const next = random(seed);
  const nodes = Array.from({ length: 3 + Math.floor(next() * 5) }, (_, i) => `node-${i}`);
  const vnodes = [1, 8, 32, 128][Math.floor(next() * 4)];
  const keys = Array.from({ length: 50 + Math.floor(next() * 451) }, (_, i) => `key-${i}`);
  const node = nodes[Math.floor(next() * nodes.length)];
  return { id: `hash-ring:${seed}`, seed, nodes, vnodes, keys, action: { type: "removeNode", node },
    prompt: `With ${nodes.length} nodes, ${vnodes} virtual nodes each and ${keys.length} keys (seed ${seed}), how many keys move when ${node} is removed?` };
}

export function solveHashRingVariant(variant: HashRingVariant): number {
  const model = createHashRingModel(variant);
  return model.step(model.init(variant.seed), variant.action).movedKeys.length;
}
