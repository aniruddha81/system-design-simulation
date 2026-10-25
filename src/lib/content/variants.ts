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
  "cap.minority-clients": {
    id: "cap.minority-clients", objective: "state-cap", step: "partition",
    params: { n: { min: 3, max: 9, step: 2 }, cut: { min: 1, max: 4, step: 1 } },
    valid: (p) => p.cut < p.n / 2,
    unit: "%", tolerance: 0.01,
    prompt: (p) => `A ${p.n}-replica store keeps writes linearizable by requiring a strict majority of replicas for every write. Clients are spread evenly, each pinned to one replica. A partition cuts ${p.cut} replica${p.cut === 1 ? "" : "s"} off from the other ${p.n - p.cut}. What percent of clients can no longer complete a write until the partition heals?`,
    solve: (p) => (p.cut / p.n) * 100,
    mistakes: (p) => [
      { value: 100, feedback: "CAP does not take the whole system down. The side that still holds a majority keeps committing; only clients stranded with the minority lose writes." },
      { value: 0, feedback: "The minority side cannot form a majority, so a consistent store must refuse or time out its writes. That refusal is the 'A' that CAP says you give up." },
      { value: ((p.n - p.cut) / p.n) * 100, feedback: "That is the share of clients on the majority side, who can still write. The question asks for the stranded minority." },
    ],
    hint: "Only the side with a strict majority can commit. Count the clients pinned to replicas on the other side.",
  },
  "pacelc.majority-latency": {
    id: "pacelc.majority-latency", objective: "apply-pacelc", step: "else-latency",
    params: { r1: { min: 10, max: 60, step: 5 }, d2: { min: 5, max: 40, step: 5 }, d3: { min: 5, max: 60, step: 5 }, d4: { min: 5, max: 80, step: 5 } },
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `Five replicas sit in five regions; the leader is in region A. Round trips from A to the four follower regions are ${p.r1}, ${p.r1 + p.d2}, ${p.r1 + p.d2 + p.d3} and ${p.r1 + p.d2 + p.d3 + p.d4} ms. A write is acknowledged once a majority of the five replicas, leader included, has it. Ignoring disk and processing time, what write latency does a client next to the leader see?`,
    solve: (p) => p.r1 + p.d2,
    mistakes: (p) => [
      { value: p.r1 + p.d2 + p.d3 + p.d4, feedback: "That waits for every replica. A majority of five is three, and the leader is one of them, so it needs only the two nearest followers." },
      { value: p.r1, feedback: "Leader plus one follower is two of five, which is not a majority. Wait for the second-nearest follower." },
      { value: p.r1 + p.d2 + p.d3, feedback: "That waits for three followers. The leader's own copy counts toward the majority, so two followers are enough." },
    ],
    hint: "A majority of five is three. The leader is one; the latency is the round trip to the second-nearest follower.",
  },
  "consistency.stale-read": {
    id: "consistency.stale-read", objective: "estimate-staleness", step: "eventual",
    params: { n: { min: 5, max: 9, step: 1 }, w: { min: 1, max: 3, step: 1 }, r: { min: 2, max: 3, step: 1 } },
    valid: (p) => p.r + p.w <= p.n,
    unit: "%", tolerance: 0.01,
    prompt: (p) => `A leaderless store has N=${p.n} replicas. A write has so far reached exactly W=${p.w} of them and anti-entropy has not run. A read contacts R=${p.r} distinct replicas chosen uniformly at random and returns the newest version it sees. What is the probability, in percent, that the read misses the write entirely?`,
    solve: (p) => {
      let miss = 1;
      for (let i = 0; i < p.r; i++) miss *= (p.n - p.w - i) / (p.n - i);
      return miss * 100;
    },
    mistakes: (p) => [
      { value: ((p.n - p.w) / p.n) * 100, feedback: "That is the chance that one replica misses. Every one of the R replicas must miss: multiply (N − W − i) ÷ (N − i) for each pick." },
      { value: ((p.n - p.w) / p.n) ** p.r * 100, feedback: "That samples with replacement. The read contacts distinct replicas, so each pick leaves one fewer stale replica: (N − W − i) ÷ (N − i)." },
      { value: 0, feedback: "Overlap is only guaranteed when R + W > N. Here R + W ≤ N, so the read can land entirely on replicas that have not seen the write." },
    ],
    hint: "Count read sets that avoid all W fresh replicas: multiply (N − W − i) ÷ (N − i) for i = 0 to R − 1.",
  },
  "consistency.session-wait": {
    id: "consistency.session-wait", objective: "choose-model", step: "session",
    params: { applied: { min: 1000, max: 9000, step: 500 }, gap: { min: 50, max: 2000, step: 50 }, rate: { min: 2, max: 10, step: 2 } },
    valid: (p) => Math.abs(p.applied + p.gap - p.gap * p.rate ** 2) > 0.03 * p.gap * p.rate ** 2,
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `A user's write committed at log position ${fmt(p.applied + p.gap)}, and their session carries that position as a token. The follower serving their next read has applied up to position ${fmt(p.applied)} and applies ${p.rate} entries per millisecond. To guarantee read-your-writes it waits until it reaches the token. How many milliseconds does the read wait?`,
    solve: (p) => p.gap / p.rate,
    mistakes: (p) => [
      { value: (p.applied + p.gap) / p.rate, feedback: "The follower is not replaying from position zero. It only has to apply the entries between its applied position and the token." },
      { value: p.gap * p.rate, feedback: "Rate is entries per millisecond, so divide the missing entries by it rather than multiplying." },
    ],
    hint: "Wait = (token position − applied position) ÷ apply rate.",
  },
  "clocks.drift": {
    id: "clocks.drift", objective: "bound-skew", step: "drift",
    params: { ppm: { min: 20, max: 200, step: 10 }, interval: { min: 10, max: 300, step: 10 } },
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `Two servers synchronise to the same reference every ${p.interval} s. Between syncs each oscillator may drift up to ${p.ppm} ppm, in either direction. Ignoring the error of the sync itself, what is the largest possible offset between the two clocks just before the next sync, in milliseconds?`,
    solve: (p) => (2 * p.ppm * p.interval) / 1000,
    mistakes: (p) => [
      { value: (p.ppm * p.interval) / 1000, feedback: "That is one clock's drift from true time. The two clocks can drift in opposite directions, so their offset from each other is double." },
      { value: 2 * p.ppm * p.interval, feedback: "ppm × seconds gives microseconds. Divide by 1,000 for milliseconds." },
    ],
    hint: "One ppm is one microsecond per second. Worst-case pairwise offset = 2 × ppm × interval, in microseconds.",
  },
  "clocks.lamport": {
    id: "clocks.lamport", objective: "lamport-rules", step: "lamport",
    params: { clock: { min: 1, max: 40, step: 1 }, local: { min: 1, max: 5, step: 1 }, msg: { min: 1, max: 60, step: 1 } },
    valid: (p) => Math.abs(p.clock + p.local - p.msg) >= 2,
    unit: "timestamp", tolerance: 0,
    prompt: (p) => `Node B's Lamport clock reads ${p.clock}. B performs ${p.local} local event${p.local === 1 ? "" : "s"}, each incrementing its clock by one, then receives a message stamped ${p.msg}. What Lamport timestamp does B assign to the receive event?`,
    solve: (p) => Math.max(p.clock + p.local, p.msg) + 1,
    mistakes: (p) => {
      const own = p.clock + p.local;
      return [
        { value: Math.max(own, p.msg), feedback: "The receive is itself an event, so after taking the maximum of the local clock and the message stamp the clock still increments by one." },
        own > p.msg
          ? { value: p.msg + 1, feedback: "That ignores B's own history. B's clock is already ahead of the message stamp, and Lamport clocks never move backwards: take the maximum first." }
          : { value: own + 1, feedback: "That ignores the message stamp. The receive must be ordered after the send, so jump to the maximum of the local clock and the stamp, then add one." },
      ];
    },
    hint: "Each local event adds one. On receive: clock = max(local clock, message stamp) + 1.",
  },
  "clocks.commit-wait": {
    id: "clocks.commit-wait", objective: "choose-clock", step: "truetime",
    params: { eps: { min: 1, max: 10, step: 1 } },
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `Spanner-style commit wait: a transaction takes timestamp s = TT.now().latest and may not make its writes visible until TT.now().earliest > s. The clock uncertainty bound ε is a constant ${p.eps} ms around true time. About how long is the commit wait?`,
    solve: (p) => 2 * p.eps,
    mistakes: (p) => [
      { value: p.eps, feedback: "s sits ε above true time, and earliest sits ε below it. Earliest must climb past s, so true time must advance by 2ε." },
      { value: 0, feedback: "Without waiting, a later transaction on another node could pick a smaller timestamp even though it started after this one committed. The wait is what buys external consistency." },
    ],
    hint: "latest = now + ε and earliest = now − ε. Earliest passes the chosen latest after 2ε of true time.",
  },
  "raft.fault-tolerance": {
    id: "raft.fault-tolerance", objective: "majority-math", step: "majority",
    params: { n: { min: 3, max: 9, step: 1 } },
    unit: "servers", tolerance: 0,
    prompt: (p) => `A Raft cluster has ${p.n} voting servers. How many can crash at the same time while the survivors can still elect a leader and commit new entries?`,
    solve: (p) => Math.floor((p.n - 1) / 2),
    mistakes: (p) => [
      { value: Math.floor(p.n / 2) + 1, feedback: "That is the majority the survivors need. The tolerated failures are N minus that majority." },
      ...(p.n % 2 === 0
        ? [{ value: p.n / 2, feedback: "With an even count, losing half leaves exactly half, which is not a strict majority. An even cluster tolerates no more failures than the odd cluster one smaller." }]
        : []),
    ],
    hint: "A majority is floor(N ÷ 2) + 1 servers. Tolerated crashes = N − majority = floor((N − 1) ÷ 2).",
  },
  "raft.election-time": {
    id: "raft.election-time", objective: "election", step: "election",
    params: { t: { min: 100, max: 300, step: 50 }, k: { min: 2, max: 6, step: 1 } },
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `A Raft leader crashes just after sending a heartbeat. Each of the ${p.k} surviving followers draws an independent election timeout uniformly from [${p.t}, ${2 * p.t}] ms, measured from that heartbeat. Ignoring vote RPC time and split votes, what is the expected time until the first follower becomes a candidate?`,
    solve: (p) => p.t + p.t / (p.k + 1),
    mistakes: (p) => [
      { value: 1.5 * p.t, feedback: "That is one follower's mean timeout. The first of several independent timers fires earlier: the expected minimum of k uniforms is lower + width ÷ (k + 1)." },
      { value: p.t, feedback: "That is the earliest possible timeout, not the expected one. The expected minimum of k uniforms on [T, 2T] is T + T ÷ (k + 1)." },
    ],
    hint: "For k independent uniforms on [a, b], the expected minimum is a + (b − a) ÷ (k + 1).",
  },
  "raft.commit-index": {
    id: "raft.commit-index", objective: "commit-rule", step: "commit",
    params: { last: { min: 20, max: 40, step: 1 }, a: { min: 0, max: 15, step: 1 }, b: { min: 0, max: 15, step: 1 }, c: { min: 0, max: 15, step: 1 }, d: { min: 0, max: 15, step: 1 } },
    valid: (p) => {
      const s = [p.last, p.last - p.a, p.last - p.b, p.last - p.c, p.last - p.d].sort((x, y) => y - x);
      return s[0] > s[1] && s[1] > s[2] && s[2] > s[4];
    },
    unit: "index", tolerance: 0,
    prompt: (p) => `A five-server Raft cluster. The leader's log ends at index ${p.last}, and every entry after index 5 was created in the leader's current term. The leader's matchIndex for its four followers is ${p.last - p.a}, ${p.last - p.b}, ${p.last - p.c} and ${p.last - p.d}. What is the highest index the leader may mark committed?`,
    solve: (p) => [p.last, p.last - p.a, p.last - p.b, p.last - p.c, p.last - p.d].sort((x, y) => y - x)[2],
    mistakes: (p) => {
      const s = [p.last, p.last - p.a, p.last - p.b, p.last - p.c, p.last - p.d].sort((x, y) => y - x);
      return [
        { value: s[4], feedback: "That waits for every follower. Raft commits once a majority, three of five here, stores the entry, so one slow follower cannot stall the cluster." },
        { value: s[0], feedback: "That is only the leader's log. One copy is not a majority; an entry is committed once three of the five servers store it." },
        { value: s[1], feedback: "That index is stored on two servers. Sort all five match positions, leader included, and take the third highest." },
      ];
    },
    hint: "Sort the five match indexes (the leader's last index counts as its own) from high to low and take the third: the highest index a majority stores.",
  },
  "election.min-quorum": {
    id: "election.min-quorum", objective: "split-brain", step: "split-brain",
    params: { half: { min: 2, max: 5, step: 1 } },
    unit: "votes", tolerance: 0,
    prompt: (p) => `A ${2 * p.half}-node cluster elects a leader when a candidate collects q votes, and each node votes at most once per term. What is the smallest q that guarantees at most one leader per term, even when the network splits the cluster in half?`,
    solve: (p) => p.half + 1,
    mistakes: (p) => [
      { value: p.half, feedback: "With q = N ÷ 2, each half of a 50/50 split can elect its own leader in the same term. Two quorums must share a voter: 2q > N." },
      { value: 2 * p.half, feedback: "Unanimity is safe but not minimal, and any single failed node stops all elections. Any two quorums intersect once 2q > N." },
    ],
    hint: "Two quorums must share at least one voter: 2q > N, so q = floor(N ÷ 2) + 1.",
  },
  "lease.drift-margin": {
    id: "lease.drift-margin", objective: "lease-safety", step: "lease",
    params: { ppm: { min: 50, max: 500, step: 50 }, lease: { min: 5, max: 60, step: 5 } },
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `A lock service grants ${p.lease}-second leases. The holder starts its timer before sending the request, so network delay only shortens its view of the lease. The holder's and the service's clocks may each drift up to ${p.ppm} ppm, in opposite directions. How many milliseconds before its timer reaches ${p.lease} s must the holder stop, to cover drift alone?`,
    solve: (p) => (2 * p.ppm * p.lease) / 1000,
    mistakes: (p) => [
      { value: (p.ppm * p.lease) / 1000, feedback: "That covers one clock. The holder may run slow while the service runs fast, so the relative error is twice the per-clock bound." },
      { value: 2 * p.ppm * p.lease, feedback: "ppm × seconds gives microseconds. Divide by 1,000 for milliseconds." },
    ],
    hint: "Relative drift between two clocks is up to 2 × ppm. Over L seconds that is 2 × ppm × L microseconds.",
  },
  "lease.pause-overrun": {
    id: "lease.pause-overrun", objective: "fencing", step: "pause",
    params: { lease: { min: 5, max: 30, step: 5 }, check: { min: 1, max: 29, step: 1 }, pause: { min: 2, max: 40, step: 1 } },
    valid: (p) => p.check < p.lease && p.check + p.pause > p.lease && p.lease - p.check !== p.check + p.pause - p.lease,
    unit: "seconds", tolerance: 0,
    prompt: (p) => `A client holds a ${p.lease}-second lock lease. At ${p.check} s into the lease it checks that the lease is still valid; then a garbage-collection pause stops it for ${p.pause} s. When it resumes it writes to storage without checking again. How many seconds after the lease expired does that write land?`,
    solve: (p) => p.check + p.pause - p.lease,
    mistakes: (p) => [
      { value: p.pause, feedback: "Part of the pause was still inside the lease. The write lands at check time + pause; subtract the lease length." },
      { value: p.lease - p.check, feedback: "That is how much lease was left at the check. The pause outlasted it; measure from the expiry to the write." },
    ],
    hint: "The write happens at check time + pause. Subtract the lease length to get how long after expiry it lands.",
  },
  "timeouts.remaining": {
    id: "timeouts.remaining", objective: "deadline-propagation", step: "deadline",
    params: { deadline: { min: 200, max: 2000, step: 100 }, gateway: { min: 5, max: 50, step: 5 }, svc: { min: 10, max: 200, step: 10 }, margin: { min: 5, max: 30, step: 5 } },
    valid: (p) => p.deadline - p.gateway - p.svc - p.margin > 50,
    unit: "ms", tolerance: 0,
    prompt: (p) => `A client sets a ${p.deadline} ms deadline. The gateway uses ${p.gateway} ms, then calls service A, which spends ${p.svc} ms before calling service B. A reserves ${p.margin} ms to build and send its own response. What timeout should A give its call to B?`,
    solve: (p) => p.deadline - p.gateway - p.svc - p.margin,
    mistakes: (p) => [
      { value: p.deadline, feedback: "Restarting the full deadline at every hop lets B keep working after the client has given up. Pass down what remains." },
      { value: p.deadline - p.gateway - p.svc, feedback: "That leaves A no time to respond. Subtract the margin A needs after B returns." },
    ],
    hint: "Remaining = deadline − time already spent upstream − time the caller needs after the call returns.",
  },
  "timeouts.threads": {
    id: "timeouts.threads", objective: "timeout-cost", step: "too-long",
    params: { rps: { min: 50, max: 1000, step: 50 }, timeout: { min: 1500, max: 30000, step: 500 } },
    unit: "threads", tolerance: 0.01,
    prompt: (p) => `A dependency starts accepting connections but never replying. Your service calls it ${fmt(p.rps)} times per second with a ${fmt(p.timeout)} ms timeout, holding a worker thread for each call. In steady state, how many worker threads are stuck waiting on it?`,
    solve: (p) => (p.rps * p.timeout) / 1000,
    mistakes: (p) => [
      { value: p.rps * p.timeout, feedback: "Convert the timeout to seconds before multiplying by calls per second." },
      { value: p.rps, feedback: "That assumes each call ends within a second. Every call now holds its thread for the whole timeout: Little's law, L = λ × W." },
    ],
    hint: "Little's law: threads held = call rate × time each call is held (the timeout, in seconds).",
  },
  "timeouts.retry-window": {
    id: "timeouts.retry-window", objective: "set-timeout", step: "attempts",
    params: { tryMs: { min: 50, max: 500, step: 50 }, attempts: { min: 2, max: 5, step: 1 }, backoff: { min: 10, max: 200, step: 10 } },
    unit: "ms", tolerance: 0,
    prompt: (p) => `Each attempt has a ${p.tryMs} ms timeout. A caller makes up to ${p.attempts} attempts, sleeping a fixed ${p.backoff} ms between consecutive attempts. If every attempt times out, how long before the caller gives up?`,
    solve: (p) => p.attempts * p.tryMs + (p.attempts - 1) * p.backoff,
    mistakes: (p) => [
      { value: p.attempts * p.tryMs, feedback: "That forgets the sleeps between attempts. They count against the caller's deadline too." },
      { value: p.attempts * (p.tryMs + p.backoff), feedback: "There is no sleep after the last attempt: only attempts − 1 sleeps." },
    ],
    hint: "Worst case = attempts × per-try timeout + (attempts − 1) × sleep.",
  },
  "retries.amplification": {
    id: "retries.amplification", objective: "amplification", step: "amplification",
    params: { attempts: { min: 2, max: 4, step: 1 }, layers: { min: 2, max: 4, step: 1 } },
    valid: (p) => !(p.attempts === 2 && p.layers === 2),
    unit: "attempts", tolerance: 0,
    prompt: (p) => `A call chain has ${p.layers} service layers above a database. Every layer, including the one that calls the database, makes up to ${p.attempts} attempts (the first try plus ${p.attempts - 1} ${p.attempts === 2 ? "retry" : "retries"}) when the call below fails. The database is down, so everything fails. How many attempts reach the database for one user request?`,
    solve: (p) => p.attempts ** p.layers,
    mistakes: (p) => [
      { value: p.attempts * p.layers, feedback: "Retries multiply, they do not add. Each attempt from a layer triggers a full set of attempts in the layer below: attempts^layers." },
      { value: p.attempts, feedback: "That counts only the bottom layer. Every upper layer repeats the whole sub-tree beneath it." },
    ],
    hint: "Each layer multiplies the attempts below it: attempts raised to the number of layers.",
  },
  "retries.capped-backoff": {
    id: "retries.capped-backoff", objective: "backoff", step: "backoff",
    params: { base: { min: 50, max: 400, step: 50 }, retries: { min: 3, max: 7, step: 1 }, cap: { min: 200, max: 3000, step: 100 } },
    valid: (p) => p.cap > p.base && p.base * 2 ** (p.retries - 1) > p.cap && p.base * (2 ** p.retries - 1) !== p.retries * p.cap,
    unit: "ms", tolerance: 0,
    prompt: (p) => `Retry k (counting from 0) sleeps min(cap, base × 2^k), with base ${p.base} ms, cap ${fmt(p.cap)} ms and no jitter. Every attempt fails immediately. What is the total sleep across ${p.retries} retries?`,
    solve: (p) => {
      let total = 0;
      for (let k = 0; k < p.retries; k++) total += Math.min(p.cap, p.base * 2 ** k);
      return total;
    },
    mistakes: (p) => [
      { value: p.base * (2 ** p.retries - 1), feedback: "That ignores the cap. Once base × 2^k exceeds the cap, each further sleep is just the cap." },
      { value: p.retries * p.cap, feedback: "The early retries sleep less than the cap: base, 2 × base, 4 × base, until the doubling reaches the cap." },
    ],
    hint: "List the sleeps base × 2^k for k = 0 … retries − 1, clamp each to the cap, then add them.",
  },
  "retries.full-jitter": {
    id: "retries.full-jitter", objective: "backoff", step: "jitter",
    params: { base: { min: 50, max: 500, step: 50 }, k: { min: 0, max: 6, step: 1 }, cap: { min: 1000, max: 10000, step: 1000 } },
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `With full jitter, retry k sleeps a uniformly random time between 0 and min(cap, base × 2^k). With base ${p.base} ms, cap ${fmt(p.cap)} ms and k = ${p.k}, what is the expected sleep?`,
    solve: (p) => Math.min(p.cap, p.base * 2 ** p.k) / 2,
    mistakes: (p) => [
      { value: Math.min(p.cap, p.base * 2 ** p.k), feedback: "That is the ceiling of the random range, the sleep without jitter. A uniform draw from 0 to the ceiling averages half of it." },
    ],
    hint: "The expected value of a uniform draw on [0, x] is x ÷ 2, where x = min(cap, base × 2^k).",
  },
  "retries.budget": {
    id: "retries.budget", objective: "retry-budget", step: "budget",
    params: { rps: { min: 1000, max: 20000, step: 1000 }, retries: { min: 2, max: 5, step: 1 }, budget: { min: 5, max: 20, step: 5 } },
    unit: "requests/s", tolerance: 0.01,
    prompt: (p) => `A dependency fails every call. Clients send ${fmt(p.rps)} requests/s. Policy A retries each failed call up to ${p.retries} times. Policy B caps retries at ${p.budget}% of first attempts (a retry budget). Under policy B, how many calls per second reach the dependency?`,
    solve: (p) => p.rps * (1 + p.budget / 100),
    mistakes: (p) => [
      { value: p.rps * (1 + p.retries), feedback: "That is policy A: every request fans out into 1 + retries attempts, which multiplies load on a dependency that is already failing." },
      { value: (p.rps * p.budget) / 100, feedback: "That counts only the retries. First attempts still reach the dependency too." },
    ],
    hint: "Under a retry budget, total load = first attempts × (1 + budget fraction).",
  },
  "idempotency.duplicates": {
    id: "idempotency.duplicates", objective: "lost-ack", step: "lost-ack",
    params: { rps: { min: 10, max: 500, step: 10 }, lost: { min: 0.1, max: 2, step: 0.1 } },
    unit: "charges", tolerance: 0.01,
    prompt: (p) => `A checkout service sends ${p.rps} charge requests per second. For ${p.lost}% of them the charge commits but the response is lost, so the client times out and retries once. Without deduplication, how many duplicate charges happen per hour?`,
    solve: (p) => ((p.rps * p.lost) / 100) * 3600,
    mistakes: (p) => [
      { value: (p.rps * p.lost) / 100, feedback: "That is duplicates per second. Multiply by 3,600 for an hour." },
      { value: 0, feedback: "A timeout does not mean the charge failed. Here it committed and only the response was lost, so the retry charges again." },
    ],
    hint: "Duplicates per second = request rate × lost-ack fraction. Multiply by 3,600 seconds.",
  },
  "idempotency.key-storage": {
    id: "idempotency.key-storage", objective: "key-design", step: "retention",
    params: { rps: { min: 100, max: 5000, step: 100 }, hours: { min: 24, max: 72, step: 24 }, bytes: { min: 200, max: 2000, step: 200 } },
    unit: "GB", tolerance: 0.01,
    prompt: (p) => `An API receives ${fmt(p.rps)} new idempotency keys per second. Each stored entry (key, request fingerprint, status and saved response) takes ${fmt(p.bytes)} bytes. Keys are kept for ${p.hours} hours. Ignoring indexes and replication, how many decimal GB does one copy need?`,
    solve: (p) => (p.rps * p.hours * 3600 * p.bytes) / 1e9,
    mistakes: (p) => [
      { value: (p.rps * p.hours * p.bytes) / 1e9, feedback: "The rate is per second and retention is in hours. Multiply hours by 3,600." },
      { value: (p.rps * 3600 * p.bytes) / 1e9, feedback: "That is one hour of keys. Every key lives for the full retention window." },
    ],
    hint: "Live entries = keys/s × retention seconds. Bytes = live entries × bytes per entry; divide by 10^9 for GB.",
  },
  "breaker.trip": {
    id: "breaker.trip", objective: "breaker-threshold", step: "threshold",
    params: { window: { min: 10, max: 100, step: 10 }, threshold: { min: 20, max: 80, step: 10 } },
    unit: "calls", tolerance: 0,
    prompt: (p) => `A circuit breaker keeps a count-based sliding window of the last ${p.window} calls and opens when the failure rate in the window reaches ${p.threshold}%. The window is full of successes when the dependency starts failing every call. How many consecutive failures until the breaker opens?`,
    solve: (p) => Math.ceil((p.window * p.threshold) / 100),
    mistakes: (p) => [
      { value: p.window, feedback: "The breaker does not wait for the whole window to fail. Each failure pushes out a success; it opens once failures make up the threshold share of the window." },
    ],
    hint: "Failures needed = window size × threshold, rounded up.",
  },
  "bulkhead.size": {
    id: "bulkhead.size", objective: "bulkhead-sizing", step: "bulkhead",
    params: { rps: { min: 100, max: 2000, step: 100 }, ms: { min: 20, max: 200, step: 10 } },
    unit: "slots", tolerance: 0,
    prompt: (p) => `A service calls a recommendations API ${fmt(p.rps)} times per second. Healthy calls take ${p.ms} ms. You size its bulkhead at twice the healthy concurrency. How many concurrent call slots is that?`,
    solve: (p) => (2 * p.rps * p.ms) / 1000,
    mistakes: (p) => [
      { value: (p.rps * p.ms) / 1000, feedback: "That is the healthy concurrency itself, with no headroom. The question doubles it." },
      { value: 2 * p.rps, feedback: "Concurrency is rate × time in the system, not rate alone: Little's law with the latency in seconds." },
    ],
    hint: "Healthy concurrency = calls/s × latency in seconds (Little's law). Double it for headroom.",
  },
  "bulkhead.throughput": {
    id: "bulkhead.throughput", objective: "bulkhead-sizing", step: "contain",
    params: { size: { min: 10, max: 100, step: 10 }, timeout: { min: 500, max: 5000, step: 500 } },
    valid: (p) => p.timeout !== 1000,
    unit: "requests/s", tolerance: 0.01,
    prompt: (p) => `A bulkhead allows ${p.size} concurrent calls to a recommendations API. The API now hangs until the ${fmt(p.timeout)} ms timeout on every call. Excess calls are rejected immediately. At most how many calls per second can the bulkhead admit?`,
    solve: (p) => (p.size * 1000) / p.timeout,
    mistakes: (p) => [
      { value: (p.size * p.timeout) / 1000, feedback: "Inverted. Each slot completes one call per timeout period, so throughput = slots ÷ timeout in seconds." },
      { value: p.size, feedback: "That assumes each call takes one second. Each slot is held for the whole timeout." },
    ],
    hint: "Little's law turned round: throughput = concurrency ÷ time each call holds a slot.",
  },
  "shedding.fraction": {
    id: "shedding.fraction", objective: "shed-amount", step: "how-much",
    params: { cap: { min: 1000, max: 20000, step: 1000 }, over: { min: 10, max: 200, step: 10 } },
    unit: "%", tolerance: 0.01,
    prompt: (p) => `A service saturates at ${fmt(p.cap)} requests/s. Offered load is ${fmt(p.cap * (1 + p.over / 100))} requests/s, and rejecting a request is cheap. What percent of incoming requests must it shed to stay at capacity?`,
    solve: (p) => (p.over / (100 + p.over)) * 100,
    mistakes: (p) => [
      { value: p.over, feedback: "That is the excess as a share of capacity. Shedding is a share of offered load: (offered − capacity) ÷ offered." },
    ],
    hint: "Shed fraction = (offered − capacity) ÷ offered.",
  },
  "shedding.queue-depth": {
    id: "shedding.queue-depth", objective: "shed-amount", step: "queue-bound",
    params: { rate: { min: 100, max: 5000, step: 100 }, deadline: { min: 50, max: 950, step: 50 } },
    unit: "requests", tolerance: 0.01,
    prompt: (p) => `A server completes ${fmt(p.rate)} requests/s in FIFO order. Clients give up after ${p.deadline} ms. Ignoring a request's own service time, beyond what queue depth is a newly queued request certain to be served after its client has gone?`,
    solve: (p) => (p.rate * p.deadline) / 1000,
    mistakes: (p) => [
      { value: p.rate * p.deadline, feedback: "Convert the deadline to seconds before multiplying by the completion rate." },
      { value: p.rate, feedback: "That is one second of work. The useful queue holds only a deadline's worth: rate × deadline in seconds." },
    ],
    hint: "Queue wait = depth ÷ completion rate. Set that equal to the deadline: depth = rate × deadline in seconds.",
  },
  "shedding.collapse-time": {
    id: "shedding.collapse-time", objective: "goodput-collapse", step: "collapse",
    params: { cap: { min: 500, max: 5000, step: 500 }, excess: { min: 10, max: 90, step: 10 }, timeout: { min: 200, max: 2000, step: 100 } },
    unit: "seconds", tolerance: 0.01,
    prompt: (p) => `A server completes ${fmt(p.cap)} requests/s in FIFO order with an unbounded queue. Starting empty, offered load jumps to ${fmt(p.cap * (1 + p.excess / 100))} requests/s. Clients time out after ${fmt(p.timeout)} ms. After how many seconds does a newly arriving request wait longer than the client timeout?`,
    solve: (p) => p.timeout / 1000 / (p.excess / 100),
    mistakes: (p) => [
      { value: p.timeout / 1000, feedback: "The wait does not reach the timeout instantly. The queue grows at offered − capacity per second, and wait = queue ÷ capacity." },
      { value: (p.timeout / 1000) * (p.excess / 100), feedback: "Inverted. A smaller excess makes the queue grow more slowly, so collapse takes longer: timeout ÷ excess fraction." },
    ],
    hint: "Queue after t seconds = (offered − capacity) × t. Wait = queue ÷ capacity. Solve wait = timeout for t.",
  },
  "twopc.messages": {
    id: "twopc.messages", objective: "two-pc", step: "two-pc",
    params: { n: { min: 2, max: 10, step: 1 } },
    unit: "messages", tolerance: 0,
    prompt: (p) => `A two-phase commit coordinator commits a transaction across ${p.n} participants with no failures: prepare requests, votes, commit decisions and acknowledgements. How many messages are exchanged?`,
    solve: (p) => 4 * p.n,
    mistakes: (p) => [
      { value: 2 * p.n, feedback: "That is one phase. After the votes, the coordinator still sends every participant the decision and collects acknowledgements." },
      { value: 3 * p.n, feedback: "The acknowledgements count too: the coordinator needs them before it can forget the transaction." },
    ],
    hint: "Each participant gets a prepare, sends a vote, gets the decision and sends an acknowledgement: four messages each.",
  },
  "twopc.decision-latency": {
    id: "twopc.decision-latency", objective: "two-pc", step: "blocking",
    params: { rtt: { min: 1, max: 80, step: 1 }, fsync: { min: 1, max: 10, step: 1 } },
    unit: "ms", tolerance: 0,
    prompt: (p) => `Every participant is ${p.rtt} ms round trip from the coordinator. A forced log write (fsync) takes ${p.fsync} ms. Each participant must fsync its prepare record before voting yes, and the coordinator must fsync its decision before telling anyone. How long from sending prepare until the commit decision is durable at the coordinator? Ignore processing time.`,
    solve: (p) => p.rtt + 2 * p.fsync,
    mistakes: (p) => [
      { value: p.rtt + p.fsync, feedback: "There are two forced writes on the path: each participant's prepare record, then the coordinator's decision record." },
      { value: 2 * p.rtt + 2 * p.fsync, feedback: "The commit messages go out after the decision is durable. The question stops at the durable decision: one round trip plus two forced writes." },
    ],
    hint: "Prepare and vote are one round trip, with a participant fsync inside it; then the coordinator fsyncs its decision.",
  },
  "saga.compensations": {
    id: "saga.compensations", objective: "saga-compensation", step: "compensate",
    params: { n: { min: 3, max: 8, step: 1 }, k: { min: 2, max: 8, step: 1 } },
    valid: (p) => p.k < p.n,
    unit: "compensations", tolerance: 0,
    prompt: (p) => `A saga has ${p.n} steps, each a local transaction with a compensating action. Steps 1 to ${p.k - 1} committed; step ${p.k} fails and its local transaction rolls back. How many compensating transactions must run?`,
    solve: (p) => p.k - 1,
    mistakes: (p) => [
      { value: p.k, feedback: "The failed step rolled back locally, so it left nothing to undo. Compensate only the steps that committed." },
      { value: p.n, feedback: "Steps after the failure never ran. Compensations undo committed steps, in reverse order." },
    ],
    hint: "Compensate each committed step, in reverse order. The failed step rolled back on its own.",
  },
  "crdt.gcounter": {
    id: "crdt.gcounter", objective: "gcounter", step: "counter",
    params: { x1: { min: 0, max: 20, step: 1 }, x2: { min: 0, max: 20, step: 1 }, x3: { min: 0, max: 20, step: 1 }, y1: { min: 0, max: 20, step: 1 }, y2: { min: 0, max: 20, step: 1 }, y3: { min: 0, max: 20, step: 1 } },
    valid: (p) => {
      const x = [p.x1, p.x2, p.x3], y = [p.y1, p.y2, p.y3];
      return x.some((v, i) => v > y[i]) && y.some((v, i) => v > x[i]) && x.reduce((s, v, i) => s + Math.min(v, y[i]), 0) > 0;
    },
    unit: "count", tolerance: 0,
    prompt: (p) => `A G-Counter over replicas A, B and C. Replica X holds [A: ${p.x1}, B: ${p.x2}, C: ${p.x3}]; replica Y holds [A: ${p.y1}, B: ${p.y2}, C: ${p.y3}]. They merge their states. What value does the merged counter report?`,
    solve: (p) => Math.max(p.x1, p.y1) + Math.max(p.x2, p.y2) + Math.max(p.x3, p.y3),
    mistakes: (p) => {
      const one = "That is one replica's view, without the increments only the other replica has seen. Merge takes the per-entry maximum, then sums.";
      return [
        { value: p.x1 + p.x2 + p.x3 + p.y1 + p.y2 + p.y3, feedback: "Adding the states double-counts every increment both replicas have seen. Merge is the per-entry maximum, which is idempotent." },
        { value: p.x1 + p.x2 + p.x3, feedback: one },
        { value: p.y1 + p.y2 + p.y3, feedback: one },
      ];
    },
    hint: "Merge takes the maximum of each replica's entry; the counter's value is the sum of the merged entries.",
  },
  "ot.transform": {
    id: "ot.transform", objective: "ot-vs-crdt", step: "ot",
    params: { a: { min: 0, max: 20, step: 1 }, len: { min: 2, max: 6, step: 1 }, b: { min: 0, max: 40, step: 1 } },
    valid: (p) => p.b > p.a,
    unit: "index", tolerance: 0,
    prompt: (p) => `Alice and Bob edit the same document version. Concurrently, Alice inserts ${p.len} characters at index ${p.a} and Bob inserts one character at index ${p.b}. The server applies Alice's insert first. At what index must Bob's insert be applied after transformation?`,
    solve: (p) => p.b + p.len,
    mistakes: (p) => [
      { value: p.b, feedback: "Alice's insert sits before Bob's position, so everything after it moved right. Applying Bob's index unchanged puts his character in the wrong place." },
      { value: p.b + 1, feedback: "Shift by the number of characters Alice inserted, not by one operation." },
    ],
    hint: "An insert before your position shifts it right by the inserted length.",
  },
  "gossip.rounds": {
    id: "gossip.rounds", objective: "gossip-rounds", step: "epidemic",
    params: { n: { min: 100, max: 100000, step: 100 } },
    unit: "rounds", tolerance: 0.05,
    prompt: (p) => `Push gossip with fanout 1: each round, every informed node tells one peer chosen uniformly at random. Using Pittel's estimate log2(N) + ln(N), about how many rounds until all ${fmt(p.n)} nodes are informed?`,
    solve: (p) => Math.log2(p.n) + Math.log(p.n),
    mistakes: (p) => [
      { value: Math.log2(p.n), feedback: "That is only the doubling phase. The last few uninformed nodes are hard to hit at random, which adds about ln(N) more rounds." },
      { value: p.n - 1, feedback: "That is one-at-a-time broadcast. In gossip every informed node spreads in parallel, so coverage roughly doubles each round." },
    ],
    hint: "Add log2(N) for the doubling phase and ln(N) for the tail where few nodes remain uninformed.",
  },
  "gossip.phi": {
    id: "gossip.phi", objective: "phi", step: "phi",
    params: { mean: { min: 500, max: 2000, step: 100 }, silence: { min: 500, max: 10000, step: 100 } },
    unit: "phi", tolerance: 0.02,
    prompt: (p) => `A phi accrual detector models heartbeat gaps as exponential with mean ${fmt(p.mean)} ms, as Cassandra does, so phi = −log10(P(gap ≥ t)) = t ÷ (mean × ln 10). It has heard nothing for ${fmt(p.silence)} ms. What is phi?`,
    solve: (p) => p.silence / (p.mean * Math.LN10),
    mistakes: (p) => [
      { value: p.silence / p.mean, feedback: "That is the natural-log version. Phi uses log base 10, so divide by ln 10 as well." },
    ],
    hint: "phi = silence ÷ (mean gap × ln 10), with ln 10 ≈ 2.303.",
  },
  "gossip.phi-silence": {
    id: "gossip.phi-silence", objective: "phi", step: "threshold",
    params: { mean: { min: 500, max: 2000, step: 100 }, threshold: { min: 1, max: 16, step: 1 } },
    unit: "ms", tolerance: 0.02,
    prompt: (p) => `Under the same exponential model with mean heartbeat gap ${fmt(p.mean)} ms, a node is suspected when phi reaches ${p.threshold}. How many milliseconds of silence does that take?`,
    solve: (p) => p.threshold * p.mean * Math.LN10,
    mistakes: (p) => [
      { value: p.threshold * p.mean, feedback: "Phi is a base-10 logarithm: silence = phi × mean × ln 10, not phi × mean." },
    ],
    hint: "Invert phi = t ÷ (mean × ln 10): t = phi × mean × ln 10.",
  },
  // --- Track 2 (distributed-systems) templates: append above this line ---
  // Track 3: reliability and operations
  "obs.cardinality": {
    id: "obs.cardinality", objective: "control-cardinality", step: "cardinality",
    params: { endpoints: { min: 10, max: 60, step: 5 }, statuses: { min: 3, max: 6, step: 1 }, pods: { min: 20, max: 200, step: 20 }, buckets: { min: 8, max: 16, step: 2 } },
    unit: "series", tolerance: 0.01,
    prompt: (p) => `A Prometheus-style latency histogram has the labels endpoint (${p.endpoints} values), status_class (${p.statuses} values) and pod (${p.pods} values). Each label combination stores ${p.buckets} bucket series (including +Inf) plus one _sum and one _count series. If every combination occurs, how many time series does this one metric create?`,
    solve: (p) => p.endpoints * p.statuses * p.pods * (p.buckets + 2),
    mistakes: (p) => [
      { value: p.endpoints + p.statuses + p.pods, feedback: "Labels multiply, they do not add: every distinct combination of label values is its own series." },
      { value: p.endpoints * p.statuses * p.pods, feedback: "That counts each label combination once. A histogram stores a series per bucket plus _sum and _count for every combination." },
    ],
    hint: "Series = product of every label's distinct values × series per combination (buckets + 2 for a histogram).",
  },
  "obs.trace-volume": {
    id: "obs.trace-volume", objective: "budget-telemetry", step: "sampling",
    params: { rps: { min: 5000, max: 100000, step: 5000 }, sample: { min: 1, max: 10, step: 1 }, spans: { min: 10, max: 60, step: 5 }, bytes: { min: 200, max: 1000, step: 100 } },
    unit: "GB/day", tolerance: 0.02,
    prompt: (p) => `A system serves ${fmt(p.rps)} requests/s. Head-based sampling keeps ${p.sample}% of traces. An average trace has ${p.spans} spans of ${p.bytes} bytes each. Before compression and indexing, how many decimal GB of span data are stored per day?`,
    solve: (p) => (p.rps * (p.sample / 100) * p.spans * p.bytes * 86400) / 1e9,
    mistakes: (p) => [
      { value: (p.rps * p.spans * p.bytes * 86400) / 1e9, feedback: "That stores every trace. Only the sampled fraction is kept: multiply by the sampling rate." },
      { value: (p.rps * (p.sample / 100) * p.bytes * 86400) / 1e9, feedback: "That stores one span per trace. A trace has one span per unit of work: multiply by spans per trace." },
    ],
    hint: "GB/day = requests/s × sampling fraction × spans per trace × bytes per span × 86,400 ÷ 10^9.",
  },
  "slo.budget-minutes": {
    id: "slo.budget-minutes", objective: "compute-error-budget", step: "budget",
    params: { slo: { min: 99, max: 99.95, step: 0.05 }, days: { min: 7, max: 35, step: 7 } },
    unit: "minutes", tolerance: 0.01,
    prompt: (p) => `An SLO says ${p.slo}% of minutes are good, measured over a rolling ${p.days}-day window. How many bad minutes does the error budget allow in that window?`,
    solve: (p) => (p.days * 1440 * (100 - p.slo)) / 100,
    mistakes: (p) => [
      { value: (p.days * 1440 * p.slo) / 100, feedback: "That is the number of good minutes the SLO requires. The budget is the complement: window × (1 − SLO)." },
      { value: (p.days * 24 * (100 - p.slo)) / 100, feedback: "That is the budget in hours. A day has 1,440 minutes, not 24." },
    ],
    hint: "Error budget = window in minutes × (1 − SLO). A day is 1,440 minutes.",
  },
  "slo.burn-rate": {
    id: "slo.burn-rate", objective: "alert-on-burn-rate", step: "burn-rate",
    params: { slo: { min: 99, max: 99.9, step: 0.1 }, err: { min: 0.5, max: 10, step: 0.5 } },
    unit: "× sustainable", tolerance: 0.02,
    valid: (p) => p.err / (100 - p.slo) >= 2 && Math.abs((100 - p.slo) / p.err - p.err / p.slo) > 0.05 * ((100 - p.slo) / p.err),
    prompt: (p) => `A request SLO is ${p.slo}% success over 30 days. Over the last hour, ${p.err}% of requests failed. What is the burn rate: how many times faster than the sustainable pace is the error budget being spent?`,
    solve: (p) => p.err / (100 - p.slo),
    mistakes: (p) => [
      { value: (100 - p.slo) / p.err, feedback: "That is inverted. Burn rate = observed error ratio ÷ budgeted error ratio, so a rate above 1 means the budget runs out early." },
      { value: p.err / p.slo, feedback: "Divide by the error budget (1 − SLO), not by the SLO itself." },
    ],
    hint: "Burn rate = observed error ratio ÷ (1 − SLO). A burn rate of 1 spends exactly the whole budget over the window.",
  },
  "failure.retry-amplification": {
    id: "failure.retry-amplification", objective: "predict-retry-amplification", step: "retry-storm",
    params: { layers: { min: 2, max: 4, step: 1 }, attempts: { min: 2, max: 5, step: 1 } },
    unit: "attempts", tolerance: 0,
    valid: (p) => !(p.layers === 2 && p.attempts === 2),
    prompt: (p) => `A request passes through ${p.layers} layers of services before reaching a database. Each layer makes up to ${p.attempts} attempts on the layer below (the first try plus ${p.attempts - 1} retries). The database is down, so every attempt fails. How many attempts reach the database for one user request?`,
    solve: (p) => p.attempts ** p.layers,
    mistakes: (p) => [
      { value: p.attempts * p.layers, feedback: "Retries at stacked layers multiply, not add: each attempt from above triggers a full set of attempts below." },
      { value: p.attempts, feedback: "That counts only the layer next to the database. Every layer above it also retries, and each retry fans out again." },
    ],
    hint: "Attempts at the bottom = (attempts per layer) ^ (number of retrying layers).",
  },
  "failure.metastable-load": {
    id: "failure.metastable-load", objective: "explain-metastability", step: "metastable",
    params: { base: { min: 1000, max: 8000, step: 500 }, headroom: { min: 10, max: 60, step: 10 }, retries: { min: 2, max: 4, step: 1 } },
    unit: "attempts/s", tolerance: 0.01,
    prompt: (p) => `Clients send ${fmt(p.base)} requests/s to a service that can complete ${fmt(round(p.base * (1 + p.headroom / 100)))} requests/s. A 30-second database pause pushed latency past the client timeout. Each client retries a timed-out request ${p.retries} more times, and with the queue now full, every attempt times out. The pause is over. What load, in attempts per second, does the service now receive?`,
    solve: (p) => p.base * (p.retries + 1),
    mistakes: (p) => [
      { value: p.base, feedback: "That is the organic load, which the service could handle. The retries are now part of the load and keep it overloaded after the trigger is gone." },
      { value: p.base * p.retries, feedback: "That counts only the retries. Each request is attempted once plus its retries: base × (retries + 1)." },
    ],
    hint: "When every attempt times out, each request becomes 1 + retries attempts. Compare that with capacity.",
  },
  "failure.herd-jitter": {
    id: "failure.herd-jitter", objective: "prevent-synchronized-load", step: "herd",
    params: { clients: { min: 20000, max: 500000, step: 20000 }, jitter: { min: 10, max: 120, step: 10 } },
    unit: "reconnects/s", tolerance: 0.02,
    prompt: (p) => `${fmt(p.clients)} clients lose their connections when a server restarts. Without jitter they all reconnect within the same second. If each instead waits a uniformly random delay between 0 and ${p.jitter} seconds, about what reconnect rate per second does the server see?`,
    solve: (p) => p.clients / p.jitter,
    mistakes: (p) => [
      { value: p.clients, feedback: "That is the unjittered spike: every client in one second. A uniform delay spreads them across the whole jitter window." },
    ],
    hint: "Uniform jitter spreads N reconnects evenly over the window: rate ≈ N ÷ window seconds.",
  },
  "dr.restore-hours": {
    id: "dr.restore-hours", objective: "estimate-rto", step: "restore-time",
    params: { tb: { min: 2, max: 50, step: 2 }, gbps: { min: 1, max: 10, step: 1 } },
    unit: "hours", tolerance: 0.02,
    prompt: (p) => `A ${p.tb} TB backup must be copied back before the database can start. The restore path sustains ${p.gbps} Gbit/s end to end. Using decimal units and ignoring log replay and verification, how many hours does the copy take?`,
    solve: (p) => (p.tb * 8000) / p.gbps / 3600,
    mistakes: (p) => [
      { value: (p.tb * 1000) / p.gbps / 3600, feedback: "TB counts bytes but Gbit/s counts bits. Multiply terabytes by 8,000 to get gigabits." },
      { value: (p.tb * 8000) / p.gbps / 60, feedback: "That is minutes. Divide seconds by 3,600 for hours." },
    ],
    hint: "Hours = TB × 8,000 Gbit/TB ÷ Gbit/s ÷ 3,600.",
  },
  "dr.rpo-writes": {
    id: "dr.rpo-writes", objective: "reason-rpo", step: "rpo",
    params: { wps: { min: 50, max: 2000, step: 50 }, minutes: { min: 1, max: 15, step: 1 } },
    unit: "writes", tolerance: 0.01,
    prompt: (p) => `Nightly snapshots are copied to a second region, and the write-ahead log is shipped there every ${p.minutes} minutes. The primary region is lost just before a shipment. At ${fmt(p.wps)} committed writes per second, how many committed writes are lost in the worst case?`,
    solve: (p) => p.wps * p.minutes * 60,
    mistakes: (p) => [
      { value: p.wps * 86400, feedback: "That assumes you restore only the nightly snapshot. Shipped logs replay on top of it, so the log-shipping interval sets the RPO." },
      { value: p.wps * p.minutes, feedback: "The write rate is per second and the interval is in minutes. Multiply the interval by 60." },
    ],
    hint: "Worst-case loss = write rate × the gap since the last shipped log (in seconds).",
  },
  "region.n-plus-one": {
    id: "region.n-plus-one", objective: "size-region-failover", step: "capacity",
    params: { peak: { min: 20000, max: 200000, step: 10000 }, regions: { min: 2, max: 6, step: 1 } },
    unit: "requests/s", tolerance: 0.01,
    prompt: (p) => `An active-active service runs in ${p.regions} regions and serves ${fmt(p.peak)} requests/s at peak, split evenly. If one region fails, its traffic moves to the others with no time to autoscale. What minimum capacity, in requests/s, must each region have?`,
    solve: (p) => p.peak / (p.regions - 1),
    mistakes: (p) => [
      { value: p.peak / p.regions, feedback: "That is each region's share on a normal day. After a failure, the surviving regions split the whole peak: peak ÷ (regions − 1)." },
    ],
    hint: "Survivors carry the full peak: per-region capacity = peak ÷ (regions − 1).",
  },
  "region.quorum-latency": {
    id: "region.quorum-latency", objective: "estimate-cross-region-latency", step: "consensus-latency",
    params: { local: { min: 1, max: 5, step: 1 }, near: { min: 20, max: 80, step: 10 }, extra: { min: 20, max: 120, step: 10 } },
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `A leader in region A replicates each write to replicas in regions B and C and commits once a majority of the three (including itself) has it. It first writes its own log (${p.local} ms), then sends to both. The round-trip time from A is ${p.near} ms to B and ${p.near + p.extra} ms to C. Ignoring processing, what is the commit latency?`,
    solve: (p) => p.local + p.near,
    mistakes: (p) => [
      { value: p.local + p.near + p.extra, feedback: "A majority of three is two: the leader plus the fastest replica. The leader does not wait for the farthest region." },
      { value: p.local, feedback: "A majority needs one remote acknowledgement, which costs a round trip to the nearest replica." },
    ],
    hint: "Majority commit = local write + round trip to the nearest replica that completes the majority.",
  },
  "deploy.canary-blast": {
    id: "deploy.canary-blast", objective: "size-canary-blast-radius", step: "canary",
    params: { rps: { min: 1000, max: 50000, step: 1000 }, pct: { min: 1, max: 10, step: 1 }, minutes: { min: 5, max: 30, step: 5 }, err: { min: 2, max: 20, step: 2 } },
    unit: "failed requests", tolerance: 0.01,
    valid: (p) => p.err !== p.pct,
    prompt: (p) => `A service handles ${fmt(p.rps)} requests/s. A canary gets ${p.pct}% of traffic. The new build fails ${p.err}% of the requests it serves, and automated rollback fires after ${p.minutes} minutes. How many user requests fail before the rollback?`,
    solve: (p) => p.rps * (p.pct / 100) * p.minutes * 60 * (p.err / 100),
    mistakes: (p) => [
      { value: p.rps * p.minutes * 60 * (p.err / 100), feedback: "That is a full rollout to everyone. Only the canary's share of traffic reaches the bad build." },
      { value: p.rps * (p.pct / 100) * p.minutes * 60, feedback: "That counts every canary request. Only the failing fraction of those requests fails." },
    ],
    hint: "Failures = requests/s × canary fraction × exposure seconds × failure rate of the new build.",
  },
  "deploy.rolling-batch": {
    id: "deploy.rolling-batch", objective: "plan-rollout-capacity", step: "rolling",
    params: { n: { min: 6, max: 40, step: 2 }, util: { min: 40, max: 70, step: 5 }, target: { min: 75, max: 90, step: 5 } },
    unit: "instances", tolerance: 0,
    valid: (p) => {
      const b = Math.floor(p.n * (1 - p.util / p.target) + 1e-9);
      const all = Math.floor(p.n * (1 - p.util / 100) + 1e-9);
      const keep = Math.ceil((p.n * p.util) / p.target - 1e-9);
      return p.util < p.target && b >= 1 && b !== all && b !== keep && all !== keep;
    },
    prompt: (p) => `A fleet of ${p.n} identical instances runs at ${p.util}% utilisation at peak. A rolling deploy takes a batch of instances out of service at a time. What is the largest batch that keeps the remaining instances at or below ${p.target}% utilisation at peak?`,
    solve: (p) => Math.floor(p.n * (1 - p.util / p.target) + 1e-9),
    mistakes: (p) => [
      { value: Math.floor(p.n * (1 - p.util / 100) + 1e-9), feedback: `That runs the survivors at 100%. Keep them at or below the ${p.target}% target: (n − b) × target ≥ n × utilisation.` },
      { value: Math.ceil((p.n * p.util) / p.target - 1e-9), feedback: "That is how many instances must stay in service. The batch is the rest: n minus that, rounded down." },
    ],
    hint: "Remaining instances must carry the load at the target: (n − b) × target ≥ n × utilisation. Solve for the largest whole b.",
  },
  "capacity.months": {
    id: "capacity.months", objective: "forecast-saturation", step: "growth",
    params: { peak: { min: 10000, max: 90000, step: 10000 }, ratio: { min: 1.3, max: 4, step: 0.1 }, growth: { min: 3, max: 15, step: 1 } },
    unit: "months", tolerance: 0.02,
    valid: (p) => {
      const exact = Math.log(p.ratio) / Math.log(1 + p.growth / 100);
      return Math.abs((p.ratio - 1) / (p.growth / 100) - exact) / exact > 0.05;
    },
    prompt: (p) => `Peak traffic is ${fmt(p.peak)} requests/s and grows ${p.growth}% month over month, compounding. The system saturates at ${fmt(round(p.peak * p.ratio))} requests/s. In how many months does peak reach saturation?`,
    solve: (p) => Math.log(p.ratio) / Math.log(1 + p.growth / 100),
    mistakes: (p) => [
      { value: (p.ratio - 1) / (p.growth / 100), feedback: "That assumes linear growth. Compounding growth reaches saturation sooner: months = ln(capacity ÷ peak) ÷ ln(1 + growth)." },
    ],
    hint: "Solve peak × (1 + g)^m = capacity: m = ln(capacity ÷ peak) ÷ ln(1 + g).",
  },
  "capacity.first-saturation": {
    id: "capacity.first-saturation", objective: "find-breaking-point", step: "breaking-point",
    params: { lb: { min: 5, max: 30, step: 5 }, svc: { min: 20, max: 70, step: 5 }, db: { min: 20, max: 70, step: 5 } },
    unit: "× today's peak", tolerance: 0.01,
    valid: (p) => Math.abs(p.svc - p.db) >= 10,
    prompt: (p) => `At today's peak, the load balancer runs at ${p.lb}% utilisation, the service tier at ${p.svc}% and the database at ${p.db}%. Each component's load grows in proportion to traffic and nothing autoscales. At what multiple of today's peak does the first component reach 100%?`,
    solve: (p) => 100 / Math.max(p.lb, p.svc, p.db),
    mistakes: (p) => [
      { value: 100 / Math.min(p.lb, p.svc, p.db), feedback: "That is when the least-loaded component saturates. The breaking point is set by the most-utilised one, which saturates first." },
    ],
    hint: "Each component saturates at 100 ÷ its utilisation; the first to go is the one with the highest utilisation.",
  },

  // Track 4: security and data
  "auth.salted-crack": {
    id: "auth.salted-crack", objective: "store-passwords", step: "passwords",
    params: { dict: { min: 10, max: 500, step: 10 }, users: { min: 10, max: 1000, step: 10 }, rate: { min: 1000, max: 20000, step: 1000 } },
    unit: "days", tolerance: 0.02,
    prompt: (p) => `An attacker steals a password table hashed with a slow hash and a unique random salt per user. At this work factor their hardware computes ${fmt(p.rate)} guesses per second. They try a ${p.dict}-million-word dictionary against all ${fmt(p.users * 1000)} users. How many days does the full attack take?`,
    solve: (p) => (p.dict * 1e6 * p.users * 1000) / p.rate / 86400,
    mistakes: (p) => [
      { value: (p.dict * 1e6) / p.rate / 86400, feedback: "That is one pass of the dictionary, which would crack everyone only if hashes were unsalted. Unique salts force a separate pass per user." },
    ],
    hint: "Days = dictionary size × users (one pass per salt) ÷ guesses per second ÷ 86,400.",
  },
  "jwt.denylist": {
    id: "jwt.denylist", objective: "revoke-tokens", step: "revocation",
    params: { revokes: { min: 100, max: 5000, step: 100 }, lifetime: { min: 5, max: 60, step: 5 } },
    unit: "entries", tolerance: 0.01,
    prompt: (p) => `Access tokens are JWTs that live ${p.lifetime} minutes. You revoke about ${fmt(p.revokes)} tokens per hour (logouts, password resets) by adding their jti to a denylist, and each entry is dropped when its token would have expired. At steady state, about how many entries does the denylist hold?`,
    solve: (p) => (p.revokes * p.lifetime) / 60,
    mistakes: (p) => [
      { value: p.revokes * p.lifetime, feedback: "The revocation rate is per hour and the lifetime is in minutes. Convert the lifetime to hours first." },
    ],
    hint: "Little's law: entries = revocations per hour × hours each entry lives (the token lifetime).",
  },
  "jwt.refresh-load": {
    id: "jwt.refresh-load", objective: "choose-token-lifetime", step: "lifetime",
    params: { users: { min: 100000, max: 5000000, step: 100000 }, lifetime: { min: 5, max: 60, step: 5 } },
    unit: "requests/s", tolerance: 0.01,
    prompt: (p) => `${fmt(p.users)} clients stay active all day, each refreshing its access token just before it expires. Access tokens live ${p.lifetime} minutes. About how many refresh requests per second reach the token endpoint?`,
    solve: (p) => p.users / (p.lifetime * 60),
    mistakes: (p) => [
      { value: p.users / p.lifetime, feedback: "That is refreshes per minute. Divide by the lifetime in seconds for a per-second rate." },
    ],
    hint: "Each client refreshes once per lifetime: rate = active clients ÷ lifetime in seconds.",
  },
  "oauth.verifier-entropy": {
    id: "oauth.verifier-entropy", objective: "explain-pkce", step: "pkce",
    params: { octets: { min: 32, max: 96, step: 1 } },
    unit: "bits", tolerance: 0,
    prompt: (p) => `A client creates its PKCE code_verifier by base64url-encoding ${p.octets} bytes from a cryptographically secure random generator, giving a ${Math.ceil((p.octets * 4) / 3)}-character string. How many bits of entropy does the verifier carry?`,
    solve: (p) => p.octets * 8,
    mistakes: (p) => [
      { value: Math.ceil((p.octets * 4) / 3) * 8, feedback: "Encoding adds characters, not randomness. Each base64url character carries at most 6 bits; the entropy is the 8 bits of each random byte." },
    ],
    hint: "Entropy comes from the random bytes: bytes × 8. Encoding does not add any.",
  },
  "tls.full-handshakes": {
    id: "tls.full-handshakes", objective: "cost-tls", step: "handshakes",
    params: { conns: { min: 1000, max: 50000, step: 1000 }, resumed: { min: 55, max: 95, step: 5 } },
    unit: "handshakes/s", tolerance: 0.01,
    prompt: (p) => `A TLS 1.3 terminator accepts ${fmt(p.conns)} new connections per second. ${p.resumed}% resume an earlier session with a pre-shared key and skip the certificate signature. How many full handshakes, each needing a signature with the certificate's private key, does it perform per second?`,
    solve: (p) => (p.conns * (100 - p.resumed)) / 100,
    mistakes: (p) => [
      { value: (p.conns * p.resumed) / 100, feedback: "That is the resumed share. Full handshakes are the connections that do not resume." },
      { value: p.conns, feedback: "Resumed sessions skip the certificate signature. Only the non-resumed connections pay for it." },
    ],
    hint: "Full handshakes = new connections × (1 − resumption rate).",
  },
  "crypto.gcm-days": {
    id: "crypto.gcm-days", objective: "rotate-by-usage", step: "nonce-limit",
    params: { k: { min: 1, max: 100, step: 1 } },
    unit: "days", tolerance: 0.02,
    prompt: (p) => `A service encrypts ${fmt(p.k * 1000)} messages per second under one AES-GCM key with random 96-bit IVs. NIST SP 800-38D limits a key to 2^32 encryptions when IVs are random. After how many days must that key be retired?`,
    solve: (p) => 2 ** 32 / (p.k * 1000) / 86400,
    mistakes: (p) => [
      { value: 2 ** 32 / (p.k * 1000), feedback: "That is seconds. Divide by 86,400 for days." },
      { value: 2 ** 32 / p.k / 86400, feedback: "The rate is thousands of messages per second. Multiply by 1,000 before dividing." },
    ],
    hint: "Days = 2^32 ÷ encryptions per second ÷ 86,400. 2^32 ≈ 4.29 billion.",
  },
  "keys.envelope-rate": {
    id: "keys.envelope-rate", objective: "design-envelope-encryption", step: "envelope",
    params: { writes: { min: 1000, max: 50000, step: 1000 }, reuse: { min: 100, max: 5000, step: 100 } },
    unit: "calls/s", tolerance: 0.01,
    prompt: (p) => `A service encrypts ${fmt(p.writes)} objects per second with envelope encryption. It reuses each data key for up to ${fmt(p.reuse)} objects before asking the KMS for a new one. How many KMS data-key requests per second does it make?`,
    solve: (p) => p.writes / p.reuse,
    mistakes: (p) => [
      { value: p.writes, feedback: "That asks the KMS once per object. Data-key caching amortises one KMS call across many objects." },
    ],
    hint: "KMS calls/s = objects/s ÷ objects per data key.",
  },
  "keys.rewrap": {
    id: "keys.rewrap", objective: "plan-key-rotation", step: "rotation",
    params: { tb: { min: 50, max: 500, step: 50 }, deks: { min: 1, max: 50, step: 1 }, kms: { min: 1000, max: 10000, step: 1000 }, gbps: { min: 1, max: 5, step: 1 } },
    unit: "hours", tolerance: 0.02,
    valid: (p) => {
      const rewrap = (p.deks * 1e6) / p.kms / 3600;
      const bulk = (p.tb * 1000) / p.gbps / 3600;
      return Math.abs(rewrap - bulk) / rewrap > 0.1;
    },
    prompt: (p) => `You rotate the key-encryption key for ${p.tb} TB of data, protected under envelope encryption by ${p.deks} million wrapped data keys. Your KMS can rewrap ${fmt(p.kms)} data keys per second; re-encrypting the data itself would run at ${p.gbps} GB/s. How many hours does the key-encryption-key rotation take?`,
    solve: (p) => (p.deks * 1e6) / p.kms / 3600,
    mistakes: (p) => [
      { value: (p.tb * 1000) / p.gbps / 3600, feedback: "Rotating the key-encryption key does not touch the data. You decrypt and re-wrap each small data key; the bulk data stays as it is." },
    ],
    hint: "Hours = wrapped data keys ÷ rewraps per second ÷ 3,600.",
  },
  "ddos.amplification": {
    id: "ddos.amplification", objective: "size-reflection-attack", step: "amplification",
    params: { mbps: { min: 100, max: 2000, step: 100 }, factor: { min: 20, max: 560, step: 20 } },
    unit: "Gbit/s", tolerance: 0.01,
    prompt: (p) => `Attackers send ${fmt(p.mbps)} Mbit/s of small UDP queries with the victim's spoofed source address to open reflectors. Each reflector's response is ${p.factor} times larger than the query. How many Gbit/s arrive at the victim?`,
    solve: (p) => (p.mbps * p.factor) / 1000,
    mistakes: (p) => [
      { value: p.mbps * p.factor, feedback: "That is Mbit/s. Divide by 1,000 for Gbit/s." },
      { value: p.mbps / 1000, feedback: "That ignores the amplification. Reflectors send the larger response to the spoofed victim address." },
    ],
    hint: "Victim bandwidth = query bandwidth × amplification factor; 1,000 Mbit/s = 1 Gbit/s.",
  },
  "ddos.anycast": {
    id: "ddos.anycast", objective: "absorb-volumetric", step: "anycast",
    params: { attack: { min: 200, max: 3000, step: 100 }, pops: { min: 20, max: 300, step: 20 } },
    unit: "Gbit/s", tolerance: 0.01,
    prompt: (p) => `A ${fmt(p.attack)} Gbit/s volumetric attack comes from a botnet spread worldwide. Your address is anycast from ${p.pops} edge locations, and you assume the attack splits evenly between them. How many Gbit/s must each location absorb?`,
    solve: (p) => p.attack / p.pops,
    mistakes: (p) => [
      { value: p.attack, feedback: "With anycast, each source is routed to its nearest location, so the attack is divided between them rather than landing on one." },
    ],
    hint: "Per-location load = attack ÷ locations, if sources are spread evenly. Real botnets cluster, so size for the worst location.",
  },
  "abuse.stuffing-hours": {
    id: "abuse.stuffing-hours", objective: "stop-credential-stuffing", step: "stuffing",
    params: { creds: { min: 1, max: 50, step: 1 }, limit: { min: 5, max: 50, step: 5 }, ips: { min: 1, max: 100, step: 1 } },
    unit: "hours", tolerance: 0.01,
    prompt: (p) => `An attacker has ${p.creds} million leaked username and password pairs. Your login rate limit allows ${p.limit} attempts per IP address per hour. The attacker rents ${fmt(p.ips * 1000)} residential proxy IPs. How many hours does it take to try every pair?`,
    solve: (p) => (p.creds * 1e6) / (p.limit * p.ips * 1000),
    mistakes: (p) => [
      { value: (p.creds * 1e6) / p.limit, feedback: "That assumes one IP address. A per-IP limit scales with the attacker's proxy pool: divide by limit × IPs." },
    ],
    hint: "Hours = credential pairs ÷ (attempts per IP per hour × number of IPs).",
  },
  "abuse.base-rate": {
    id: "abuse.base-rate", objective: "weigh-false-positives", step: "false-positives",
    params: { legit: { min: 10, max: 100, step: 5 }, abuse: { min: 0.5, max: 10, step: 0.5 }, fp: { min: 0.1, max: 2, step: 0.1 }, tp: { min: 80, max: 99, step: 1 } },
    unit: "%", tolerance: 0.02,
    valid: (p) => {
      const share = (100 * p.legit * p.fp) / (p.legit * p.fp + p.abuse * p.tp);
      return Math.abs(share - p.fp) / share > 0.1 && Math.abs(share - (100 - p.tp)) / share > 0.1 && Math.abs(p.fp - (100 - p.tp)) > 0.1;
    },
    prompt: (p) => `A login-abuse classifier blocks ${p.tp}% of abusive attempts and wrongly blocks ${p.fp}% of legitimate ones. Each day brings ${p.legit} million legitimate and ${p.abuse} million abusive attempts. What percent of blocked attempts come from legitimate users?`,
    solve: (p) => (100 * p.legit * p.fp) / (p.legit * p.fp + p.abuse * p.tp),
    mistakes: (p) => [
      { value: p.fp, feedback: "That is the false-positive rate on legitimate traffic. The share of blocks that hit real users also depends on how much more legitimate traffic there is: legit × fp ÷ (legit × fp + abuse × tp)." },
      { value: 100 - p.tp, feedback: "That is the share of abuse the classifier misses, not the share of blocks that hit legitimate users." },
    ],
    hint: "Count both kinds of block: legitimate blocked = legit × fp; abusive blocked = abuse × tp. Take the legitimate share of the total.",
  },
  "tenancy.shuffle-shards": {
    id: "tenancy.shuffle-shards", objective: "contain-blast-radius", step: "shuffle",
    params: { n: { min: 6, max: 16, step: 1 }, k: { min: 2, max: 4, step: 1 } },
    unit: "shards", tolerance: 0,
    prompt: (p) => `Each tenant is assigned a shuffle shard: ${p.k} of ${p.n} workers, chosen as an unordered set. How many distinct shuffle shards are possible?`,
    solve: (p) => {
      let c = 1;
      for (let i = 0; i < p.k; i++) c = (c * (p.n - i)) / (i + 1);
      return Math.round(c);
    },
    mistakes: (p) => [
      { value: p.n / p.k, feedback: "That is classic sharding into fixed groups of k. Shuffle sharding lets groups overlap, giving n choose k combinations." },
      { value: p.n ** p.k, feedback: "That counts ordered picks with repeats. A shard is a set of k distinct workers: n! ÷ (k! × (n − k)!)." },
    ],
    hint: "Distinct shards = n choose k = n! ÷ (k! × (n − k)!).",
  },
  "privacy.erasure-days": {
    id: "privacy.erasure-days", objective: "bound-erasure", step: "backups",
    params: { p: { min: 1, max: 10, step: 1 }, r: { min: 7, max: 91, step: 7 }, a: { min: 14, max: 182, step: 14 } },
    unit: "days", tolerance: 0,
    prompt: (p) => `A deletion request is applied to the primary database within ${p.p} days. Daily backups are kept for ${p.r} days and are never edited. The analytics warehouse holds raw events for ${p.a} days and is not purged on request. In the worst case, how many days after the request does the last copy of the user's data disappear?`,
    solve: (p) => p.p + Math.max(p.r, p.a),
    mistakes: (p) => [
      { value: p.p + p.r + p.a, feedback: "Backups and analytics expire in parallel, not one after the other. Add the longest retention, not every retention." },
      { value: Math.max(p.r, p.a), feedback: "Copies taken just before the primary deletion still contain the data. The retention clock starts after the deletion is applied." },
      { value: p.p, feedback: "That covers the primary only. Backups and the warehouse keep copies until their retention ends." },
    ],
    hint: "Worst case = time to apply the deletion + the longest retention of any copy that is not purged.",
  },

  // Track 6: interview craft
  "interview.time-budget": {
    id: "interview.time-budget", objective: "allocate-time", step: "time",
    params: { total: { min: 45, max: 60, step: 15 }, req: { min: 3, max: 8, step: 1 }, est: { min: 3, max: 6, step: 1 }, api: { min: 3, max: 8, step: 1 }, hld: { min: 8, max: 15, step: 1 }, wrap: { min: 2, max: 5, step: 1 } },
    unit: "minutes", tolerance: 0,
    valid: (p) => p.total - (p.req + p.est + p.api + p.hld + p.wrap) >= 5,
    prompt: (p) => `In a ${p.total}-minute interview you plan ${p.req} minutes for requirements, ${p.est} for estimates, ${p.api} for the API and data model, ${p.hld} for the high-level design and ${p.wrap} for the wrap-up. How many minutes are left for deep dives?`,
    solve: (p) => p.total - (p.req + p.est + p.api + p.hld + p.wrap),
    mistakes: (p) => [
      { value: p.total - (p.req + p.est + p.api + p.hld), feedback: "Leave the wrap-up in the plan. Summarising trade-offs and next steps is part of the signal, so subtract it too." },
    ],
    hint: "Deep-dive time = total − every other planned stage.",
  },
  "interview.storage-years": {
    id: "interview.storage-years", objective: "sanity-check-estimates", step: "estimates",
    params: { m: { min: 1, max: 100, step: 1 }, bytes: { min: 200, max: 2000, step: 100 }, years: { min: 1, max: 10, step: 1 } },
    unit: "TB", tolerance: 0.05,
    prompt: (p) => `Users create ${p.m} million records per day, each about ${fmt(p.bytes)} bytes. How many decimal TB of raw data accumulate in ${p.years} years, before replication and indexes?`,
    solve: (p) => (p.m * 1e6 * p.bytes * 365 * p.years) / 1e12,
    mistakes: (p) => [
      { value: (p.m * 1e6 * p.bytes * p.years) / 1e12, feedback: "That is one day per year. Multiply the daily volume by 365 days per year." },
      { value: (p.m * 1e6 * p.bytes * 365 * p.years) / 1e9, feedback: "That is GB. A TB is 10^12 bytes." },
    ],
    hint: "TB = records/day × bytes × 365 × years ÷ 10^12.",
  },
  "clarify.fanout": {
    id: "clarify.fanout", objective: "ask-about-distribution", step: "distribution",
    params: { posts: { min: 1000, max: 20000, step: 1000 }, followers: { min: 50, max: 500, step: 50 } },
    unit: "writes/s", tolerance: 0.01,
    prompt: (p) => `Users publish ${fmt(p.posts)} posts per second, and the average author has ${p.followers} followers. With fan-out on write, each post is inserted into every follower's home timeline. How many timeline inserts per second does that create on average?`,
    solve: (p) => p.posts * p.followers,
    mistakes: (p) => [
      { value: p.posts, feedback: "That counts the posts, not the inserts. Fan-out on write does one insert per follower of each post." },
    ],
    hint: "Timeline inserts/s = posts/s × average followers per author.",
  },
  "clarify.celebrity": {
    id: "clarify.celebrity", objective: "ask-about-distribution", step: "celebrity",
    params: { followers: { min: 10, max: 150, step: 10 }, rate: { min: 50000, max: 500000, step: 50000 } },
    unit: "minutes", tolerance: 0.01,
    prompt: (p) => `An account with ${p.followers} million followers posts once. Fan-out workers insert ${fmt(p.rate)} timeline entries per second in total, with nothing else queued. How many minutes until the last follower's timeline has the post?`,
    solve: (p) => (p.followers * 1e6) / p.rate / 60,
    mistakes: (p) => [
      { value: (p.followers * 1e6) / p.rate, feedback: "That is seconds. Divide by 60 for minutes." },
    ],
    hint: "Minutes = followers ÷ inserts per second ÷ 60.",
  },
  "tradeoff.sync-latency": {
    id: "tradeoff.sync-latency", objective: "quantify-tradeoff", step: "quantify",
    params: { base: { min: 20, max: 80, step: 5 }, writes: { min: 2, max: 5, step: 1 }, rtt: { min: 30, max: 150, step: 10 } },
    unit: "ms", tolerance: 0.01,
    prompt: (p) => `A checkout request takes ${p.base} ms today and performs ${p.writes} database writes, one after another. Making replication synchronous to a second region adds one ${p.rtt} ms round trip to every write. What will the request latency be?`,
    solve: (p) => p.base + p.writes * p.rtt,
    mistakes: (p) => [
      { value: p.base + p.rtt, feedback: "Every sequential write waits for its own cross-region acknowledgement. Multiply the round trip by the number of writes." },
      { value: p.base, feedback: "Synchronous replication waits for the remote acknowledgement before each write commits, so its round trip lands on the request path." },
    ],
    hint: "New latency = current latency + sequential writes × added round trip.",
  },
  "mistakes.qps": {
    id: "mistakes.qps", objective: "catch-estimate-errors", step: "units",
    params: { dau: { min: 10, max: 500, step: 10 }, actions: { min: 5, max: 50, step: 5 } },
    unit: "requests/s", tolerance: 0.15,
    prompt: (p) => `${p.dau} million daily active users each make ${p.actions} requests per day. What is the average request rate per second? (Rounding a day to 100,000 seconds is fine.)`,
    solve: (p) => (p.dau * 1e6 * p.actions) / 86400,
    mistakes: (p) => [
      { value: (p.dau * 1e6 * p.actions) / 3600, feedback: "That divides by the seconds in an hour. A day has 86,400 seconds; this mistake inflates load 24 times and the design with it." },
      { value: p.dau * 1e6 * p.actions, feedback: "That is requests per day. Divide by about 86,400 seconds for a per-second rate." },
    ],
    hint: "Average requests/s = DAU × requests per user per day ÷ 86,400.",
  },
  // --- Tracks 3, 4, 6 (reliability, security, interview-craft) templates: append above this line ---
};

import { templatesA } from "./variants-a";
import { templatesB } from "./variants-b";

// New-lesson templates live in their own files so authors can add them in parallel.
Object.assign(templates, templatesA, templatesB);

export const templateIds = Object.keys(templates) as [string, ...string[]];
