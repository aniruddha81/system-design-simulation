import type { Design, Percentiles, Scenario } from '../types';

export type Support = 'supported' | 'approximate' | 'unsupported';
export type Prediction = 'utilisation' | 'backlog' | 'drops' | 'latency' | 'hitRate' | 'timelySuccess' | 'cost' | 'correctness';
export type PredictionState = { enabled: true } | { enabled: false; reasons: string[] };
export type FidelityReport = {
  predictions: Record<Prediction, PredictionState>;
  paths: { endpointId: string; predictions: Record<Prediction, PredictionState> }[];
  correctness: 'unknown';
};
export type Conservation = {
  nodeId: string; tUs: number; dtUs: number; backlogStart: number; arrivals: number;
  completions: number; drops: number; backlogEnd: number;
};
export type ScaleNode = {
  nodeId: string; utilisation: number; backlog: number; avgQueue: number; maxQueue: number;
  arrivals: number; completions: number; drops: number; errors: number;
  capacityPerSec: number; latency: Percentiles; unavailableReason?: string;
  cache?: { occupancy: number; hitRate: number | null; steadyHitRate: number; timeTo90Us: number | null; originPerSec: number };
};
export type ScalePoint = {
  tUs: number; dtUs: number; offeredPerSec: number; succeededPerSec: number;
  estimatedTimelySuccessRatio: number | null; retryAmplification: number | null;
  nodes: Record<string, { utilisation: number; backlog: number; arrivalsPerSec: number; completionsPerSec: number; dropsPerSec: number; cacheHitRate?: number; occupancy?: number }>;
};
export type ScaleMetrics = {
  offered: number; admitted: number; succeeded: number; failed: number; unfinished: number; attempts: number;
  estimatedTimelySuccessRatio: number | null; availability: number | null; retryAmplification: number | null;
  timeoutTailFraction: number | null; successLatency: Percentiles; allLatency: Percentiles;
  throughput: { offeredPerSec: number; admittedPerSec: number; completedPerSec: number };
  costPerMonth: number; costPerMillionRequests: number | null;
};
export type ScaleResult = {
  mode: 'scale'; correctness: 'unknown'; confidence: 'validated-envelope' | 'low-confidence';
  assumptions: string[]; warnings: string[]; fidelity: FidelityReport;
  outcome: 'finished' | 'cancelled' | 'step-limit'; metrics: ScaleMetrics; nodes: ScaleNode[];
  series: ScalePoint[]; steps: number; simEndUs: number; bottleneck: string | null;
};
export type AbortFlag = { readonly aborted: boolean };
export type ScaleOptions = {
  maxDtUs?: number; minDtUs?: number; maxSteps?: number; signal?: AbortFlag;
  onStep?: (step: ScalePoint, conservation: Conservation[]) => void;
};
export type SweepKind = 'independent' | 'continuous';
export type SweepOptions = ScaleOptions & {
  kind?: SweepKind; levels?: number; maxMultiple?: number; warmupUs?: number; levelUs?: number;
  maxTotalSteps?: number; maxWallMs?: number; onLevel?: (level: SweepLevel) => void;
};
export type SweepLevel = { multiple: number; state: 'steady' | 'unstable — no steady state'; result: ScaleResult };
export type FailureRung = {
  multiple: number; component: string; what: string; why: string;
  remedy: { suggestion: string; verified: boolean };
};
export type SweepResult = { kind: SweepKind; outcome: 'finished' | 'cancelled' | 'step-limit' | 'wall-limit'; levels: SweepLevel[]; ladder: FailureRung[]; steps: number };
export type WhatIfResult = {
  a: ScaleResult; b: ScaleResult;
  deltas: Record<string, number | null>;
  nodeDeltas: Record<string, Record<string, number | null>>;
  ladder: { a: FailureRung[]; b: FailureRung[]; improved: boolean };
};
export type ScaleInput = { design: Design; scenario: Scenario };
