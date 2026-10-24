// Parameterised question templates (PLAN §2, §9). Each template declares its parameter
// ranges and a solver; variants come from a seed and the solver computes the answer key,
// so no answer is ever hand-computed.

export type ParamSpec = { min: number; max: number; step: number };
export type Params = Record<string, number>;

export type Template = {
  id: string;
  objective: string;
  /** Lesson step that teaches this objective; wrong answers link back to it. */
  step: string;
  params: Record<string, ParamSpec>;
  unit: string;
  /** Relative tolerance, e.g. 0.02 = within ±2%. */
  tolerance: number;
  prompt: (p: Params) => string;
  solve: (p: Params) => number;
  /** Variants the solver rejects are re-rolled (e.g. capacity must be below load). */
  valid?: (p: Params) => boolean;
  /** Predictable wrong answers with targeted feedback. */
  mistakes?: (p: Params) => { value: number; feedback: string }[];
  /** Shown after any wrong answer that is not a known mistake. */
  hint: string;
};

export type Variant = { templateId: string; seed: number; params: Params; answer: number };

/** mulberry32: tiny, fast, good enough for picking parameters. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit seed from a string, so server and client render the same first variant. */
export function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export function generate(template: Template, seed: number): Variant {
  const next = rng(seed);
  for (let attempt = 0; attempt < 100; attempt++) {
    const params: Params = {};
    for (const [name, { min, max, step }] of Object.entries(template.params)) {
      const steps = Math.floor((max - min) / step);
      params[name] = round(min + Math.floor(next() * (steps + 1)) * step);
    }
    if (template.valid && !template.valid(params)) continue;
    const answer = template.solve(params);
    if (Number.isFinite(answer)) return { templateId: template.id, seed, params, answer };
  }
  throw new Error(`Template ${template.id} produced no valid variant for seed ${seed}`);
}

