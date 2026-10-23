import type { Dist, Percentiles } from '../types';

export type Histogram = Map<number, number>;
export const emptyPercentiles = (): Percentiles => ({ p50: null, p90: null, p99: null, p999: null });
const bucket = (us: number) => us <= 1000 ? Math.ceil(Math.max(0, us)) : 1000 * 1.005 ** Math.ceil(Math.log(us / 1000) / Math.log(1.005));
export const point = (us = 0, mass = 1): Histogram => new Map(mass > 0 ? [[bucket(us), mass]] : []);
export const mass = (h: Histogram) => [...h.values()].reduce((a, b) => a + b, 0);
export const mean = (h: Histogram) => {
  const total = mass(h);
  return total > 0 ? [...h].reduce((a, [x, p]) => a + x * p, 0) / total : 0;
};
export function add(into: Histogram, h: Histogram, weight = 1) {
  if (weight <= 0) return into;
  for (const [x, p] of h) into.set(x, (into.get(x) ?? 0) + p * weight);
  return into;
}
export const scaled = (h: Histogram, weight: number) => add(new Map(), h, weight);
export const mixture = (...hs: Histogram[]) => hs.reduce((h, next) => add(h, next), new Map());
export const cdf = (h: Histogram, us: number) => [...h].reduce((a, [x, p]) => a + (x <= us ? p : 0), 0);
export function percentile(h: Histogram, q: number): number | null {
  let left = mass(h) * q;
  if (left <= 0) return null;
  for (const [x, p] of [...h].sort(([a], [b]) => a - b)) { left -= p; if (left <= 1e-10) return x; }
  return null;
}
export function percentiles(h: Histogram, count: number): Percentiles {
  return { p50: percentile(h, .5), p90: percentile(h, .9), p99: count >= 1000 ? percentile(h, .99) : null, p999: count >= 10000 ? percentile(h, .999) : null };
}

// Quadrature retains extra strata in the timeout/p99 tail; final buckets match Exact's HDR grid.
const cuts = [...Array.from({ length: 99 }, (_, i) => i / 100), .985, .99, .9925, .995, .9975, .999, .9995, .9999, .99999, 1];
function compact(h: Histogram): Histogram {
  if (h.size <= 128) return h;
  const sorted = [...h].sort(([a], [b]) => a - b), total = mass(h), result: Histogram = new Map();
  let i = 0, used = 0;
  for (let j = 1; j < cuts.length; j++) {
    let remain = (cuts[j] - cuts[j - 1]) * total, amount = 0, sum = 0;
    while (remain > total * 1e-13 && i < sorted.length) {
      const take = Math.min(remain, sorted[i][1] - used);
      amount += take; sum += take * sorted[i][0]; remain -= take; used += take;
      if (used >= sorted[i][1] - total * 1e-14) { i++; used = 0; }
    }
    if (amount > 0) add(result, point(sum / amount, amount));
  }
  return result;
}
export function convolve(a: Histogram, b: Histogram): Histogram {
  const h: Histogram = new Map();
  for (const [x, p] of a) for (const [y, q] of b) {
    const key = bucket(x + y); h.set(key, (h.get(key) ?? 0) + p * q);
  }
  return compact(h);
}
export const shifted = (h: Histogram, us: number) => convolve(h, point(us));
export function split(h: Histogram, deadlineUs: number): [Histogram, number] {
  const within: Histogram = new Map(); let tail = 0;
  for (const [x, p] of h) { if (x <= deadlineUs) within.set(x, p); else tail += p; }
  return [within, tail];
}
export function moments(d: Dist): { mean: number; cv2: number } {
  switch (d.kind) {
    case 'constant': return { mean: Math.max(1, d.us), cv2: 0 };
    case 'exponential': return { mean: Math.max(1, d.meanUs), cv2: 1 };
    case 'lognormal': return { mean: d.medianUs * Math.exp(d.sigma ** 2 / 2), cv2: Math.expm1(d.sigma ** 2) };
    case 'empirical': {
      const total = d.buckets.reduce((s, b) => s + b.weight, 0);
      const m = d.buckets.reduce((s, b) => s + b.us * b.weight, 0) / total;
      return { mean: m, cv2: Math.max(0, d.buckets.reduce((s, b) => s + b.us ** 2 * b.weight, 0) / total / m ** 2 - 1) };
    }
  }
}
function normalQuantile(p: number): number {
  // Acklam's inverse normal CDF, sufficient for histogram quadrature.
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-.00778489400243029, -.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [.00778469570904146, .32246712907004, 2.445134137143, 3.75440866190742];
  const poly = (xs: number[], x: number) => xs.reduce((s, v) => s * x + v, 0);
  if (p < .02425 || p > .97575) {
    const q = Math.sqrt(-2 * Math.log(Math.min(p, 1 - p)));
    const value = poly(c, q) / (poly(d, q) * q + 1);
    return p < .5 ? value : -value;
  }
  const q = p - .5, r = q * q;
  return poly(a, r) * q / (poly(b, r) * r + 1);
}
const distributionCache = new Map<string, Histogram>();
export function distribution(d: Dist, factor = 1): Histogram {
  const key = JSON.stringify([d, factor]);
  const old = distributionCache.get(key); if (old) return old;
  const h: Histogram = new Map();
  if (d.kind === 'constant') add(h, point(Math.max(1, d.us * factor)));
  else if (d.kind === 'empirical') {
    const total = d.buckets.reduce((s, b) => s + b.weight, 0);
    for (const b of d.buckets) add(h, point(b.us * factor, b.weight / total));
  } else for (let i = 1; i < cuts.length; i++) {
    const p = (cuts[i] + cuts[i - 1]) / 2;
    const value = d.kind === 'exponential' ? -Math.log1p(-p) * d.meanUs : d.medianUs * Math.exp(d.sigma * normalQuantile(p));
    add(h, point(Math.max(1, value * factor), cuts[i] - cuts[i - 1]));
  }
  if (distributionCache.size >= 512) distributionCache.clear();
  distributionCache.set(key, h); return h;
}

