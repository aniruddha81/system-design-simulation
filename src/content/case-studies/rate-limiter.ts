import type { CaseStudy } from "./types";
import { alter, client, constant, data, entity, link, loadBalancer, lognormal, node, pool, respond, scenario, service, variant, window } from "./kit";

const orders = entity("orders", "db", { id: ["string", 12], accountId: ["int", 8], amount: ["int", 8], status: ["string", 10] }, 5_000);
// The protected backend: each request does ~8 ms of work and one database read.
const handlers = { request: [data("db", "orders", { kind: "get" }, 100), respond(200)] };
const limiter = (id: string, at: [number, number], ratePerSec: number, burst: number, centralised: boolean) =>
  node(id, "rateLimiter", centralised ? "Rate limiter (shared counters)" : "Local limiter", at, { ...pool(512, 0.2), serviceTime: constant(0.1), algorithm: "tokenBucket", ratePerSec, burst, centralised });

const design = {
  schemaVersion: 1 as const,
  id: "rate-limiter",
  name: "Rate-limited API",
  nodes: [
    client("gw"),
    node("gw", "apiGateway", "API gateway", [1, 1], { ...pool(2048, 0.1), serviceTime: lognormal(0.5), maxRequestBytes: 1_000_000 }),
    limiter("rl", [2, 1], 2000, 400, true),
    loadBalancer("lb", [3, 1]),
    service("api1", "API 1", [4, 0], handlers, 16, 8),
    service("api2", "API 2", [4, 2], handlers, 16, 8),
    node("db", "database", "Orders DB", [5, 1], { ...pool(32, 0.5, 400), readTime: lognormal(2), writeTime: lognormal(4), replicas: 1 }),
  ],
  edges: [link("client", "gw"), link("gw", "rl"), link("rl", "lb"), link("lb", "api1"), link("lb", "api2"), link("api1", "db"), link("api2", "db")],
  endpoints: [{ id: "request", name: "GET /v1/orders/:id", op: "read" as const, keyTemplate: "order:{id}", requestBytes: 400, responseBytes: 800, idempotent: true }],
  entities: [orders],
};

const baseline = scenario("rate-limiter-day", { arrival: { kind: "poisson", rps: 1000 }, mix: { request: 1 }, keys: { kind: "uniform", n: 5_000 }, deadlineMs: 500 });
const burst = variant(baseline, "rate-limiter-abuse", [{ id: "abusive-client", kind: "trafficSpike", target: "", multiplier: 6, ...window(1300, 2300) }]);

