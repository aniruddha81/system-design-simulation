import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, cacheDelete, client, data, entity, find, link, loadBalancer, lognormal, node, pool, respond, scenario, service, variant, window } from "./kit";

const businesses = entity("businesses", "db", { businessId: ["int", 8], name: ["string", 60], geohash: ["string", 6], lat: ["float", 8], lng: ["float", 8], category: ["string", 20], rating: ["float", 4], details: ["string", 800] }, 20_000, {
  indexes: [{ name: "byGeohash", fields: ["geohash"], unique: false }],
  shardKey: "businessId",
});

const handlers = {
  // Nearby search: cell results are cached; a miss queries the geo index (an eventually consistent copy of the DB).
  nearby: cacheAside("cellcache", [data("geoindex", "businesses", { kind: "query", index: "byGeohash", limit: 50 }, 100)]),
  detail: cacheAside("cellcache", [data("db", "businesses", { kind: "get" }, 50)]),
  update: [data("db", "businesses", { kind: "update", field: "rating", op: "set", value: 4.5 }, 100), cacheDelete("cellcache"), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "proximity-service",
  name: "Proximity service",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "Search API 1", [2, 0], handlers),
    service("api2", "Search API 2", [2, 2], handlers),
    cache("cellcache", "Cell + detail cache", [3, 0], 7_000_000, 60_000),
    node("geoindex", "searchIndex", "Geo index (read replicas)", [4, 1], { ...pool(32, 0.8, 600), serviceTime: lognormal(2), indexLag: lognormal(500, 0.3), source: "db" }),
    node("db", "database", "Business DB", [3, 2], { ...pool(16, 0.6, 400), readTime: lognormal(2), writeTime: lognormal(4), replicas: 1 }),
  ],
  edges: [link("client", "lb"), link("lb", "api1"), link("lb", "api2"), ...["api1", "api2"].flatMap((a) => [link(a, "cellcache"), link(a, "geoindex"), link(a, "db")])],
  endpoints: [
    { id: "nearby", name: "GET /v1/search?lat&lng&radius", op: "read" as const, keyTemplate: "cell:{geohash}", requestBytes: 200, responseBytes: 5000, idempotent: true },
    { id: "detail", name: "GET /v1/businesses/:id", op: "read" as const, keyTemplate: "biz:{id}", requestBytes: 150, responseBytes: 1200, idempotent: true },
    { id: "update", name: "PUT /v1/businesses/:id", op: "write" as const, keyTemplate: "biz:{id}", requestBytes: 1200, responseBytes: 100, idempotent: true },
  ],
  entities: [businesses],
};

const baseline = scenario("proximity-day", { arrival: { kind: "poisson", rps: 3000 }, mix: { nearby: 0.6, detail: 0.39, update: 0.01 }, keys: { kind: "zipf", n: 20_000, s: 1.1 }, deadlineMs: 500 });