export function erlangC(load: number, workers: number): number {
  if (load <= 0) return 0;
  if (load >= workers) return 1;
  // Erlang-B recurrence avoids factorial overflow even for 250k workers.
  let b = 1;
  for (let k = 1; k <= workers; k++) b = load * b / (k + load * b);
  const rho = load / workers;
  return b / (1 - rho + rho * b);
}
export type QueueStep = {
  backlog: number; arrivals: number; completions: number; drops: number; utilisation: number;
  stationaryQueue: number; capacity: number; wait: Histogram; regime: 'stable' | 'transient' | 'outage';
};
export function queueStep(rate: number, holdUs: number, cv2: number, ca2: number, workers: number, queueCapacity: number, start: number, dt: number): QueueStep {
  const capacity = workers > 0 && holdUs > 0 ? workers * 1e6 / holdUs : 0, arrivals = rate * dt;
  if (!capacity) return { backlog: 0, arrivals, completions: 0, drops: start + arrivals, utilisation: 0, stationaryQueue: 0, capacity: 0, wait: point(), regime: 'outage' };
  const rho = rate / capacity;
  let delay = rho < 1 ? erlangC(rate * holdUs / 1e6, workers) : 1;
  let waitMean = rho < 1 ? delay * (ca2 + cv2) / 2 * holdUs / (workers * (1 - rho)) : 0;
  let stationaryQueue = rate * waitMean / 1e6, blocking = 0;
  if (rho > 0 && rho < .9999 && ca2 > 0 && delay > 0) {
    // Finite M/M/c/K stationary correction; the Allen–Cunneen variability factor adjusts waiting.
    const b = delay * (1 - rho) / (1 - delay * rho), k = queueCapacity;
    const geometric = -Math.expm1((k + 1) * Math.log(rho)) / (1 - rho);
    const normalizer = 1 + b * (geometric - 1);
    blocking = b * rho ** k / normalizer;
    stationaryQueue = Math.max(0, b / normalizer * rho * (1 - (k + 1) * rho ** k + k * rho ** (k + 1)) / (1 - rho) ** 2 * (ca2 + cv2) / 2);
    delay = Math.max(0, (b * geometric / normalizer - blocking) / (1 - blocking));
    waitMean = stationaryQueue / (rate * (1 - blocking)) * 1e6;
  }
  if (rho < 1 && start <= stationaryQueue + 1e-9) {
    // Clear any transient residue through completions; never add it to stationary waiting.
    const drops = arrivals * blocking, completions = start + arrivals - drops;
    const wait = delay > 0 && waitMean > 0 ? mixture(point(0, 1 - delay), scaled(distribution({ kind: 'exponential', meanUs: waitMean / delay }), delay)) : point();
    return { backlog: 0, arrivals, completions, drops, utilisation: Math.min(1, rho * (1 - blocking)), stationaryQueue, capacity, wait, regime: 'stable' };
  }
  const completions = Math.min(capacity * dt, start + arrivals);
  const drops = Math.max(0, start + arrivals - completions - queueCapacity);
  const backlog = Math.max(0, start + arrivals - completions - drops);
  return { backlog, arrivals, completions, drops, utilisation: Math.min(1, completions / (capacity * dt)), stationaryQueue: 0, capacity, wait: point((start + backlog) / 2 / capacity * 1e6), regime: 'transient' };
}
