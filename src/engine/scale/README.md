# Scale mode (P1 + P2)

Import from `@/engine/scale` (the Exact engine's root export is unchanged):

```ts
runScale(design, scenario, { maxDtUs: 1_000_000, signal, onStep });
checkFidelity(design, scenario);
sweep(design, scenario, { kind: 'independent', levels: 8, onLevel, signal });
sweep(design, scenario, { kind: 'continuous', levels: 8 });
whatIf(designA, designB, scenario);
```

Times and percentiles are microseconds, rates are requests/second, queues and occupancy are expected counts, and costs are USD. `onStep(point, conservation)` exposes every step before the bounded 600-point result series is downsampled. Abort flags are read synchronously between steps; `onLevel` can cancel a sweep while preserving every completed level. Partial levels are discarded. Runs carry explicit outcomes for cancellation and step limits.

`capabilityMatrix` in `fidelity.ts` is the executable matrix (typed TypeScript instead of the plan's YAML). `featureCoverage` exhaustively maps every component, step, condition, chaos kind, arrival kind, data operation and invariant to an entry. A test reads those unions from the shared TypeScript contract and compares every member, so additions cannot silently lack fidelity coverage. The matrix stays within E3's owned directory; the lead can synchronize `content/fidelity.yaml` separately.

All prediction consumers must check `result.fidelity`, including endpoint-specific flags. Enabled and disabled predictions carry reasons. Unsupported semantics disable their affected predictions, independently of confidence. Cached values and dependent flow statistics must not be displayed when their flags are disabled. Correctness is always **unknown**, and the global SLI is `estimatedTimelySuccessRatio`.

| P2 feature | Scale support |
|---|---|
| Autoscaler | Supported: evaluation/cooldown boundaries, independent target capacity steps after provisioning + warmup |
| Partition, zone/region outage, link loss/latency, traffic spike | Supported capacity, health, directional delivery and offered-rate multipliers |
| Clock skew | Correctness unsupported; performance unaffected |
| Parallel all/any/quorum/firstN | Approximate independent success CDF order statistics; all branch work retained even with cancellation |
| Queue, publish, workers | Approximate bounded fluid messages and consumer capacity; delivery correctness unknown |
| Async/sync/semi-sync replication | Approximate write/apply backlog plus shipping delay; synchronous acknowledgement adds replication delay |
| DNS | Approximate resolution latency and first healthy record; TTL convergence approximate |
| CDN | Approximate Che cache independently per requesting region; fixed bytes and stationary Zipf required |
| API gateway, rate limiter, circuit breaker | Approximate pass-through admission/bulkhead capacity; breaker uses failure-rate threshold with timed reopening |
| kvStore, objectStore, searchIndex | Approximate service cost; quorum staleness, versions and search freshness unknown |
| Data get/put/delete and indexed/unindexed query | Approximate service cost; query uses the shared entity-count cost model |
| Read-only found branch | Approximate independent entity-population coverage; mutation-dependent found branches disabled |
| Dedup, updates/row contention, conditional writes, insert conflicts | Affected flow, latency and timely-success predictions disabled; no race or 409 prediction |
| Region matrix and contended links | Approximate directional propagation, bandwidth queues and cross-region byte costs |
| LFU, variable objects, invalidation/popularity changes | Affected cache/flow predictions disabled; variable bytes also disable cost |
| Split brain, fencing, isolation, every correctness invariant | Unsupported; correctness always disabled |

`ScaleNode.queue` reports message depth, peak depth, consumer rate and peak consumer age in microseconds. `ScaleNode.replication` reports unapplied writes and lag (current/mean/max microseconds). Series include concurrency, consumer backlog and replication lag. `onStep` conservation includes `messages:<queueId>` separately from publish-ack resources. Region egress, CDN egress and object-store storage/request costs contribute to monthly cost.

The model accounts for downstream holding time in service/LB capacity, independent fluid link directions through their limiting bandwidth, finite-buffer stationary loss, Erlang-C/Allen–Cunneen waiting, bounded transient queues, and timeout-tail retry feedback. Latency uses Exact's logarithmic bucket grid with bounded, tail-stratified convolution quadrature. Cold cache occupancy comes from delayed successful distinct fills, with explicit pending distinct keys and duplicate-origin load when coalescing is off. Non-refreshing TTL uses the renewal-reward TTL-Che probability. Large Zipf populations use bounded log-rank quadrature.

Validated benchmarks cover 1k–3k rps M/M/1 and a service→DB path across three seeds, 1.5× capacity drops, finite-buffer loss, timeout tails, deterministic capacity brownout backlog/recovery, Zipf cold-start time to 90%, dead-origin cold cache, and a slow single-key origin with coalescing on/off. Three saturation components are compared with Exact at 1.2k/2.4k/4.8k rps. P2 cross-validations run autoscaling step load (settled utilisation ±5 pp, transient backlog peak ±25%), queue/worker consumer age (±25%, worker utilisation ±5 pp), and async replication mean lag (±25%) across three seeds. Autoscaling utilisation is compared after scaling settles because Exact's aggregate uses final capacity as its denominator. None of these tests is a todo. Headline refinement checks use both stable/overloaded queues and a cold cache. Tests retain the plan's tolerances.

Sustained resource utilisation above 0.95, CV above 4, and measured outages make latency percentiles unavailable and results low-confidence. Branches, retries, hop latency, and residual coalesced-fill waits assume independence. Live health-probe congestion, correlated retries, consumer redelivery/DLQ histories, and individual transient request histories are not represented exactly; cohort completion through drain is a fluid estimate. Consumer age is the stationary fluid backlog divided by the larger of publish/consume rates, not a per-message FIFO history. Replication applies at configured worker/write-time capacity without individual replica scheduling. Designs without explicit replication retain P1's replica capacity multiplier. No correctness predictions are claimed.

Sweeps use at most 12 logarithmic levels, 30 minutes including warm-up per level, 5M total steps and 120 seconds. Independent levels reset all state; continuous levels carry caches, queues and limiter state. Steady state requires 30 simulated seconds of <1% utilisation/backlog variation and input/completion balance; saturated or oscillating levels can report `unstable — no steady state`. Failure ladders are scenario-specific, suppress losses below 0.1% to avoid numerical noise, and never verify a remedy without a completed improving what-if run.

Validation in the restricted Windows shell:

```powershell
npx.cmd tsc --noEmit --incremental false
npx.cmd vitest run src/engine/scale --configLoader native --pool threads
npx.cmd eslint src/engine/scale
```

The Vitest flags avoid blocked subprocess spawning by the default config loader and fork pool; they do not change the tests or their assertions.