export const proximityService: CaseStudy = {
  id: "proximity-service",
  title: "Proximity service (Yelp nearby)",
  summary: "Find businesses near a location. The data barely changes and the queries are heavily concentrated on dense areas, so the design is a read-optimised geo index — geohash, quadtree or S2/H3 cells — replicated and cached, fed asynchronously from the source of truth.",
  requirements: {
    functional: ["Search businesses within a radius of a point, optionally filtered by category.", "View business details.", "Owners add or update businesses; changes may take minutes to appear in search."],
    nonFunctional: [
      "Search p99 under ~100 ms.",
      "Read-heavy: ~5,000 searches/s against a few updates per second.",
      "Highly available reads; eventual consistency for updates is acceptable.",
    ],
  },
  estimates: [
    { label: "Search rate", formula: "100M DAU × 5 searches/day ÷ 86,400", result: "≈ 5,800 searches/s average, ≈ 15k/s peak" },
    { label: "Data", formula: "200M businesses × ~1 KB", result: "≈ 200 GB of details; the geo index itself (ID + cell + lat/lng ≈ 30 B) is ≈ 6 GB — fits in memory on every replica" },
    { label: "Cell size", formula: "geohash length 6 ≈ 1.2 km × 0.6 km", result: "a 1 km radius search reads the cell and its 8 neighbours" },
    { label: "Index replicas", formula: "15k/s ÷ ~5k queries/s per replica (in-memory, 9 cell lookups + filtering)", result: "3 replicas per region plus headroom; no sharding needed for the index" },
    { label: "Write rate", formula: "~100k business updates/day", result: "≈ 1/s — rebuilding or patching the index asynchronously is cheap" },
  ],
  api: [
    { signature: "GET /v1/search?lat&lng&radius&category&cursor", request: "radius ≤ 20 km", response: "200 { businesses[], next }", endpointId: "nearby" },
    { signature: "GET /v1/businesses/{id}", request: "—", response: "200 { details }", endpointId: "detail" },
    { signature: "PUT /v1/businesses/{id}", request: "{ fields }", response: "200", notes: "Visible in details immediately (cache invalidated); in search after the index catches up.", endpointId: "update" },
  ],
  dataModel: {
    entities: [businesses],
    notes: [
      "businesses is the source of truth, sharded by businessId; the geohash column is derived from lat/lng on write.",
      "The geo index maps cell → business IDs (plus lat/lng for exact distance filtering). It is a read replica of the DB in a different shape, rebuilt or patched from a change stream.",
      "Search results for popular cells are cached for a minute; details are cached until updated.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "No geo index: scan the business table",
      tradeoffs: "A query without an index is a full scan of every business for every search. In the simulated cell the database scans 20,000 rows per search and saturates almost immediately — the reason geo indexes exist.",
      design: alter(design, "proximity-scan", "Proximity search by full scan", (d) => {
        for (const id of ["api1", "api2"]) find<"service">(d, id).handlers!.nearby = cacheAside("cellcache", [data("db", "businesses", { kind: "query", limit: 50 }, 100)]);
      }),
      check: { scenario: "baseline", maxGoodput: 0.9 },
    },
    {
      title: "Quadtree instead of fixed geohash cells",
      tradeoffs: "A quadtree splits a square until each leaf holds at most k businesses, so dense Manhattan gets tiny cells and the Sahara one big one: every query reads a similar number of results. It is built in memory at startup (seconds for 200M points) and updated incrementally. Geohash cells are simpler, work as a plain database index, but have very uneven occupancy.",
    },
    {
      title: "Database-native spatial index (PostGIS, R-tree)",
      tradeoffs: "Radius queries in SQL with an R-tree or GiST index, no separate system. Excellent up to a few thousand queries per second per replica; beyond that, read replicas or a dedicated in-memory index take over. Often the right first version.",
    },
  ],
  failureScenarios: [
    {
      id: "hot-cell",
      title: "Everyone searches Times Square",
      explanation: "New Year's Eve: one cell receives 30% of all searches.",
      scenario: variant(baseline, "proximity-hot-cell", [], { keys: { kind: "hotspot", n: 20_000, hotFraction: 0.3 } }),
      expect: "The hot cell's results are cached, so it costs one index query per minute. The rest of this scenario is spread uniformly, so the cache hit rate drops overall and the index replicas work harder — they have the headroom.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "index-down",
      title: "The geo index is unavailable",
      explanation: "The geo index replicas are down from t = 1.5 s to 2.0 s (a bad index build was rolled out).",
      scenario: variant(baseline, "proximity-index-down", [{ id: "index-down", kind: "kill", target: "geoindex", ...window(1500, 2000) }]),
      expect: "Cached cells keep answering; uncached searches time out. Details, which come from the database, are unaffected. A safer rollout would build the new index beside the old one and switch atomically, keeping the old one until the new one is verified.",
      check: { maxGoodput: 0.99, minGoodput: 0.8 },
    },
    {
      id: "slow-index",
      title: "Index replicas slow down 5×",
      explanation: "From t = 1.5 s to 2.3 s index queries take 5× longer — the replicas are rebuilding in the background and competing for CPU.",
      scenario: variant(baseline, "proximity-slow-index", [{ id: "slow", kind: "degrade", target: "geoindex", slowFactor: 5, ...window(1500, 2300) }]),
      expect: "Cache hits are unaffected; misses take ~10 ms longer and the index's worker pool gets busier. Because the cache absorbs most of the popular cells, the index never saturates.",
      check: { minGoodput: 0.99, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Geohash, and why you also query neighbours",
      body: "Geohash interleaves the bits of latitude and longitude and encodes them in base 32, so a prefix is a rectangle and longer prefixes are smaller rectangles (length 6 ≈ 1.2 × 0.6 km). Nearby points usually share a prefix, but not always: two points either side of a cell boundary can have completely different hashes. So a search computes the cell for the point and its 8 neighbours, fetches all candidates, and filters by exact distance.",
    },
    {
      title: "Choosing a cell size and handling density",
      body: "Pick the geohash length whose cell is about the search radius. In sparse areas a small radius returns nothing, so expand to a shorter prefix (bigger cells) until enough results come back. In dense areas fixed cells hold thousands of businesses; a quadtree, or Google's S2 cells (a hierarchy on a cube projection), adapt to density. Uber's H3 uses hexagons for uniform neighbour distances.",
    },
    {
      title: "Keeping the index fresh",
      body: "Business data changes rarely, so the index is a derived view: a change-data-capture stream from the business DB patches the in-memory index on each replica, with a nightly full rebuild as a safety net. The index lags the database by seconds to minutes, which the requirements allow; details are read from the database (through a cache invalidated on update), so an owner sees their own edit immediately.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["'Find nearby places'.", "Radius search and details.", "Read-heavy ratio, latency, freshness tolerance.", "Separates search freshness from detail freshness."] },
    { stage: "estimates", descriptors: ["None.", "QPS.", "Index size shows it fits in memory; replica count.", "Cell size chosen from search radius."] },
    { stage: "api", descriptors: ["Search endpoint.", "With radius and filters.", "Pagination and limits on radius.", "Owner update path and visibility semantics."] },
    { stage: "data model", descriptors: ["Lat/lng columns.", "Geohash column with an index.", "Source table + derived geo index.", "Density handling (quadtree/S2/H3) justified."] },
    { stage: "high level", descriptors: ["Query the database.", "Index + database.", "Replicated in-memory index, caches, async updates.", "Regional deployment and safe index rollout."] },
    { stage: "deep dive", descriptors: ["None.", "Explains geohash.", "Neighbour cells and boundary effects.", "Adaptive cells and CDC-based index updates."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Metrics.", "Hot cells and index lag as risks.", "Index build verification and rollback plan."] },
  ],
  clarifyingQuestions: ["Maximum search radius?", "Number of businesses and growth?", "How fast must updates appear in search?", "Filters and ranking needed?"],
  commonMistakes: [
    "Computing distance to every business per query.",
    "Querying only the point's own cell and missing results across the boundary.",
    "Sharding a small index that fits in memory.",
    "Synchronously updating the index in the owner's write path.",
    "Ignoring density differences between cities and rural areas.",
  ],
};
