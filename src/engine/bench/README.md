Add this package.json script (E2 does not own package.json):

```json
"bench": "node src/engine/bench/run.mjs"
```

`node src/engine/bench/run.mjs` runs S/M/L with 5/25/100 active nodes,
500/5,000/20,000 rps, and 300 seconds of measured simulation. Direct client/service
pools keep all nodes active while staying within Exact's 50M-event ceiling.
It checks both wall
time and events/s against baseline.json, failing on a regression above 15%.
One untimed warmup precedes measurement. Baselines are machine-specific; avoid
other CPU-intensive work on the reference device. Node 24+ is required by the
runner's native TypeScript config loader.

Regenerate the baseline in PowerShell:

```powershell
$env:UPDATE_BASELINE='1'; node src/engine/bench/run.mjs
Remove-Item Env:UPDATE_BASELINE
```

Golden tests run three fixed RunKeys and compare SHA-256 hashes of the complete
canonical result. If deterministic behavior changes, bump REPLAY_COMPAT_ID first,
then regenerate:

```powershell
$env:UPDATE_GOLDEN='1'; npx.cmd vitest run src/engine/bench/golden.test.ts --configLoader native --pool threads --maxWorkers 1
Remove-Item Env:UPDATE_GOLDEN
```

E1/lead must regenerate goldens after the concurrent Exact-engine implementation
lands, and remeasure the baseline after replacing the temporary inline modules.
The slow benchmark is opt-in; ordinary unit runs test its regression comparator
but skip the full S/M/L timing gate. `run.mjs` enables that gate and propagates its
exit status.
