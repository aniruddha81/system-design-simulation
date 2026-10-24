import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, client, data, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

const posts = entity("posts", "db", { postId: ["string", 12], authorId: ["int", 8], text: ["string", 300], mediaKeys: ["string", 60], createdAt: ["timestamp", 8] }, 10_000, {
  indexes: [{ name: "byAuthor", fields: ["authorId"], unique: false }],
  shardKey: "authorId",
});
// One row per user: the precomputed feed (post IDs, newest first, capped at ~500).
const feeds = entity("feeds", "feedstore", { userId: ["int", 8], postIds: ["string", 4000] }, 10_000);

const handlers = {
  feed: cacheAside("feedcache", [data("feedstore", "feeds", { kind: "get" }, 50)]),
  // put with a client-generated post ID: a retried POST overwrites instead of duplicating.
  post: [data("db", "posts", { kind: "put" }, 100), publish("fanout"), respond(201)],
};

const design = {
  schemaVersion: 1 as const,
  id: "news-feed",
  name: "News feed (fan-out on write)",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "Feed API 1", [2, 0], handlers),
    service("api2", "Feed API 2", [2, 2], handlers),
    cache("feedcache", "Feed cache", [3, 0], 8_200_000, 30_000),
    node("db", "database", "Posts DB", [3, 2], { ...pool(16, 0.5, 400), readTime: lognormal(2), writeTime: lognormal(4), replicas: 1 }),
    node("fanout", "queue", "Fan-out queue", [3, 3], { partitions: 8, capacityMessages: 5000, visibilityTimeoutUs: 500_000, maxDeliveries: 5, retentionUs: 3_600_000_000, publishTime: lognormal(1), costPerHour: 0.1, region: "us-east", zone: "a" }),
    // Each message fans one post out to ~200 followers' feeds: ~20 ms of batched writes.
    node("fanworker", "worker", "Fan-out workers", [4, 3], { ...pool(8, 0.34), serviceTime: lognormal(20), source: "fanout", batchSize: 8 }, { post: [data("feedstore", "feeds", { kind: "put" }, 100), respond(200)] }),
    node("feedstore", "kvStore", "Feed store", [4, 1], { ...pool(64, 0.9), readTime: lognormal(1.5), writeTime: lognormal(2), members: 6, vnodes: 64, replicationFactor: 3, readQuorum: 2, writeQuorum: 2, hintedHandoff: true, readRepair: true, tombstoneGcUs: 864_000_000_000 }),
  ],
  edges: [link("client", "lb"), link("lb", "api1"), link("lb", "api2"), ...["api1", "api2"].flatMap((a) => [link(a, "feedcache"), link(a, "db"), link(a, "feedstore"), link(a, "fanout")]), link("fanworker", "feedstore")],
  endpoints: [
    { id: "feed", name: "GET /v1/feed", op: "read" as const, keyTemplate: "feed:{userId}", requestBytes: 200, responseBytes: 8000, idempotent: true },
    { id: "post", name: "POST /v1/posts", op: "write" as const, keyTemplate: "post:{postId}", requestBytes: 600, responseBytes: 200, idempotent: false, inputs: { postId: { kind: "sequence" as const, start: 0 } } },
  ],
  entities: [posts, feeds],
};

const baseline = scenario("feed-day", { arrival: { kind: "poisson", rps: 1500 }, mix: { feed: 0.9, post: 0.1 }, keys: { kind: "zipf", n: 10_000, s: 1 }, deadlineMs: 500 });
const workerCrash = variant(baseline, "feed-worker-crash", [{ id: "workers-down", kind: "kill", target: "fanworker", ...window(1300, 1900) }]);

