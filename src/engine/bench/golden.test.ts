import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { REPLAY_COMPAT_ID, runToCompletion } from '@/engine';
import { canonical } from '../core';
import { benchmarkFixture } from './fixtures';

it('keeps fixed RunKey results stable within a replay compatibility version', () => {
  const path = fileURLToPath(new URL('./golden.json', import.meta.url));
  const runs = [11, 42, 99].map(seed => {
    const { design, scenario } = benchmarkFixture('S');
    const result = runToCompletion(design, { ...scenario, measureUs: 2_000_000, workload: { ...scenario.workload, arrival: { kind: 'poisson', rps: 500 } } }, seed, { traceSampleRate: 0 });
    expect(result.outcome).toBe('finished');
    return { runKey: result.runKey, hash: createHash('sha256').update(canonical(result)).digest('hex') };
  });
  const current = { replayCompatId: REPLAY_COMPAT_ID, runs };
  if (process.env.UPDATE_GOLDEN === '1') {
    writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
  }
  expect(current, 'Deterministic output changed. Bump REPLAY_COMPAT_ID and regenerate with UPDATE_GOLDEN=1 npx vitest run src/engine/bench/golden.test.ts').toEqual(JSON.parse(readFileSync(path, 'utf8')));
});
