import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, client, data, entity, find, link, loadBalancer, lognormal, node, pool, respond, scenario, service, variant, window } from "./kit";

const urls = entity("urls", "db", { code: ["string", 7], longUrl: ["string", 120], userId: ["int", 8], createdAt: ["timestamp", 8], expiresAt: ["timestamp", 8] }, 5_000, {
  indexes: [{ name: "byUser", fields: ["userId"], unique: false }],
  shardKey: "code",
});

const handlers = {
  redirect: cacheAside("cache", [data("db", "urls", { kind: "get" }, 50)]),
  shorten: [data("db", "urls", { kind: "insert" }, 100), respond(201)],
};

const design = {
  schemaVersion: 1 as const,
  id: "url-shortener",
  name: "URL shortener",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "API 1", [2, 0], handlers),
    service("api2", "API 2", [2, 2], handlers),
    cache("cache", "Redirect cache", [3, 0], 330_000, 3_600_000),
    node("db", "database", "URL store", [3, 2], {
      ...pool(8, 0.5, 400), readTime: lognormal(3), writeTime: lognormal(5), replicas: 3,
      replication: "semiSync", replicationLag: lognormal(1), readFromReplicas: true, walDurable: true,
      failover: { heartbeatUs: 100_000, missedHeartbeats: 3, electionUs: 200_000, fencing: true },
    }),
  ],
  edges: [link("client", "lb"), link("lb", "api1"), link("lb", "api2"), link("api1", "cache"), link("api2", "cache"), link("api1", "db"), link("api2", "db")],
  endpoints: [
    { id: "redirect", name: "GET /:code", op: "read" as const, keyTemplate: "url:{code}", requestBytes: 200, responseBytes: 300, idempotent: true },
    { id: "shorten", name: "POST /v1/urls", op: "write" as const, keyTemplate: "url:{code}", requestBytes: 300, responseBytes: 200, idempotent: false, inputs: { code: { kind: "sequence" as const, start: 1_000_000 } } },
  ],
  entities: [urls],
};

const baseline = scenario("url-shortener-day", { arrival: { kind: "poisson", rps: 3000 }, mix: { redirect: 0.99, shorten: 0.01 }, keys: { kind: "zipf", n: 5_000, s: 1 }, deadlineMs: 500 });

