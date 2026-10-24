import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, client, data, dedup, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// Minute-bucketed aggregate counts per (adId, windowStart) and raw billing ledger.
const aggregates = entity("aggregates", "olapdb", { adWindowKey: ["string", 24], adId: ["int", 8], clicks: ["int", 8], spendCents: ["int", 8] }, 10_000);
const billingLedger = entity("billingLedger", "olapdb", { clickId: ["string", 16], adId: ["int", 8], billedCents: ["int", 4] }, 10_000);

const collectorHandlers = {
  // Fast edge ack: record click on the partitioned stream and redirect immediately; stream workers deduplicate and aggregate.
  click: [publish("clickstream", true), respond(200)],
  // Advertiser dashboard queries recent minute rollups via a short-TTL cache in front of the OLAP store.
  query: cacheAside("dashcache", [data("olapdb", "aggregates", { kind: "get" }, 80)]),
};

const aggregatorHandlers = {
  // Stream processor: deduplicates by clickId/impressionId, then updates the tumbling window rollup and billing ledger.
  click: [
    dedup("dedup"),
    {
      type: "branch" as const,
      cond: { kind: "dedupHit" as const },
      then: [respond(200)],
      else: [
        data("olapdb", "aggregates", { kind: "put" }, 80),
        data("olapdb", "billingLedger", { kind: "put" }, 80),
        respond(200),
      ],
    },
  ],
};

