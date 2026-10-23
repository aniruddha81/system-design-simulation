import type { Script, Violation } from "../types";

export type IsolationLevel = "readCommitted" | "snapshot" | "serializable";
export type Anomaly = "dirtyRead" | "nonRepeatableRead" | "phantom" | "lostUpdate" | "writeSkew";
export type Value = number | null;
export interface ReadOp { type: "read"; key: string }
/** Inclusive lexicographic key predicate, including keys not yet inserted. */
export interface RangeReadOp { type: "rangeRead"; from: string; to: string }
export type Operation = ReadOp | RangeReadOp
  | { type: "write"; key: string; value: Value | { read: string; delta: number } }
  | { type: "commit" } | { type: "abort" };
export interface Transaction { id: string; ops: Operation[] }
export interface IsolationAction { type: "execute"; transaction: string }
export interface IsolationDefinition { initial: Record<string, number>; transactions: Transaction[] }
export interface IsolationScenario extends IsolationDefinition, Script<IsolationAction> { anomaly: Anomaly }
export interface Version { value: Value; commit: number; writer: string | null }
export interface TransactionState extends Transaction {
  pc: number;
  status: "pending" | "active" | "blocked" | "committed" | "aborted";
  start: number | null;
  commitAt: number | null;
  writes: Record<string, Value>;
  writeBases: Record<string, Version>;
  reason?: "explicit" | "writeConflict" | "deadlock";
}
export interface ReadEvent {
  transaction: string;
  at: number;
  op: ReadOp | RangeReadOp;
  values: Record<string, Version>;
  ownKeys: string[];
}
export interface Lock { transaction: string; mode: "shared" | "exclusive"; from: string; to: string }
export interface IsolationState {
  seed: number;
  level: IsolationLevel;
  clock: number;
  database: Record<string, Version[]>;
  transactions: TransactionState[];
  locks: Lock[];
  waitFor: Record<string, string[]>;
  reads: ReadEvent[];
  anomalies: Violation[];
  history: { transaction: string; op: Operation; outcome: "executed" | "blocked" | "aborted" }[];
}
