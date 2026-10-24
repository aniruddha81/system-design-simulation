import type { CaseStudy } from "./types";
import { cache, cacheAside, cacheDelete, client, data, entity, link, loadBalancer, lognormal, node, pool, respond, scenario, service, variant, window } from "./kit";

const profiles = entity("profiles", "db", { userId: ["int", 8], name: ["string", 40], bio: ["string", 300], avatarUrl: ["string", 80], settings: ["string", 400] }, 10_000);
const handlers = {
  get: cacheAside("cache", [data("db", "profiles", { kind: "get" }, 100)]),
  // Write the database, then delete the cached copy (never update it): the next read refills.
  put: [data("db", "profiles", { kind: "put" }, 100), cacheDelete("cache"), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "distributed-cache",
  name: "Distributed cache (cache-aside)",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("app1", "App 1", [2, 0], handlers),
    service("app2", "App 2", [2, 2], handlers),
    cache("cache", "Cache cluster", [3, 0], 2_200_000, 60_000),
    node("db", "database", "Profiles DB", [3, 2], { ...pool(8, 0.5, 300), readTime: lognormal(3.5), writeTime: lognormal(6), replicas: 1 }),
  ],
  edges: [link("client", "lb"), link("lb", "app1"), link("lb", "app2"), link("app1", "cache"), link("app2", "cache"), link("app1", "db"), link("app2", "db")],
  endpoints: [
    { id: "get", name: "GET /profiles/:id", op: "read" as const, keyTemplate: "profile:{id}", requestBytes: 150, responseBytes: 1000, idempotent: true },
    { id: "put", name: "PUT /profiles/:id", op: "write" as const, keyTemplate: "profile:{id}", requestBytes: 1000, responseBytes: 100, idempotent: true },
  ],
  entities: [profiles],
};

const baseline = scenario("cache-day", { arrival: { kind: "poisson", rps: 4000 }, mix: { get: 0.97, put: 0.03 }, keys: { kind: "zipf", n: 10_000, s: 1.1 }, deadlineMs: 250 });
const restart = variant(baseline, "cache-cold-restart", [{ id: "cold", kind: "kill", target: "cache", ...window(1500, 1550) }]);
const restartSlowDb = variant(baseline, "cache-restart-slow-db", [
  { id: "cold", kind: "kill", target: "cache", ...window(1500, 1550) },
  { id: "slow-db", kind: "degrade", target: "db", slowFactor: 2.5, ...window(1400, 2200) },
]);

