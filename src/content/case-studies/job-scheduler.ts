import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, client, data, dedup, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// Durable job definitions and per-execution state machine (SCHEDULED -> RUNNING -> SUCCEEDED / FAILED / DEAD_LETTER).
const jobs = entity("jobs", "jobdb", { jobId: ["string", 16], tenantId: ["int", 8], scheduleCron: ["string", 24], nextRunAt: ["timestamp", 8], status: ["string", 12] }, 10_000, {
  indexes: [{ name: "byNextRun", fields: ["nextRunAt"], unique: false }],
  shardKey: "jobId",
});
const executions = entity("executions", "jobdb", { executionId: ["string", 20], jobId: ["string", 16], leaseEpoch: ["int", 4], status: ["string", 12], output: ["string", 64] }, 10_000);

const apiHandlers = {
  // Submit a one-off or recurring job: persist durably and enqueue due work into the partitioned ready queue.
  submit: [
    dedup("dedup"),
    {
      type: "branch" as const,
      cond: { kind: "dedupHit" as const },
      then: [respond(200)],
      else: [
        data("jobdb", "jobs", { kind: "put" }, 80),
        publish("readyqueue", false),
        respond(201),
      ],
    },
  ],
  status: cacheAside("statuscache", [data("jobdb", "executions", { kind: "get" }, 60)]),
};

const runnerHandlers = {
  // Worker claims a lease with a fencing token (deduped by executionId) and records completion atomically.
  submit: [
    dedup("execdedup"),
    {
      type: "branch" as const,
      cond: { kind: "dedupHit" as const },
      then: [respond(200)],
      else: [
        data("jobdb", "executions", { kind: "put" }, 80),
        respond(200),
      ],
    },
  ],
};

const design = {
  schemaVersion: 1 as const,
  id: "job-scheduler",
  name: "Distributed job scheduler",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "Scheduler API 1", [2, 0], apiHandlers, 128, 0.5),
    service("api2", "Scheduler API 2", [2, 2], apiHandlers, 128, 0.5),
    node("dedup", "dedupStore", "Submission idempotency", [3, 0], { ...pool(256, 0.2), serviceTime: lognormal(0.3), ttlUs: 86_400_000_000, atomic: true, durable: true }),
    cache("statuscache", "Execution status cache", [3, 1], 8_000_000, 5000),
    node("jobdb", "database", "Jobs & executions DB", [3, 2], {
      ...pool(48, 0.9, 1000),
      readTime: lognormal(1.5),
      writeTime: lognormal(2.5),
      replicas: 3,
      replication: "semiSync",
      replicationLag: lognormal(1),
      walDurable: true,
      failover: { heartbeatUs: 100_000, missedHeartbeats: 3, electionUs: 200_000, fencing: true },
    }),
    node("readyqueue", "queue", "Ready execution queue", [3, 3], {
      partitions: 16,
      capacityMessages: 25_000,
      visibilityTimeoutUs: 400_000,
      maxDeliveries: 5,
      retentionUs: 86_400_000_000,
      publishTime: lognormal(0.6),
      costPerHour: 0.2,
      region: "us-east",
      zone: "a",
    }),
    node("runners", "worker", "Job worker fleet", [4, 3], { ...pool(32, 0.6), serviceTime: lognormal(6), source: "readyqueue", batchSize: 8 }, runnerHandlers),
    node("execdedup", "dedupStore", "Execution lease & fencing store", [5, 3], { ...pool(256, 0.2), serviceTime: lognormal(0.3), ttlUs: 86_400_000_000, atomic: true, durable: true }),
  ],
  edges: [
    link("client", "lb"),
    link("lb", "api1"),
    link("lb", "api2"),
    ...["api1", "api2"].flatMap((a) => [link(a, "dedup"), link(a, "statuscache"), link(a, "jobdb"), link(a, "readyqueue")]),
    link("runners", "execdedup"),
    link("runners", "jobdb"),
  ],
  endpoints: [
    { id: "submit", name: "POST /v1/jobs", op: "write" as const, keyTemplate: "job:{id}", requestBytes: 500, responseBytes: 180, idempotent: false },
    { id: "status", name: "GET /v1/jobs/:id/executions", op: "read" as const, keyTemplate: "exec:{id}", requestBytes: 150, responseBytes: 600, idempotent: true },
  ],
  entities: [jobs, executions],
};

