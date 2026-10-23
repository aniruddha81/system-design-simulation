# P1 Scale mode

Import from `@/engine/scale` (the Exact engine's root export is unchanged):

```ts
runScale(design, scenario, { maxDtUs: 1_000_000, signal, onStep });
checkFidelity(design, scenario);
sweep(design, scenario, { kind: 'independent', levels: 8, onLevel, signal });
sweep(design, scenario, { kind: 'continuous', levels: 8 });
whatIf(designA, designB, scenario);
```

Times and percentiles are microseconds, rates are requests/second, queues and occupancy are expected counts, and costs are USD. `onStep(point, conservation)` exposes every step before the bounded 600-point result series is downsampled. Abort flags are read synchronously between steps; `onLevel` can cancel a sweep while preserving every completed level. Partial levels are discarded. Runs carry explicit outcomes for cancellation and step limits.

`capabilityMatrix` is typed TypeScript instead of the plan's YAML: there is no YAML runtime dependency. Future features in the plan carry `availableInP1: false`; their planned fidelity does not advertise an implemented P1 route or component. Unknown components/steps fail validation. All prediction consumers must check `result.fidelity`, including endpoint-specific flags. Unsupported cache policies disable hit rate **and** dependent flow/latency predictions; cost remains available. Correctness is always **unknown**. The global SLI is `estimatedTimelySuccessRatio`.

The model accounts for downstream holding time in service/LB capacity, independent fluid link directions through their limiting bandwidth, finite-buffer stationary loss, Erlang-C/Allen–Cunneen waiting, bounded transient queues, and timeout-tail retry feedback. Latency uses Exact's logarithmic bucket grid with bounded, tail-stratified convolution quadrature. Cold cache occupancy comes from delayed successful distinct fills, with explicit pending distinct keys and duplicate-origin load when coalescing is off. Non-refreshing TTL uses the renewal-reward TTL-Che probability. Large Zipf populations use bounded log-rank quadrature.

Validated benchmarks cover 1k–3k rps M/M/1 and a service→DB path across three seeds, 1.5× capacity drops, finite-buffer loss, timeout tails, deterministic capacity brownout backlog/recovery, Zipf cold-start time to 90%, dead-origin cold cache, and a slow single-key origin with coalescing on/off. Three saturation components are compared with Exact at 1.2k/2.4k/4.8k rps. Headline refinement checks use both stable/overloaded queues and a cold cache. Tests retain the plan's ±5 pp / ±25% / ±10% / <2% tolerances.

Sustained resource utilisation above 0.95, CV above 4, and measured outages make latency percentiles unavailable and results low-confidence. Branches, retries, hop latency, and residual coalesced-fill waits assume independence. Live health-probe congestion, correlated retries, and individual transient request histories are not represented exactly; cohort completion through drain is a fluid estimate. P1 replicas affect capacity and cost only. No correctness, replication-lag, autoscaling, or P2-step semantics are claimed.

Sweeps use at most 12 logarithmic levels, 30 minutes including warm-up per level, 5M total steps and 120 seconds. Independent levels reset all state; continuous levels carry caches, queues and limiter state. Steady state requires 30 simulated seconds of <1% utilisation/backlog variation and input/completion balance; saturated or oscillating levels can report `unstable — no steady state`. Failure ladders are scenario-specific, suppress losses below 0.1% to avoid numerical noise, and never verify a remedy without a completed improving what-if run.

Validation in the restricted Windows shell:

```powershell
npx.cmd tsc --noEmit --incremental false
npx.cmd vitest run src/engine/scale --configLoader native --pool threads
npx.cmd eslint src/engine/scale
```

The Vitest flags avoid blocked subprocess spawning by the default config loader and fork pool; they do not change the tests or their assertions.