export const newsFeed: CaseStudy = {
  id: "news-feed",
  title: "News feed",
  summary: "Show each user a feed of recent posts from the people they follow. The central decision is when to do the work: at write time (fan-out on write, cheap reads) or at read time (fan-out on read, cheap writes).",
  requirements: {
    functional: ["Publish a post (text, media references).", "Read a feed of recent posts from followed accounts, newest first (ranking is out of scope here), paginated.", "Follow and unfollow."],
    nonFunctional: [
      "Feed reads p99 under 200 ms; reads outnumber posts ~100:1.",
      "A new post appears in followers' feeds within a few seconds (eventual consistency is fine).",
      "Posting must stay fast and available even when fan-out lags.",
    ],
  },
  estimates: [
    { label: "Feed reads", formula: "300M DAU × 10 feed loads/day ÷ 86,400", result: "≈ 35k reads/s average, ≈ 70k/s peak" },
    { label: "Posts", formula: "300M × 0.1 posts/day ÷ 86,400", result: "≈ 350 posts/s average" },
    { label: "Fan-out writes", formula: "350 posts/s × 200 followers (median-ish)", result: "≈ 70k feed inserts/s — write amplification of 200×" },
    { label: "Feed storage", formula: "300M feeds × 500 post IDs × 8 B", result: "≈ 1.2 TB of IDs — feeds store IDs, not post bodies" },
    { label: "Celebrity post", formula: "one account with 50M followers", result: "50M inserts for one post: at 70k/s, ~12 minutes of the whole fan-out tier — the reason for the hybrid model" },
  ],
  api: [
    { signature: "POST /v1/posts", request: "{ text, mediaIds[] } + Idempotency-Key", response: "201 { postId }", endpointId: "post" },
    { signature: "GET /v1/feed?cursor=", request: "cursor (opaque, encodes last seen post ID)", response: "200 { posts[], nextCursor }", notes: "Cursor pagination stays stable while new posts arrive; offsets skip or repeat items.", endpointId: "feed" },
    { signature: "POST /v1/follows/{userId}", request: "—", response: "204", notes: "Optionally backfills recent posts into the follower's feed." },
  ],
  dataModel: {
    entities: [posts, feeds],
    notes: [
      "posts is the source of truth, sharded by author so 'posts by author X' is one shard.",
      "feeds holds one precomputed list of post IDs per user in a KV store; post bodies are hydrated from a post cache at read time.",
      "The follow graph (follower → followee, both directions indexed) lives in its own store and is read by the fan-out workers.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Fan-out on read (pull)",
      tradeoffs: "No fan-out tier and no write amplification: a feed read queries recent posts for every followed account and merges them. Posting is trivial, but every read becomes a scatter-gather over hundreds of authors, so read latency and database load grow with the follow count. In the simulator each feed read becomes a scatter-gather of 8 indexed queries, one per posts shard, so the posts database takes 8 queries per read and every read waits for the slowest shard. At this read rate that is more than the database can serve, and most reads fail — the same hardware that comfortably serves the push design.",
      design: alter(design, "news-feed-pull", "News feed (fan-out on read)", (d) => {
        // Scatter-gather: one indexed query per posts shard (8 here), merged when all return.
        const shardQuery = [data("db", "posts", { kind: "query", index: "byAuthor", limit: 50 }, 200)];
        for (const id of ["api1", "api2"]) find<"service">(d, id).handlers!.feed = [{ type: "parallel", branches: Array.from({ length: 8 }, () => structuredClone(shardQuery)), join: { kind: "all" }, cancelLosers: false }, respond(200)];
      }),
      check: { scenario: "baseline", maxGoodput: 0.8 },
    },
    {
      title: "Append post IDs instead of writing idempotently",
      tradeoffs: "Appending is natural ('push post ID onto the list'), but a fan-out worker that crashes after writing and before acknowledging the message gets it redelivered and appends the same post twice. Write fan-out entries keyed by post ID (a set or sorted set) so a redelivery is a no-op.",
      design: alter(design, "news-feed-append", "Fan-out with appends", (d) => {
        find<"worker">(d, "fanworker").handlers = { post: [data("feedstore", "feeds", { kind: "update", field: "postIds", op: "append", value: "p" }, 100), respond(200)] };
      }),
      check: { scenario: "worker-crash", violations: ["duplicateEffect"] },
    },
    {
      title: "Hybrid: push for most, pull for celebrities",
      tradeoffs: "Fan out on write for accounts below a follower threshold; for celebrities, skip fan-out and merge their recent posts at read time. Twitter's timeline service works this way. See the Twitter timeline case study.",
    },
  ],
  failureScenarios: [
    {
      id: "post-surge",
      title: "Posting surges 4× during a live event",
      explanation: "From t = 1.2 s to 2.2 s all traffic quadruples; posts go from 150/s to 600/s, beyond the fan-out workers' ~400 posts/s.",
      scenario: variant(baseline, "feed-surge", [{ id: "event", kind: "trafficSpike", target: "", multiplier: 4, ...window(1200, 2200) }]),
      expect: "Posting stays fast because it only writes the post and enqueues one message. The fan-out queue absorbs the excess — its depth and consumer lag grow and drain after the surge — so new posts reach feeds late but nothing fails. The queue converts a load spike into delay.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "worker-crash",
      title: "The fan-out workers crash",
      explanation: "All fan-out workers die from t = 1.3 s to 1.9 s. Messages they were processing are not acknowledged and become visible again after the 500 ms visibility timeout.",
      scenario: workerCrash,
      expect: "Feeds stop updating for the outage, then the backlog drains. In-flight messages are redelivered; because the reference worker writes feed entries idempotently, redelivery creates no duplicates. Users never see an error, only staleness.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "feed-cache-loss",
      title: "The feed cache is flushed",
      explanation: "The feed cache restarts empty at t = 1.5 s.",
      scenario: variant(baseline, "feed-cache-loss", [{ id: "flush", kind: "kill", target: "feedcache", ...window(1500, 1550) }]),
      expect: "Feed reads fall through to the KV feed store, which is sized to take them: latency rises a little and the cache refills. Precomputed feeds make a cache loss cheap — in a pull design a cache loss means recomputing every feed.",
      check: { minGoodput: 0.99, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Push, pull or hybrid",
      body: "Fan-out on write costs (posts/s × average followers) writes but makes a feed read one key lookup. Fan-out on read costs (feed reads/s × accounts followed) lookups but posting is free. With 100 reads per post and a median of a few hundred followers, push wins for ordinary accounts. A celebrity with tens of millions of followers breaks push — one post is minutes of fan-out — so hybrid systems skip fan-out above a threshold and merge celebrity posts at read time.",
    },
    {
      title: "Feed storage and hydration",
      body: "Store post IDs only, capped at a few hundred per user; older pages are computed on demand. A feed read fetches the ID list, then hydrates posts and authors with batched multi-gets from caches. Inactive users can be skipped during fan-out and rebuilt on their next visit, which removes a large share of fan-out writes.",
    },
    {
      title: "Idempotent fan-out and ordering",
      body: "The queue delivers at least once, so fan-out must be idempotent: add the post ID to a set or sorted set keyed by post ID rather than appending. Feeds sort by post timestamp or a time-ordered ID (Snowflake-style), so out-of-order fan-out does not matter. Deleting a post removes it from the source; readers filter deleted IDs at hydration instead of un-fanning out.",
    },
    {
      title: "Ranking",
      body: "Ranked feeds keep the same pipeline but replace 'newest first' with a scoring pass at read time over a few hundred candidates (from the precomputed list plus other sources). The candidate generation is the system-design problem; the scoring model is not.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Post and read.", "Adds follows and pagination.", "Read/write ratio and freshness target.", "Distinguishes availability of posting from freshness of feeds."] },
    { stage: "estimates", descriptors: ["None.", "QPS only.", "QPS, fan-out write rate and feed storage.", "Celebrity fan-out cost and its consequence."] },
    { stage: "api", descriptors: ["Endpoints only.", "Post/feed/follow with codes.", "Cursor pagination and idempotent posting.", "Explains why offset pagination breaks with live data."] },
    { stage: "data model", descriptors: ["One table.", "Posts and follows.", "Posts by author, precomputed feeds of IDs.", "Caps, hydration and storage per user justified."] },
    { stage: "high level", descriptors: ["Query at read time without analysis.", "Push or pull chosen.", "Push with queue, workers and feed store.", "Hybrid with celebrity handling and caches on hydration."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions caching.", "Push vs pull with numbers.", "Idempotent fan-out, inactive users and deletes."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Metrics.", "Consumer lag and hot accounts as risks.", "Freshness SLO on fan-out lag with alerting and backfill plans."] },
  ],
  clarifyingQuestions: [
    "Chronological or ranked feed?",
    "Follower count distribution — are there accounts with millions of followers?",
    "How fresh must a feed be?",
    "Media in posts, and is hydration in scope?",
  ],
  commonMistakes: [
    "Pure fan-out on write with no celebrity strategy.",
    "Storing full post bodies in every follower's feed.",
    "Non-idempotent fan-out with at-least-once delivery.",
    "Offset pagination on a live feed.",
    "Doing fan-out synchronously in the post request.",
  ],
};
