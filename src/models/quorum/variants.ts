import { createQuorumModel, type QuorumAction, type QuorumOptions } from ".";
import { random } from "../random";

export interface QuorumVariant extends QuorumOptions { id: string; seed: number; prompt: string; actions: QuorumAction[] }
export function generateQuorumVariant(seed: number): QuorumVariant {
  const next = random(seed), n = 3 + Math.floor(next() * 4), r = 1 + Math.floor(next() * n), w = 1 + Math.floor(next() * n), sloppy = next() < 0.3;
  const model = createQuorumModel({ n, r, w, sloppy });
  const script = model.scenarios[sloppy ? 3 : 0];
  return { id: `quorum:${seed}`, seed, prompt: `N=${n}, R=${r}, W=${w}, sloppy=${sloppy}. Does any read in this schedule miss the latest acknowledged write?`, n, r, w, sloppy, actions: structuredClone(script.actions) };
}
export function solveQuorumVariant(v: QuorumVariant): boolean { const model = createQuorumModel(v); return v.actions.reduce(model.step, model.init(v.seed)).reads.some(r => r.stale); }
