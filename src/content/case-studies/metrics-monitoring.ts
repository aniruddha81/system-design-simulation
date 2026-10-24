import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, client, data, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// Active time-series head chunks and compacted blocks in the TSDB; alert rules evaluate recent windows.
const series = entity("series", "tsdb", { seriesId: ["int", 8], metricLabels: ["string", 80], chunkBytes: ["string", 256], updatedAt: ["timestamp", 8] }, 15_000, {
  indexes: [{ name: "byLabel", fields: ["metricLabels"], unique: false }],
  shardKey: "seriesId",
});

const handlers = {
  // Ingestion acknowledges once the batch is appended to the partitioned write-ahead stream; TSDB ingesters flush in batches.
  write: [publish("walqueue", true), respond(200)],
  // Dashboard and alert queries hit a query result cache (aligned to step boundaries) in front of the TSDB.
  query: cacheAside("qcache", [data("tsdb", "series", { kind: "get" }, 80)]),
};

const ingesterHandlers = {
  write: [data("tsdb", "series", { kind: "put" }, 80), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "metrics-monitoring",
  name: "Metrics monitoring & alerting",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("dist1", "Distributor 1", [2, 0], handlers, 128, 0.4),
    service("dist2", "Distributor 2", [2, 2], handlers, 128, 0.4),
    node("walqueue", "queue", "Partitioned metric stream", [3, 0], {
      partitions: 16,
      capacityMessages: 30_000,
      visibilityTimeoutUs: 400_000,
      maxDeliveries: 5,
      retentionUs: 14_400_000_000,
      publishTime: lognormal(0.4),
      costPerHour: 0.25,
      region: "us-east",
      zone: "a",
    }),
    node("ingester", "worker", "TSDB ingesters (in-memory head)", [4, 0], { ...pool(24, 0.6), serviceTime: lognormal(2), source: "walqueue", batchSize: 32 }, ingesterHandlers),
    cache("qcache", "Query & step cache", [3, 2], 10_000_000, 10_000),
    node("tsdb", "kvStore", "Time-series store (Gorilla chunks)", [4, 2], {
      ...pool(64, 1.4),
      readTime: lognormal(1.2),
      writeTime: lognormal(1.5),
      members: 6,
      vnodes: 64,
      replicationFactor: 3,
      readQuorum: 2,
      writeQuorum: 2,
      hintedHandoff: true,
      readRepair: true,
      tombstoneGcUs: 864_000_000_000,
    }),
  ],
  edges: [
    link("client", "lb"),
    link("lb", "dist1"),
    link("lb", "dist2"),
    ...["dist1", "dist2"].flatMap((a) => [link(a, "walqueue"), link(a, "qcache"), link(a, "tsdb")]),
    link("ingester", "tsdb"),
  ],
  endpoints: [
    { id: "write", name: "POST /v1/metrics/write (batched samples)", op: "write" as const, keyTemplate: "series:{id}", requestBytes: 800, responseBytes: 80, idempotent: true },
    { id: "query", name: "GET /v1/query_range?query=...&step=15s", op: "read" as const, keyTemplate: "q:{id}", requestBytes: 220, responseBytes: 3000, idempotent: true },
  ],
  entities: [series],
};

const baseline = scenario("metrics-day", {
  arrival: { kind: "poisson", rps: 3000 },
  mix: { write: 0.85, query: 0.15 },
  keys: { kind: "zipf", n: 15_000, s: 0.9 },
  deadlineMs: 400,
});