export const urlShortener: CaseStudy = {
  id: "url-shortener",
  title: "URL shortener",
  summary: "Turn long URLs into 7-character codes and redirect at 100× the write rate. The interesting parts are code generation without collisions and a read path that the cache, not the database, carries.",
  requirements: {
    functional: [
      "Create a short code for a long URL, optionally with a custom alias and an expiry time.",
      "Redirect GET /{code} to the long URL with HTTP 301 or 302.",
      "Return 404 for unknown codes and 410 for expired ones.",
      "Owners can list and delete their links.",
    ],
    nonFunctional: [
      "Redirect latency p99 under 50 ms at the server; it sits in front of every click.",
      "Redirects 99.99% available (about 52 minutes of downtime a year); creation can tolerate brief outages.",
      "A code never maps to two different URLs, and codes are not trivially enumerable.",
      "Links are durable for at least 5 years.",
    ],
  },
  estimates: [
    { label: "Write rate", formula: "100M new URLs/day ÷ 86,400 s", result: "≈ 1,160 writes/s average, ≈ 2,300/s at a 2× peak" },
    { label: "Read rate", formula: "100 reads per write × 1,160/s", result: "≈ 116k redirects/s average, ≈ 230k/s peak" },
    { label: "Record count", formula: "100M/day × 365 × 5 years", result: "≈ 183 billion links" },
    { label: "Storage", formula: "183B × ~500 B per row (URL, code, owner, timestamps, index)", result: "≈ 91 TB, ≈ 275 TB with 3 replicas" },
    { label: "Code length", formula: "62⁷ = 3.5 × 10¹²  vs  1.83 × 10¹¹ needed", result: "7 base-62 characters give ≈ 19× headroom; 6 (5.7 × 10¹⁰) do not" },
    { label: "Cache size", formula: "~1B distinct links read/day; hottest 20% ≈ 80% of clicks → 200M × 500 B", result: "≈ 100 GB of hot entries — a handful of cache nodes" },
    { label: "Egress", formula: "116k/s × ~500 B per redirect response", result: "≈ 58 MB/s (≈ 460 Mbit/s): bandwidth is not the constraint" },
  ],
  api: [
    { signature: "POST /v1/urls", request: "{ longUrl, customAlias?, expiresAt? } + Idempotency-Key header", response: "201 { code, shortUrl } · 409 alias taken · 429 over quota", endpointId: "shorten" },
    { signature: "GET /{code}", request: "—", response: "301/302 Location: longUrl · 404 unknown · 410 expired", notes: "301 lets browsers cache the redirect (less load, no click analytics); 302 sends every click to you.", endpointId: "redirect" },
    { signature: "DELETE /v1/urls/{code}", request: "auth: owner", response: "204 · 404", notes: "Must also delete the cached entry, or the link keeps working until its TTL." },
  ],
  dataModel: {
    entities: [urls],
    notes: [
      "One table, keyed and sharded by code: every redirect is a point lookup on the shard key, so no query fans out.",
      "A secondary index on userId serves 'my links'; it is the only non-key access path and it is rare.",
      "A key-value store fits equally well — there are no joins or multi-row transactions.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Key-value store instead of SQL",
      tradeoffs: "Every access is by key, so a Dynamo-style store (N=3, R=W=2) scales writes horizontally with no resharding project. You lose the cheap userId index (you maintain a second table yourself) and uniqueness of custom aliases needs a conditional write instead of a UNIQUE constraint.",
      design: alter(design, "url-shortener-kv", "URL shortener on a KV store", (d) => {
        d.nodes = d.nodes.filter((n) => n.id !== "db");
        d.nodes.push(node("kv", "kvStore", "URL store (KV)", [3, 2], { ...pool(16, 0.3, 400), readTime: lognormal(2), writeTime: lognormal(3), members: 6, vnodes: 64, replicationFactor: 3, readQuorum: 2, writeQuorum: 2, hintedHandoff: true, readRepair: true, tombstoneGcUs: 864_000_000 }));
        d.edges = d.edges.map((e) => (e.to === "db" ? link(e.from, "kv") : e));
        d.entities = [{ ...urls, store: "kv", indexes: [] }];
        for (const id of ["api1", "api2"]) find<"service">(d, id).handlers = {
          redirect: cacheAside("cache", [data("kv", "urls", { kind: "get" }, 50)]),
          shorten: [data("kv", "urls", { kind: "insert" }, 100), respond(201)],
        };
      }),
      check: { scenario: "baseline", minGoodput: 0.99, clean: true },
    },
    {
      title: "No cache: send every redirect to the database",
      tradeoffs: "Simpler and always fresh, but the database must absorb the full read rate. In the simulated cell the store saturates: 3,000 reads/s against roughly 2,700/s of capacity, so queues grow until requests miss their deadline.",
      design: alter(design, "url-shortener-no-cache", "URL shortener without a cache", (d) => {
        for (const id of ["api1", "api2"]) find<"service">(d, id).handlers!.redirect = [data("db", "urls", { kind: "get" }, 50), respond(200)];
      }),
      check: { scenario: "baseline", maxGoodput: 0.9 },
    },
    {
      title: "Hash the URL (MD5/SHA-256) and keep the first 7 characters",
      tradeoffs: "The same URL always gets the same code, which deduplicates for free. But truncation makes collisions certain at this scale, so every insert needs a check-and-retry, and two users shortening one URL now share analytics and deletion rights. A counter or random code with insert-if-absent is simpler.",
    },
  ],
  failureScenarios: [
    {
      id: "cache-restart",
      title: "The redirect cache restarts empty",
      explanation: "At t = 1.5 s the cache node dies and comes back cold 50 ms later. Every redirect misses until the hot set refills, so the database briefly sees the full read rate.",
      scenario: variant(baseline, "url-shortener-cache-restart", [{ id: "cache-cold", kind: "kill", target: "cache", ...window(1500, 1550) }]),
      expect: "The hit rate collapses and the URL store queues up, but request coalescing and the Zipf-skewed hot set refill the cache within a few hundred milliseconds. Most redirects still succeed; the tail latency spike is the cost.",
      check: { minGoodput: 0.9, clean: true },
    },
    {
      id: "viral-link",
      title: "One link goes viral",
      explanation: "A single code receives 30% of all clicks — a link in a breaking news push.",
      scenario: variant(baseline, "url-shortener-viral", [], { keys: { kind: "hotspot", n: 5_000, hotFraction: 0.3 } }),
      expect: "Nothing breaks, and the viral link itself costs one database read: it lives in the cache. The store does get busier, but from the other 70% of clicks, which this scenario spreads uniformly over the long tail where the cache helps least. In a sharded cache one shard would take the whole hot key — the fix is to replicate hot keys or keep a small in-process cache.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "store-failover",
      title: "The URL store's leader dies",
      explanation: "The database leader is killed at t = 1.5 s. Failure detection takes 3 missed 100 ms heartbeats plus a 200 ms election, so the store is unavailable for about 0.5 s before a replica takes over.",
      scenario: variant(baseline, "url-shortener-failover", [{ id: "leader-down", kind: "kill", target: "db", ...window(1500, 2300) }]),
      expect: "Cache hits keep redirecting through the outage; cache misses and new links fail until the replica is promoted. Because replication is semi-synchronous and the old leader is fenced, no acknowledged link is lost.",
      check: { minGoodput: 0.9, maxGoodput: 0.995, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Generating codes without collisions",
      body: "Three workable schemes. (1) A counter encoded in base 62: hand each API server a range of IDs (Flickr's ticket servers, or a Snowflake-style timestamp + worker + sequence ID), so there is no per-request coordination and no collision by construction. Sequential codes are enumerable, so pass the counter through a keyed bijective permutation before encoding. (2) Random 7-character codes with insert-if-absent: with n codes already used out of N = 62⁷, the next insert collides with probability n/N — about 5% when 183B are used — so retry on a 409. (3) Hash truncation, which collides like (2) but also couples codes to URLs. Custom aliases always need the insert-if-absent path.",
    },
    {
      title: "301 or 302, and where the redirect is cached",
      body: "A 301 (permanent) may be cached by browsers and proxies, so repeat clicks never reach you: cheaper, but you lose click counts and cannot change or delete the target. A 302 (or 307) sends every click to you. Most commercial shorteners use 301 with short Cache-Control lifetimes or 302 because analytics is the product. Either way, a server-side cache-aside layer serves the hot set: with Zipf-like popularity, caching 20% of links answers roughly 80–85% of redirects.",
    },
    {
      title: "Expiry and deletion",
      body: "Check expiresAt on every read (lazy expiry) so an expired link returns 410 immediately, and run a background sweep that deletes expired rows in small batches to reclaim space. Deleting a link must also delete its cache entry; otherwise it keeps redirecting until the cache TTL — the classic invalidation bug. Never recycle expired codes: old printed links would silently point somewhere new.",
    },
    {
      title: "Abuse",
      body: "Shorteners are a favourite tool for hiding phishing and malware. Rate-limit creation per account and per IP, check new URLs against a reputation service before returning the code, and keep the ability to disable a code centrally — which again means invalidating caches.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Lists create and redirect only.", "Adds expiry or custom aliases, but no non-functional targets.", "States read-heavy ratio, latency and availability targets.", "Also pins down 301 vs 302, enumerability, deletion semantics and durability horizon."] },
    { stage: "estimates", descriptors: ["No numbers.", "Computes QPS but not storage or code length.", "QPS, storage and code length with formulas.", "Also sizes the cache from popularity skew and shows bandwidth is not the bottleneck."] },
    { stage: "api", descriptors: ["Endpoints without status codes.", "Create and redirect with main status codes.", "Adds 404/410/409/429 and idempotency for creation.", "Explains the 301/302 trade-off and its effect on analytics and deletion."] },
    { stage: "data model", descriptors: ["Undefined storage.", "A table with code and URL.", "Keyed and sharded by code, owner index identified.", "Argues SQL vs KV from access patterns and handles alias uniqueness."] },
    { stage: "high level", descriptors: ["Single server and database.", "Load balancer, stateless API, database.", "Adds a cache-aside read path sized from the estimates.", "Explains which component carries which load and how the design survives losing each one."] },
    { stage: "deep dive", descriptors: ["No collision story.", "Hash or counter without analysis.", "Compares counter, random and hash schemes with collision math.", "Adds ID-range allocation, non-enumerability and failover behaviour."] },
    { stage: "wrap-up", descriptors: ["Stops at the diagram.", "Mentions monitoring.", "Names the bottlenecks and their mitigations.", "Prioritises the next risks (abuse, hot keys, cache invalidation on delete) with measurable signals."] },
  ],
  clarifyingQuestions: [
    "How many links are created per day, and what is the read-to-write ratio?",
    "Do we need click analytics? (It decides 301 vs 302.)",
    "Are custom aliases allowed, and can links be edited or deleted?",
    "Do links expire by default?",
    "Must codes be unguessable?",
  ],
  commonMistakes: [
    "Using 6 characters: 62⁶ ≈ 57B codes runs out within two years at 100M/day.",
    "Generating codes with a single global counter — a write bottleneck and a single point of failure.",
    "Hashing and truncating without a collision check.",
    "Sizing the database for the full redirect rate instead of the cache miss rate.",
    "Forgetting to invalidate the cache when a link is deleted or disabled.",
  ],
};
