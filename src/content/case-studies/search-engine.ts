import type { Step } from "@/engine/types";
import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, client, data, entity, find, link, loadBalancer, lognormal, node, pool, respond, scenario, service, variant, window } from "./kit";

// Document store holds metadata/snippets; searchIndex shards hold the inverted index derived from docstore.
const documents = entity("documents", "docstore", { docId: ["int", 8], termHash: ["int", 8], title: ["string", 120], snippet: ["string", 400], pagerank: ["float", 4] }, 20_000, {
  indexes: [{ name: "byTerm", fields: ["termHash"], unique: false }],
  shardKey: "docId",
});

// Scatter-gather across document-partitioned index shards, with a query result cache in front and snippet fetch for top k.
const scatterGather: Step[] = [
  {
    type: "parallel" as const,
    join: { kind: "all" as const },
    cancelLosers: false,
    branches: [
      [data("idx1", "documents", { kind: "query", index: "byTerm", limit: 25 }, 60)],
      [data("idx2", "documents", { kind: "query", index: "byTerm", limit: 25 }, 60)],
    ],
  },
  data("docstore", "documents", { kind: "get" }, 40),
];

const handlers = {
  search: cacheAside("qcache", scatterGather),
  indexDoc: [data("docstore", "documents", { kind: "put" }, 80), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "search-engine",
  name: "Full-text search engine",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("coord1", "Query coordinator 1", [2, 0], handlers, 128, 0.8),
    service("coord2", "Query coordinator 2", [2, 2], handlers, 128, 0.8),
    cache("qcache", "Query result cache", [3, 0], 15_000_000, 60_000),
    node("idx1", "searchIndex", "Inverted index shard 1", [4, 0], { ...pool(64, 0.9, 800), serviceTime: lognormal(2.5, 0.35), indexLag: lognormal(500, 0.3), source: "docstore" }),
    node("idx2", "searchIndex", "Inverted index shard 2", [4, 1], { ...pool(64, 0.9, 800), serviceTime: lognormal(2.5, 0.35), indexLag: lognormal(500, 0.3), source: "docstore" }),
    node("docstore", "database", "Document + snippet store", [4, 2], { ...pool(20, 0.8, 500), readTime: lognormal(1.5), writeTime: lognormal(2.5), replicas: 2 }),
  ],
  edges: [
    link("client", "lb"), link("lb", "coord1"), link("lb", "coord2"),
    ...["coord1", "coord2"].flatMap((c) => [link(c, "qcache"), link(c, "idx1"), link(c, "idx2"), link(c, "docstore")]),
  ],
  endpoints: [
    { id: "search", name: "GET /v1/search?q=:terms", op: "read" as const, keyTemplate: "q:{termHash}", requestBytes: 180, responseBytes: 4000, idempotent: true },
    { id: "indexDoc", name: "PUT /v1/documents/:docId", op: "write" as const, keyTemplate: "doc:{docId}", requestBytes: 2000, responseBytes: 100, idempotent: true },
  ],
  entities: [documents],
};

const baseline = scenario("search-day", { arrival: { kind: "poisson", rps: 2500 }, mix: { search: 0.95, indexDoc: 0.05 }, keys: { kind: "zipf", n: 20_000, s: 1.1 }, deadlineMs: 250 });

