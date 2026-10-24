import { causalRelation, createClocksModel, type ClocksAction, type CausalRelation } from ".";
import { random } from "../random";

export interface ClocksVariant { id: string; seed: number; prompt: string; actions: ClocksAction[]; pair: [string, string] }
export function generateClocksVariant(seed: number): ClocksVariant {
  const next = random(seed), causal = next() < 0.5;
  const actions: ClocksAction[] = [{ type: "send", from: "A", to: "B" }, { type: "advance", ms: 1 + Math.floor(next() * 20) }, causal ? { type: "receive", message: "m1" } : { type: "local", node: "B" }];
  const pair: [string, string] = next() < 0.5 ? ["e1", "e2"] : ["e2", "e1"];
  return { id: `clocks:${seed}`, seed, prompt: `Using the diagram's causal edges, how is ${pair[0]} related to ${pair[1]}?`, actions, pair };
}
export function solveClocksVariant(v: ClocksVariant): CausalRelation {
  const model = createClocksModel(); return causalRelation(v.actions.reduce(model.step, model.init(v.seed)), ...v.pair);
}
