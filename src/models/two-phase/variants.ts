import { createTwoPhaseModel, type SagaStep, type TwoPhaseAction, type TransactionMode } from ".";
import { random } from "../random";

export interface TwoPhaseVariant { id: string; seed: number; prompt: string; mode: TransactionMode; steps: SagaStep[]; actions: TwoPhaseAction[] }
export function generateTwoPhaseVariant(seed: number): TwoPhaseVariant {
  const next = random(seed), mode = (["twoPhase", "saga", "outbox"] as const)[Math.floor(next() * 3)];
  const steps = Array.from({ length: 3 + Math.floor(next() * 3) }, (_, i) => ({ id: `step-${i}`, compensatable: next() > 0.2 }));
  const model = createTwoPhaseModel({ mode, steps });
  const script = model.scenarios[Math.floor(next() * model.scenarios.length)];
  return { id: `two-phase:${seed}`, seed, mode, steps, actions: structuredClone(script.actions), prompt: "Replay the supplied transaction schedule. Which invariant or limitation codes are present at the final state?" };
}
export function solveTwoPhaseVariant(v: TwoPhaseVariant): string[] {
  const model = createTwoPhaseModel(v); return model.invariants(v.actions.reduce(model.step, model.init(v.seed))).map(i => i.code).sort();
}