const baseline = scenario("scheduler-day", {
  arrival: { kind: "poisson", rps: 2000 },
  mix: { submit: 0.4, status: 0.6 },
  keys: { kind: "zipf", n: 10_000, s: 0.9 },
  deadlineMs: 500,
});
const runnerCrash = variant(baseline, "scheduler-runner-crash", [{ id: "runners-down", kind: "kill", target: "runners", ...window(1300, 1800) }]);

export const jobScheduler: CaseStudy = {
  id: "job-scheduler",
  title: "Distributed job scheduler",
  summary: "Schedule one-off delayed tasks and recurring cron jobs across a fleet of workers with at-least-once execution, lease heartbeats, fencing tokens so zombie workers cannot corrupt downstream state, and isolation when every tenant schedules a job for 00:00 UTC.",
  requirements: {
    functional: [
      "Register one-time delayed jobs (`runAt`) and recurring cron jobs (`0 * * * *`), with payload, retry policy, and timeout.",
      "Dispatch due jobs to worker nodes within ~1 second of their scheduled time, track execution status, and retry failed runs with exponential backoff up to `maxAttempts` before moving to a dead-letter queue.",
      "Allow tenants to cancel a scheduled job or inspect execution history.",
    ],
    nonFunctional: [
      "No lost jobs once acknowledged: every due job executes at least once even if schedulers or workers crash.",
      "Prevent duplicate side effects on worker lease expiry via fencing tokens (`leaseEpoch`) and execution idempotency keys.",
      "Absorb the top-of-the-hour ('00:00 UTC') thundering herd without starving real-time high-priority jobs.",
    ],
  },
  estimates: [
    { label: "Registered jobs", formula: "50M active cron & delayed definitions × ~500 B", result: "≈ 25 GB of job metadata — easily indexed by `(shardId, nextRunAt)`" },
    { label: "Executions", formula: "500M executions/day ÷ 86,400", result: "≈ 5,800 executions/s average" },
    { label: "Top-of-hour spike", formula: "20% of daily cron jobs fire at 00:00 UTC (or on the hour)", result: "≈ 50k–100k jobs due in the same second (~15× average) — requires pre-bucketing and jitter" },
    { label: "Worker fleet", formula: "5,800 jobs/s × 500 ms mean execution duration", result: "≈ 2,900 concurrent worker slots on average (Little's law: L = λW)" },
    { label: "Heartbeat traffic", formula: "3,000 running jobs ÷ 10 s heartbeat interval", result: "≈ 300 lease extensions/s — negligible" },
  ],
  api: [
    { signature: "POST /v1/jobs", request: "{ schedule, payload, retryPolicy, timeoutSec } + Idempotency-Key", response: "201 { jobId, nextRunAt }", endpointId: "submit" },
    { signature: "GET /v1/jobs/{jobId}/executions", request: "—", response: "200 { executions[{ executionId, status, leaseEpoch, startedAt, finishedAt }] }", endpointId: "status" },
    { signature: "POST /v1/executions/{executionId}/heartbeat", request: "{ workerId, leaseEpoch }", response: "200 { extendUntil } · 409 lease lost / cancelled", notes: "Worker aborts immediately if it receives 409." },
  ],
  dataModel: {
    entities: [jobs, executions],
    notes: [
      "jobs stores the definition and `nextRunAt`, partitioned across `N` virtual buckets (e.g., 64 shards) with a composite index `(bucketId, status, nextRunAt)` so each scheduler partition scans only its own due slice.",
      "executions records each deterministic run `(jobId, scheduledTime)` with a monotonically increasing `leaseEpoch` (fencing token) incremented every time a worker claims or steals the lease.",
      "When a recurring job is claimed at `t`, the scheduler atomically inserts the execution for `t` and advances `jobs.nextRunAt` to the next cron tick.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "No execution idempotency or fencing token on worker retry",
      tradeoffs: "When a worker crashes or pauses longer than the visibility timeout, the queue redelivers the execution to a second worker. If the execution handler applies side effects (such as appending to an execution ledger or charging an account) without deduplicating by `(executionId, leaseEpoch)`, redeliveries cause duplicate side effects. Run the runner-crash scenario against this alternative to see `duplicateEffect` violations.",
      design: alter(design, "scheduler-no-fencing", "Job scheduler without execution idempotency", (d) => {
        find<"worker">(d, "runners").handlers = {
          submit: [
            data("jobdb", "executions", { kind: "update", field: "output", op: "append", value: "ran" }, 80),
            respond(200),
          ],
        };
      }),
      check: { scenario: "runner-crash", violations: ["duplicateEffect"] },
    },
    {
      title: "Unindexed table polling (`SELECT * FROM jobs WHERE next_run_at <= NOW()`)",
      tradeoffs: "Having workers poll a single unsharded SQL table without a partitioning scheme or ready queue causes lock contention (`FOR UPDATE SKIP LOCKED` helps up to a few thousand rows/s) or full-table scans. In the simulator, replacing the cached status and indexed lookup with unindexed table queries pushes p99 latency above 14 ms.",
      design: alter(design, "scheduler-table-scan", "Scheduler polling unindexed jobs table", (d) => {
        for (const id of ["api1", "api2"]) {
          find<"service">(d, id).handlers!.status = [data("jobdb", "jobs", { kind: "query", limit: 50 }, 100), respond(200)];
        }
      }),
      check: { scenario: "baseline", minP99Ms: 14 },
    },
    {
      title: "In-memory hierarchical timing wheel vs database range scan",
      tradeoffs: "A hashed timing wheel (Netty / Kafka style) gives O(1) timer insertion and tick advancement in RAM, ideal for sub-second delays at 100k+ timers/s, but loses state on crash unless backed by a write-ahead log. A hybrid loads the next 60 seconds of due jobs from the sharded DB into an in-memory timing wheel.",
    },
  ],
  failureScenarios: [
    {
      id: "runner-crash",
      title: "Worker fleet crashes mid-execution",
      explanation: "From t = 1.3 s to 1.8 s the worker fleet dies while holding in-flight executions. Unacknowledged jobs exceed the 400 ms visibility timeout and are redelivered.",
      scenario: runnerCrash,
      expect: "Job submissions and status queries remain 100% available. When workers recover, redelivered executions are deduplicated via `executionId` and fencing state, completing cleanly without duplicate effects.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "midnight-cron-spike",
      title: "00:00 UTC cron spike: traffic triples",
      explanation: "At the top of the hour (t = 1.2 s to 2.0 s), scheduled job volume triples.",
      scenario: variant(baseline, "scheduler-midnight-spike", [{ id: "midnight", kind: "trafficSpike", target: "", multiplier: 3, ...window(1200, 2000) }]),
      expect: "The ready queue absorbs the burst and feeds the worker fleet at its max concurrency without dropping submissions.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "db-leader-failover",
      title: "The jobs database leader fails over",
      explanation: "At t = 1.5 s the primary jobs database crashes; replica promotion completes in ~0.5 s.",
      scenario: variant(baseline, "scheduler-db-failover", [{ id: "db-kill", kind: "kill", target: "jobdb", ...window(1500, 2050) }]),
      expect: "Cached status reads keep succeeding during the election window; semi-sync replication and leader fencing ensure no committed job schedule is lost or split-brained.",
      check: { minGoodput: 0.75, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Two-tier architecture: durable time-bucket store + ready queue",
      body: "Message brokers (Kafka, SQS) are great at dispatching ready work, but most do not natively sort millions of arbitrary future timestamps days in advance. Store future jobs in a sharded database indexed by `(bucketId, status, nextRunAt)`. Each scheduler node owns a subset of `bucketId`s (assigned via consensus/leases), queries `nextRunAt <= now + 5s`, atomically transitions those rows to `ENQUEUED` (incrementing `leaseEpoch`), and publishes them to the ready queue where workers pull them immediately.",
    },
    {
      title: "Leases, heartbeats, and fencing tokens against zombie workers",
      body: "At-least-once delivery is mandatory because a worker can die mid-job. When a worker claims an execution, it receives a lease (visibility timeout, e.g., 60 s) and a monotonically increasing integer `leaseEpoch = 1` (the fencing token). Long jobs heartbeat every 15 s to extend the lease. If Worker A pauses in a long GC or network partition, its lease expires and Worker B claims the execution with `leaseEpoch = 2`. When Worker A wakes up and tries to write its result or call a downstream storage service, the store rejects `leaseEpoch = 1 < 2`, preventing the zombie worker from overwriting Worker B's state.",
    },
    {
      title: "Taming the 00:00 UTC thundering herd and noisy tenants",
      body: "Human-written crons overwhelmingly specify `0 * * * *` or `0 0 * * *`. Mitigate this in three ways: (1) support fuzzy cron expressions (`H * * * *` in Jenkins) that hash the `jobId` to a deterministic offset minute/second across the window; (2) separate queues by priority tier (latency-sensitive vs batch); and (3) enforce per-tenant concurrency quotas or weighted fair queuing so one tenant submitting 100,000 jobs cannot starve everyone else.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Run jobs at a time.", "Adds cron, retries, and status.", "Defines dispatch lag SLO, at-least-once + idempotency, and dead-letter handling.", "Addresses lease heartbeats, cancellation, and multi-tenant fairness at 00:00 UTC."] },
    { stage: "estimates", descriptors: ["None.", "Executions/s only.", "Applies Little's law (`L = λW`) to size worker concurrency and estimates midnight spike.", "Sizes the due-index scan rate per shard and heartbeat QPS."] },
    { stage: "api", descriptors: ["Submit job.", "Submit, cancel, get status.", "Idempotent submission, deterministic `(jobId, scheduledAt)` execution IDs, and worker heartbeat API.", "Includes `leaseEpoch` fencing token in worker heartbeat and completion calls."] },
    { stage: "data model", descriptors: ["Jobs table.", "Jobs + executions tables.", "Composite `(bucketId, status, nextRunAt)` index + `executions` state machine with `leaseEpoch`.", "Explains atomic claim + `nextRunAt` advancement for recurring cron jobs."] },
    { stage: "high level", descriptors: ["Cron daemon on one box.", "DB + workers.", "Sharded time-bucket store, partitioned scheduler pollers, ready queue, and worker fleet.", "Adds DLQ, priority queues, and lease reaper for expired in-flight runs."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions `SKIP LOCKED` or Kafka.", "Explains zombie workers and how `leaseEpoch` fencing tokens stop stale writes.", "Details 00:00 UTC jittering (`H`), timing wheels, and per-tenant fair queuing."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions monitoring.", "Highlights schedule lag, poison-pill jobs, and zombie workers as top risks.", "Defines SLOs on dispatch delay (`startedAt - scheduledAt`) and DLQ alerting."] },
  ],
  clarifyingQuestions: [
    "What is the acceptable dispatch delay between a job's scheduled time and when a worker starts running it (e.g., <1 s vs <30 s)?",
    "How long can a single job execution run (milliseconds vs hours), and do workers need heartbeats?",
    "Are jobs strictly one-off, recurring cron, or DAG workflows with dependencies?",
    "Is the system multi-tenant, where one tenant might dump 1M jobs at once?",
  ],
  commonMistakes: [
    "Running `SELECT * FROM jobs WHERE next_run_at <= NOW()` across an unpartitioned table from hundreds of workers.",
    "Claiming 'exactly-once execution' without explaining that worker crashes require at-least-once dispatch plus idempotent/fenced side effects.",
    "Setting a fixed short visibility timeout with no heartbeat mechanism for long-running jobs.",
    "Ignoring the 00:00 UTC cron spike where 20% of the day's jobs fire in the same second.",
    "Retrying a deterministic poison-pill job forever instead of capping `maxAttempts` and routing to a dead-letter queue.",
  ],
};
