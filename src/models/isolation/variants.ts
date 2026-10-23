import { random } from "../random";
import { runIsolationScenario } from ".";
import { isolationLevels, isolationScenarios } from "./scenarios";
import type { Anomaly, IsolationLevel, IsolationScenario } from "./types";

export interface IsolationVariant {
  id: string;
  seed: number;
  prompt: string;
  level: IsolationLevel;
  scenario: IsolationScenario;
}

export function generateIsolationVariant(seed: number): IsolationVariant {
  const next = random(seed);
  const scenario = structuredClone(isolationScenarios[Math.floor(next() * isolationScenarios.length)]);
  const level = isolationLevels[Math.floor(next() * isolationLevels.length)];
  const offset = Math.floor(next() * 100);
  scenario.initial = Object.fromEntries(Object.entries(scenario.initial).map(([key, value]) => [key, value + offset]));
  for (const tx of scenario.transactions) for (const op of tx.ops) if (op.type === "write" && typeof op.value === "number") op.value += offset;
  return { id: `isolation:${seed}`, seed, level, scenario,
    prompt: `Which anomalies, if any, are observed in this ${level} schedule? Blocked operations resume after lock release; aborted transactions are not retried.` };
}

export function solveIsolationVariant(variant: IsolationVariant): Anomaly[] {
  const state = runIsolationScenario(variant.level, variant.scenario, variant.seed);
  return [...new Set(state.anomalies.map(item => item.code as Anomaly))].sort();
}