export const distributedCache: CaseStudy = {
  id: "distributed-cache",
  title: "Distributed cache",
  summary: "Design a Memcached/Redis-style cache tier that absorbs most reads for a database. The hard parts are not the hash map: they are partitioning, hot keys, invalidation races and what happens when a cache node restarts empty.",
  requirements: {
    functional: ["get, set with TTL, delete for keys up to 250 B and values up to 1 MB.", "Used cache-aside by many services.", "Optional: atomic increment and compare-and-set."],
    nonFunctional: [
      "Sub-millisecond p99 inside a data centre.",
      "Sustain a hit rate high enough that the database never sees more than its capacity — including after a node restart.",
      "Losing a cache node must not take the database down.",
      "Stale reads bounded in time (TTL) and cleared on write (invalidation).",
    ],
  },
  estimates: [
    { label: "Read load", formula: "1M reads/s peak at the application tier", result: "the database can take ~50k reads/s → needs ≥ 95% hit rate" },
    { label: "Working set", formula: "100M active objects × ~1 KB", result: "≈ 100 GB of hot data" },
    { label: "Nodes", formula: "100 GB ÷ 25 GB usable per node (64 GB box, headroom for fragmentation and replicas)", result: "4 nodes by memory; 1M ops/s ÷ ~200k ops/s per node → 5; plan 8" },
    { label: "Losing one of 8 nodes", formula: "1/8 of keys miss at once × 1M reads/s", result: "≈ 125k reads/s extra at the database — 2.5× its capacity unless misses are coalesced or the node is replaced warm" },
    { label: "Network", formula: "1M/s × 1 KB", result: "≈ 1 GB/s across the tier — ~1 Gbit/s per node on 8 nodes" },
  ],
  api: [
    { signature: "get(key)", request: "key", response: "value | miss", endpointId: "get" },
    { signature: "set(key, value, ttl)", request: "key, value, TTL with jitter", response: "ok" },
    { signature: "delete(key)", request: "key", response: "ok", notes: "Writers delete after committing to the database (invalidation).", endpointId: "put" },
  ],
  dataModel: {
    entities: [profiles],
    notes: [
      "Keys are namespaced and versioned (profile:v3:{id}) so a schema change invalidates by changing the prefix.",
      "Each node is an LRU hash table with slab or arena allocation; eviction happens per node.",
      "The source of truth is the database; the cache holds disposable copies.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "No request coalescing",
      tradeoffs: "Simpler client, and in this simulated cell — fills take ~4 ms and popularity is moderately skewed — it changes surprisingly little: most post-restart misses are distinct long-tail keys, which coalescing cannot merge (try it). It pays off when a few keys are very hot relative to fill time: overlapping misses per key ≈ request rate for that key × fill time, so a key read 10,000 times a second with a 50 ms fill sends 500 queries without coalescing and 1 with it.",
    },
    {
      title: "Write-through (update the cache on write)",
      tradeoffs: "Reads after a write hit immediately. But two concurrent writers can set the cache in the opposite order to the database commits and leave the old value cached until TTL. Deleting is idempotent and order-safe; Facebook's memcache paper chose delete for that reason.",
    },
    {
      title: "Replicated cache (every node holds every key)",
      tradeoffs: "Survives node loss with no misses and spreads hot keys perfectly, but capacity is one node's memory and every write goes to every node. Good for small, very hot data (feature flags, configuration); partitioning is the only option for a 100 GB working set.",
    },
  ],
  failureScenarios: [
    {
      id: "cold-restart",
      title: "The cache restarts empty",
      explanation: "At t = 1.5 s the cache tier loses its contents (restart, or a failed deploy that flushes it).",
      scenario: restart,
      expect: "The hit rate drops to zero and the 8-worker database gets every read for a moment. Coalescing turns many concurrent misses per hot key into one database read each, so the hot set refills within a few hundred milliseconds and only the tail pays. Compare the alternative without coalescing.",
      check: { minGoodput: 0.97, clean: true },
    },
    {
      id: "restart-slow-db",
      title: "The cache restarts while the database is slow",
      explanation: "A deploy restarts the cache at t = 1.5 s while the database runs 2.5× slower because a migration is running. The database alone can now serve about 900 reads/s; the cold cache sends it four times that.",
      scenario: restartSlowDb,
      expect: "Most requests fail, and the system does not recover by itself while the database is slow. A database read that is rejected never fills the cache, so the cache stays cold and the database stays overloaded — a metastable failure. Coalescing cannot help much, because most misses are distinct long-tail keys. The fixes are on the load side: bounded queues and deadline propagation so abandoned requests are not served, warming the cache before taking traffic, and never restarting the cache during a database incident.",
      check: { maxGoodput: 0.8 },
    },
    {
      id: "slow-cache",
      title: "The cache becomes slower than its timeout",
      explanation: "From t = 1.5 s to 2.0 s cache operations take 40× longer (~8 ms), exceeding the 5 ms client timeout — a swapping or CPU-starved cache node.",
      scenario: variant(baseline, "cache-slow", [{ id: "slow", kind: "degrade", target: "cache", slowFactor: 40, ...window(1500, 2000) }]),
      expect: "Every read waits 5 ms, gives up and goes to the database, which cannot take the full read rate: queues grow, p99 approaches the 250 ms deadline and a few percent of requests miss it. A slow cache is worse than a dead one — the database load is the same, but every request also pays the timeout first.",
      check: { maxGoodput: 0.98, minP99Ms: 150 },
    },
    {
      id: "hot-key-writes",
      title: "Writes triple on popular keys",
      explanation: "The write share rises from 3% to 8% of requests while reads stay Zipf-skewed — every popular profile is being edited during an event. Each write deletes its key from the cache.",
      scenario: variant(baseline, "cache-hot-writes", [], { mix: { get: 0.92, put: 0.08 } }),
      expect: "Invalidations knock hot keys out of the cache over and over, so the hit rate falls and the database takes the extra misses on top of more than twice the writes. Coalescing caps each invalidated key at about one refill, but the database now runs near saturation and latency climbs: write-heavy hot keys are the case where caching an object stops paying.",
      check: { minGoodput: 0.98, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Partitioning: consistent hashing on the client",
      body: "Clients (or a proxy such as mcrouter or twemproxy) map each key to a node with consistent hashing, so adding or removing one of n nodes remaps only about 1/n of the keys instead of nearly all of them with hash mod n. Virtual nodes even out the load. Redis Cluster uses 16,384 fixed hash slots assigned to nodes, which is a directory variant of the same idea.",
    },
    {
      title: "Hot keys",
      body: "A single key can exceed one node's capacity — a celebrity profile or a configuration blob. Options: replicate the hot key under several names (key#1..key#k) and read a random one; keep a tiny in-process L1 cache with a TTL of a second or two; or detect hot keys and pin them to dedicated replicas. All of them trade freshness for load spreading.",
    },
    {
      title: "Invalidation races and leases",
      body: "Cache-aside has a classic race: a reader misses and reads v1 from the database; a writer commits v2 and deletes the key; the reader then sets v1, which stays until TTL. Facebook's memcache paper fixes it with leases: a miss returns a token, a delete invalidates outstanding tokens, and a set with an invalid token is ignored. Leases also throttle the stampede, since only the token holder fills a key.",
    },
    {
      title: "Surviving node loss",
      body: "A replacement node starts empty. Gutter pools (a small set of spare nodes that take over failed nodes' keys with short TTLs), cold-cluster warm-up (new nodes read through from warm ones), request coalescing and TTL jitter keep the database from seeing the full miss rate. Size the database for the worst plausible hit rate, not the average.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["'Cache things'.", "get/set/delete with TTL.", "Latency, hit-rate and staleness requirements.", "States the database's capacity as the real constraint on hit rate."] },
    { stage: "estimates", descriptors: ["None.", "Memory size.", "Memory, node count and required hit rate.", "Database load when a node is lost."] },
    { stage: "api", descriptors: ["get/set.", "Adds delete and TTL.", "Explains delete-on-write.", "Leases or CAS for safe fills."] },
    { stage: "data model", descriptors: ["A map.", "Key/value with TTL.", "Namespaced, versioned keys; LRU per node.", "Memory allocation and value-size limits."] },
    { stage: "high level", descriptors: ["One cache box.", "Cache cluster beside the database.", "Client-side consistent hashing.", "Proxy tier, replication choices and failure paths."] },
    { stage: "deep dive", descriptors: ["None.", "Eviction policy.", "Stampede and hot keys.", "Invalidation races and leases, gutter pools, warm-up."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Hit-rate metric.", "Names cold start and hot keys as risks.", "Alerts on hit rate and database headroom; runbook for node loss."] },
  ],
  clarifyingQuestions: [
    "What is the database's read capacity, and the peak read rate?",
    "How stale may cached data be?",
    "Value sizes and working-set size?",
    "Is the cache a pure cache, or do some features rely on it as storage?",
  ],
  commonMistakes: [
    "hash mod n partitioning that remaps everything on resize.",
    "Updating instead of deleting on write.",
    "Sizing the database for the average hit rate.",
    "No plan for hot keys or for a cold restart.",
    "Client timeouts that are longer than a database read, so a slow cache adds latency to every request.",
  ],
};
