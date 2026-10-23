import type { Design, Scenario } from '../types';
import { ScaleSession, runScale } from './model';
import type { FailureRung, ScaleOptions, ScalePoint, SweepLevel, SweepOptions, SweepResult, WhatIfResult } from './types';

export const SWEEP_LIMITS = { levels: 12, maxMultiple: 1000, levelUs: 1_800_000_000, totalSteps: 5_000_000, wallMs: 120_000 } as const;

export function failureLadder(levels: SweepLevel[]): FailureRung[] {
  const ladder: FailureRung[] = [], seen = new Set<string>();
  const rung = (multiple: number, component: string, what: string, why: string, suggestion: string) => {
    const key = `${component}:${what}`;
    if (!seen.has(key)) { seen.add(key); ladder.push({ multiple, component, what, why, remedy: { suggestion, verified: false } }); }
  };
  for (const { multiple, result } of levels) {
    for (const n of [...result.nodes].sort((a, b) => b.utilisation - a.utilisation || a.nodeId.localeCompare(b.nodeId))) {
      if (n.utilisation >= .95 || (n.capacityPerSec === 0 && n.arrivals > 0)) rung(multiple, n.nodeId, 'capacity saturates', `${(n.utilisation * 100).toFixed(1)}% busy; capacity ${n.capacityPerSec.toFixed(1)}/s under this scenario.`, 'Test additional capacity or reduced downstream holding time.');
      if (n.drops / Math.max(1, n.arrivals) > .001) rung(multiple, n.nodeId, 'queue overflows', `${n.drops.toFixed(1)} attempts exceed the bounded queue or arrive during an outage.`, 'Test admission control or additional capacity.');
    }
    const retry = result.metrics.retryAmplification;
    if (retry !== null && retry > 1.05) rung(multiple, result.bottleneck ?? 'global', 'retry amplification', `Timeout/error feedback raises attempts to ${retry.toFixed(2)} per logical request.`, 'Test a smaller retry budget and longer backoff.');
    const timely = result.metrics.estimatedTimelySuccessRatio;
    if (timely !== null && timely < .99) rung(multiple, 'global', 'timely-success falls', `${(timely * 100).toFixed(1)}% estimated timely-success; correctness remains unknown.`, 'Test the first bottleneck remedy against the same scenario.');
  }
  return ladder;
}

function steadyDetector() {
  let baseline: ScalePoint | undefined, steady = false;
  return {
    step(p: ScalePoint) {
      const balanced = Object.values(p.nodes).every(n => n.arrivalsPerSec === 0 || Math.abs(n.arrivalsPerSec - n.completionsPerSec) / n.arrivalsPerSec < .01);
      const unchanged = baseline && Object.entries(p.nodes).every(([id, n]) => {
        const previous = baseline!.nodes[id];
        return previous && Math.abs(n.utilisation - previous.utilisation) < .01 && Math.abs(n.backlog - previous.backlog) / Math.max(1, previous.backlog) < .01;
      }) && Math.abs((p.estimatedTimelySuccessRatio ?? 0) - (baseline.estimatedTimelySuccessRatio ?? 0)) < .01;
      if (!balanced || !unchanged) { baseline = balanced ? p : undefined; steady = false; }
      else if (p.tUs + p.dtUs - baseline!.tUs >= 30_000_000) steady = true;
    },
    get reached() { return steady; },
  };
}