export const metricsMonitoring: CaseStudy = {
  id: "metrics-monitoring",
  title: "Metrics monitoring and alerting (Prometheus / Datadog)",
  summary: "Collect tens of millions of time-series samples per second from hosts and services, compress them in memory, serve fast dashboard range queries, and evaluate alerting rules without failing when the fleet being monitored is itself on fire.",
  requirements: {
    functional: [
      "Ingest time-series samples `(metricName, labels{}, timestampMs, float64Value)` from hundreds of thousands of targets.",
      "Query time-series over a time range with label selectors, aggregations (`sum`, `rate`, `histogram_quantile`), and downsampled resolutions.",
      "Continuously evaluate alerting rules against recent windows and fire deduplicated notifications with hysteresis (`for: 5m`).",
    ],
    nonFunctional: [
      "Write-heavy (~85–95% writes): sustain millions of samples/s with zero impact on monitored applications.",
      "Dashboard and alert evaluation queries return in <500 ms p99.",
      "High availability during incidents: the monitoring system must stay up when a zone or workload spikes.",
    ],
  },
  estimates: [
    { label: "Active time series", formula: "200k hosts/pods × 250 series each", result: "≈ 50M active time series (cardinality is the primary memory driver)" },
    { label: "Sample ingestion rate", formula: "50M series ÷ 10 s scrape/push interval", result: "≈ 5M samples/s (~5,000 batched HTTP requests/s at 1,000 samples/batch)" },
    { label: "Raw vs Gorilla compressed size", formula: "16 B raw (8 B ts + 8 B float) → ~1.37 B/sample with delta-of-delta + XOR compression", result: "5M/s × 1.37 B × 86,400 ≈ 590 GB/day (~12× smaller than raw)" },
    { label: "In-memory head state", formula: "50M active series × ~300 B metadata + 2 h head chunk", result: "≈ 65 GB RAM across the ingester ring before flushing 2-hour blocks to object storage" },
    { label: "Downsampled retention", formula: "raw 10s for 15d + 1m rollup (min/max/sum/count) for 90d + 1h for 2y", result: "long-range 90-day queries read 6× fewer points than raw" },
  ],
  api: [
    { signature: "POST /v1/metrics/write", request: "Protobuf/Snappy batch of `{ labels[], samples[{ ts, value }] }`", response: "200 · 429 series cardinality limit exceeded", notes: "Agents batch 500–2,000 samples per request.", endpointId: "write" },
    { signature: "GET /v1/query_range?query=...&start=...&end=...&step=15s", request: "PromQL-style selector + step", response: "200 { resultType: 'matrix', result[{ metric, values[] }] }", endpointId: "query" },
    { signature: "POST /v1/rules", request: "{ expr, forDuration, severity, labels }", response: "201 { ruleId }", notes: "Evaluated every 15–30 s by the rule engine against the query tier." },
  ],
  dataModel: {
    entities: [series],
    notes: [
      "Each unique label set (`__name__=\"http_requests_total\", service=\"checkout\", status=\"500\"`) is hashed to a 64-bit `seriesId`. High-cardinality labels like `userId` or `requestId` create millions of new `seriesId`s (cardinality explosion) and must be rejected or stripped.",
      "Ingesters append samples for each `seriesId` to an in-memory 2-hour head chunk (Gorilla compressed) backed by a disk WAL, and flush immutable 2-hour blocks + inverted label index to object storage.",
      "A step-aligned query frontend splits `query_range` into day/hour sub-queries, caches immutable historical intervals, and merges them with the live head chunk.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Synchronous uncached range scans without stream buffering",
      tradeoffs: "Storing each `(seriesId, timestamp, value)` as an individual row without an in-memory head chunk or query cache turns range queries and writes into full scans. In the simulator, routing writes and uncached scans straight to the store pushes p99 latency above 18 ms (more than 4× the buffered chunk design).",
      design: alter(design, "metrics-sql-rows", "Metrics stored and scanned synchronously", (d) => {
        for (const id of ["dist1", "dist2"]) {
          find<"service">(d, id).handlers = {
            write: [data("tsdb", "series", { kind: "query", limit: 100 }, 80), data("tsdb", "series", { kind: "put" }, 80), respond(200)],
            query: [data("tsdb", "series", { kind: "query", limit: 100 }, 100), respond(200)],
          };
        }
      }),
      check: { scenario: "baseline", minP99Ms: 18 },
    },
    {
      title: "Pull (Prometheus scrape) vs Push (agents / OpenTelemetry)",
      tradeoffs: "Pull lets the monitoring server control scrape rate, discover targets via service discovery, and tell immediately when a target is down (`up == 0`). Push works across NAT/firewalls, supports short-lived serverless jobs, and scales centrally via load-balanced distributors (Cortex / Mimir / VictoriaMetrics combine Prometheus pull at the edge with remote-write push to central storage).",
    },
    {
      title: "No query step alignment or caching",
      tradeoffs: "When an incident hits, 200 engineers open the same Grafana dashboard and refresh it every 10 seconds with slightly different `now` timestamps (`12:00:01`, `12:00:03`). Aligning `start`/`end` to the `step` grid (`15s`) and caching historical sub-intervals turns 200 identical TSDB scans into 1.",
    },
  ],
  failureScenarios: [
    {
      id: "incident-dashboard-storm",
      title: "Major incident: metric volume and dashboard queries double",
      explanation: "During an outage from t = 1.2 s to 2.2 s, autoscaled pods emit 2× more metrics and engineers refresh dashboards at 2× the normal rate.",
      scenario: variant(baseline, "metrics-incident-storm", [{ id: "storm", kind: "trafficSpike", target: "", multiplier: 2, ...window(1200, 2200) }]),
      expect: "The partitioned write stream buffers the ingestion burst while step-aligned query caching shields the TSDB from repeated dashboard refreshes.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "ingester-restart",
      title: "TSDB ingesters restart during a rolling deploy",
      explanation: "The ingester worker pool restarts from t = 1.3 s to 1.8 s.",
      scenario: variant(baseline, "metrics-ingester-restart", [{ id: "restart", kind: "kill", target: "ingester", ...window(1300, 1800) }]),
      expect: "Distributors continue accepting metric batches into the durable partitioned stream without dropping samples; ingesters drain the backlog as soon as they come back.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "query-cache-cold",
      title: "The query cache restarts cold",
      explanation: "At t = 1.5 s the query cache loses its state.",
      scenario: variant(baseline, "metrics-cache-cold", [{ id: "cold", kind: "kill", target: "qcache", ...window(1500, 1550) }]),
      expect: "Queries fall through to the in-memory/chunk TSDB store and repopulate the cache within milliseconds; ingestion is completely unaffected.",
      check: { minGoodput: 0.99, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Gorilla time-series compression (delta-of-delta + XOR)",
      body: "Facebook's Gorilla paper showed that within a single time series, timestamps arrive at nearly constant intervals (e.g., every 10,000 ms) and float values change slowly. Storing the *delta-of-delta* `(t_n - t_{n-1}) - (t_{n-1} - t_{n-2})` means 96% of timestamps equal 0 and take a single `0` bit! Float64 values are XORed with the previous value: if identical, store one `0` bit; otherwise store the leading/trailing zero count and the changed middle bits. Average size drops from 16 bytes to ~1.37 bytes per sample.",
    },
    {
      title: "The enemy is cardinality, not sample rate",
      body: "Adding 10× more samples to an existing series only appends 1.37 bytes to an existing chunk. Adding a label like `user_id` or `url_path` creates millions of *new* series, each requiring an in-memory head chunk, inverted-index postings list entries (`label=value → [seriesId...]`), and compaction work. Production systems enforce per-tenant active-series quotas at the distributor and drop or relabel unbounded tags before they reach the ingesters.",
    },
    {
      title: "Reliable alerting: hysteresis, deduplication, and dead-man's switch",
      body: "Alert rules run every 15–30 s against recent in-memory head chunks (never cold disk). To avoid paging on transient 10-second blips, rules require a `for: 5m` pending duration (hysteresis) before transitioning `INACTIVE → PENDING → FIRING`. Multiple HA alert evaluators send firing alerts to an Alertmanager cluster that deduplicates by alert fingerprint, groups related host alerts into one notification, and sends a continuous heartbeat ('dead-man's switch') to an external pager so you know if the alerting pipeline itself dies.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Collect and graph metrics.", "Adds alerting.", "Quantifies write-heavy ratio, query latency, retention tiers, and HA during incidents.", "Distinguishes metrics (aggregated counters/gauges/histograms) from high-cardinality logs and traces."] },
    { stage: "estimates", descriptors: ["None.", "Samples/s only.", "Calculates active series (50M), samples/s (5M/s), and Gorilla ~1.37 B/sample compression.", "Sizes in-memory head chunk RAM and downsampled retention tiers."] },
    { stage: "api", descriptors: ["Write and read endpoints.", "Batched writes and range query.", "Step-aligned range queries, label selectors, and 429 on cardinality quota.", "Explains client-side batching and scrape vs remote-write protocols."] },
    { stage: "data model", descriptors: ["Metrics table.", "Series + samples.", "Series ID + inverted label index + compressed time-ordered chunks (head + 2h blocks).", "Explains cardinality explosion and downsampling rollups (`min/max/sum/count`)."] },
    { stage: "high level", descriptors: ["Agent → DB.", "Collectors + TSDB + dashboards.", "Distributors, partitioned WAL/stream, in-memory head ingesters, object store blocks, query cache.", "Includes decoupled alert rule evaluators + HA Alertmanager with deduplication."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions TSDB.", "Explains Gorilla delta-of-delta + XOR compression and inverted label postings.", "Details cardinality limits, query splitting/step alignment, and dead-man's switch alerting."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions dashboards.", "Names cardinality spikes and incident query storms as primary failure modes.", "Proposes per-tenant shuffle sharding and meta-monitoring in a separate failure domain."] },
  ],
  clarifyingQuestions: [
    "How many hosts/containers and how many active time series do we expect, and at what collection interval?",
    "Are we designing for pull (Prometheus-style scraping), push (agents/remote-write), or both?",
    "What retention resolution is needed (e.g., 10s raw for 15 days, 1m rollups for 90 days, 1h for 2 years)?",
    "How quickly must alerts fire, and how should the alerting pipeline itself be monitored?",
  ],
  commonMistakes: [
    "Storing every metric sample as an individual row in a B-tree SQL database.",
    "Allowing unbounded labels (`userId`, `requestId`, raw URLs) into metric tags, causing a cardinality OOM.",
    "Sending every sample as a separate HTTP request instead of batching hundreds of samples per payload.",
    "Running alert evaluations against slow cold storage instead of the in-memory recent head chunks.",
    "Hosting the monitoring and alerting system inside the exact same cluster and dependencies it monitors.",
  ],
};
