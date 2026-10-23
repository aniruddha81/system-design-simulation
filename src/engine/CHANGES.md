# Additive engine contract changes

- `RunSettings.limits?`: lower deterministic event/live-request/heap/queue/memory ceilings for testing and constrained devices. Values cannot exceed the documented hard ceilings.
- `NodeStats.meanQueueWaitUs?`, `inFlight?`, `wastedWork?`: analytical verification and wasted-work visibility.
- Exported `TraceInput` (`endpointId`, `key`), `AdvanceOptions`, and `Simulation` describe the previously documented public methods.

P1 implements `duplicateEffect`. Other invariant kinds remain typed; their storage/replication/transaction semantics are deferred (TODO in grading). The grader refuses to certify unsupported invariants.

## P1 model conventions

- Database `replicas` multiplies processing capacity and hourly cost; replication semantics are P2.
- Idempotent endpoint writes apply once per logical request at each database; non-idempotent retries can produce `duplicateEffect`.
- Cache bytes include the endpoint response size and UTF-16 key storage; payload bytes are never allocated. A restart clears entries and pending fills. Recovery takes one microsecond because this contract has no configurable restart warm-up.
- Leaky bucket uses a continuously draining meter (policing); fixed/sliding windows are one second, capped by `min(ratePerSec, burst)`.
- Series outcomes and cache ratios belong to arrival cohorts. Node utilisation and queue integrals use actual time inside the measurement window. Downsampled histogram buckets are merged before computing percentiles.
- Cost is provisioned components (30-day months). The P1 contract has no egress or per-operation prices.
- Link bottlenecks use `nodeId: "edge:<edgeId>"`; the more saturated direction determines utilisation.
- `priorInputs` for `traceRequest` is an ordered `TraceInput[]`. Traces use independent session state, replay every prior input, and retain up to 10,000 spans/data operations per trace. Unknown P2 invariants produce an inconclusive grade instead of a false pass.