export const searchEngine: CaseStudy = {
  id: "search-engine",
  title: "Full-text search engine",
  summary: "Index billions of documents into an inverted index sharded by document ID, scatter queries across shards in parallel, score candidates with BM25 + static signals (PageRank) + neural re-ranking, and gather the top results with snippets under a tight tail-latency budget.",
  requirements: {
    functional: [
      "Full-text search over multi-word queries with boolean/phrase matching, returning ranked results with title, URL, and highlighted snippet.",
      "Ingest new and updated documents continuously so fresh documents become searchable within seconds to minutes.",
      "Multi-stage ranking: fast lexical retrieval (BM25 + static quality score) followed by re-ranking of the top candidates.",
    ],
    nonFunctional: [
      "Search p99 latency under ~150–250 ms despite fanning out across many index shards.",
      "High availability: if one shard replica is slow or down, serve partial or hedged results rather than failing the whole query.",
      "Scale to tens of billions of documents and ~100k queries/s.",
    ],
  },
  estimates: [
    { label: "Query rate", formula: "8B queries/day ÷ 86,400", result: "≈ 93k queries/s average, ≈ 200k/s peak" },
    { label: "Inverted index size", formula: "20B docs × ~200 unique terms × ~8 B per posting (delta-compressed docId, tf, positions)", result: "≈ 32 TB of compressed postings across shards (fits in RAM/NVMe across ~500 shard nodes)" },
    { label: "Fan-out tail amplification", formula: "1 query touches N = 64 shards; if each shard has p99 = 50 ms, P(all < 50 ms) = 0.99⁶⁴ ≈ 53%", result: "almost half of uncached queries hit at least one 99th-percentile shard — requires query caching, shard replicas, and soft timeouts" },
    { label: "Snippet fetch", formula: "top 10 results fetched only after merging top-k docIds", result: "two-phase fetch avoids reading full document text for thousands of scored candidates" },
  ],
  api: [
    { signature: "GET /v1/search?q={terms}&page=1", request: "query string, locale, pagination cursor", response: "200 { totalApprox, hits: [{ docId, title, url, snippet, score }] }", endpointId: "search" },
    { signature: "PUT /v1/documents/{docId}", request: "{ url, title, body, pagerank, updatedAt }", response: "200", notes: "Appended to an indexing log; indexed into immutable LSM-like segments.", endpointId: "indexDoc" },
  ],
  dataModel: {
    entities: [documents],
    notes: [
      "Inverted index: maps `term → postings list [(docId, termFreq, positions)]` sorted by `docId` (or by static quality tier) for fast intersection via skip pointers and WAND.",
      "Document partitioning (local index per shard) vs term partitioning: sharding by `docId` means every query fans out to all shards, but multi-word intersection happens locally in memory without shipping giant posting lists across the network.",
      "Immutable index segments (Lucene style): new documents buffer in memory and flush to immutable segments that are merged in the background, avoiding in-place locks on posting lists.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "No inverted index: full scan of document store",
      tradeoffs: "Without an inverted index (`byTerm`), every search scans the document table. Even on a 20,000-document cell, full scans saturate the store and miss the 250 ms deadline.",
      design: alter(design, "search-full-scan", "Search without inverted index", (d) => {
        for (const id of ["coord1", "coord2"]) {
          find<"service">(d, id).handlers!.search = [data("docstore", "documents", { kind: "query", limit: 50 }, 150), respond(200)];
        }
      }),
      check: { scenario: "baseline", maxGoodput: 0.85 },
    },
    {
      title: "Partition index by term instead of by document",
      tradeoffs: "In a term-partitioned index, a single-word query hits only one shard. Wait until a user searches 'the best coffee near me': you must read a multi-gigabyte posting list for 'the' and 'best' over the network to intersect them, and the shards holding common stop words melt down. Document partitioning keeps intersection local to each shard.",
    },
    {
      title: "Return full snippets from every shard during scatter",
      tradeoffs: "If all 64 shards generate and return full text snippets for their top 10 candidates, 640 snippets are generated and transferred when only 10 are shown. Two-phase search (Phase 1: shards return only `(docId, score)`; Phase 2: coordinator requests snippets only for the global top 10) cuts disk reads and network payload by an order of magnitude.",
    },
  ],
  failureScenarios: [
    {
      id: "slow-shard",
      title: "One inverted index shard degrades 6× (segment merge)",
      explanation: "From t = 1.3 s to 2.2 s index shard 2 runs 6× slower due to a heavy background segment merge.",
      scenario: variant(baseline, "search-slow-shard", [{ id: "merge-slow", kind: "degrade", target: "idx2", slowFactor: 6, ...window(1300, 2200) }]),
      expect: "Because every uncached scatter-gather waits for both shards (`join: all`), the single slow shard pulls up overall search latency for every cache miss — the classic fan-out tail latency problem. Popular queries stay fast in the query cache.",
      check: { minGoodput: 0.98, clean: true },
    },
    {
      id: "shard-outage",
      title: "An index shard goes down",
      explanation: "Index shard 2 crashes from t = 1.5 s to 1.9 s.",
      scenario: variant(baseline, "search-shard-down", [{ id: "shard-down", kind: "kill", target: "idx2", ...window(1500, 1900) }]),
      expect: "Cached queries and document writes continue to succeed, while uncached searches requiring `all` shards fail during the 400 ms outage. In production, each shard is a replica group and the coordinator also uses a soft deadline to return partial results from healthy shards rather than an error.",
      check: { maxGoodput: 0.99, minGoodput: 0.82 },
    },
    {
      id: "hot-query",
      title: "Viral news query takes 35% of search traffic",
      explanation: "A single query accounts for 35% of all traffic.",
      scenario: variant(baseline, "search-hot-query", [], { keys: { kind: "hotspot", n: 20_000, hotFraction: 0.35 } }),
      expect: "The query result cache absorbs the viral query after the first scatter-gather, shielding the index shards from redundant fan-out.",
      check: { minGoodput: 0.99, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Inverted index internals: postings, compression, and WAND",
      body: "An inverted index maps each term in a vocabulary dictionary to a sorted postings list of `(docId, termFreq, positions)`. Because docIds are sorted, we store gaps (`delta = docId[i] - docId[i-1]`) compressed with SIMD-BP128 or Elias-Fano coding, shrinking postings to a few bytes per occurrence. To avoid scoring every document containing common words, WAND (Weak AND) and Block-Max WAND maintain upper-bound score metadata per block and skip entire blocks that cannot beat the current k-th best score.",
    },
    {
      title: "Document partitioning and two-phase scatter-gather",
      body: "Documents are hash-partitioned across N shards (and tiered into hot/high-PageRank in-memory tiers vs cold tiers). Phase 1 scatters the parsed query to all shards; each shard intersects its local posting lists using WAND, runs fast BM25 + static scoring, and returns only the top k `(docId, score)` pairs. The coordinator merges the `N × k` pairs, optionally invokes a learned re-ranker on the top ~100, and in Phase 2 fetches titles and dynamic snippets for the final 10 results.",
    },
    {
      title: "Taming tail latency across 64+ shards",
      body: "When a request fans out to N shards, the slowest shard determines latency. Three defences work together: (1) a query result cache in front of the coordinator (caching full results for common queries and posting list intersections for common sub-queries), (2) hedged requests to a replica shard if a shard hasn't answered by its p95, and (3) a soft timeout (~120 ms) where the coordinator returns the best results gathered from the 98% of shards that responded on time.",
    },
    {
      title: "Real-time indexing with immutable segments",
      body: "Mutating compressed posting lists in place on disk is prohibitively slow. Instead, indexers buffer incoming documents in an in-memory inverted index and flush them every second into a new immutable segment (Lucene's Near-Real-Time search). Searches query all active segments in parallel; a background merge thread compacts small segments into larger ones and drops deleted docIds.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Keyword search.", "Ranked results with snippets.", "Multi-stage ranking, near-real-time indexing, and tail-latency SLO.", "Partial-result degradation vs complete failure under shard slowdowns."] },
    { stage: "estimates", descriptors: ["None.", "QPS and doc count.", "Postings size with compression and shard count.", "Quantifies fan-out tail latency amplification across N shards."] },
    { stage: "api", descriptors: ["Search endpoint.", "Search + indexing.", "Two-phase internal RPC (IDs/scores then snippets).", "Pagination cursors, soft-timeout flags, and idempotent document updates."] },
    { stage: "data model", descriptors: ["Documents table.", "Mentions inverted index.", "Document-partitioned postings lists with delta compression + forward store.", "Immutable segments, skip lists/Block-Max metadata, and quality tiers."] },
    { stage: "high level", descriptors: ["API + DB.", "Coordinator + index shards.", "Query cache, scatter-gather across replicated shards, two-phase snippet fetch.", "Real-time segment ingestion pipeline and multi-stage re-ranking."] },
    { stage: "deep dive", descriptors: ["None.", "Explains inverted index.", "Document vs term partitioning and WAND/skip-pointer intersection.", "Tail-latency mitigations (hedging, soft timeouts, tiering) and LSM segment merges."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions latency.", "Slow shards and segment merge I/O storms as top risks.", "SLOs on p99 latency, recall/completeness ratio, and indexing lag."] },
  ],
  clarifyingQuestions: [
    "How many documents and what average document length?",
    "How fresh must newly published or edited documents be in search results?",
    "Is returning 98% complete results acceptable when a shard times out?",
    "Do we need phrase queries and positional proximity scoring?",
  ],
  commonMistakes: [
    "Sharding the inverted index by term without accounting for multi-word intersection network traffic and hot stop words.",
    "Fetching full document bodies/snippets from all shards during the first scatter phase.",
    "Mutating inverted index posting lists in place instead of writing immutable segments.",
    "Ignoring how fan-out across puluhan shards amplifies p99 latency.",
    "Scoring every matching document instead of early termination with WAND / tiered indexes.",
  ],
};
