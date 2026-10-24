import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, client, data, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// Prefix trie nodes precomputed with top-k completions; query logs aggregated asynchronously.
const prefixes = entity("prefixes", "triestore", { prefixKey: ["string", 16], suggestions: ["string", 600], version: ["int", 4] }, 15_000, {
  indexes: [{ name: "byPrefix", fields: ["prefixKey"], unique: true }],
});
const queryEvents = entity("queryEvents", "triestore", { queryId: ["int", 8], rawQuery: ["string", 64] }, 15_000);

const handlers = {
  // Keystroke path: edge/memory cache in front of in-memory trie shards.
  suggest: cacheAside("prefixcache", [data("triestore", "prefixes", { kind: "get" }, 30)]),
  // Completed search logs the query asynchronously to the aggregation pipeline; never touches the trie synchronously.
  log: [publish("querylog"), respond(200)],
};

const aggregatorHandlers = {
  log: [data("triestore", "queryEvents", { kind: "put" }, 100), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "typeahead",
  name: "Search typeahead",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "Suggest API 1", [2, 0], handlers, 128, 0.4),
    service("api2", "Suggest API 2", [2, 2], handlers, 128, 0.4),
    cache("prefixcache", "Hot-prefix cache", [3, 0], 10_000_000, 60_000),
    node("triestore", "database", "In-memory trie shards", [3, 1], { ...pool(12, 1.2, 400), readTime: lognormal(2.0, 0.3), writeTime: lognormal(2.5, 0.3), replicas: 1 }),
    node("querylog", "queue", "Sampled query log", [3, 2], { partitions: 64, capacityMessages: 25_000, visibilityTimeoutUs: 400_000, maxDeliveries: 3, retentionUs: 86_400_000_000, publishTime: lognormal(0.6), costPerHour: 0.15, region: "us-east", zone: "a" }),
    node("aggregator", "worker", "Stream aggregators + trie builder", [4, 2], { ...pool(32, 0.5), serviceTime: lognormal(4), source: "querylog", batchSize: 32 }, aggregatorHandlers),
  ],
  edges: [
    link("client", "lb"), link("lb", "api1"), link("lb", "api2"),
    ...["api1", "api2"].flatMap((a) => [link(a, "prefixcache"), link(a, "triestore"), link(a, "querylog")]),
    link("aggregator", "triestore"),
  ],
  endpoints: [
    { id: "suggest", name: "GET /v1/suggest?q=:prefix", op: "read" as const, keyTemplate: "pfx:{prefixKey}", requestBytes: 120, responseBytes: 600, idempotent: true },
    { id: "log", name: "POST /v1/queries (completed search)", op: "write" as const, keyTemplate: "qlog:{queryId}", requestBytes: 200, responseBytes: 60, idempotent: true },
  ],
  entities: [prefixes, queryEvents],
};

const baseline = scenario("typeahead-day", { arrival: { kind: "poisson", rps: 3000 }, mix: { suggest: 0.9, log: 0.1 }, keys: { kind: "zipf", n: 15_000, s: 1.15 }, deadlineMs: 100 });

