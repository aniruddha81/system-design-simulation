import { Random } from '../core';
import type { InputGen, KeyDist, Workload } from '../types';

/** Ramp spans durationUs; callers with a scenario should pass warmup + measure. */
export function arrivalRate(arrival: Workload['arrival'], tUs: number, durationUs = 300_000_000): number {
  switch (arrival.kind) {
    case 'constant': case 'poisson': return arrival.rps;
    case 'step': return tUs < arrival.stepAtUs ? arrival.rps : arrival.stepRps;
    case 'spike': return tUs >= arrival.spikeAtUs && tUs < arrival.spikeAtUs + arrival.spikeDurUs ? arrival.spikeRps : arrival.rps;
    case 'ramp': return arrival.fromRps + (arrival.toRps - arrival.fromRps) * Math.max(0, Math.min(1, tUs / durationUs));
    case 'diurnal': return arrival.meanRps * (1 + arrival.amplitude * Math.sin(2 * Math.PI * tUs / arrival.periodUs));
    case 'replay': {
      const p = arrival.points;
      if (!p.length) return 0;
      if (tUs <= p[0].atUs) return p[0].rps;
      let lo = 0, hi = p.length - 1;
      while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (p[mid].atUs <= tUs) lo = mid; else hi = mid; }
      if (tUs >= p[hi].atUs) return p[hi].rps;
      return p[lo].rps + (p[hi].rps - p[lo].rps) * (tUs - p[lo].atUs) / (p[hi].atUs - p[lo].atUs);
    }
  }
}

const sequences = new WeakMap<Random, WeakMap<InputGen, number>>();
const zipfs = new WeakMap<InputGen | KeyDist, Float64Array>();
function zipf(gen: InputGen | KeyDist, n: number, s: number, rng: Random): number {
  let cdf = zipfs.get(gen);
  if (!cdf) {
    cdf = new Float64Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) { total += 1 / (i + 1) ** s; cdf[i] = total; }
    zipfs.set(gen, cdf);
  }
  const x = rng.next() * cdf[n - 1];
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (cdf[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

export function sampleKey(dist: KeyDist, rng: Random, sequence = 0): number {
  switch (dist.kind) {
    case 'sequential': return sequence % dist.n;
    case 'zipf': return zipf(dist, dist.n, dist.s, rng);
    case 'uniform': return Math.floor(rng.next() * dist.n);
    case 'hotspot': return rng.next() < dist.hotFraction || dist.n === 1 ? 0 : 1 + Math.floor(rng.next() * (dist.n - 1));
  }
}

export function sampleInput(gen: InputGen, rng: Random): number | string {
  switch (gen.kind) {
    case 'uniform': return Math.ceil(gen.min) + Math.floor(rng.next() * (Math.floor(gen.max) - Math.ceil(gen.min) + 1));
    case 'zipf': return gen.min + zipf(gen, gen.max - gen.min + 1, gen.s, rng);
    case 'sequence': {
      let state = sequences.get(rng);
      if (!state) { state = new WeakMap(); sequences.set(rng, state); }
      const value = state.get(gen) ?? gen.start;
      state.set(gen, value + 1);
      return value;
    }
    case 'size': return Math.max(0, Math.round(gen.meanBytes + gen.sdBytes * Math.sqrt(-2 * Math.log(rng.next())) * Math.cos(2 * Math.PI * rng.next())));
  }
}

export function renderKey(template: string, inputs: Record<string, number | string>): string {
  return template.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    if (!Object.hasOwn(inputs, name)) throw new Error(`Missing key input: ${name}`);
    return String(inputs[name]);
  });
}

/** CSV columns are atUs,rps (integer microseconds); an exact header is optional. */
export function parseReplayCsv(text: string): { points: { atUs: number; rps: number }[] } | { error: string } {
  if (text.length > 1_048_576 || new TextEncoder().encode(text).length > 1_048_576) return { error: 'Replay CSV exceeds 1 MB.' };
  const lines = text.trim().split(/\r?\n/);
  if (lines[0]?.trim() === 'atUs,rps') lines.shift();
  if (!lines.length || lines.length > 10_000) return { error: 'Replay requires 1–10,000 points.' };
  const points: { atUs: number; rps: number }[] = [];
  const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  for (const line of lines) {
    const cells = line.split(',').map(cell => cell.trim());
    if (cells.length !== 2 || !cells.every(cell => numeric.test(cell))) return { error: 'Expected numeric atUs,rps cells.' };
    const [atUs, rps] = cells.map(Number);
    if (!Number.isSafeInteger(atUs) || atUs < 0 || !Number.isFinite(rps) || rps < 0 || (points.length > 0 && atUs <= points[points.length - 1].atUs)) return { error: 'Times must strictly increase; rates must be finite and non-negative.' };
    points.push({ atUs, rps });
  }
  return { points };
}

export function toPeakRps(perDay: number, peakFactor: number): { avgRps: number; peakRps: number } {
  if (!Number.isFinite(perDay) || perDay < 0 || !Number.isFinite(peakFactor) || peakFactor < 1 || !Number.isFinite(perDay / 86400 * peakFactor)) throw new RangeError('Use finite non-negative daily requests and a peak factor ≥ 1.');
  const avgRps = perDay / 86400;
  return { avgRps, peakRps: avgRps * peakFactor };
}

const base = (endpoint: string): Workload => ({ arrival: { kind: 'constant', rps: 500 }, mix: { [endpoint]: 1 }, keys: { kind: 'uniform', n: 10_000 }, deadlineUs: 1_000_000 });
export const launchDaySpike = (endpoint = 'get'): Workload => ({ ...base(endpoint), arrival: { kind: 'spike', rps: 500, spikeAtUs: 60_000_000, spikeDurUs: 30_000_000, spikeRps: 5000 } });
export const diurnal = (endpoint = 'get'): Workload => ({ ...base(endpoint), arrival: { kind: 'diurnal', meanRps: 500, amplitude: .8, periodUs: 86_400_000_000 } });
export const viralKey = (endpoint = 'get'): Workload => ({ ...base(endpoint), keys: { kind: 'hotspot', n: 10_000, hotFraction: .9 } });
export const ddos = (endpoint = 'get'): Workload => ({ ...base(endpoint), arrival: { kind: 'step', rps: 500, stepAtUs: 60_000_000, stepRps: 20_000 } });
export const batchBackfill = (endpoint = 'put'): Workload => ({ ...base(endpoint), arrival: { kind: 'constant', rps: 2000 }, keys: { kind: 'sequential', n: 1_000_000 } });
