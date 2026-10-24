import type { Step } from "@/engine/types";
import type { CaseStudy } from "./types";
import { cache, cacheAside, client, data, entity, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

const tweets = entity("tweets", "tweetdb", { tweetId: ["string", 8], authorId: ["int", 8], text: ["string", 280], createdAt: ["timestamp", 8] }, 20_000, {
  indexes: [{ name: "byAuthor", fields: ["authorId"], unique: false }],
  shardKey: "tweetId",
});
// Home timelines: ~800 tweet IDs per user, held in a replicated in-memory store (Redis at Twitter).
const timelines = entity("timelines", "tlstore", { userId: ["int", 8], tweetIds: ["string", 6400] }, 10_000);

// Read = precomputed timeline ∥ recent tweets from the few celebrities the user follows, merged.
const home: Step[] = [
  { type: "parallel", join: { kind: "all" }, cancelLosers: false, branches: [
    cacheAside("tlcache", [data("tlstore", "timelines", { kind: "get" }, 30)]),
    [data("tweetdb", "tweets", { kind: "query", index: "byAuthor", limit: 20 }, 50)],
  ] },
  respond(200),
];
// Write = store the tweet; fan out unless the author is above the follower threshold (~1% of tweets here).
const tweet: Step[] = [
  data("tweetdb", "tweets", { kind: "put" }, 100),
  { type: "branch", cond: { kind: "prob", p: 0.99 }, then: [publish("fanout")], else: [] },
  respond(201),
];
const handlers = { home, tweet };

const design = {
  schemaVersion: 1 as const,
  id: "twitter-timeline",
  name: "Twitter home timeline (hybrid fan-out)",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("tl1", "Timeline service 1", [2, 0], handlers),
    service("tl2", "Timeline service 2", [2, 2], handlers),
    cache("tlcache", "Timeline cache", [3, 0], 13_000_000, 30_000),
    node("tlstore", "kvStore", "Timeline store", [4, 0], { ...pool(96, 1.5), readTime: lognormal(1), writeTime: lognormal(1.5), members: 6, vnodes: 64, replicationFactor: 3, readQuorum: 1, writeQuorum: 2, hintedHandoff: true, readRepair: true, tombstoneGcUs: 864_000_000_000 }),
    node("tweetdb", "database", "Tweet store", [3, 2], { ...pool(32, 0.6, 600), readTime: lognormal(2), writeTime: lognormal(4), replicas: 1 }),
    node("fanout", "queue", "Fan-out queue", [3, 3], { partitions: 16, capacityMessages: 10_000, visibilityTimeoutUs: 500_000, maxDeliveries: 5, retentionUs: 86_400_000_000, publishTime: lognormal(1), costPerHour: 0.2, region: "us-east", zone: "a" }),
    // ~200 follower timelines per tweet, written in a batch.
    node("fanworker", "worker", "Fan-out service", [4, 3], { ...pool(16, 0.68), serviceTime: lognormal(15), source: "fanout", batchSize: 16 }, { tweet: [data("tlstore", "timelines", { kind: "put" }, 100), respond(200)] }),
  ],
  edges: [link("client", "lb"), link("lb", "tl1"), link("lb", "tl2"), ...["tl1", "tl2"].flatMap((s) => [link(s, "tlcache"), link(s, "tlstore"), link(s, "tweetdb"), link(s, "fanout")]), link("fanworker", "tlstore")],
  endpoints: [
    { id: "home", name: "GET /2/timeline/home", op: "read" as const, keyTemplate: "timeline:{userId}", requestBytes: 200, responseBytes: 12_000, idempotent: true },
    { id: "tweet", name: "POST /2/tweets", op: "write" as const, keyTemplate: "tweet:{tweetId}", requestBytes: 500, responseBytes: 200, idempotent: true, inputs: { tweetId: { kind: "sequence" as const, start: 0 } } },
  ],
  entities: [tweets, timelines],
};

const baseline = scenario("timeline-day", { arrival: { kind: "poisson", rps: 2500 }, mix: { home: 0.95, tweet: 0.05 }, keys: { kind: "zipf", n: 10_000, s: 1 }, deadlineMs: 400 });