export function sweep(design: Design, scenario: Scenario, options: SweepOptions = {}): SweepResult {
  const kind = options.kind ?? 'independent', levelsCount = options.levels ?? 8, maximum = options.maxMultiple ?? 1000;
  const warmup = options.warmupUs ?? Math.max(scenario.warmupUs, 30_000_000), duration = options.levelUs ?? 120_000_000;
  const maxTotal = options.maxTotalSteps ?? SWEEP_LIMITS.totalSteps, wallMs = options.maxWallMs ?? SWEEP_LIMITS.wallMs;
  if (!['independent', 'continuous'].includes(kind) || !Number.isInteger(levelsCount) || levelsCount < 1 || levelsCount > 12 || !Number.isFinite(maximum) || maximum < 1 || maximum > 1000) throw new Error('Sweep requires 1–12 log-spaced levels within 1×–1000×.');
  if (![warmup, duration].every(Number.isSafeInteger) || warmup < 0 || duration < 1 || duration + warmup > SWEEP_LIMITS.levelUs) throw new Error('Warm-up plus measurement must fit the 30-minute level cap.');
  if (!Number.isInteger(maxTotal) || maxTotal < 1 || maxTotal > SWEEP_LIMITS.totalSteps || !Number.isFinite(wallMs) || wallMs <= 0 || wallMs > SWEEP_LIMITS.wallMs) throw new Error('Sweep exceeds its 5M-step or 120-second bound.');
  const levels: SweepLevel[] = [], startWall = Date.now();
  const snapshotDesign = structuredClone(design), snapshotScenario = structuredClone(scenario);
  let steps = 0, outcome: SweepResult['outcome'] = 'finished';
  const continuous = kind === 'continuous' ? new ScaleSession(snapshotDesign, snapshotScenario, options) : undefined;
  for (let i = 0; i < levelsCount; i++) {
    if (options.signal?.aborted) { outcome = 'cancelled'; break; }
    if (Date.now() - startWall >= wallMs) { outcome = 'wall-limit'; break; }
    if (steps >= maxTotal) { outcome = 'step-limit'; break; }
    const multiple = levelsCount === 1 ? 1 : maximum ** (i / (levelsCount - 1));
    const detector = steadyDetector();
    const signal = { get aborted() { return Boolean(options.signal?.aborted) || Date.now() - startWall >= wallMs; } };
    const runOptions: ScaleOptions = { ...options, maxSteps: Math.min(options.maxSteps ?? 5_000_000, maxTotal - steps), signal, onStep(p, c) { detector.step(p); options.onStep?.(p, c); } };
    const session = continuous ?? new ScaleSession(snapshotDesign, snapshotScenario, runOptions);
    const result = session.run(runOptions, multiple, kind === 'continuous' && i > 0 ? 0 : warmup, duration, 0);
    steps += result.steps;
    if (result.outcome !== 'finished') {
      outcome = result.outcome === 'step-limit' ? 'step-limit' : options.signal?.aborted ? 'cancelled' : 'wall-limit';
      break;
    }
    const level: SweepLevel = { multiple, state: detector.reached ? 'steady' : 'unstable — no steady state', result };
    levels.push(level); options.onLevel?.(level);
  }
  return { kind, outcome, levels, ladder: failureLadder(levels), steps };
}

function numericDiff(a: object, b: object, path = ''): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const name = path ? `${path}.${key}` : key, x = left[key], y = right[key];
    if (typeof x === 'number' && typeof y === 'number') result[name] = y - x;
    else if (x === null || y === null || x === undefined || y === undefined) result[name] = null;
    else if (typeof x === 'object' && typeof y === 'object') Object.assign(result, numericDiff(x, y, name));
  }
  return result;
}

export function whatIf(designA: Design, designB: Design, scenario: Scenario, options: ScaleOptions = {}): WhatIfResult {
  const a = runScale(designA, scenario, options), b = runScale(designB, scenario, options);
  const ladderA = failureLadder([{ multiple: 1, state: 'unstable — no steady state', result: a }]);
  const ladderB = failureLadder([{ multiple: 1, state: 'unstable — no steady state', result: b }]);
  const improved = a.outcome === 'finished' && b.outcome === 'finished' && a.fidelity.predictions.timelySuccess.enabled && b.fidelity.predictions.timelySuccess.enabled
    && ladderB.length < ladderA.length && (b.metrics.estimatedTimelySuccessRatio ?? 0) >= (a.metrics.estimatedTimelySuccessRatio ?? 0);
  if (improved) for (const rung of ladderA) if (!ladderB.some(b => b.component === rung.component && b.what === rung.what)) rung.remedy.verified = true;
  const nodeDeltas = Object.fromEntries([...new Set([...a.nodes, ...b.nodes].map(n => n.nodeId))].map(id => [id, numericDiff(a.nodes.find(n => n.nodeId === id) ?? {}, b.nodes.find(n => n.nodeId === id) ?? {})]));
  return { a, b, deltas: numericDiff(a.metrics, b.metrics), nodeDeltas, ladder: { a: ladderA, b: ladderB, improved } };
}
