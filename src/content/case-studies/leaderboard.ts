import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, client, data, entity, find, link, loadBalancer, lognormal, node, pool, respond, scenario, service, variant, window } from "./kit";

// Authoritative score history and player profile in durable storage; live rank queries are served from the in-memory sorted-set store.
const scores = entity("scores", "scoredb", { userId: ["int", 8], score: ["int", 8], updatedAt: ["timestamp", 8] }, 20_000, {
  indexes: [{ name: "byScore", fields: ["score"], unique: false }],
  shardKey: "userId",
});
const rankSet = entity("rankSet", "redis", { userId: ["int", 8], score: ["int", 8], rank: ["int", 4] }, 20_000);

const handlers = {
  // Update score in durable DB and in-memory sorted set (ZADD / ZINCRBY: O(log N) in-memory).
  submit: [
    data("redis", "rankSet", { kind: "put" }, 20),
    data("scoredb", "scores", { kind: "put" }, 60),
    respond(200),
  ],
  // Top-K leaderboard is identical for every viewer: cache it for 1 second in front of the sorted-set store.
  top: cacheAside("topcache", [data("redis", "rankSet", { kind: "get" }, 20)]),
  // Player's own rank + surrounding neighbours: O(log N) lookup in the in-memory sorted set.
  rank: [data("redis", "rankSet", { kind: "get" }, 20), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "leaderboard",
  name: "Real-time gaming leaderboard",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "Leaderboard API 1", [2, 0], handlers, 128, 0.5),
    service("api2", "Leaderboard API 2", [2, 2], handlers, 128, 0.5),
    cache("topcache", "Top-100 cache (1s TTL)", [3, 0], 4_000_000, 1000),
    node("redis", "kvStore", "Sorted-set rank store (Redis)", [3, 1], {
      ...pool(128, 1.4),
      readTime: lognormal(0.4),
      writeTime: lognormal(0.5),
      members: 6,
      vnodes: 64,
      replicationFactor: 2,
      readQuorum: 1,
      writeQuorum: 1,
      hintedHandoff: true,
      readRepair: false,
      tombstoneGcUs: 60_000_000,
    }),
    node("scoredb", "database", "Durable score ledger", [3, 2], {
      ...pool(32, 0.7, 600),
      readTime: lognormal(2),
      writeTime: lognormal(3),
      replicas: 2,
      replication: "semiSync",
      replicationLag: lognormal(1),
      walDurable: true,
    }),
  ],
  edges: [
    link("client", "lb"),
    link("lb", "api1"),
    link("lb", "api2"),
    ...["api1", "api2"].flatMap((a) => [link(a, "topcache"), link(a, "redis"), link(a, "scoredb")]),
  ],
  endpoints: [
    { id: "top", name: "GET /v1/leaderboards/:board/top", op: "read" as const, keyTemplate: "top:{id}", requestBytes: 120, responseBytes: 2000, idempotent: true },
    { id: "rank", name: "GET /v1/leaderboards/:board/users/:id", op: "read" as const, keyTemplate: "user:{id}", requestBytes: 150, responseBytes: 400, idempotent: true },
    { id: "submit", name: "POST /v1/leaderboards/:board/scores", op: "write" as const, keyTemplate: "score:{id}", requestBytes: 220, responseBytes: 120, idempotent: true },
  ],
  entities: [scores, rankSet],
};

const baseline = scenario("leaderboard-day", {
  arrival: { kind: "poisson", rps: 3000 },
  mix: { top: 0.45, rank: 0.35, submit: 0.2 },
  keys: { kind: "zipf", n: 20_000, s: 1.0 },
  deadlineMs: 300,
});

