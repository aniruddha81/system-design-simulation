import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, client, data, dedup, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// Crawled page metadata and content hash, keyed by normalized URL ID; raw HTML goes to object storage.
const pages = entity("pages", "pagedb", { urlId: ["int", 8], domain: ["string", 40], contentHash: ["string", 32], status: ["int", 4], crawledAt: ["timestamp", 8] }, 15_000, {
  indexes: [{ name: "byContentHash", fields: ["contentHash"], unique: false }],
});
const htmlBlobs = entity("htmlBlobs", "blobstore", { urlId: ["int", 8], html: ["string", 32_000] }, 15_000);
const robotsRules = entity("robotsRules", "pagedb", { domainId: ["int", 8], rules: ["string", 1000] }, 15_000);

const schedulerHandlers = {
  // Enqueue discovered URLs only if the URL dedup filter (Bloom filter + seen store) has not seen them.
  enqueue: [
    dedup("urlseen"),
    {
      type: "branch" as const,
      cond: { kind: "dedupHit" as const },
      then: [respond(200)],
      else: [publish("frontier", true), respond(201)],
    },
  ],
  robots: cacheAside("robotscache", [data("pagedb", "robotsRules", { kind: "get" }, 50)]),
};

const fetcherHandlers = {
  // Fetch worker checks cached robots.txt, stores raw HTML in object store and records page metadata + content hash.
  enqueue: [
    { type: "cacheGet" as const, cache: "robotscache", timeoutUs: 5_000 },
    data("blobstore", "htmlBlobs", { kind: "put" }, 400),
    data("pagedb", "pages", { kind: "put" }, 80),
    respond(200),
  ],
};

const design = {
  schemaVersion: 1 as const,
  id: "web-crawler",
  name: "Web crawler",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("sched1", "Frontier scheduler 1", [2, 0], schedulerHandlers, 128, 0.5),
    service("sched2", "Frontier scheduler 2", [2, 2], schedulerHandlers, 128, 0.5),
    node("urlseen", "dedupStore", "URL seen filter (Bloom + KV)", [3, 0], { ...pool(256, 0.25), serviceTime: lognormal(0.25), ttlUs: 86_400_000_000, atomic: true, durable: true }),
    cache("robotscache", "robots.txt + DNS cache", [3, 1], 20_000_000, 300_000),
    node("frontier", "queue", "Politeness frontier queues", [3, 2], { partitions: 128, capacityMessages: 30_000, visibilityTimeoutUs: 500_000, maxDeliveries: 5, retentionUs: 86_400_000_000, publishTime: lognormal(0.8), costPerHour: 0.25, region: "us-east", zone: "a" }),
    node("fetchers", "worker", "Fetcher + parser workers", [4, 2], { ...pool(128, 0.85), serviceTime: lognormal(8, 0.4), source: "frontier", batchSize: 32 }, fetcherHandlers),
    node("pagedb", "database", "Crawl metadata + hashes", [5, 1], { ...pool(24, 0.8, 500), readTime: lognormal(1.5), writeTime: lognormal(2.5), replicas: 2, replication: "semiSync", replicationLag: lognormal(1), walDurable: true }),
    node("blobstore", "objectStore", "Raw HTML archive", [5, 2], { readTime: lognormal(15, 0.4), writeTime: lognormal(25, 0.4), costPerGBMonth: 0.02, costPerMillionRequests: 0.4, region: "us-east", zone: "a" }),
  ],
  edges: [
    link("client", "lb"), link("lb", "sched1"), link("lb", "sched2"),
    ...["sched1", "sched2"].flatMap((s) => [link(s, "urlseen"), link(s, "robotscache"), link(s, "frontier"), link(s, "pagedb")]),
    link("fetchers", "robotscache"), link("fetchers", "blobstore"), link("fetchers", "pagedb"),
  ],
  endpoints: [
    { id: "enqueue", name: "POST /v1/frontier/urls (discovered URL batch)", op: "write" as const, keyTemplate: "url:{urlId}", requestBytes: 300, responseBytes: 80, idempotent: false },
    { id: "robots", name: "GET /v1/robots/:domainId", op: "read" as const, keyTemplate: "domain:{domainId}", requestBytes: 120, responseBytes: 1000, idempotent: true },
  ],
  entities: [pages, htmlBlobs, robotsRules],
};

const baseline = scenario("crawler-day", { arrival: { kind: "poisson", rps: 1800 }, mix: { enqueue: 0.8, robots: 0.2 }, keys: { kind: "zipf", n: 15_000, s: 1.0 }, deadlineMs: 400 });

