import type { Model, Script, Violation } from "../types";
import { random } from "../random";

export interface QuorumVersion { version: number; value: string | null; writtenAt: number }
export interface QuorumReplica { id: string; alive: boolean; values: Record<string, QuorumVersion> }
export interface QuorumRead { key: string; replicas: string[]; result: QuorumVersion | null; expected: QuorumVersion | null; stale: boolean }
export interface QuorumState {
  seed: number; now: number; n: number; r: number; w: number; sloppy: boolean; gcGrace: number;
  replicas: QuorumReplica[]; sequence: number; latestAcked: Record<string, QuorumVersion>;
  writes: { key: string; entry: QuorumVersion; replicas: string[]; acknowledged: boolean }[];
  reads: QuorumRead[];
  hints: { holder: string; target: string; key: string; entry: QuorumVersion }[];
}
export type QuorumAction =
  | { type: "write"; key: string; value: string | null; replicas?: string[] }
  | { type: "read"; key: string; replicas?: string[]; repair?: boolean }
  | { type: "crash" | "recover"; replica: string }
  | { type: "advance"; ticks: number }
  | { type: "handoff" }
  | { type: "repair"; key: string; replicas?: string[] }
  | { type: "gc"; replicas?: string[] };
export interface QuorumOptions { n?: number; r?: number; w?: number; sloppy?: boolean; spares?: number; gcGrace?: number }

