# Additive engine contract changes

- `RunSettings.limits?`: lower deterministic event/live-request/heap/queue/memory ceilings for testing and constrained devices. Values cannot exceed the documented hard ceilings.
- `NodeStats.meanQueueWaitUs?`, `inFlight?`, `wastedWork?`: analytical verification and wasted-work visibility.
- Exported `TraceInput` (`endpointId`, `key`), `AdvanceOptions`, and `Simulation` describe the previously documented public methods.

P1 implemented `duplicateEffect`; P2 extends continuous checks to every declared invariant and removes the grading restriction.

## P1 model conventions

- Database `replicas` multiplies processing capacity and hourly cost; replication semantics are P2.
- Idempotent endpoint writes apply once per logical request at each database; non-idempotent retries can produce `duplicateEffect`.
- Cache bytes include the endpoint response size and UTF-16 key storage; payload bytes are never allocated. A restart clears entries and pending fills. Recovery takes one microsecond because this contract has no configurable restart warm-up.
- Leaky bucket uses a continuously draining meter (policing); fixed/sliding windows are one second, capped by `min(ratePerSec, burst)`.
- Series outcomes and cache ratios belong to arrival cohorts. Node utilisation and queue integrals use actual time inside the measurement window. Downsampled histogram buckets are merged before computing percentiles.
- Cost is provisioned components (30-day months). The P1 contract has no egress or per-operation prices.
- Link bottlenecks use `nodeId: "edge:<edgeId>"`; the more saturated direction determines utilisation.
- `priorInputs` for `traceRequest` is an ordered `TraceInput[]`. Traces use independent session state, replay every prior input, and retain up to 10,000 spans/data operations per trace.

## P2 additive contract changes (E1)

- `DataOp.update.value?` supplies the numeric/string/boolean set/increment/append operand. `insert`, `put`, and `conditionalPut` accept optional `values` field maps. `conditionalPut.expectedVersion?` defaults to the route's preceding read version. These match E2's `DataOperation` operands; payload bytes are not allocated.
- `Simulation.liveEdit(nodeId, path, value, acknowledge?)` queues a validated edit; returns a rejection reason synchronously, or acknowledges at the next processed event cursor. `Simulation.replayEdits(log)` installs the acknowledged log before advancing a fresh simulation.
- Worker `start.liveEditLog?` supports replay in a fresh worker after a crash. `editAck` is sent only at application; structural and invalid edits return `editRejected`.
- `NodeStats.dropsOnEdit?` distinguishes newest-first queue drops caused by reducing capacity.
- `ENGINE_VERSION = 2.0.0`, `REPLAY_COMPAT_ID = exact-p2-2026-10-24.2`. Benchmark goldens are regenerated after E1 integration under the user's explicit authorization; the remaining benchmark code belongs to E2.

### P2 model conventions

- Database replicas and KV members are internal store replicas, not extra graph nodes. Killing a database kills its current leader; configured detection/election promotes an available replica. Recovery spends restart warm-up plus sampled replication catch-up time in `restarting`. Unfenced recovered leaders retain overlapping leadership; new writes may reach either leader, even across terms.
- Async ships to followers after lag; semi-sync waits for one follower, sync for every configured follower. Read-from-replicas, lag, or failover without an explicit replication mode defaults to async. The connection pool caps simultaneous database requests and row locks serialize writes to a hot row. Durable follower state can restore a primary that lost its WAL. P1 databases without replication/data retain their original capacity and idempotent-write behavior.
- KV owners come from a vnode ring; reads contact R rotating owners and choose the newest returned version, writes reach W owners before ack. Hinted handoff, replication, and read repair transfer versioned record snapshots so reordered delivery cannot drop increments. Changing members rebuilds ownership and transfers records; tombstones have explicit GC timers.
- Queue acceptance is independent of consumer completion. A partition's oldest unacked message blocks later messages; visibility expiry can overlap deliveries. The configured worker nodes share the consumer group and select the oldest eligible partition head. Background cache work during drain belongs to its original publisher cohort. Successful late deliveries are still checked for duplicate effects and ordering. Max-delivery exhaustion counts a DLQ message; retention expires persisted messages.
- CDN caches are partitioned by calling region; origin shield coalesces misses across regions. Failed origin requests may use a retained expired entry as fallback. TTL changes affect future entries. DNS caches its chosen failover record until TTL expiry.
- Clock skew changes local TTL clocks. Cross-region latency and directional egress charges use the region matrix; link latency adds, independent loss probabilities compose, partitions affect only their listed direction. Down overrides degraded/gray.
- Variable-rate arrivals integrate rate across 10ms boundaries (including intervals with zero traffic), preserving the remaining arrival budget. Ramp duration is warm-up plus measurement; sessions rotate deterministically and consistent-hash balancing uses the session when present. Read-your-writes snapshots session state at request start; monotonic reads compare observed response versions.
- Live edits use node parameter paths (`concurrency` or `params.concurrency`), route timeout/retry paths (`handlers.<endpoint>.<step>.timeoutUs`), `@workload` arrival/mix paths, and `@chaos` event-id paths with a whole future event as value. They do not consume event sequence numbers, so recorded boundary cursors replay exactly. Simultaneous chaos runs before edits; edits precede completions and timeouts.
- Cost includes provisioned compute, measured per-request/egress costs extrapolated over a 30-day month, and object-store bytes. Dataset records, mutation logs, and replica copies count toward deterministic memory limits.