export const webCrawler: CaseStudy = {
  id: "web-crawler",
  title: "Web crawler",
  summary: "Download billions of web pages politely and fresh without getting trapped in infinite URL spaces or hammering small hosts. The architecture revolves around a two-tier frontier (priority + per-host politeness queues), URL canonicalisation with Bloom-filter deduplication, SimHash content deduplication, and aggressive DNS/robots.txt caching.",
  requirements: {
    functional: [
      "Start from seed URLs, fetch pages, parse outgoing links, and enqueue unseen URLs.",
      "Enforce politeness: obey robots.txt rules, Crawl-delay, and a maximum of one concurrent request per host.",
      "Deduplicate both URLs (after canonicalisation) and page contents (near-duplicate detection).",
      "Prioritise high-value and frequently updated pages for recrawling.",
    ],
    nonFunctional: [
      "Crawl ~15 billion pages per month (~6,000 pages/s sustained, ~12,000/s peak).",
      "Never overload a target web server; strict per-host rate limiting even across hundreds of fetcher nodes.",
      "Resilient to spider traps, slow responses, malformed HTML, and crashes without losing frontier state.",
    ],
  },
  estimates: [
    { label: "Crawl rate", formula: "15B pages/month ÷ (30 × 86,400 s)", result: "≈ 5,800 pages/s average, ≈ 12,000 pages/s peak" },
    { label: "Ingress bandwidth", formula: "5,800 pages/s × ~100 KB average compressed HTML", result: "≈ 580 MB/s (4.6 Gbit/s) sustained; peak ~10 Gbit/s" },
    { label: "HTML storage", formula: "15B pages × 100 KB compressed", result: "≈ 1.5 PB per crawl cycle; multi-petabyte object store over retention" },
    { label: "URL seen filter (Bloom)", formula: "15B URLs × ~14 bits/URL (≈ 0.1% false-positive rate)", result: "≈ 26 GB of RAM — easily fits in memory across a small cluster" },
    { label: "Fetcher concurrency", formula: "Little's law: 6,000 pages/s × 500 ms mean fetch time", result: "≈ 3,000 concurrent fetches in flight; async I/O handles thousands per worker" },
  ],
  api: [
    { signature: "POST /v1/frontier/urls", request: "{ urls: [{ rawUrl, sourceHost, depth }] }", response: "201 { enqueued, skippedDuplicate }", notes: "Internal RPC from parser workers feeding discovered links back to the frontier.", endpointId: "enqueue" },
    { signature: "GET /v1/robots/{domain}", request: "—", response: "200 { disallow[], crawlDelayMs, expiresAt }", notes: "Cached per host; fetched at most once per TTL.", endpointId: "robots" },
  ],
  dataModel: {
    entities: [pages, htmlBlobs, robotsRules],
    notes: [
      "urlseen: an in-memory sharded Bloom filter backed by a persistent KV table of canonicalised URL hashes so a restart does not recrawl the web.",
      "robotsRules: cached per registered host for up to 24 hours so fetchers do not re-request /robots.txt on every page.",
      "pages: stores metadata, HTTP status, fetch timestamp, and a 64-bit SimHash fingerprint to detect near-duplicate content before indexing.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "No seen-URL or robots.txt cache: hit metadata DB on every URL",
      tradeoffs: "Every discovered URL and page fetch checks URL seen state and robots.txt rules. Without in-memory Bloom/robots caches, every request scans the metadata database and saturates it immediately.",
      design: alter(design, "crawler-no-robots-cache", "Crawler without URL/robots caches", (d) => {
        for (const id of ["sched1", "sched2"]) {
          find<"service">(d, id).handlers!.enqueue = [data("pagedb", "pages", { kind: "query", limit: 200 }, 100), publish("frontier", true), respond(201)];
          find<"service">(d, id).handlers!.robots = [data("pagedb", "robotsRules", { kind: "query", limit: 200 }, 100), respond(200)];
        }
      }),
      check: { scenario: "baseline", maxGoodput: 0.9 },
    },
    {
      title: "Single FIFO queue instead of per-host politeness queues",
      tradeoffs: "A single FIFO frontier is trivial to build, but a page with 500 internal links enqueues 500 consecutive requests to the same host, turning your crawler into a denial-of-service attacker. Splitting the frontier into a front priority tier and a back tier of per-host FIFO queues mapped to specific fetcher workers guarantees politeness.",
    },
    {
      title: "Exact hash set in database instead of a Bloom filter",
      tradeoffs: "Every parsed page yields ~50–100 outgoing URLs, so URL deduplication runs at 50–100× the page fetch rate (~500k checks/s). Doing 500k disk lookups/s is expensive; an in-memory Bloom filter filters out 99.9% of already-seen URLs in RAM at ~14 bits per URL.",
    },
  ],
  failureScenarios: [
    {
      id: "link-burst",
      title: "Link discovery burst from hub pages",
      explanation: "From t = 1.2 s to 2.1 s crawlers hit large directory/sitemap pages and URL enqueue traffic doubles.",
      scenario: variant(baseline, "crawler-link-burst", [{ id: "burst", kind: "trafficSpike", target: "", multiplier: 2, ...window(1200, 2100) }]),
      expect: "The Bloom/dedup filter absorbs duplicate URLs in sub-millisecond time, and the partitioned frontier queue buffers the newly discovered URLs so fetcher workers drain them at a steady, polite pace.",
      check: { minGoodput: 0.98, clean: true },
    },
    {
      id: "fetcher-crash",
      title: "Fetcher worker pool crashes mid-crawl",
      explanation: "Fetcher workers crash from t = 1.3 s to 1.8 s while holding leased URLs from the frontier queue.",
      scenario: variant(baseline, "crawler-fetcher-crash", [{ id: "fetchers-down", kind: "kill", target: "fetchers", ...window(1300, 1800) }]),
      expect: "Frontier schedulers keep accepting discovered URLs and serving robots.txt lookups. Unacknowledged URLs in the frontier queue reappear after the visibility timeout and are fetched once workers recover; no frontier state is lost.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "slow-archive",
      title: "Object store write latency spikes 4×",
      explanation: "From t = 1.4 s to 2.2 s writing raw HTML blobs to the object store takes 4× longer.",
      scenario: variant(baseline, "crawler-slow-archive", [{ id: "slow-blob", kind: "degrade", target: "blobstore", slowFactor: 4, ...window(1400, 2200) }]),
      expect: "Because HTML writes happen asynchronously inside the fetcher workers behind the frontier queue, URL ingestion and robots.txt reads stay fast while the frontier queue temporarily buffers the slower fetch completion rate.",
      check: { minGoodput: 0.98, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Frontier architecture: priority + politeness",
      body: "Following Mercator's classic design, separate the frontier into two stages. Front queues rank URLs by priority (PageRank, domain authority, update frequency, freshness). A router moves URLs from front queues into back queues — one FIFO queue per target host — and a heap tracks the next allowed fetch time `t_next = t_last + crawlDelay` for each back queue. Assigning each host consistently to one fetcher worker ensures two workers never hit the same host concurrently.",
    },
    {
      title: "URL canonicalisation, Bloom filters, and spider traps",
      body: "Before checking whether a URL was seen, normalise it: lowercase scheme and host, strip default ports (`:80`, `:443`) and fragments, sort query parameters, resolve relative paths, and strip known tracking parameters (`utm_*`). Check the canonical URL against a sharded Bloom filter. To defeat spider traps (infinite calendars, session IDs in paths, faceted search combinations), enforce a maximum URL length, maximum path depth, and a per-host page budget.",
    },
    {
      title: "Content deduplication with SimHash",
      body: "Up to 30% of web pages are exact or near-duplicates (mirrors, print views, syndication, boilerplate changes). Cryptographic hashes (SHA-256) only catch byte-identical pages. Charikar's SimHash hashes token features into a 64-bit fingerprint such that two pages with similar text have a small Hamming distance (e.g. ≤ 3 bits differing), catching near-duplicates before wasting index storage.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Fetch pages from seeds.", "Mentions robots.txt or deduplication.", "Politeness, URL + content dedup, freshness, and scale targets.", "Defines spider-trap defences, recrawl priority, and failure recovery."] },
    { stage: "estimates", descriptors: ["None.", "Pages per second.", "Pages/s, bandwidth, HTML storage, and URL dedup memory.", "Sizes Bloom filter bits per URL and fetcher concurrency via Little's law."] },
    { stage: "api", descriptors: ["Seed endpoint.", "Enqueue and fetch interfaces.", "Batch URL submission, robots.txt cache API, and status reporting.", "Idempotent frontier leases and canonicalisation rules."] },
    { stage: "data model", descriptors: ["URLs table.", "URLs and pages.", "Frontier state, seen-URL filter, robots cache, and SimHash fingerprints.", "Separates hot metadata/fingerprints from cold compressed HTML blobs."] },
    { stage: "high level", descriptors: ["Workers fetching URLs from a list.", "Queue + fetchers + storage.", "Two-tier frontier, DNS/robots caches, parser feeding URL dedup.", "Consistent host-to-worker mapping and back-pressure when stores slow down."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions Bloom filters.", "Mercator front/back queues and Bloom filter false-positive trade-offs.", "SimHash near-duplicate detection and spider-trap heuristics."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions monitoring.", "Crawl rate, host errors, and frontier lag as key signals.", "SLOs on politeness compliance, freshness, and trap detection alerts."] },
  ],
  clarifyingQuestions: [
    "Are we indexing HTML text only, or also rendering JavaScript (headless browsers) and downloading media?",
    "How many pages per month, and do we recrawl continuously for freshness or run one-off snapshots?",
    "What is our tolerance for Bloom filter false positives (skipping a tiny fraction of unseen URLs)?",
    "How should we handle paywalls, authentication, and geo-specific content?",
  ],
  commonMistakes: [
    "Using a single FIFO queue, which hammers a single host with bursts of requests.",
    "Using synchronous DNS resolution and fetching robots.txt on every page.",
    "Checking URL deduplication without canonicalising URLs first.",
    "Using MD5/SHA-256 alone for content deduplication, missing near-duplicate pages.",
    "Ignoring spider traps like infinite calendar links or session IDs embedded in URLs.",
  ],
};