export const leaderboard: CaseStudy = {
  id: "leaderboard",
  title: "Real-time leaderboard",
  summary: "Rank millions of players by score in real time: update a player's score when a match ends, fetch the global top 100, and show any player their exact rank and neighbours. SQL `COUNT(*)` rank queries collapse at scale; augmented skip lists (Redis sorted sets) turn both updates and rank lookups into O(log N) memory operations.",
  requirements: {
    functional: [
      "Record a match score (increment or max-score update) for a user on a current tournament or daily/monthly board.",
      "Fetch the top K players (e.g., top 100) with their scores and ranks.",
      "Fetch any player's own global rank and the k players immediately above and below them.",
    ],
    nonFunctional: [
      "Score updates visible in rankings within ~100 ms; read p99 under ~50 ms.",
      "Support 25M DAU on a single global board without full-table scans.",
      "Durable score history so an in-memory node failure can be rebuilt without losing player points.",
    ],
  },
  estimates: [
    { label: "Score writes", formula: "25M DAU × 10 matches/day ÷ 86,400", result: "≈ 2,900 updates/s average, ≈ 9,000/s peak" },
    { label: "Rank & top-K reads", formula: "25M DAU × 20 views/day ÷ 86,400", result: "≈ 5,800 reads/s average, ≈ 18,000/s peak" },
    { label: "Sorted-set memory", formula: "25M users × ~64 B (8 B userId + 8 B score + skip-list pointers & hash entry)", result: "≈ 1.6 GB per board — fits in a single Redis instance's RAM!" },
    { label: "Skip-list ops", formula: "log₂(25,000,000) ≈ 25 pointer hops in RAM", result: "a single Redis thread serves ~50k–100k ZADD/ZREVRANK ops/s" },
    { label: "Tie-breaking", formula: "64-bit IEEE float (53-bit integer mantissa) or composite score", result: "(score << 20) | (MAX_TS - epochSec) breaks ties deterministically in favour of who reached the score first" },
  ],
  api: [
    { signature: "POST /v1/leaderboards/{boardId}/scores", request: "{ userId, delta, matchId } + Idempotency-Key", response: "200 { newScore, rank }", notes: "matchId deduplicates retried game-server reports.", endpointId: "submit" },
    { signature: "GET /v1/leaderboards/{boardId}/top?limit=100", request: "limit ≤ 100", response: "200 { entries[{ rank, userId, score }] }", endpointId: "top" },
    { signature: "GET /v1/leaderboards/{boardId}/users/{userId}?neighbours=5", request: "—", response: "200 { userId, score, rank, window[] }", endpointId: "rank" },
  ],
  dataModel: {
    entities: [scores, rankSet],
    notes: [
      "rankSet is an in-memory Redis sorted set (`ZSET`) per board (`leaderboard:2026-10`): it pairs a hash table (`userId → score`) with an augmented skip list whose forward pointers store the span (number of nodes skipped), giving O(log N) rank computation (`ZREVRANK`).",
      "scores is the durable ledger in a relational or wide-column store, used for auditing and rebuilding the sorted set if memory is lost.",
      "Display names and avatars are hydrated from a user profile cache by userId after fetching the top IDs.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "SQL ORDER BY / COUNT(*) on the durable database",
      tradeoffs: "No Redis tier to operate: compute a player's rank with `SELECT COUNT(*) FROM scores WHERE score > :myScore`. Even with a B-tree index, counting millions of rows per read scans index pages linearly (unless the DB maintains counted B-trees, which relational engines omit for concurrency). Run this alternative to see the database saturate under rank queries.",
      design: alter(design, "leaderboard-sql-scan", "Leaderboard using SQL scans", (d) => {
        for (const id of ["api1", "api2"]) {
          find<"service">(d, id).handlers = {
            submit: [data("scoredb", "scores", { kind: "put" }, 80), respond(200)],
            top: [data("scoredb", "scores", { kind: "query", limit: 100 }, 100), respond(200)],
            rank: [data("scoredb", "scores", { kind: "query", limit: 100 }, 100), respond(200)],
          };
        }
      }),
      check: { scenario: "baseline", maxGoodput: 0.7 },
    },
    {
      title: "Partitioned sorted sets: shard by score range (bucketing)",
      tradeoffs: "When a board outgrows one node's memory or write throughput (>100M players or >100k writes/s), sharding by `userId` requires scatter-gather for `ZREVRANK` because no shard knows how many higher scores live on other shards. Sharding by fixed score intervals (e.g., `[0..1000)`, `[1000..2000)`) plus a tiny summary table of shard counts lets a rank lookup sum the counts of higher shards and query `ZREVRANK` on the player's own shard.",
    },
    {
      title: "Approximate percentiles and histograms for massive casual games",
      tradeoffs: "Keep exact sorted sets only for the top 10,000 players and maintain coarse score-bucket counters (or a t-digest / HDR histogram) for everyone else, returning 'Top 4.2%' instead of '#1,048,291'. Cuts memory by 100× when exact tail ranks do not matter.",
    },
  ],
  failureScenarios: [
    {
      id: "tournament-finale",
      title: "Tournament finale: traffic doubles across the board",
      explanation: "During the final minute of a seasonal event (t = 1.2 s to 2.2 s), both score submissions and leaderboard views double to 6,000 rps.",
      scenario: variant(baseline, "leaderboard-finale", [{ id: "finale", kind: "trafficSpike", target: "", multiplier: 2, ...window(1200, 2200) }]),
      expect: "The 1-second top-100 cache coalesces global board views, and the in-memory sorted set handles the doubled rank and score operations in sub-millisecond time without dropping requests.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "top-cache-flush",
      title: "The top-100 cache restarts",
      explanation: "At t = 1.5 s the top-100 cache is flushed.",
      scenario: variant(baseline, "leaderboard-cache-flush", [{ id: "flush", kind: "kill", target: "topcache", ...window(1500, 1550) }]),
      expect: "Because `ZREVRANGE 0 99` on the sorted set is already an O(log N + 100) in-memory read (~0.4 ms), the rank store absorbs the cache misses effortlessly while the cache refills.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "db-slowdown",
      title: "The durable score ledger slows down 5×",
      explanation: "From t = 1.4 s to 2.2 s the relational score ledger experiences a 5× latency spike during a checkpoint.",
      scenario: variant(baseline, "leaderboard-db-slow", [{ id: "slow-db", kind: "degrade", target: "scoredb", slowFactor: 5, ...window(1400, 2200) }]),
      expect: "All `top` and `rank` reads (80% of traffic) hit only the cache and sorted-set store, so their latency is completely untouched. Score writes take ~15 ms instead of ~3 ms, well within the 60 ms timeout.",
      check: { minGoodput: 0.98, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Why augmented skip lists beat B-trees for live rank",
      body: "A standard B-tree or skip list finds a key in O(log N) time, but cannot tell you *how many items precede it* without walking every node from the head — O(N). Redis implements `ZSET` as a hash table (`member → score`) plus a skip list where each forward link is annotated with its *span* (the number of level-0 nodes it jumps over). Inserting or deleting updates the spans along the O(log N) search path; `ZREVRANK` sums the spans along the path to compute the exact 0-based rank in O(log N) time.",
    },
    {
      title: "Sharding beyond a single Redis node",
      body: "25M players occupy ~1.6 GB, so one primary + read replicas usually suffices. If you must shard across M nodes: (1) **Hash-partition by userId**: `ZINCRBY` routes to one node, `top 100` queries top 100 from all M nodes and merges M × 100 items, but exact `rank(userId)` requires asking all M nodes `ZCOUNT(score, +inf)` and summing. (2) **Range-partition by score bucket**: each node owns a score interval and maintains its total count; when a user's score crosses a bucket boundary, move them between two shards and update the bucket counts.",
    },
    {
      title: "Tie-breaking and tournament rotation",
      body: "Redis sorts members with identical scores lexicographically by member ID, which feels arbitrary to players. To reward the player who reached the score first, pack `(score, maxTimestamp - achievedAt)` into the 53-bit integer precision of a 64-bit float, or scale scores by `10^10` and add `9999999999 - epochSeconds`. For daily/monthly boards, include the period in the key (`board:2026-10`) so rotation is an instant key switch and old boards expire or archive cleanly.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Show top players.", "Adds score updates and player's own rank.", "Latency (<100 ms), DAU scale, tie-breaking, and seasonal/daily board rotation.", "Distinguishes global exact rank from friend leaderboards and approximate percentile tiers."] },
    { stage: "estimates", descriptors: ["None.", "QPS only.", "Calculates memory (~64 B × 25M ≈ 1.6 GB) and read/write QPS.", "Proves a 25M-user board fits in a single node's RAM and computes O(log N) op capacity."] },
    { stage: "api", descriptors: ["Submit and get top.", "Adds get user rank.", "Includes idempotent matchId on score updates and relative window (`±k` neighbours).", "Addresses anti-cheat server-to-server signing so clients cannot post raw scores."] },
    { stage: "data model", descriptors: ["Scores table.", "Adds index on score.", "Pairs an in-memory sorted set (`ZSET`) with a durable score ledger.", "Encodes deterministic timestamp tie-breaking inside the score representation."] },
    { stage: "high level", descriptors: ["API + SQL DB.", "Adds Redis.", "Sorted-set store for live rank, short-TTL top-K cache, durable ledger + profile hydration.", "Explains recovery/rebuild of the sorted set from the durable ledger or change stream."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions Redis ZSET commands.", "Explains augmented skip lists with span counters for O(log N) rank.", "Compares user-hash sharding vs score-range sharding when scaling past one node."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions monitoring.", "Identifies Redis failover and tournament-end spikes as main risks.", "Describes async write-behind via Kafka for extreme write spikes and reconciliation checks."] },
  ],
  clarifyingQuestions: [
    "How many active players are on a single leaderboard, and what is the peak score update rate?",
    "Are scores cumulative (incremented per match) or high-water-mark (best single run)?",
    "How should ties be broken — earlier timestamp wins?",
    "Do we need exact global rank for a player ranked #18,000,000, or is exact rank only needed for the top tier?",
  ],
  commonMistakes: [
    "Running `SELECT COUNT(*) FROM scores WHERE score > ?` on a relational database at scale.",
    "Assuming 25M players require a complex 50-node sharded cluster without calculating that 25M × 64 B is ~1.6 GB.",
    "Sharding a sorted set by `userId` and forgetting that `ZREVRANK` on one shard only gives the shard-local rank.",
    "Letting mobile clients call the score update endpoint directly instead of only accepting signed game-server reports.",
    "Storing only in Redis with no durable ledger to rebuild from after an accidental flush or region loss.",
  ],
};