export const typeahead: CaseStudy = {
  id: "typeahead",
  title: "Typeahead / autocomplete",
  summary: "Return the top k query completions on every keystroke in under 50 ms so suggestions feel instantaneous. The trick is precomputing the top-k list at every trie node offline or in a streaming window, serving reads entirely from memory, and never mutating the trie synchronously on the read path.",
  requirements: {
    functional: [
      "As the user types a prefix, return the top k (typically 5–10) most relevant completions ranked by popularity and recency.",
      "Record completed searches and fold trending queries into suggestions within minutes.",
      "Filter out offensive, sensitive, or legally blocked phrases before serving.",
    ],
    nonFunctional: [
      "Server-side p99 latency under 50 ms (total round-trip under 100 ms so it stays ahead of typing speed).",
      "Read-dominated workload (~10× more prefix lookups than completed searches); high availability via in-memory replicas.",
      "Eventual consistency for frequency updates is fine, except blocklist removals which must take effect quickly.",
    ],
  },
  estimates: [
    { label: "Keystroke QPS", formula: "5B searches/day × ~6 keystrokes/search ÷ 86,400", result: "≈ 350k suggest requests/s average, ≈ 700k/s peak" },
    { label: "Prefix keyspace", formula: "50M distinct common prefixes × ~500 B (prefix + top-10 completions + scores)", result: "≈ 25 GB — the entire compiled trie fits in RAM on a single machine or a few shards" },
    { label: "Cache hit ratio", formula: "1–3 character prefixes ('a', 'we', 'wha') account for > 60% of requests", result: "a small front cache + browser local caching absorbs the majority of traffic" },
    { label: "Log ingestion", formula: "5B completed searches/day ÷ 86,400 (sampled at 10%)", result: "≈ 58k events/s raw, ≈ 5.8k/s after 1-in-10 sampling" },
  ],
  api: [
    { signature: "GET /v1/suggest?q={prefix}&limit=10&lang=en", request: "prefix capped at ~50 chars; client debounces ~50–100 ms", response: "200 { suggestions: [{ text, score }] } + Cache-Control", endpointId: "suggest" },
    { signature: "POST /v1/queries", request: "{ query, locale, ts }", response: "200", notes: "Logged when the user submits a search, not on every keystroke.", endpointId: "log" },
  ],
  dataModel: {
    entities: [prefixes],
    notes: [
      "prefixes: materialised trie nodes where each prefix maps directly to its pre-sorted top-k suggestions (`O(1)` lookup by prefix key or `O(L)` trie traversal, instead of scanning all subtries).",
      "Query logs flow through a streaming window (e.g. exponentially decayed counts every 5–15 minutes) that rebuilds or patches the trie snapshots and swaps them in atomically.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Query database with LIKE 'prefix%' on every keystroke",
      tradeoffs: "Without precomputed top-k lists per prefix and a front cache, every keystroke scans matching rows and sorts them by frequency. At 3,000 RPS with a 100 ms deadline, scanning the store blows the latency budget immediately.",
      design: alter(design, "typeahead-scan", "Typeahead by uncached prefix scan", (d) => {
        for (const id of ["api1", "api2"]) {
          find<"service">(d, id).handlers!.suggest = [data("triestore", "prefixes", { kind: "query", limit: 200 }, 80), respond(200)];
        }
      }),
      check: { scenario: "baseline", maxGoodput: 0.85 },
    },
    {
      title: "Update the live trie synchronously on every search",
      tradeoffs: "Incrementing node weights and bubbling top-k changes up to the root on every search causes severe write contention on short prefixes ('t', 'th', 'the') and locks out readers. Batching updates in a stream processor and swapping immutable trie snapshots eliminates read/write contention.",
    },
    {
      title: "Shard trie by uniform hash of prefix vs prefix range",
      tradeoffs: "Range sharding ('a'–'c' on shard 1) concentrates traffic on common starting letters ('s', 'c', 't'). Hashing the prefix (or mapping short 1–2 char prefixes to a replicated front cache and hashing longer prefixes) spreads load evenly across shards.",
    },
  ],
  failureScenarios: [
    {
      id: "trending-event",
      title: "Breaking news spikes one prefix to 40% of traffic",
      explanation: "A major live event causes 40% of users to type the same prefix.",
      scenario: variant(baseline, "typeahead-trending", [], { keys: { kind: "hotspot", n: 15_000, hotFraction: 0.4 } }),
      expect: "The hot prefix sits in the front cache (with request coalescing), so the trie shards barely see the spike and p99 stays well below the 100 ms deadline.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "cache-flush",
      title: "Hot-prefix cache restarts cold",
      explanation: "The front cache is killed from t = 1.4 s to 1.7 s and comes back empty.",
      scenario: variant(baseline, "typeahead-cache-flush", [{ id: "cache-down", kind: "kill", target: "prefixcache", ...window(1400, 1700) }]),
      expect: "While the front cache is down and refilling, misses fall back to the trie store and tail latency more than doubles before settling back to normal once the Zipf head refills.",
      check: { minGoodput: 0.95, minP99Ms: 10, clean: true },
    },
    {
      id: "aggregator-down",
      title: "Stream aggregator workers pause during trie rebuild",
      explanation: "The aggregator workers are killed from t = 1.2 s to 2.2 s.",
      scenario: variant(baseline, "typeahead-aggregator-down", [{ id: "agg-down", kind: "kill", target: "aggregator", ...window(1200, 2200) }]),
      expect: "Because the read path (`suggest`) and write ingestion (`querylog` queue) are decoupled from the aggregator workers, user-facing suggestions and query logging continue at 100% goodput while trending updates simply lag by a second.",
      check: { minGoodput: 0.99, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Trie optimisations: compressed radix trees and cached top-k",
      body: "A naive trie traverses down to the prefix node in `O(L)` steps and then visits every leaf in the subtree (`O(V)`) to find the top k — far too slow for short prefixes like 's'. Storing the precomputed top-k list directly on every trie node turns lookup into `O(L)` (or `O(1)` in a flat prefix hash table) at a modest memory multiplier. Compressing single-child chains into radix/Patricia trie edges further cuts node count and pointer chasing.",
    },
    {
      title: "Two-speed updates: immutable snapshots + trending overlay",
      body: "Full trie rebuilds run hourly or daily from sampled query logs using exponentially decayed frequency (`score = count × λ^age`), producing an immutable image loaded into memory by replicas without locks. For breaking news (earthquakes, sports scores), a lightweight streaming job detects velocity spikes over 1–5 minute windows and writes a small trending overlay merged at query time.",
    },
    {
      title: "Client-side optimisations and safety filtering",
      body: "Client debouncing (wait ~50 ms after a keystroke before firing), cancelling in-flight requests when the next character is typed, and caching prefix results in browser memory cut server QPS by half. Safety blocklists live in a separate fast filter applied both during offline trie construction and at serving time so an urgent legal takedown takes effect in seconds without waiting for a full trie rebuild.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Autocomplete prefixes.", "Top-k ranked by popularity under low latency.", "Sub-50 ms p99, read/write asymmetry, freshness vs safety filtering.", "Separates keystroke read path from completed-query logging and trending velocity."] },
    { stage: "estimates", descriptors: ["None.", "Keystroke QPS.", "Keystroke QPS, trie memory footprint, and log sampling rate.", "Proves the working trie fits in memory and explains why short prefixes dominate hits."] },
    { stage: "api", descriptors: ["GET suggest.", "Suggest + query log.", "Prefix length cap, debouncing, and cache headers.", "Cancellation, locale/personalisation context, and blocklist overrides."] },
    { stage: "data model", descriptors: ["Queries table.", "Trie structure.", "Trie with precomputed top-k cached at each node.", "Radix compression, time-decayed scoring, and immutable snapshot versioning."] },
    { stage: "high level", descriptors: ["API queries DB.", "In-memory trie + DB.", "Front cache, replicated in-memory trie shards, async log pipeline.", "Snapshot build/swap pipeline plus streaming trending overlay."] },
    { stage: "deep dive", descriptors: ["None.", "Explains trie traversal.", "O(1) top-k node caching and offline rebuilds vs live lock contention.", "Exponential decay, hot-prefix sharding, and fast takedown filtering."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions latency.", "Tail latency, stale trends, and offensive suggestions as top risks.", "SLOs on p99 latency and freshness lag with automated rollback of bad trie builds."] },
  ],
  clarifyingQuestions: [
    "How many suggestions per prefix, and are they global, per-language, or personalised?",
    "How quickly must a newly trending query appear in suggestions?",
    "Do we support spell correction / fuzzy prefix matching or strict prefixes only?",
    "How fast must a blocked/offensive suggestion be removed globally?",
  ],
  commonMistakes: [
    "Running `SELECT ... WHERE query LIKE 'prefix%' ORDER BY count DESC` on a relational database.",
    "Traversing the entire subtree below a prefix at query time instead of caching top-k on each node.",
    "Mutating the serving trie in place on every keystroke or search.",
    "Logging every intermediate keystroke instead of only completed searches (and not sampling).",
    "Using raw all-time counts without time decay, so old queries crowd out fresh ones forever.",
  ],
};
