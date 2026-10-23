import type { Model } from "../types";
import { detectAnomalies } from "./anomalies";
import { isolationScenarios } from "./scenarios";
import type { IsolationAction, IsolationDefinition, IsolationLevel, IsolationScenario, IsolationState, Lock, Operation, ReadEvent, TransactionState, Version } from "./types";

export * from "./types";
export * from "./scenarios";
export { detectAnomalies } from "./anomalies";

const terminal = (tx: TransactionState) => tx.status === "committed" || tx.status === "aborted";
const absent: Version = { value: null, commit: 0, writer: null };

function latest(state: IsolationState, key: string, at = Infinity): Version {
  return (Object.hasOwn(state.database, key) ? state.database[key] : []).findLast(version => version.commit <= at) ?? absent;
}

function requestedLock(state: IsolationState, tx: TransactionState): Lock | null {
  const op = tx.ops[tx.pc];
  if (!op || op.type === "commit" || op.type === "abort" || state.level === "snapshot") return null;
  if (op.type !== "write" && state.level !== "serializable") return null;
  return { transaction: tx.id, mode: op.type === "write" ? "exclusive" : "shared",
    from: op.type === "rangeRead" ? op.from : op.key,
    to: op.type === "rangeRead" ? op.to : op.key };
}

function blockers(state: IsolationState, tx: TransactionState): string[] {
  const lock = requestedLock(state, tx);
  if (!lock) return [];
  return [...new Set(state.locks.filter(held => held.transaction !== tx.id && held.from <= lock.to && lock.from <= held.to &&
    (held.mode === "exclusive" || lock.mode === "exclusive")).map(held => held.transaction))];
}

function refreshWaits(state: IsolationState): void {
  state.waitFor = Object.fromEntries(state.transactions.filter(tx => tx.status === "blocked").map(tx => [tx.id, blockers(state, tx)]));
  for (const tx of state.transactions) if (tx.status === "blocked" && !state.waitFor[tx.id].length) {
    tx.status = "active";
    delete state.waitFor[tx.id];
  }
}

function deadlocked(state: IsolationState, id: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return true;
  const nextSeen = new Set([...seen, id]);
  return (Object.hasOwn(state.waitFor, id) ? state.waitFor[id] : []).some(next => deadlocked(state, next, nextSeen));
}

function abort(state: IsolationState, tx: TransactionState, reason: TransactionState["reason"]): void {
  tx.status = "aborted";
  tx.reason = reason;
  tx.writes = {};
  state.locks = state.locks.filter(lock => lock.transaction !== tx.id);
  refreshWaits(state);
}

function read(state: IsolationState, tx: TransactionState, op: ReadEvent["op"]): void {
  const at = state.level === "snapshot" ? tx.start! : Infinity;
  const visible = (key: string): Version => Object.hasOwn(tx.writes, key)
    ? { value: tx.writes[key], commit: state.clock, writer: tx.id } : latest(state, key, at);
  const keys = op.type === "read" ? [op.key] : [...new Set([...Object.keys(state.database), ...Object.keys(tx.writes)])]
    .filter(key => op.from <= key && key <= op.to && visible(key).value !== null).sort();
  state.reads.push({ transaction: tx.id, at: state.clock, op: { ...op },
    ownKeys: Object.keys(tx.writes), values: Object.fromEntries(keys.map(key => [key, { ...visible(key) }])) });
}

function execute(state: IsolationState, tx: TransactionState, op: Operation): "executed" | "aborted" {
  if (op.type === "read" || op.type === "rangeRead") read(state, tx, op);
  else if (op.type === "write") {
    let value = op.value;
    if (typeof value === "object" && value !== null) {
      const expression = value;
      const observation = state.reads.findLast(read => read.transaction === tx.id && Object.hasOwn(read.values, expression.read));
      const base = observation?.values[expression.read].value;
      if (base === undefined || base === null) throw new Error(`Read a numeric ${expression.read} before using it in a write`);
      value = base + expression.delta;
      if (!Number.isFinite(value)) throw new Error("Write expression must produce a finite number");
    }
    tx.writes = { ...tx.writes, [op.key]: value };
    const baseRead = state.reads.findLast(read => read.transaction === tx.id && Object.hasOwn(read.values, op.key));
    if (baseRead && !baseRead.ownKeys.includes(op.key)) tx.writeBases = { ...tx.writeBases, [op.key]: { ...baseRead.values[op.key] } };
  } else if (op.type === "abort") {
    abort(state, tx, "explicit");
    return "aborted";
  } else {
    if (state.level === "snapshot" && Object.keys(tx.writes).some(key => latest(state, key).commit > tx.start!)) {
      abort(state, tx, "writeConflict");
      return "aborted";
    }
    for (const [key, value] of Object.entries(tx.writes)) state.database = { ...state.database,
      [key]: [...(Object.hasOwn(state.database, key) ? state.database[key] : []), { value, commit: state.clock, writer: tx.id }] };
    tx.status = "committed";
    tx.commitAt = state.clock;
    state.locks = state.locks.filter(lock => lock.transaction !== tx.id);
    refreshWaits(state);
  }
  tx.pc++;
  return "executed";
}

