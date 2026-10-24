import { createGossipModel, type GossipAction, type GossipMode } from ".";
import { random } from "../random";

export interface GossipVariant { id: string; seed: number; prompt: string; nodes: number; fanout: number; mode: GossipMode; actions: GossipAction[] }
export function generateGossipVariant(seed: number): GossipVariant {
  const next = random(seed), nodes = 8 + Math.floor(next() * 25), fanout = 1 + Math.floor(next() * 3), mode = (["push", "pull", "pushPull"] as const)[Math.floor(next() * 3)];
  const actions: GossipAction[] = Array.from({ length: 1 + Math.floor(next() * 6) }, () => ({ type: "round" }));
  return { id: `gossip:${seed}`, seed, nodes, fanout, mode, actions, prompt: `With ${nodes} nodes, ${mode}, fanout ${fanout} and seed ${seed}, how many nodes know the rumor after ${actions.length} rounds?` };
}
export function solveGossipVariant(v: GossipVariant): number { const model = createGossipModel(v); return v.actions.reduce(model.step, model.init(v.seed)).curve.at(-1)!; }