export const rateLimiter: CaseStudy = {
  id: "rate-limiter",
  title: "Rate limiter",
  summary: "Protect an API from overload and abuse by rejecting excess requests early with 429. The design choices are the algorithm, where the counters live, and what happens when the limiter itself is slow or down.",
  requirements: {
    functional: [
      "Limit requests per client (API key, user or IP) per rule, e.g. 100 requests/minute, with short bursts allowed.",
      "Rejected requests get 429 Too Many Requests with Retry-After and rate-limit headers.",
      "Rules are configurable per endpoint and per plan without a deploy.",
    ],
    nonFunctional: [
      "Adds under 1 ms p99 to each request.",
      "Limits hold across all API servers (a client cannot multiply its quota by hitting different servers), within a small tolerance.",
      "A limiter failure must not take the API down: decide fail-open or fail-closed explicitly.",
    ],
  },
  estimates: [
    { label: "Check rate", formula: "every API request is checked: 50k req/s peak", result: "50k counter operations/s" },
    { label: "Counter state", formula: "1M active clients × 3 rules × ~50 B (key, count, timestamp)", result: "≈ 150 MB — fits in memory on one Redis node" },
    { label: "Counter store throughput", formula: "~100k simple ops/s per Redis shard", result: "1 shard suffices; run 3 shards for headroom and blast radius" },
    { label: "Latency budget", formula: "same-AZ round trip ≈ 0.5 ms + Redis op ≈ 0.1 ms", result: "≈ 0.6 ms per check, inside the 1 ms budget" },
    { label: "Protected capacity", formula: "2 API servers × 16 workers ÷ ~10 ms per request (simulated cell)", result: "≈ 3,200 req/s; the global limit is set to 2,000/s with a 400-token burst, below saturation" },
  ],
  api: [
    { signature: "Any API call", request: "API key / user identity", response: "pass-through · 429 { error } + Retry-After, RateLimit-Limit, RateLimit-Remaining", endpointId: "request" },
    { signature: "PUT /internal/limits/{rule}", request: "{ match, limit, window, burst }", response: "200", notes: "Rules are pushed to limiters through config, cached locally." },
  ],
  dataModel: {
    entities: [orders],
    notes: [
      "Counter state is a key per (client, rule): token bucket = (tokens, lastRefill); sliding window counter = (current count, previous count, window start).",
      "Keys carry a TTL slightly longer than the window, so idle clients cost nothing.",
      "The orders entity is the protected backend's data, not limiter state.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "No limiter",
      tradeoffs: "Nothing to operate, no extra hop. Under a 6× burst the backend still completes about as many requests as it can — roughly the same goodput — but every request now waits in a full queue: median latency rises about 10×, failures arrive as slow timeouts instead of instant 429s, and the work spent on requests that time out is wasted.",
      design: alter(design, "rate-limiter-none", "API without a limiter", (d) => {
        d.nodes = d.nodes.filter((n) => n.id !== "rl");
        d.edges = d.edges.filter((e) => e.from !== "rl" && e.to !== "rl").concat(link("gw", "lb"));
      }),
      check: { scenario: "abusive-burst", maxGoodput: 0.6, minP99Ms: 300 },
    },
    {
      title: "Local in-process limiters",
      tradeoffs: "No network hop and no shared dependency to fail. But each server only sees its own traffic, so the effective limit is (per-server limit × number of servers) and drifts as the fleet scales or the load balancer skews. Good as a coarse first line; pair it with shared counters for per-client quotas.",
      design: alter(design, "rate-limiter-local", "Local limiters", (d) => {
        d.nodes = d.nodes.filter((n) => n.id !== "rl");
        d.nodes.push(limiter("rl1", [3.5, 0], 1000, 200, false), limiter("rl2", [3.5, 2], 1000, 200, false));
        d.edges = [link("client", "gw"), link("gw", "lb"), link("lb", "rl1"), link("lb", "rl2"), link("rl1", "api1"), link("rl2", "api2"), link("api1", "db"), link("api2", "db")];
      }),
      check: { scenario: "abusive-burst", minGoodput: 0.3 },
    },
    {
      title: "Sliding window instead of token bucket",
      tradeoffs: "A fixed window lets a client send 2× the limit across a window boundary. A sliding-window log is exact but stores every timestamp; the sliding-window counter (weighting the previous window's count) is a cheap approximation that Cloudflare reported to be within a fraction of a percent of exact. A token bucket expresses 'sustained rate plus burst' directly, which is usually what a quota means.",
    },
  ],
  failureScenarios: [
    {
      id: "abusive-burst",
      title: "One client sends 6× the normal traffic",
      explanation: "From t = 1.3 s to 2.3 s the offered load jumps from 1,000 to 6,000 req/s — a misbehaving batch job or a scraper.",
      scenario: burst,
      expect: "The limiter admits about 2,000 req/s plus the burst and answers the rest with 429 in well under a millisecond. Admitted requests stay fast, because the backend never runs past about two-thirds utilisation. Goodput falls, since a 429 is a failure from the client's point of view. The simulated limiter is one global bucket, so it rejects well-behaved clients too; with per-client buckets the 429s would land on the abusive client alone.",
      check: { minGoodput: 0.3, maxGoodput: 0.8, maxP99Ms: 200, clean: true },
    },
    {
      id: "slow-limiter",
      title: "The counter store becomes slow",
      explanation: "From t = 1.5 s to 2.3 s every limiter check takes 50× longer — a Redis failover or a hot shard.",
      scenario: variant(baseline, "rate-limiter-slow", [{ id: "slow-counters", kind: "degrade", target: "rl", slowFactor: 50, ...window(1500, 2300) }]),
      expect: "Every request pays the slowdown, because the limiter sits in the request path. Latency rises for all clients even though nobody is over quota. Production limiters put a tight timeout on the counter call and fail open (allow) when it expires.",
      check: { minGoodput: 0.9, minP99Ms: 50, clean: true },
    },
    {
      id: "limiter-down",
      title: "The limiter goes down",
      explanation: "The limiter is killed from t = 1.5 s to 2.0 s.",
      scenario: variant(baseline, "rate-limiter-down", [{ id: "limiter-dead", kind: "kill", target: "rl", ...window(1500, 2000) }]),
      expect: "Requests time out for the whole outage: in this topology the limiter fails closed, so a protection layer became a single point of failure. Fail-open with a local fallback limit keeps the API up and still bounds the damage.",
      check: { maxGoodput: 0.8 },
    },
  ],
  deepDives: [
    {
      title: "Choosing the algorithm",
      body: "Token bucket: a bucket of capacity B refills at r tokens/s; a request takes a token or is rejected. It allows bursts of B and a sustained rate of r, and needs two numbers per key. Leaky bucket smooths output to a constant rate (useful in front of a fragile dependency). Fixed window is one counter per window but lets 2× the limit through at a boundary. Sliding-window counter estimates the rolling count as current + previous × (overlap fraction), fixing most of the boundary problem for one extra number.",
    },
    {
      title: "Where the counters live",
      body: "Shared counters in Redis make limits global, at the cost of one round trip per request. Make the check atomic — a Lua script or INCR with EXPIRE — otherwise two servers read the same count and both allow. To cut the round trip, servers can batch: take tokens locally in chunks and sync every few hundred milliseconds, accepting a small overshoot. Shard counters by client key so one hot client cannot overload all shards.",
    },
    {
      title: "Failure policy and layering",
      body: "Decide per rule: abuse protection can fail open (an outage of the limiter should not be an outage of the API), while hard financial quotas may fail closed. Layer limits: a coarse per-IP limit at the edge or CDN against floods, per-key quotas at the gateway, and concurrency limits (bulkheads) inside services for overload that rate limits cannot see — a slow dependency at normal rate still exhausts workers.",
    },
    {
      title: "Being a good 429",
      body: "Return 429 with Retry-After so well-behaved clients back off, and the RateLimit headers so they can pace themselves. Clients must retry with exponential backoff and jitter; synchronised retries at exactly Retry-After create a new burst.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["'Limit requests'.", "Per-client limits with a window.", "Burst policy, accuracy tolerance and latency budget.", "Explicit fail-open/closed policy and rule configurability."] },
    { stage: "estimates", descriptors: ["None.", "Request rate.", "Counter memory and store throughput.", "Latency budget per check and shard count with headroom."] },
    { stage: "api", descriptors: ["None.", "Returns an error when limited.", "429 with Retry-After and limit headers.", "Rule management API and propagation."] },
    { stage: "data model", descriptors: ["None.", "A counter per client.", "Algorithm-specific state with TTLs.", "Atomic update strategy and key sharding."] },
    { stage: "high level", descriptors: ["Limiter in the service code only.", "Shared counter store.", "Limiter at the gateway, before expensive work.", "Layered edge + gateway + concurrency limits."] },
    { stage: "deep dive", descriptors: ["None.", "Names one algorithm.", "Compares algorithms including boundary bursts.", "Handles races, batching and failure policy."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions metrics.", "Names limiter latency and availability as risks.", "Defines 429-rate and fail-open alerts and a rollout plan for new rules."] },
  ],
  clarifyingQuestions: [
    "What identifies a client: API key, user, IP?",
    "Is the limit a hard quota (billing) or overload protection?",
    "Are bursts allowed, and how large?",
    "Must the limit be exact across all servers, or is a few percent of overshoot fine?",
    "What should happen if the limiter is unavailable?",
  ],
  commonMistakes: [
    "Read-then-write counter updates that race across servers.",
    "A fixed window without acknowledging the 2× boundary burst.",
    "Putting the limiter in the request path with no timeout and no failure policy.",
    "Per-server limits presented as global limits.",
    "Using rate limits as the only overload protection.",
  ],
};