/** Accepts "12,000", " 12000 ", "1.5e3". */
export function parseAnswer(text: string): number | null {
  const cleaned = text.replace(/[,\s_]/g, "").replace(/%$/, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function isCorrect(template: Template, variant: Variant, value: number): boolean {
  const tol = Math.max(Math.abs(variant.answer) * template.tolerance, 1e-9);
  return Math.abs(value - variant.answer) <= tol;
}

/** Targeted feedback for a wrong answer: a known mistake, else the template hint. */
export function diagnose(template: Template, variant: Variant, value: number): string {
  for (const m of template.mistakes?.(variant.params) ?? []) {
    if (Math.abs(value - m.value) <= Math.max(Math.abs(m.value) * template.tolerance, 1e-9)) return m.feedback;
  }
  return template.hint;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (f: number) => `${round(f * 100)}%`;
/** Harmonic number H_n (exact below 1,000, asymptotic above). */
function harmonic(n: number): number {
  if (n < 1000) {
    let s = 0;
    for (let i = 1; i <= n; i++) s += 1 / i;
    return s;
  }
  return Math.log(n) + 0.5772156649 + 1 / (2 * n) - 1 / (12 * n * n);
}

export const templates: Record<string, Template> = {
  "cache.db-load": {
    id: "cache.db-load",
    objective: "predict-db-load",
    step: "db-load",
    params: { rps: { min: 2000, max: 60000, step: 1000 }, hit: { min: 0.6, max: 0.97, step: 0.01 } },
    unit: "rps",
    tolerance: 0.02,
    prompt: (p) =>
      `A service receives ${fmt(p.rps)} reads per second. The cache-aside hit rate is ${pct(p.hit)}. How many reads per second reach the database?`,
    solve: (p) => p.rps * (1 - p.hit),
    mistakes: (p) => [
      { value: p.rps * p.hit, feedback: "That is the traffic the cache absorbs. Only misses go to the database: multiply by (1 − hit rate)." },
      { value: p.rps, feedback: "That assumes no hits. Hits are answered by the cache and never reach the database." },
    ],
    hint: "Database reads = request rate × miss rate, and miss rate = 1 − hit rate.",
  },
  "cache.hit-rate-needed": {
    id: "cache.hit-rate-needed",
    objective: "predict-db-load",
    step: "hit-rate-needed",
    params: { rps: { min: 10000, max: 100000, step: 5000 }, capacity: { min: 1000, max: 20000, step: 500 } },
    unit: "%",
    tolerance: 0.01,
    valid: (p) => p.capacity < p.rps * 0.45,
    prompt: (p) =>
      `Peak load is ${fmt(p.rps)} reads per second and the database saturates at ${fmt(p.capacity)} reads per second. What is the minimum cache hit rate, in percent, that keeps the database below saturation?`,
    solve: (p) => (1 - p.capacity / p.rps) * 100,
    mistakes: (p) => [
      { value: (p.capacity / p.rps) * 100, feedback: "That is the share of traffic the database can take, which is the maximum miss rate. The hit rate is 100% minus that." },
    ],
    hint: "The miss rate may be at most capacity ÷ load; the hit rate is 1 minus that.",
  },
  "cache.zipf-coverage": {
    id: "cache.zipf-coverage",
    objective: "hit-rate-from-skew",
    step: "skew",
    params: { keys: { min: 100000, max: 10000000, step: 100000 }, cached: { min: 1000, max: 100000, step: 1000 } },
    unit: "%",
    tolerance: 0.03,
    prompt: (p) =>
      `Key popularity follows Zipf with exponent 1 over ${fmt(p.keys)} keys. The cache holds the ${fmt(p.cached)} most popular keys. Roughly what hit rate, in percent, should you expect? (Use H(n) ≈ ln n + 0.577.)`,
    solve: (p) => (harmonic(p.cached) / harmonic(p.keys)) * 100,
    mistakes: (p) => [
      { value: (p.cached / p.keys) * 100, feedback: "That assumes every key is equally popular. Under Zipf the top keys carry far more than their share: the hit rate is H(cached) ÷ H(keys)." },
    ],
    hint: "Under Zipf(1), the top k keys receive H(k) ÷ H(N) of requests, where H(n) ≈ ln n + 0.577.",
  },
  "cache.stampede": {
    id: "cache.stampede",
    objective: "explain-stampede",
    step: "stampede",
    params: { keyRps: { min: 500, max: 5000, step: 100 }, fillMs: { min: 5, max: 80, step: 5 } },
    unit: "queries",
    tolerance: 0.05,
    prompt: (p) =>
      `A hot key receives ${fmt(p.keyRps)} reads per second. The cache restarts empty. Refilling the key takes ${p.fillMs} ms (one database read, then a cache SET). Without request coalescing, about how many database queries for this key arrive before the first fill completes?`,
    solve: (p) => Math.max(1, (p.keyRps * p.fillMs) / 1000),
    mistakes: () => [
      { value: 1, feedback: "One query is what request coalescing (single-flight or a lease) achieves. Without it, every request that misses during the fill window goes to the database." },
    ],
    hint: "Every read that misses during the fill window queries the database: rate × window (convert ms to seconds).",
  },
  "web.handshake": {
    id: "web.handshake", objective: "estimate-handshake", step: "handshake",
    params: { rtt: { min: 20, max: 150, step: 10 }, server: { min: 5, max: 25, step: 5 } },
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `DNS is cached. A fresh TCP connection costs one RTT; a full TLS 1.3 handshake costs another; the HTTP request and first response byte cost one more, plus ${p.server} ms server work. With RTT ${p.rtt} ms, estimate time to first byte. Ignore loss and transfer size.`,
    solve: (p) => 3 * p.rtt + p.server,
    mistakes: (p) => [{ value: p.rtt + p.server, feedback: "That is the warm-connection path. This cold path also pays TCP and TLS setup: three RTTs in total." }],
    hint: "Add TCP setup, TLS setup, request/response, and server work: 3 × RTT + server time.",
  },
  "latency.serial": {
    id: "latency.serial", objective: "calculate-critical-path", step: "serial",
    params: { calls: { min: 3, max: 8, step: 1 }, rtt: { min: 10, max: 60, step: 5 }, work: { min: 2, max: 8, step: 1 } },
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `A handler makes ${p.calls} sequential RPCs. Each takes ${p.rtt} ms network round trip plus ${p.work} ms remote work. With no other cost, what is handler latency?`,
    solve: (p) => p.calls * (p.rtt + p.work),
    mistakes: (p) => [{ value: p.rtt + p.work, feedback: "That counts one call. Sequential calls cannot overlap; add every round trip and service time." }],
    hint: "Sequential latency is calls × (round-trip time + remote work).",
  },
  "latency.parallel": {
    id: "latency.parallel", objective: "calculate-critical-path", step: "parallel",
    params: { fast: { min: 5, max: 20, step: 5 }, slow: { min: 40, max: 100, step: 10 }, local: { min: 2, max: 8, step: 1 } },
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `Two independent RPCs start together and take ${p.fast} ms and ${p.slow} ms, including their networks. The handler waits for both, then spends ${p.local} ms formatting. What is total latency?`,
    solve: (p) => p.slow + p.local,
    mistakes: (p) => [{ value: p.fast + p.slow + p.local, feedback: "That adds overlapping work. A join-all waits for the slower branch, then formatting runs." }],
    hint: "Use max(branch durations) + work after the join.",
  },
  "throughput.inflight": {
    id: "throughput.inflight", objective: "apply-littles-law", step: "inflight",
    params: { rps: { min: 500, max: 10000, step: 500 }, ms: { min: 20, max: 200, step: 10 } },
    unit: "requests", tolerance: 0.01,
    prompt: (p) => `A stable service completes ${fmt(p.rps)} requests/s with mean end-to-end time ${p.ms} ms, including waiting. How many requests are in the service on average?`,
    solve: (p) => p.rps * p.ms / 1000,
    mistakes: (p) => [{ value: p.rps * p.ms, feedback: "Milliseconds must become seconds before multiplying by requests per second. Divide the time by 1,000." }],
    hint: "Little's law: L = λW. Use seconds for W and the same system boundary for all terms.",
  },
  "throughput.capacity": {
    id: "throughput.capacity", objective: "estimate-service-capacity", step: "capacity",
    params: { workers: { min: 4, max: 32, step: 4 }, ms: { min: 10, max: 50, step: 5 } },
    unit: "requests/s", tolerance: 0.01,
    prompt: (p) => `${p.workers} independent workers each handle one request at a time in a constant ${p.ms} ms. Ignoring all shared bottlenecks, what is their theoretical total service capacity?`,
    solve: (p) => p.workers * 1000 / p.ms,
    mistakes: (p) => [{ value: 1000 / p.ms, feedback: "That is one worker's capacity. Multiply by the number of independent workers." }],
    hint: "Each worker completes 1 / service-time-seconds requests/s; multiply by workers. Leave headroom in production.",
  },
  "percentiles.rank": {
    id: "percentiles.rank", objective: "compute-percentile", step: "rank",
    params: { samples: { min: 1000, max: 10000, step: 1000 }, percentile: { min: 95, max: 99, step: 1 } },
    unit: "rank", tolerance: 0,
    prompt: (p) => `Sort ${fmt(p.samples)} latency samples from fastest to slowest. Using nearest rank ceil(p × N), which one-based rank gives p${p.percentile}?`,
    solve: (p) => Math.ceil(p.percentile * p.samples / 100),
    mistakes: (p) => [{ value: p.samples * (100 - p.percentile) / 100, feedback: "That counts observations in the slow tail, not the rank of the percentile. Rank is ceil(percentile / 100 × sample count)." }],
    hint: "Multiply the percentile fraction by the sample count, round up, and count from one.",
  },
  "percentiles.fanout": {
    id: "percentiles.fanout", objective: "predict-fanout-tail", step: "fanout",
    params: { branches: { min: 10, max: 100, step: 10 } },
    unit: "%", tolerance: 0.01,
    prompt: (p) => `Each of ${p.branches} independent RPCs has a 1% chance of exceeding 100 ms. A request starts them together and waits for all. What percent of requests have at least one RPC exceeding 100 ms?`,
    solve: (p) => 100 * (1 - 0.99 ** p.branches),
    mistakes: () => [{ value: 1, feedback: "One percent is a single branch's tail. The parent is slow whenever any branch is slow: 1 − 0.99^branches." }],
    hint: "Compute the chance all branches are fast, 0.99^branches, then subtract it from one and convert to percent.",
  },
  "bandwidth.transfer": {
    id: "bandwidth.transfer", objective: "calculate-transfer-time", step: "transfer",
    params: { mb: { min: 10, max: 200, step: 10 }, mbps: { min: 20, max: 200, step: 20 } },
    unit: "seconds", tolerance: 0.01,
    prompt: (p) => `An otherwise idle ${p.mbps} megabit/s link transfers a ${p.mb} MB object. Use decimal units, ignore protocol overhead and propagation. How many seconds does serialization take?`,
    solve: (p) => 8 * p.mb / p.mbps,
    mistakes: (p) => [{ value: p.mb / p.mbps, feedback: "MB measures bytes and megabit/s measures bits. Multiply the object size by eight before dividing." }],
    hint: "Serialization time = bits / bits per second. One byte is eight bits.",
  },
  "bandwidth.load": {
    id: "bandwidth.load", objective: "size-link-and-egress", step: "load",
    params: { rps: { min: 100, max: 2000, step: 100 }, kb: { min: 10, max: 100, step: 10 } },
    unit: "Mbit/s", tolerance: 0.01,
    prompt: (p) => `${fmt(p.rps)} responses/s each contain ${p.kb} decimal kB. Ignoring overhead, what outbound bandwidth in decimal Mbit/s do they require?`,
    solve: (p) => p.rps * p.kb * 8 / 1000,
    mistakes: (p) => [{ value: p.rps * p.kb / 1000, feedback: "That result is MB/s. Link speeds are in bits/s, so multiply bytes by eight." }],
    hint: "responses/s × kB/response × 8 / 1,000 gives Mbit/s.",
  },
  "bandwidth.egress": {
    id: "bandwidth.egress", objective: "size-link-and-egress", step: "egress",
    params: { gb: { min: 1000, max: 20000, step: 1000 }, cents: { min: 4, max: 15, step: 1 } },
    unit: "dollars", tolerance: 0.01,
    prompt: (p) => `Your hypothetical contract charges ${p.cents} cents per decimal GB. You send ${fmt(p.gb)} billable GB this month. With no free tier or other fees, what is the dollar charge?`,
    solve: (p) => p.gb * p.cents / 100,
    mistakes: (p) => [{ value: p.gb * p.cents, feedback: "That is cents. Divide by 100 to report dollars; this example is not a current vendor quote." }],
    hint: "Multiply billable GB by cents per GB, then divide by 100.",
  },
  "availability.downtime": {
    id: "availability.downtime", objective: "convert-nines", step: "downtime",
    params: { nines: { min: 2, max: 5, step: 1 }, days: { min: 28, max: 31, step: 1 } },
    unit: "minutes", tolerance: 0.01,
    prompt: (p) => `A time-based SLO promises ${p.nines} nines of availability over exactly ${p.days} days. What is its downtime budget in minutes? Count all minutes equally.`,
    solve: (p) => p.days * 24 * 60 * 10 ** (-p.nines),
    mistakes: (p) => [{ value: p.days * 24 * 60 * (1 - 10 ** (-p.nines)), feedback: "That is the uptime allowance. Downtime uses the unavailable fraction: 10 raised to minus the number of nines." }],
    hint: "Budget = days × 24 × 60 × unavailable fraction; three nines means fraction 0.001.",
  },
  "availability.requests": {
    id: "availability.requests", objective: "define-availability-sli", step: "requests",
    params: { million: { min: 1, max: 20, step: 1 }, nines: { min: 2, max: 4, step: 1 } },
    unit: "requests", tolerance: 0.001,
    prompt: (p) => `A request-based availability SLO is ${p.nines} nines across ${p.million} million eligible requests. How many unsuccessful requests fit in the error budget?`,
    solve: (p) => p.million * 1000000 * 10 ** (-p.nines),
    mistakes: (p) => [{ value: p.million * 1000000 * (1 - 10 ** (-p.nines)), feedback: "You calculated required successes. The error budget counts failures: total requests × unavailable fraction." }],
    hint: "Multiply eligible requests by 10^(-nines). A request budget is not a fixed number of outage minutes.",
  },
  "estimation.qps": {
    id: "estimation.qps", objective: "estimate-peak-qps", step: "qps",
    params: { million: { min: 1, max: 50, step: 1 }, actions: { min: 2, max: 20, step: 2 }, peak: { min: 2, max: 6, step: 1 } },
    unit: "requests/s", tolerance: 0.01,
    prompt: (p) => `${p.million} million daily active users each make ${p.actions} requests/day. Assume peak is ${p.peak} times daily average. Estimate peak requests/s using 86,400 seconds/day.`,
    solve: (p) => p.million * 1000000 * p.actions * p.peak / 86400,
    mistakes: (p) => [{ value: p.million * 1000000 * p.actions / 86400, feedback: "That is average QPS. Apply the stated peak-to-average multiplier before sizing capacity." }],
    hint: "DAU × requests per user per day / 86,400 × peak factor.",
  },
  "estimation.storage": {
    id: "estimation.storage", objective: "estimate-storage-memory", step: "storage",
    params: { million: { min: 1, max: 20, step: 1 }, bytes: { min: 200, max: 1000, step: 100 }, days: { min: 30, max: 180, step: 30 }, copies: { min: 2, max: 4, step: 1 } },
    unit: "GB", tolerance: 0.01,
    prompt: (p) => `${p.million} million records/day, ${p.bytes} bytes/record, ${p.days} days retention, ${p.copies} full copies. Estimate decimal GB, excluding indexes, logs, backups and compression.`,
    solve: (p) => p.million * p.bytes * p.days * p.copies / 1000,
    mistakes: (p) => [{ value: p.million * p.bytes * p.days / 1000, feedback: "That is one copy. Multiply retained logical data by the number of full copies." }],
    hint: "records/day × bytes/record × retention days × copies / 1,000,000,000.",
  },
  "estimation.memory": {
    id: "estimation.memory", objective: "estimate-storage-memory", step: "memory",
    params: { million: { min: 1, max: 20, step: 1 }, bytes: { min: 100, max: 500, step: 100 }, overhead: { min: 2, max: 4, step: 1 } },
    unit: "GB", tolerance: 0.01,
    prompt: (p) => `Keep ${p.million} million hot entries in memory. Each has ${p.bytes} payload bytes; metadata and allocation make the total ${p.overhead} times payload size. Estimate decimal GB for one cache copy.`,
    solve: (p) => p.million * p.bytes * p.overhead / 1000,
    mistakes: (p) => [{ value: p.million * p.bytes / 1000, feedback: "That counts payload only. Keys, pointers and allocation consume the stated multiplier too." }],
    hint: "entries × payload bytes × total-size multiplier / 10^9.",
  },
  "estimation.servers": {
    id: "estimation.servers", objective: "size-server-count", step: "servers",
    params: { rps: { min: 10000, max: 50000, step: 1000 }, perServer: { min: 1000, max: 4000, step: 500 } },
    unit: "servers", tolerance: 0,
    prompt: (p) => `Peak demand is ${fmt(p.rps)} requests/s. Each server benchmarks at ${fmt(p.perServer)} requests/s, but you target at most 50% of that. What minimum whole server count meets peak demand before adding failure reserves?`,
    solve: (p) => Math.ceil(p.rps / (p.perServer * 0.5)),
    mistakes: (p) => [{ value: Math.ceil(p.rps / p.perServer), feedback: "That sizes to 100% of benchmark capacity. At a 50% target, each server contributes half its benchmark rate." }],
    hint: "Divide peak by per-server capacity × 0.5, then round up. Reserve for failures separately.",
  },
  "queues.backlog": {
    id: "queues.backlog", objective: "predict-queue-growth", step: "backlog",
    params: { consume: { min: 100, max: 500, step: 100 }, excess: { min: 50, max: 200, step: 50 }, seconds: { min: 10, max: 60, step: 10 } },
    unit: "messages", tolerance: 0.01,
    prompt: (p) => `An empty queue receives ${p.consume + p.excess} messages/s and workers complete ${p.consume}/s for ${p.seconds} seconds. Assume constant rates and no failures. What backlog accumulates?`,
    solve: (p) => p.excess * p.seconds,
    mistakes: (p) => [{ value: (p.consume + p.excess) * p.seconds, feedback: "That counts every arrival but ignores completed messages. Backlog grows at arrival rate minus completion rate." }],
    hint: "Backlog growth = (arrivals/s − completions/s) × duration.",
  },
  "queues.drain": {
    id: "queues.drain", objective: "predict-queue-growth", step: "drain",
    params: { backlog: { min: 1000, max: 10000, step: 1000 }, arrival: { min: 100, max: 400, step: 100 }, spare: { min: 100, max: 500, step: 100 } },
    unit: "seconds", tolerance: 0.01,
    prompt: (p) => `A queue holds ${fmt(p.backlog)} messages. New arrivals continue at ${p.arrival}/s, while workers complete ${p.arrival + p.spare}/s. How long until the backlog reaches zero?`,
    solve: (p) => p.backlog / p.spare,
    mistakes: (p) => [{ value: p.backlog / (p.arrival + p.spare), feedback: "Workers must also process new arrivals. Only completion capacity left after new arrivals drains the old backlog." }],
    hint: "Drain time = backlog / (completion rate − continuing arrival rate).",
  },
  "partitioning.movement": {
    id: "partitioning.movement", objective: "estimate-key-movement", step: "movement",
    params: { nodes: { min: 3, max: 15, step: 1 }, million: { min: 1, max: 20, step: 1 } },
    unit: "keys", tolerance: 0.01,
    prompt: (p) => `An ideally balanced consistent-hash ring has ${p.nodes} equal nodes and ${p.million} million uniformly hashed keys, one owner each. Add one equal node. Approximately how many existing keys change owner after rebalancing?`,
    solve: (p) => p.million * 1000000 / (p.nodes + 1),
    mistakes: (p) => [{ value: p.million * 1000000 / p.nodes, feedback: "The new node's target share is one over the new node count, N + 1, not the old count N." }],
    hint: "The added node receives about 1 / (old node count + 1) of all keys. Finite rings vary.",
  },
  "partitioning.hot-key": {
    id: "partitioning.hot-key", objective: "choose-shard-key", step: "hot-key",
    params: { rps: { min: 10000, max: 50000, step: 5000 }, hot: { min: 20, max: 45, step: 5 } },
    unit: "requests/s", tolerance: 0.01,
    prompt: (p) => `Traffic totals ${fmt(p.rps)} requests/s. One indivisible key accounts for ${p.hot}% of requests. Regardless of shard count, what minimum request rate must the owner of that key handle, before its other traffic?`,
    solve: (p) => p.rps * p.hot / 100,
    mistakes: (p) => [{ value: p.rps * (100 - p.hot) / 100, feedback: "That is traffic for all the other keys. The hot key alone sends total rate × its popularity share to its owner." }],
    hint: "Multiply total request rate by the hot key's fraction. Adding shards cannot split one key by itself.",
  },
  "transactions.write-amplification": {
    id: "transactions.write-amplification", objective: "compare-write-cost", step: "indexes",
    params: { logical: { min: 10, max: 100, step: 10 }, btree: { min: 2, max: 4, step: 1 }, lsm: { min: 6, max: 12, step: 1 } },
    unit: "MB", tolerance: 0.01,
    prompt: (p) => `A measured workload writes ${p.logical} MB of logical updates. Its B-tree writes ${p.btree} physical bytes per logical byte; its LSM writes ${p.lsm}, including compaction. How many additional physical MB does the LSM write? These are supplied measurements, not universal engine constants.`,
    solve: (p) => p.logical * (p.lsm - p.btree),
    mistakes: (p) => [{ value: p.logical * p.lsm, feedback: "That is the LSM's total physical write volume. The question asks for its excess over the B-tree: subtract both volumes." }],
    hint: "Additional physical MB = logical MB × (LSM amplification − B-tree amplification).",
  },
  "replication.quorum": {
    id: "replication.quorum", objective: "calculate-quorum", step: "quorum",
    params: { n: { min: 3, max: 9, step: 1 }, w: { min: 2, max: 5, step: 1 } },
    valid: (p) => p.w < p.n,
    unit: "replicas", tolerance: 0,
    prompt: (p) => `There are N=${p.n} fixed replicas and a write acknowledges W=${p.w} of those replicas. What minimum integer R guarantees every read set of size R intersects every acknowledged write set? No sloppy quorums or membership changes.`,
    solve: (p) => p.n - p.w + 1,
    mistakes: (p) => [{ value: p.n - p.w, feedback: "R + W = N allows disjoint sets. Guaranteed overlap requires the strict inequality R + W > N." }],
    hint: "Solve R + W > N for the smallest integer R. Overlap alone is not a linearizability proof.",
  },
  "replication.failures": {
    id: "replication.failures", objective: "calculate-quorum", step: "failures",
    params: { n: { min: 3, max: 9, step: 2 } },
    unit: "replicas", tolerance: 0,
    prompt: (p) => `A fixed replica set has N=${p.n} nodes. Both reads and writes require a strict majority of this set. How many unavailable replicas can it tolerate while still completing both operations, assuming the remaining replicas can communicate?`,
    solve: (p) => Math.floor(p.n / 2),
    mistakes: (p) => [{ value: Math.floor(p.n / 2) + 1, feedback: "That is the required live majority. Subtract it from N to find the tolerated unavailable replicas." }],
    hint: "Required live replicas = floor(N / 2) + 1; tolerated unavailable = N − required live.",
  },
  "replication.loss": {
    id: "replication.loss", objective: "predict-async-loss", step: "async-loss",
    params: { writes: { min: 100, max: 1000, step: 100 }, lag: { min: 2, max: 10, step: 1 } },
    unit: "writes", tolerance: 0.01,
    prompt: (p) => `A leader acknowledges ${p.writes} writes/s at a constant rate. The promoted async follower is exactly ${p.lag} seconds behind when the leader and its disk are lost. With no other surviving copy, how many acknowledged writes are at risk?`,
    solve: (p) => p.writes * p.lag,
    mistakes: () => [{ value: 0, feedback: "An async acknowledgement does not wait for the follower. Acknowledged writes in the replication gap can be lost with the leader." }],
    hint: "At-risk writes = write rate × replication lag, under the stated constant-rate assumptions.",
  },
  "limiting.tokens": {
    id: "limiting.tokens", objective: "calculate-token-budget", step: "tokens",
    params: { capacity: { min: 20, max: 100, step: 10 }, initial: { min: 0, max: 10, step: 1 }, rate: { min: 2, max: 8, step: 1 }, seconds: { min: 2, max: 10, step: 1 } },
    unit: "requests", tolerance: 0,
    prompt: (p) => `A token bucket holds at most ${p.capacity} tokens, starts with ${p.initial}, and refills ${p.rate} tokens/s. It is idle for ${p.seconds} seconds, then receives an instantaneous burst of one-token requests. How many can pass immediately?`,
    solve: (p) => Math.min(p.capacity, p.initial + p.rate * p.seconds),
    mistakes: (p) => [{ value: p.capacity + p.rate * p.seconds, feedback: "Capacity is a cap, not the starting token balance. Refill the stated initial balance, then clamp to capacity." }],
    hint: "Available = min(capacity, initial balance + refill rate × idle time).",
  },
  "limiting.wait": {
    id: "limiting.wait", objective: "calculate-token-budget", step: "wait",
    params: { deficit: { min: 2, max: 20, step: 2 }, rate: { min: 2, max: 10, step: 2 } },
    unit: "seconds", tolerance: 0.01,
    prompt: (p) => `A request costs ${p.deficit} tokens, the bucket is empty, and refill is ${p.rate} tokens/s. Capacity is large enough for this request and no other requests arrive. How long before it can pass?`,
    solve: (p) => p.deficit / p.rate,
    mistakes: (p) => [{ value: p.deficit * p.rate, feedback: "Refill is tokens per second. Divide missing tokens by tokens per second to obtain seconds." }],
    hint: "Wait = missing tokens / refill tokens per second. This is eligibility time, not a promise of automatic queuing.",
  },
  "limiting.boundary": {
    id: "limiting.boundary", objective: "choose-limiter", step: "windows",
    params: { limit: { min: 50, max: 500, step: 50 } },
    unit: "requests", tolerance: 0,
    prompt: (p) => `A fixed-window limiter allows ${p.limit} requests per clock minute. A client sends a full allowed batch just before the minute boundary and another just after. How many requests pass in that short interval?`,
    solve: (p) => p.limit * 2,
    mistakes: (p) => [{ value: p.limit, feedback: "The counter resets at the clock boundary, so two adjacent windows each admit a full batch." }],
    hint: "Add the allowed batch from each of the two adjacent fixed windows.",
  },
  "streams.window": {
    id: "streams.window", objective: "assign-event-window", step: "windows",
    params: { timestamp: { min: 61, max: 599, step: 1 }, width: { min: 10, max: 60, step: 10 } },
    unit: "seconds", tolerance: 0,
    prompt: (p) => `Tumbling event-time windows are ${p.width} seconds wide, aligned at epoch 0, with intervals [start, end). An event has timestamp ${p.timestamp} seconds. What is its window's start timestamp?`,
    solve: (p) => Math.floor(p.timestamp / p.width) * p.width,
    mistakes: (p) => [{ value: (Math.floor(p.timestamp / p.width) + 1) * p.width, feedback: "That is the window end. The start rounds the timestamp down to a width-aligned boundary; the end is exclusive." }],
    hint: "Window start = floor(event timestamp / window width) × window width.",
  },
  "streams.retention": {
    id: "streams.retention", objective: "handle-late-data", step: "late-data",
    params: { end: { min: 60, max: 600, step: 60 }, late: { min: 10, max: 50, step: 10 } },
    unit: "seconds", tolerance: 0,
    prompt: (p) => `A window ends at event time ${p.end} seconds. This lesson's policy retains state until the watermark reaches end + allowed lateness; allowed lateness is ${p.late} seconds. At what watermark timestamp is this state eligible for removal?`,
    solve: (p) => p.end + p.late,
    mistakes: (p) => [{ value: p.end, feedback: "That is the nominal window end. This policy keeps state for an additional allowed-lateness interval so late events can revise the result." }],
    hint: "State cleanup threshold = window end + allowed lateness, compared against the watermark, not wall-clock time.",
  },
  "streams.dedup-state": {
    id: "streams.dedup-state", objective: "bound-stream-state", step: "dedup",
    params: { rps: { min: 100, max: 1000, step: 100 }, minutes: { min: 2, max: 10, step: 1 }, bytes: { min: 32, max: 128, step: 32 } },
    unit: "MB", tolerance: 0.01,
    prompt: (p) => `${p.rps} new unique event IDs/s enter a dedup store. Retain each for exactly ${p.minutes} minutes; each ID entry takes ${p.bytes} bytes including metadata. At steady rate, estimate decimal MB for one copy, ignoring allocator overhead.`,
    solve: (p) => p.rps * p.minutes * 60 * p.bytes / 1000000,
    mistakes: (p) => [{ value: p.rps * p.minutes * p.bytes / 1000000, feedback: "The rate is per second but retention is in minutes. Multiply retention by 60 before estimating stored IDs." }],
    hint: "State bytes = unique IDs/s × retention seconds × bytes/entry; divide by 10^6 for decimal MB.",
  },
};

export const templateIds = Object.keys(templates) as [string, ...string[]];
