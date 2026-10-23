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
};

export const templateIds = Object.keys(templates) as [string, ...string[]];
