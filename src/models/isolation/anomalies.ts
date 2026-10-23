import type { Violation } from "../types";
import type { IsolationState, ReadEvent, Version } from "./types";

function matches(read: ReadEvent, key: string): boolean {
  return read.op.type === "read" ? read.op.key === key : read.op.from <= key && key <= read.op.to;
}
const absent: Version = { value: null, commit: 0, writer: null };

/** Detect observed phenomena from actual versions, never from a scenario's expected label. */
export function detectAnomalies(state: IsolationState): Violation[] {
  const found: Violation[] = [];
  const add = (code: string, message: string, transactions: string[], keys: string[]) => {
    if (!found.some(item => item.code === code && JSON.stringify(item.transactions) === JSON.stringify(transactions) && JSON.stringify(item.keys) === JSON.stringify(keys))) {
      found.push({ code, message, transactions, keys });
    }
  };
  for (let i = 0; i < state.reads.length; i++) {
    const read = state.reads[i];
    for (const [key, version] of Object.entries(read.values)) {
      if (version.writer && version.writer !== read.transaction && !state.database[key]?.some(v => v.commit === version.commit && v.writer === version.writer && v.commit <= read.at)) {
        add("dirtyRead", "A read observed another transaction's uncommitted version.", [read.transaction, version.writer], [key]);
      }
    }
    for (const prior of state.reads.slice(0, i).filter(item => item.transaction === read.transaction)) {
      if (read.op.type === "read" && prior.op.type === "read" && read.op.key === prior.op.key) {
        const key = read.op.key;
        if (!read.ownKeys.includes(key) && !prior.ownKeys.includes(key) && read.values[key].value !== prior.values[key].value) {
          add("nonRepeatableRead", "A repeated point read returned a different committed value.", [read.transaction], [key]);
        }
      }
      if (read.op.type === "rangeRead" && prior.op.type === "rangeRead" && read.op.from === prior.op.from && read.op.to === prior.op.to) {
        const changed = [...new Set([...Object.keys(prior.values), ...Object.keys(read.values)])].sort().filter(key =>
          !read.ownKeys.includes(key) && !prior.ownKeys.includes(key) && Object.hasOwn(read.values, key) !== Object.hasOwn(prior.values, key));
        if (changed.length) add("phantom", "A repeated range predicate returned different members.", [read.transaction], changed);
      }
    }
  }
  const committed = state.transactions.filter(tx => tx.status === "committed");
  for (const tx of committed) {
    for (const key of Object.keys(tx.writes)) {
      const base = Object.hasOwn(tx.writeBases, key) ? tx.writeBases[key] : null;
      const stale = base && state.database[key]?.some(version => version.writer !== tx.id && version.commit > base.commit && version.commit > tx.start! && version.commit < tx.commitAt!);
      if (stale) add("lostUpdate", "A committed write overwrote an update based on a stale read of that key.", [tx.id], [key]);
    }
  }
  // A cycle of read/write anti-dependencies over disjoint write sets is write skew.
  const edges = new Map(committed.map(reader => [reader.id, committed.filter(writer => writer.id !== reader.id &&
    !Object.keys(reader.writes).some(key => Object.hasOwn(writer.writes, key)) &&
    writer.start! < reader.commitAt! &&
    state.reads.some(read => read.transaction === reader.id && Object.keys(writer.writes).some(key =>
      matches(read, key) && !read.ownKeys.includes(key) && (read.values[key] ?? absent).commit < writer.commitAt! && read.at < writer.commitAt!))
  ).map(tx => tx.id)]));
  for (const tx of committed) {
    const path = (id: string, seen: string[]): string[] | null => {
      for (const next of edges.get(id) ?? []) {
        if (next === tx.id) return seen;
        if (!seen.includes(next)) {
          const cycle = path(next, [...seen, next]);
          if (cycle) return cycle;
        }
      }
      return null;
    };
    const cycle = path(tx.id, [tx.id]);
    if (cycle) add("writeSkew", "Committed transactions form a read/write dependency cycle on different keys.", cycle.sort(), []);
  }
  return found;
}