const design = {
  schemaVersion: 1 as const,
  id: "ad-click-aggregation",
  name: "Ad click event aggregation",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("ing1", "Click collector 1", [2, 0], collectorHandlers, 128, 0.3),
    service("ing2", "Click collector 2", [2, 2], collectorHandlers, 128, 0.3),
    node("clickstream", "queue", "Click event log (by adId)", [3, 1], {
      partitions: 16,
      capacityMessages: 25_000,
      visibilityTimeoutUs: 400_000,
      maxDeliveries: 8,
      retentionUs: 86_400_000_000,
      publishTime: lognormal(0.5),
      costPerHour: 0.25,
      region: "us-east",
      zone: "a",
    }),
    node("aggworker", "worker", "Stream aggregators", [4, 1], { ...pool(24, 0.5), serviceTime: lognormal(2.5), source: "clickstream", batchSize: 16 }, aggregatorHandlers),
    node("dedup", "dedupStore", "Click-ID dedup state", [5, 0], { ...pool(256, 0.25), serviceTime: lognormal(0.3), ttlUs: 3_600_000_000, atomic: true, durable: true }),
    cache("dashcache", "Dashboard cache", [3, 3], 6_000_000, 5000),
    node("olapdb", "kvStore", "Minute rollups & OLAP store", [5, 2], {
      ...pool(64, 1.1),
      readTime: lognormal(1.5),
      writeTime: lognormal(1.8),
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
    link("lb", "ing1"),
    link("lb", "ing2"),
    ...["ing1", "ing2"].flatMap((a) => [link(a, "clickstream"), link(a, "dashcache"), link(a, "olapdb")]),
    link("aggworker", "dedup"),
    link("aggworker", "olapdb"),
  ],
  endpoints: [
    { id: "click", name: "GET /v1/click?adId&clickId", op: "write" as const, keyTemplate: "ad:{id}", requestBytes: 300, responseBytes: 120, idempotent: false },
    { id: "query", name: "GET /v1/ads/:id/metrics?window=1m", op: "read" as const, keyTemplate: "metrics:{id}", requestBytes: 180, responseBytes: 1500, idempotent: true },
  ],
  entities: [aggregates, billingLedger],
};

const baseline = scenario("ad-clicks-day", {
  arrival: { kind: "poisson", rps: 3000 },
  mix: { click: 0.85, query: 0.15 },
  keys: { kind: "zipf", n: 10_000, s: 0.9 },
  deadlineMs: 300,
});
const workerCrash = variant(baseline, "ad-worker-crash", [{ id: "agg-down", kind: "kill", target: "aggworker", ...window(1300, 1800) }]);

export const adClickAggregation: CaseStudy = {
  id: "ad-click-aggregation",
  title: "Ad click event aggregation",
  summary: "Ingest tens of thousands of ad clicks per second, deduplicate retries and fraudulent double-clicks, and produce per-minute billing and dashboard counts within seconds. Because clicks are money, the pipeline needs event-time windowing, watermarks for late mobile events, and end-to-end exactly-once accounting.",
  requirements: {
    functional: [
      "Record every ad click event (`clickId`, `impressionId`, `adId`, `campaignId`, `eventTime`, user context) and redirect the user to the landing page with minimal delay.",
      "Aggregate click counts and spend per `adId` and `campaignId` in 1-minute tumbling windows for live advertiser dashboards and budget pacing.",
      "Deduplicate repeated clicks carrying the same `clickId` / `impressionId` and filter invalid or unserved impressions.",
    ],
    nonFunctional: [
      "Click redirect latency under ~50 ms p99; dashboard freshness within ~10–30 seconds.",
      "No double-billing when clients retry or stream workers crash and replay a partition.",
      "Zero lost clicks once accepted by the collector (durable partitioned log + raw archive for offline reconciliation).",
    ],
  },
  estimates: [
    { label: "Click ingestion", formula: "1B clicks/day ÷ 86,400", result: "≈ 11.5k clicks/s average, ≈ 50k/s peak during major events" },
    { label: "Impressions (join state)", formula: "100B impressions/day (~1% CTR) × 16 B key × 1 h attribution window", result: "≈ 4.2B impressions/hour ≈ 67 GB across stream partitions" },
    { label: "Raw log bandwidth", formula: "50k clicks/s × 300 B event payload", result: "≈ 15 MB/s ingress to Kafka; ≈ 300 GB/day compressed in object storage" },
    { label: "Minute rollup writes", formula: "2M active ads × 1 row/minute (sparse: ~200k ads clicked in any given minute)", result: "pre-aggregating in 1-minute windows cuts OLAP store writes from 50k/s to ~3.3k/s" },
    { label: "Dedup state", formula: "50k clicks/s × 3,600 s TTL × 24 B", result: "≈ 4.3 GB across the stream processor state stores" },
  ],
  api: [
    { signature: "GET /v1/click?clickId=...&adId=...&dest=...", request: "Signed impression token + client timestamp", response: "302 Found → advertiser landing URL", notes: "Appends to the durable click stream before or alongside returning 302.", endpointId: "click" },
    { signature: "GET /v1/ads/{adId}/metrics?from=...&to=...&granularity=1m", request: "Time range and breakdown dimensions", response: "200 { series[{ windowStart, clicks, spendCents }], watermark }", endpointId: "query" },
  ],
  dataModel: {
    entities: [aggregates, billingLedger],
    notes: [
      "aggregates is keyed by `(adId, windowStartMinute)` in a real-time OLAP store (ClickHouse / Druid / Pinot) or wide-column store; stream workers write deterministic window totals so replays overwrite rather than double-count.",
      "billingLedger records deduplicated billable click events (also dumped to Parquet in object storage) for daily batch reconciliation against the real-time stream.",
      "The stream processor maintains keyed rocksdb state partitioned by `adId` (or `impressionId`) for deduplication and 1-minute window accumulators.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Non-idempotent counter increments on worker replay",
      tradeoffs: "If stream workers simply increment a database counter (`clicks = clicks + 1`) without deduplicating by `clickId` or writing deterministic window snapshots, any worker crash that replays unacknowledged messages bills the advertiser twice. Run the worker-crash scenario against this design to observe `duplicateEffect` violations.",
      design: alter(design, "ad-click-non-idempotent", "Ad click aggregation with non-idempotent increments", (d) => {
        find<"worker">(d, "aggworker").handlers = {
          click: [
            data("olapdb", "aggregates", { kind: "update", field: "clicks", op: "increment", value: 1 }, 80),
            respond(200),
          ],
        };
      }),
      check: { scenario: "worker-crash", violations: ["duplicateEffect"] },
    },
    {
      title: "Synchronous database writes and rollup scans in the click redirect path",
      tradeoffs: "Writing and scanning rollups synchronously in the OLAP store before redirecting removes the stream queue, but couples user click latency and availability to the database. Under load, redirect p99 latency more than triples compared to asynchronous stream ingestion.",
      design: alter(design, "ad-click-sync", "Synchronous DB write on click redirect", (d) => {
        for (const id of ["ing1", "ing2"]) {
          find<"service">(d, id).handlers!.click = [
            data("olapdb", "aggregates", { kind: "query", limit: 50 }, 80),
            data("olapdb", "aggregates", { kind: "put" }, 80),
            respond(200),
          ];
        }
      }),
      check: { scenario: "baseline", minP99Ms: 15 },
    },
    {
      title: "Pure batch processing vs hybrid reconciliation",
      tradeoffs: "Hourly Spark/MapReduce jobs over object storage give simple, exact numbers with zero late-event headaches, but advertisers cannot see live campaign performance or stop an overspending budget for an hour. Production ad systems run a fast streaming path for live dashboards and pacing, plus a daily batch reconciliation job for final invoice adjustments.",
    },
  ],
  failureScenarios: [
    {
      id: "worker-crash",
      title: "Stream aggregator workers crash mid-window",
      explanation: "All stream aggregator workers crash from t = 1.3 s to 1.8 s. Unacknowledged click events in the stream reappear after the 400 ms visibility timeout and are reprocessed.",
      scenario: workerCrash,
      expect: "Click redirects keep succeeding at full speed because collectors only publish to the partitioned log. When the workers recover and replay the redelivered clicks, the dedup store and idempotent window writes prevent any duplicate billing.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "campaign-spike",
      title: "Super Bowl ad airs: click rate triples",
      explanation: "From t = 1.2 s to 2.2 s traffic triples to 9,000 rps as a broadcast ad drives a sudden burst of clicks.",
      scenario: variant(baseline, "ad-campaign-spike", [{ id: "superbowl", kind: "trafficSpike", target: "", multiplier: 3, ...window(1200, 2200) }]),
      expect: "The partitioned click log buffers the burst so click redirects stay fast; consumer lag rises for a moment and drains once the spike passes.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "olap-slowdown",
      title: "The OLAP rollup store slows down 4×",
      explanation: "Segment merges slow the OLAP store by 4× from t = 1.4 s to 2.2 s.",
      scenario: variant(baseline, "ad-olap-slow", [{ id: "merge", kind: "degrade", target: "olapdb", slowFactor: 4, ...window(1400, 2200) }]),
      expect: "Click redirects are completely isolated by the stream log, and dashboard reads are shielded by the 5-second dashboard cache.",
      check: { minGoodput: 0.99, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Event time, watermarks, and allowed lateness",
      body: "Mobile clients buffer ad clicks while offline in a subway and upload them minutes later. Aggregating by *processing time* (when the server receives the click) spikes the wrong minute bucket. Instead, bucket by *event time* (captured when the ad impression/click occurred, validated against server impression timestamps to prevent spoofing). The stream processor tracks a *watermark* `W` — a monotonic lower bound on event time — and emits the `[12:00, 12:01)` window once `W >= 12:01`. Late events arriving within an *allowed lateness* horizon (say, 10 minutes) update the emitted bucket; ultra-late events go to a side output for daily billing reconciliation.",
    },
    {
      title: "End-to-end exactly-once accounting",
      body: "At-least-once ingestion plus retries means duplicates enter the pipeline at two places: mobile client retries and stream worker crashes. First, when the ad server renders an ad, it issues a signed `impressionId`; the collector and stream processor deduplicate on `impressionId` in a partitioned state store (RocksDB backed by checkpointed changelog topics). Second, when a 1-minute window closes, the processor writes the full window total `(adId, windowStart) → totalClicks` (an idempotent `PUT` keyed by window ID) or commits Kafka offsets and sink transactions together, rather than issuing blind `+1` increments to the external database.",
    },
    {
      title: "Handling hot ads and budget pacing",
      body: "Partitioning the stream by `adId` keeps each ad's window state on a single worker, except when one viral campaign receives 20% of all clicks. Solve hot keys with a *two-stage local-then-global aggregation*: collectors or stage-1 workers append a random shard suffix `adId#0..7` and emit partial 5-second sub-aggregates, reducing message volume by 1000× before stage-2 workers merge the 8 partials per `adId` and check remaining campaign budget.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Count clicks per ad.", "Adds redirect latency and dashboard queries.", "Specifies 1-minute event-time windows, deduplication, and no double-billing.", "Covers late mobile events, impression-to-click attribution, and budget pacing."] },
    { stage: "estimates", descriptors: ["None.", "Click QPS only.", "Computes peak click QPS (~50k/s), dedup state memory, and rollup write reduction.", "Sizes the impression-join state (~67 GB/h) and raw archive bandwidth."] },
    { stage: "api", descriptors: ["Click and query endpoints.", "302 redirect on click.", "Signed impressionId/clickId token and time-range rollup query with watermark.", "Explains why `impressionId` must be server-signed to prevent fabricated clicks."] },
    { stage: "data model", descriptors: ["Clicks table.", "Clicks + aggregates table.", "Raw immutable event log (S3/Parquet) + `(adId, windowStart)` OLAP rollups + dedup state.", "Idempotent window upsert schema that tolerates stream replay and late updates."] },
    { stage: "high level", descriptors: ["Collector writes DB.", "Collector → Kafka → workers → DB.", "Partitioned log, stateful stream processor with dedup/windows, OLAP store, and dashboard cache.", "Adds raw archival sink and batch reconciliation path for invoice accuracy."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions Kafka and Flink.", "Explains event-time tumbling windows, watermarks, and allowed lateness.", "Details end-to-end idempotency on crash replay and two-stage combiner for hot ads."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions monitoring.", "Names watermark lag, hot ad partitions, and click fraud as key risks.", "Sets SLOs on redirect latency and watermark lag, plus daily stream-vs-ledger audits."] },
  ],
  clarifyingQuestions: [
    "Are we only counting clicks, or joining clicks against ad impressions to verify attribution and compute CTR?",
    "How fresh do advertiser dashboards and budget-pacing decisions need to be (seconds vs minutes)?",
    "How late can offline mobile click events arrive, and how should late events affect already-closed minute buckets?",
    "What is the peak click rate, and can a single viral campaign dominate traffic?",
  ],
  commonMistakes: [
    "Writing directly to a database in the synchronous click-redirect path.",
    "Incrementing an external counter (`clicks = clicks + 1`) from an at-least-once stream worker without idempotency.",
    "Windowing by server processing time instead of event time, corrupting minute buckets when queues lag or mobile devices reconnect.",
    "Trusting client-generated `clickId`s without verifying a server-signed `impressionId`.",
    "Keeping unbounded deduplication state in memory without a watermark-driven TTL.",
  ],
};