function integer(n: number, min: number, max: number) { if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}..${max}`); }
function newest(entries: (QuorumVersion | undefined)[]): QuorumVersion | null { return entries.reduce<QuorumVersion | null>((best, e) => e && (!best || e.version > best.version) ? e : best, null); }

export function createQuorumModel(options: QuorumOptions = {}): Model<QuorumState, QuorumAction> {
  const n = options.n ?? 3, r = options.r ?? 2, w = options.w ?? 2, sloppy = options.sloppy ?? false, spares = options.spares ?? 2, gcGrace = options.gcGrace ?? 10;
  integer(n, 1, 32); integer(r, 1, n); integer(w, 1, n); integer(spares, 0, 32); integer(gcGrace, 0, 1000000);
  const ids = Array.from({ length: n + (sloppy ? spares : 0) }, (_, i) => `N${i}`);
  function replica(s: QuorumState, id: string) { const node = s.replicas.find(n => n.id === id); if (!node) throw new Error("Unknown quorum replica"); return node; }
  function selected(s: QuorumState, given: string[] | undefined, count: number): QuorumReplica[] {
    const available = s.replicas.filter((node, i) => node.alive && (sloppy || i < n));
    const chosen = given ? given.map(id => replica(s, id)) : available.slice(0, count);
    if (new Set(chosen.map(n => n.id)).size !== chosen.length || chosen.some(node => !node.alive || (!sloppy && s.replicas.indexOf(node) >= n)) || chosen.length > n) throw new Error("Use distinct available replicas from the preference list");
    return chosen;
  }
  function put(node: QuorumReplica, key: string, entry: QuorumVersion) {
    if (!Object.hasOwn(node.values, key) || node.values[key].version < entry.version) Object.defineProperty(node.values, key, { value: { ...entry }, enumerable: true, configurable: true, writable: true });
  }
  function get(node: QuorumReplica, key: string) { return Object.hasOwn(node.values, key) ? node.values[key] : undefined; }
  function repair(nodes: QuorumReplica[], key: string) { const entry = newest(nodes.map(node => get(node, key))); if (entry) nodes.forEach(node => put(node, key, entry)); return entry; }
  const primary = ids.slice(0, n), writeSet = primary.slice(0, w), readSet = primary.slice(n - r);
  const scenarios: Script<QuorumAction>[] = [
    { name: "quorum overlap", description: "For sequential acknowledged writes without failures or GC, R+W>N forces the read to intersect the write.", actions: [{ type: "write", key: "x", value: "new", replicas: writeSet }, { type: "read", key: "x", replicas: readSet }] },
    { name: "read repair", description: "The newest response repairs older replicas in the read set.", actions: [{ type: "write", key: "x", value: "new", replicas: writeSet }, { type: "read", key: "x", replicas: primary.slice(0, r), repair: true }] },
    { name: "tombstone resurrection", description: "GC after the grace period but before repair forgets a delete; an offline replica can resurrect its old value.", actions: [{ type: "write", key: "x", value: "old", replicas: primary }, ...(n > 1 ? [{ type: "crash" as const, replica: primary[n - 1] }] : []), { type: "write", key: "x", value: null, replicas: primary.slice(0, Math.max(1, n - 1)) }, { type: "advance", ticks: gcGrace }, { type: "gc", replicas: primary.slice(0, Math.max(1, n - 1)) }, ...(n > 1 ? [{ type: "recover" as const, replica: primary[n - 1] }, { type: "repair" as const, key: "x", replicas: primary }] : []), { type: "read", key: "x", replicas: primary.slice(0, r) }] },
  ];
  if (sloppy && spares) {
    const absent = primary[w - 1], sloppyRead = [...primary.slice(w - 1), ...primary.slice(0, w - 1)].slice(0, r);
    scenarios.push({ name: "sloppy quorum and hinted handoff", description: "A spare acknowledges for an unavailable home replica. A home-only read may miss it despite R+W>N; handoff restores the missing replica.", actions: [{ type: "crash", replica: absent }, { type: "write", key: "x", value: "hinted", replicas: [...primary.slice(0, w - 1), ids[n]] }, { type: "recover", replica: absent }, { type: "read", key: "x", replicas: sloppyRead }, { type: "handoff" }, { type: "read", key: "x", replicas: sloppyRead, repair: true }] });
  }
  return {
    init(seed) { random(seed); return { seed, now: 0, n, r, w, sloppy, gcGrace, replicas: ids.map(id => ({ id, alive: true, values: {} })), sequence: 0, latestAcked: {}, writes: [], reads: [], hints: [] }; },
    actions(s) {
      const available = s.replicas.filter(node => node.alive).length;
      return [{ type: "advance", ticks: 1 }, { type: "handoff" }, { type: "gc" }, ...s.replicas.map(node => ({ type: node.alive ? "crash" as const : "recover" as const, replica: node.id })), ...(available ? [{ type: "write" as const, key: "x", value: `v${s.sequence + 1}` }, { type: "write" as const, key: "x", value: null }, { type: "repair" as const, key: "x" }] : []), ...(available >= r ? [{ type: "read" as const, key: "x" }, { type: "read" as const, key: "x", repair: true }] : [])];
    },
    step(state, action) {
      const s = structuredClone(state);
      if ("key" in action && (typeof action.key !== "string" || !action.key.length)) throw new Error("Use a nonempty string key");
      switch (action.type) {
        case "crash": case "recover": replica(s, action.replica).alive = action.type === "recover"; break;
        case "advance": integer(action.ticks, 0, 1000000); s.now += action.ticks; break;
        case "write": {
          if (action.value !== null && typeof action.value !== "string") throw new Error("Use a string value or null tombstone");
          const nodes = selected(s, action.replicas, w), entry: QuorumVersion = { version: ++s.sequence, value: action.value, writtenAt: s.now };
          nodes.forEach(node => put(node, action.key, entry));
          const acknowledged = nodes.length >= w;
          s.writes.push({ key: action.key, entry, replicas: nodes.map(n => n.id), acknowledged });
          if (acknowledged) Object.defineProperty(s.latestAcked, action.key, { value: { ...entry }, enumerable: true, configurable: true, writable: true });
          const missing = primary.filter(id => !nodes.some(node => node.id === id));
          nodes.filter(node => !primary.includes(node.id)).forEach((node, i) => s.hints.push({ holder: node.id, target: missing[i], key: action.key, entry: { ...entry } }));
          break;
        }
        case "read": {
          const nodes = selected(s, action.replicas, r); if (nodes.length < r) throw new Error("Read quorum unavailable");
          const result = newest(nodes.map(node => get(node, action.key))), expected = Object.hasOwn(s.latestAcked, action.key) ? s.latestAcked[action.key] : null;
          // Missing data and a tombstone both mean absence; an old live value after GC is stale.
          const stale = !!expected && (result ? result.version < expected.version : expected.value !== null);
          s.reads.push({ key: action.key, replicas: nodes.map(n => n.id), result: result ? { ...result } : null, expected: expected ? { ...expected } : null, stale });
          if (action.repair) repair(nodes, action.key); break;
        }
        case "repair": repair(selected(s, action.replicas, n), action.key); break;
        case "handoff":
          s.hints = s.hints.filter(hint => {
            if (!replica(s, hint.holder).alive || !replica(s, hint.target).alive) return true;
            put(replica(s, hint.target), hint.key, hint.entry); return false;
          }); break;
        case "gc":
          for (const node of selected(s, action.replicas, n)) for (const [key, entry] of Object.entries(node.values)) if (entry.value === null && s.now - entry.writtenAt >= gcGrace) delete node.values[key];
          break;
      }
      return s;
    },
    invariants: quorumInvariants,
    scenarios,
  };
}

export function quorumInvariants(s: QuorumState): Violation[] {
  return s.reads.filter(read => read.stale).map(read => ({ code: "staleRead", message: `Read of ${read.key} returned a version older than the latest acknowledged write. Quorum overlap requires a fixed replica set, retained versions/tombstones, and no concurrent writes.`, keys: [read.key] }));
}