function validate(definition: IsolationDefinition): void {
  if (!definition.transactions.length || new Set(definition.transactions.map(tx => tx.id)).size !== definition.transactions.length) throw new Error("Use uniquely named transactions");
  if (Object.values(definition.initial).some(value => !Number.isFinite(value))) throw new Error("Initial values must be finite numbers");
  for (const tx of definition.transactions) {
    if (!tx.id || !tx.ops.length || !["commit", "abort"].includes(tx.ops[tx.ops.length - 1].type)) throw new Error("Each named transaction must end in commit or abort");
    for (let i = 0; i < tx.ops.length; i++) {
      const op = tx.ops[i];
      if (!["read", "rangeRead", "write", "commit", "abort"].includes(op.type)) throw new Error("Unknown transaction operation");
      if ((op.type === "commit" || op.type === "abort") && i !== tx.ops.length - 1) throw new Error("Terminal operations must be last");
      if ((op.type === "read" || op.type === "write") && typeof op.key !== "string") throw new Error("Keys must be strings");
      if (op.type === "rangeRead" && (typeof op.from !== "string" || typeof op.to !== "string" || op.from > op.to)) throw new Error("Range endpoints must be ordered strings");
      if (op.type === "write" && op.value !== null && (typeof op.value === "object"
        ? typeof op.value.read !== "string" || !Number.isFinite(op.value.delta) : !Number.isFinite(op.value))) throw new Error("Writes require a finite value, null deletion, or a read-plus-delta expression");
    }
  }
}

/** Serializable uses strict 2PL: shared point/range locks and exclusive write locks held to termination. */
export function createIsolationModel(level: IsolationLevel, definition: IsolationDefinition = isolationScenarios[1]): Model<IsolationState, IsolationAction> {
  if (!["readCommitted", "snapshot", "serializable"].includes(level)) throw new Error("Unknown isolation level");
  validate(definition);
  const config = structuredClone(definition);
  const script = "actions" in config ? config as IsolationScenario : null;
  return {
    init(seed) {
      if (!Number.isSafeInteger(seed)) throw new Error("Seed must be a safe integer");
      return { seed, level, clock: 0, database: Object.fromEntries(Object.entries(config.initial).map(([key, value]) => [key, [{ value, commit: 0, writer: null }]])),
        transactions: structuredClone(config.transactions).map(tx => ({ ...tx, pc: 0, status: "pending", start: null, commitAt: null, writes: {}, writeBases: {} })),
        locks: [], waitFor: {}, reads: [], anomalies: [], history: [] };
    },
    actions: state => state.transactions.filter(tx => !terminal(tx)).map(tx => ({ type: "execute", transaction: tx.id })),
    step(previous, action) {
      if (action.type !== "execute" || !previous.transactions.some(tx => tx.id === action.transaction)) throw new Error("Choose an existing transaction to execute");
      const state = structuredClone(previous);
      const tx = state.transactions.find(tx => tx.id === action.transaction)!;
      if (terminal(tx)) return state;
      state.clock++;
      if (tx.start === null) { tx.start = state.clock; tx.status = "active"; }
      const op = tx.ops[tx.pc];
      const blockedBy = blockers(state, tx);
      let outcome: "executed" | "blocked" | "aborted";
      if (blockedBy.length) {
        tx.status = "blocked";
        refreshWaits(state);
        if (deadlocked(state, tx.id)) { abort(state, tx, "deadlock"); outcome = "aborted"; }
        else outcome = "blocked";
      } else {
        tx.status = "active";
        const lock = requestedLock(state, tx);
        if (lock && !state.locks.some(held => JSON.stringify(held) === JSON.stringify(lock))) state.locks.push(lock);
        outcome = execute(state, tx, op);
      }
      refreshWaits(state);
      state.history.push({ transaction: tx.id, op: { ...op }, outcome });
      state.anomalies = detectAnomalies(state);
      return state;
    },
    invariants: detectAnomalies,
    scenarios: script ? [{ name: script.name, description: script.description, actions: structuredClone(script.actions) }] : [],
  };
}

/** Execute the requested interleaving, then fairly finish operations delayed by locks. */
export function runIsolationScenario(level: IsolationLevel, scenario: IsolationScenario, seed = 0): IsolationState {
  const model = createIsolationModel(level, scenario);
  let state = scenario.actions.reduce((state, action) => model.step(state, action), model.init(seed));
  const remaining = scenario.transactions.reduce((sum, tx) => sum + tx.ops.length, 0);
  for (let i = 0; i < remaining && model.actions(state).length; i++) {
    const runnable = state.transactions.find(tx => !terminal(tx) && !blockers(state, tx).length);
    if (!runnable) throw new Error("Unresolved deadlock");
    state = model.step(state, { type: "execute", transaction: runnable.id });
  }
  if (model.actions(state).length) throw new Error("Schedule did not terminate");
  return state;
}
