import { hash32, random } from "../random";
import type { Model, Script, Violation } from "../types";

export interface SketchOptions { bloomBits?: number; bloomHashes?: number; width?: number; depth?: number; hllPrecision?: number }
export interface SketchConfig { bloomBits: number; bloomHashes: number; width: number; depth: number; hllPrecision: number }
export interface SketchState {
  seed: number; config: SketchConfig; bits: number[]; table: number[][]; registers: number[];
  // shortcut: exact counts are a teaching oracle for error measurement; omit them in a memory-bounded implementation.
  counts: [string, number][]; total: number; probes: string[];
}
export type SketchAction = { type: "add"; key: string; count?: number } | { type: "probe"; keys: string[] };
function indices(state: SketchState, key: string, count: number, width: number) {
  return Array.from({ length: count }, (_, i) => hash32(key, hash32(`hash:${i}`, state.seed)) % width);
}
export function bloomContains(state: SketchState, key: string): boolean { return indices(state, key, state.config.bloomHashes, state.config.bloomBits).every(i => state.bits[i] === 1); }
export function bloomStatistics(state: SketchState) {
  const absent = state.probes.filter(key => !state.counts.some(([k]) => k === key));
  return { theoretical: (1 - Math.exp(-state.config.bloomHashes * state.counts.length / state.config.bloomBits)) ** state.config.bloomHashes,
    measured: absent.length ? absent.filter(key => bloomContains(state, key)).length / absent.length : 0, probes: absent.length };
}
export function countMinEstimate(state: SketchState, key: string): number { return Math.min(...indices(state, key, state.config.depth, state.config.width).map((i, row) => state.table[row][i])); }
export function countMinBounds(state: SketchState) { return { epsilon: Math.E / state.config.width, delta: Math.exp(-state.config.depth), additiveError: Math.E * state.total / state.config.width }; }
export function hllEstimate(state: SketchState): number {
  const m = state.registers.length, alpha = m === 16 ? 0.673 : m === 32 ? 0.697 : m === 64 ? 0.709 : 0.7213 / (1 + 1.079 / m);
  const raw = alpha * m * m / state.registers.reduce((n, r) => n + 2 ** -r, 0), zeroes = state.registers.filter(r => r === 0).length;
  if (raw <= 2.5 * m && zeroes) return m * Math.log(m / zeroes);
  return raw <= 0x100000000 / 30 ? raw : -0x100000000 * Math.log1p(-raw / 0x100000000);
}
export function hllStatistics(state: SketchState) { const estimate = hllEstimate(state), actual = state.counts.length; return { estimate, actual, relativeError: actual ? (estimate - actual) / actual : 0, standardError: 1.04 / Math.sqrt(state.registers.length) }; }
export const sketchScenarios: Script<SketchAction>[] = [
  { name: "duplicates and absent probes", description: "Duplicates increase frequency but not Bloom membership or distinct cardinality.", actions: [{ type: "add", key: "apple", count: 4 }, { type: "add", key: "pear" }, { type: "add", key: "apple" }, { type: "probe", keys: Array.from({ length: 100 }, (_, i) => `absent-${i}`) }] },
  { name: "seeded stream", description: "Compare measured Bloom false positives and HLL error against their statistical predictions.", actions: [...Array.from({ length: 200 }, (_, i): SketchAction => ({ type: "add", key: `key-${i}` })), { type: "probe", keys: Array.from({ length: 1000 }, (_, i) => `probe-${i}`) }] },
];
export function sketchInvariants(state: SketchState): Violation[] {
  const issues: Violation[] = [];
  if (state.counts.some(([key]) => !bloomContains(state, key))) issues.push({ code: "falseNegative", message: "An inserted key must remain in the Bloom filter." });
  if (state.counts.some(([key, count]) => countMinEstimate(state, key) < count)) issues.push({ code: "underestimate", message: "A positive-update count-min sketch cannot underestimate." });
  if (state.table.some(row => row.reduce((n, v) => n + v, 0) !== state.total)) issues.push({ code: "rowTotal", message: "Every count-min row must receive every update." });
  if (state.registers.some(r => !Number.isInteger(r) || r < 0 || r > 33 - state.config.hllPrecision)) issues.push({ code: "register", message: "HLL registers contain bounded leading-zero ranks." });
  return issues;
}
export function createSketchModel(options: SketchOptions = {}): Model<SketchState, SketchAction> {
  const config: SketchConfig = { bloomBits: 1024, bloomHashes: 4, width: 128, depth: 4, hllPrecision: 8, ...options };
  for (const [key, value] of Object.entries(config)) if (!Number.isInteger(value) || value < 1 || value > (key === "bloomBits" ? 1_000_000 : key === "width" ? 10000 : key === "hllPrecision" ? 16 : 32)) throw new Error("Sketch dimensions out of bounds");
  if (config.hllPrecision < 4) throw new Error("HLL precision must be 4..16");
  return {
    init(seed) { random(seed); return { seed, config: { ...config }, bits: Array(config.bloomBits).fill(0), table: Array.from({ length: config.depth }, () => Array(config.width).fill(0)), registers: Array(2 ** config.hllPrecision).fill(0), counts: [], total: 0, probes: [] }; },
    actions: s => [{ type: "add", key: `key-${s.counts.length}` }, { type: "probe", keys: [`probe-${s.probes.length}`] }],
    step(state, action) {
      const next = structuredClone(state);
      if (action.type === "probe") {
        if (action.keys.some(k => typeof k !== "string")) throw new Error("Probe keys must be strings");
        next.probes = [...new Set([...next.probes, ...action.keys])]; return next;
      }
      const count = action.count ?? 1;
      if (typeof action.key !== "string" || !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(state.total + count)) throw new Error("Use a string key and safe positive integer update");
      for (const i of indices(next, action.key, config.bloomHashes, config.bloomBits)) next.bits[i] = 1;
      indices(next, action.key, config.depth, config.width).forEach((i, row) => next.table[row][i] += count);
      const hash = hash32(`hll:${action.key}`, state.seed), bucket = hash & (next.registers.length - 1), rest = hash >>> config.hllPrecision;
      next.registers[bucket] = Math.max(next.registers[bucket], Math.clz32(rest) - config.hllPrecision + 1);
      const existing = next.counts.find(([key]) => key === action.key);
      if (existing) existing[1] += count; else next.counts.push([action.key, count]);
      next.total += count; return next;
    }, invariants: sketchInvariants, scenarios: structuredClone(sketchScenarios),
  };
}
export interface SketchVariant { id: string; seed: number; prompt: string; options: SketchOptions; actions: SketchAction[]; key: string }
export function generateSketchVariant(seed: number): SketchVariant {
  const next = random(seed), length = 10 + Math.floor(next() * 30);
  return { id: `sketches:${seed}`, seed, prompt: "What Bloom membership, count-min estimate and HLL estimate does this stream produce?", options: { bloomBits: 64, width: 8, depth: 3, hllPrecision: 5 }, actions: Array.from({ length }, () => ({ type: "add", key: `key-${Math.floor(next() * 12)}`, count: 1 + Math.floor(next() * 5) })), key: `key-${Math.floor(next() * 16)}` };
}
export function solveSketchVariant(v: SketchVariant) { const m = createSketchModel(v.options), s = v.actions.reduce(m.step, m.init(v.seed)); return { contains: bloomContains(s, v.key), count: countMinEstimate(s, v.key), cardinality: hllEstimate(s) }; }
