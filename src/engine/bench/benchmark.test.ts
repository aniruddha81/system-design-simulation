import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { REPLAY_COMPAT_ID, runToCompletion } from '@/engine';
import { benchmarkFixture, benchmarkSizes, type BenchmarkSize } from './fixtures';

export function performanceRegression(current: { wallMs: number; eventsPerSec: number }, baseline: { wallMs: number; eventsPerSec: number }): boolean {
  return current.wallMs / baseline.wallMs > 1.15 || current.eventsPerSec / baseline.eventsPerSec < .85;
}

it('detects both wall-time and throughput regressions', () => {
  const baseline = { wallMs: 100, eventsPerSec: 100 };
  expect(performanceRegression({ wallMs: 115, eventsPerSec: 85 }, baseline)).toBe(false);
  expect(performanceRegression({ wallMs: 116, eventsPerSec: 100 }, baseline)).toBe(true);
  expect(performanceRegression({ wallMs: 100, eventsPerSec: 84 }, baseline)).toBe(true);
});

it.runIf(process.env.RUN_ENGINE_BENCH === '1')('runs the 300-second S/M/L regression gate', () => {
  const path = fileURLToPath(new URL('./baseline.json', import.meta.url));
  type Sample = { wallMs: number; eventsPerSec: number; events: number };
  type Baseline = { replayCompatId: string; machine: string; samples: Record<BenchmarkSize, Sample> };
  const update = process.env.UPDATE_BASELINE === '1';
  const baseline: Baseline | undefined = update ? undefined : JSON.parse(readFileSync(path, 'utf8'));
  const samples = {} as Record<BenchmarkSize, Sample>;
  // Warm the same code paths before timing; no wall-clock values enter the engine.
  const warm = benchmarkFixture('S');
  runToCompletion(warm.design, { ...warm.scenario, measureUs: 1_000_000 }, 42, { traceSampleRate: 0 });
  for (const size of Object.keys(benchmarkSizes) as BenchmarkSize[]) {
    const { design, scenario } = benchmarkFixture(size);
    const start = performance.now();
    const result = runToCompletion(design, scenario, 42, { traceSampleRate: 0 });
    const wallMs = performance.now() - start;
    expect(result.outcome, result.inconclusiveReason).toBe('finished');
    samples[size] = { wallMs, eventsPerSec: result.eventsProcessed / (wallMs / 1000), events: result.eventsProcessed };
    console.log(`${size}: ${wallMs.toFixed(1)} ms; ${samples[size].eventsPerSec.toFixed(0)} events/s; ${result.eventsProcessed} events`);
    if (baseline) expect(performanceRegression(samples[size], baseline.samples[size]), `${size}: >15% regression vs machine-specific baseline; rerun on the reference device before updating`).toBe(false);
  }
  if (update) writeFileSync(path, JSON.stringify({ replayCompatId: REPLAY_COMPAT_ID, machine: `${platform()} ${arch()}; ${cpus()[0]?.model}; Node ${process.version}; machine-specific`, samples }, null, 2) + '\n');
}, 1_800_000);