export const twitterTimeline: CaseStudy = {
  id: "twitter-timeline",
  title: "Twitter home timeline",
  summary: "Serve home timelines at hundreds of thousands of reads per second. Twitter's answer was fan-out on write into in-memory timelines, with celebrities merged in at read time — a hybrid that bounds both read cost and write amplification.",
  requirements: {
    functional: ["Post a tweet.", "Read the home timeline: recent tweets from followed accounts, newest first.", "Read a user timeline (one author's tweets)."],
    nonFunctional: [
      "Home timeline p99 under ~200 ms; reads dominate writes by ~60:1.",
      "A tweet reaches followers' timelines within seconds; ~5 s is acceptable, minutes for the very largest accounts is not.",
      "Posting never blocks on fan-out.",
    ],
  },
  estimates: [
    { label: "Timeline reads", formula: "reported in 2012: ~300k QPS for timelines", result: "the read path must be one lookup, not a query" },
    { label: "Tweets", formula: "reported: ~5k tweets/s average, ~12k/s peak (400M tweets/day)", result: "small on its own" },
    { label: "Fan-out writes", formula: "5k tweets/s × ~200 followers average", result: "≈ 1M timeline inserts/s — the fan-out tier is the big write system" },
    { label: "Timeline memory", formula: "~150M active users × 800 IDs × 8 B (+ overhead) × 3 replicas", result: "≈ 3 TB of RAM across the Redis fleet; inactive users are not kept" },
    { label: "Celebrity", formula: "a tweet from an account with 30M followers", result: "30M inserts: seconds to minutes of fan-out — hence merge at read time above a threshold" },
  ],
  api: [
    { signature: "POST /2/tweets", request: "{ text, media? }", response: "201 { id }", endpointId: "tweet" },
    { signature: "GET /2/timeline/home?pagination_token=", request: "cursor = last seen tweet ID", response: "200 { tweets[], next }", notes: "Tweet IDs are time-ordered (Snowflake), so the cursor is just an ID.", endpointId: "home" },
  ],
  dataModel: {
    entities: [tweets, timelines],
    notes: [
      "tweets is the source of truth, keyed by a Snowflake ID (timestamp + worker + sequence), so IDs sort by time.",
      "timelines holds per-user lists of ~800 tweet IDs (plus author and flags) in memory, replicated 3×; it is a cache of a derived view and can be rebuilt.",
      "The follow graph is a separate service (FlockDB at the time) queried by the fan-out service.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Pure fan-out on write",
      tradeoffs: "Every read is one lookup — but a celebrity tweet becomes tens of millions of writes, delaying everyone else's fan-out behind it and bloating timelines that may never be read. The hybrid caps the worst case.",
    },
    {
      title: "Pure fan-out on read",
      tradeoffs: "No timeline storage and instant posting, but each read gathers recent tweets from hundreds of followed accounts across shards. At 300k reads/s that is tens of millions of index lookups per second with fan-out tail latency on every request.",
    },
  ],
  failureScenarios: [
    {
      id: "timeline-cache-loss",
      title: "The timeline cache is flushed",
      explanation: "The front cache restarts empty at t = 1.5 s.",
      scenario: variant(baseline, "timeline-cache-loss", [{ id: "flush", kind: "kill", target: "tlcache", ...window(1500, 1550) }]),
      expect: "Reads fall through to the replicated timeline store, which is sized for them, so latency rises briefly and nothing fails. The precomputed store is what makes a cache loss cheap; if timelines had to be recomputed from tweets, the same event would be an outage.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "fanout-slow",
      title: "The fan-out service slows down",
      explanation: "From t = 1.2 s to 2.2 s the fan-out workers run 6× slower — the follow-graph service they depend on is degraded.",
      scenario: variant(baseline, "timeline-fanout-slow", [{ id: "slow", kind: "degrade", target: "fanworker", slowFactor: 6, ...window(1200, 2200) }]),
      expect: "Posting and reading are unaffected; the fan-out queue grows and consumer lag rises from near zero to a few hundred milliseconds (seconds, with a longer incident), so new tweets appear late. That is the designed degradation: staleness instead of errors. The lag metric is the freshness SLO.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "event-spike",
      title: "A global event triples traffic",
      explanation: "From t = 1.2 s to 2.2 s everything triples — a final whistle or an election result.",
      scenario: variant(baseline, "timeline-spike", [{ id: "event", kind: "trafficSpike", target: "", multiplier: 3, ...window(1200, 2200) }]),
      expect: "Reads stay fast because every read is one cache or store lookup plus a small indexed query. The celebrity merge query is the part that grows with traffic on the tweet store, so the tweet store's utilisation is the one to watch.",
      check: { minGoodput: 0.98, clean: true },
    },
  ],
  deepDives: [
    {
      title: "The hybrid model",
      body: "For most authors, fan out on write: insert the tweet ID into each follower's in-memory timeline (skipping inactive users). For accounts above a follower threshold, skip fan-out; at read time, fetch recent tweets from the celebrities the reader follows and merge them with the precomputed timeline. Reads stay O(1) + a few small queries; writes stay O(followers) for ordinary accounts only.",
    },
    {
      title: "Timeline storage",
      body: "Timelines are lists of IDs, capped at about 800, replicated three times in Redis. They are derived data: if a replica is lost it is rebuilt from the tweet store and follow graph, slowly — so the system keeps replicas and avoids flushing them. Hydration (turning IDs into tweets with authors and counts) goes through separate caches with multi-get.",
    },
    {
      title: "IDs, ordering and pagination",
      body: "Snowflake IDs (41-bit millisecond timestamp, 10-bit worker ID, 12-bit sequence) are unique without coordination and roughly time-ordered, so merging timelines is a merge of sorted lists and cursors are IDs. Clock skew between workers only reorders tweets within a few milliseconds.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Post and read.", "Home vs user timeline.", "Read/write ratio and freshness target.", "Explicit staleness budget and celebrity behaviour."] },
    { stage: "estimates", descriptors: ["None.", "Read and write QPS.", "Fan-out write rate and timeline memory.", "Celebrity fan-out time and why it forces the hybrid."] },
    { stage: "api", descriptors: ["Endpoints.", "With pagination.", "Cursor by time-ordered ID.", "Explains why the ID design makes cursors and merges cheap."] },
    { stage: "data model", descriptors: ["Tweets table.", "Tweets and follows.", "Precomputed timelines of IDs.", "Caps, replication and rebuild of derived timelines."] },
    { stage: "high level", descriptors: ["Query on read.", "Fan-out on write.", "Hybrid with queue and fan-out service.", "Hydration caches and failure behaviour of each tier."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions Redis.", "Hybrid threshold and read-time merge.", "Inactive-user skipping, rebuilds and fan-out lag SLO."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Metrics.", "Fan-out lag and hot accounts as risks.", "Concrete freshness SLO and capacity plan for events."] },
  ],
  clarifyingQuestions: [
    "How skewed is the follower distribution?",
    "How fresh must the home timeline be?",
    "Ranked or chronological?",
    "How far back must the timeline paginate?",
  ],
  commonMistakes: [
    "Query-on-read at 300k QPS.",
    "Pure push with no celebrity handling.",
    "Storing tweet bodies in timelines.",
    "Treating derived timelines as primary data with no rebuild path.",
    "Ignoring inactive users in fan-out cost.",
  ],
};
