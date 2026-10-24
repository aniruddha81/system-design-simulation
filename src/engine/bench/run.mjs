import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'run', 'src/engine/bench/benchmark.test.ts', '--configLoader', 'native', '--pool', 'threads', '--maxWorkers', '1'], { cwd: fileURLToPath(new URL('../../..', import.meta.url)), env: { ...process.env, RUN_ENGINE_BENCH: '1' }, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
