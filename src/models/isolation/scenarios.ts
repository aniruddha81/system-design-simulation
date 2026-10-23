import type { Anomaly, IsolationAction, IsolationLevel, IsolationScenario, Operation } from "./types";

export const isolationLevels: IsolationLevel[] = ["readCommitted", "snapshot", "serializable"];
export const anomalyNames: Anomaly[] = ["dirtyRead", "nonRepeatableRead", "phantom", "lostUpdate", "writeSkew"];

/** Outcomes of these concrete schedules; phantom means a repeated range changes membership. */
export const expectedOutcomes: Record<IsolationLevel, Record<Anomaly, "allowed" | "prevented">> = {
  readCommitted: { dirtyRead: "prevented", nonRepeatableRead: "allowed", phantom: "allowed", lostUpdate: "allowed", writeSkew: "allowed" },
  snapshot: { dirtyRead: "prevented", nonRepeatableRead: "prevented", phantom: "prevented", lostUpdate: "prevented", writeSkew: "allowed" },
  serializable: { dirtyRead: "prevented", nonRepeatableRead: "prevented", phantom: "prevented", lostUpdate: "prevented", writeSkew: "prevented" },
};

const read = (key: string): Operation => ({ type: "read", key });
const write = (key: string, value: number): Operation => ({ type: "write", key, value });
const commit: Operation = { type: "commit" };
const range: Operation = { type: "rangeRead", from: "a", to: "z" };
const schedule = (...ids: string[]): IsolationAction[] => ids.map(transaction => ({ type: "execute", transaction }));
function scenario(anomaly: Anomaly, description: string, initial: Record<string, number>, first: Operation[], second: Operation[], actions: IsolationAction[]): IsolationScenario {
  return { name: anomaly, anomaly, description, initial, transactions: [{ id: "T1", ops: first }, { id: "T2", ops: second }], actions };
}

export const isolationScenarios: IsolationScenario[] = [
  scenario("dirtyRead", "T2 tries to read T1's uncommitted write; T1 aborts. All three levels guard the read.", { x: 1 },
    [write("x", 2), { type: "abort" }], [read("x"), commit], schedule("T1", "T2", "T1", "T2")),
  scenario("nonRepeatableRead", "T1 reads x twice around T2's committed update.", { x: 1 },
    [read("x"), read("x"), commit], [write("x", 2), commit], schedule("T1", "T2", "T2", "T1", "T1")),
  scenario("phantom", "T1 repeats a key-range predicate around T2's committed insert.", { a: 1 },
    [range, range, commit], [write("b", 2), commit], schedule("T1", "T2", "T2", "T1", "T1")),
  scenario("lostUpdate", "Both transactions increment the same value read before either update commits.", { x: 0 },
    [read("x"), { type: "write", key: "x", value: { read: "x", delta: 1 } }, commit],
    [read("x"), { type: "write", key: "x", value: { read: "x", delta: 1 } }, commit], schedule("T1", "T2", "T1", "T1", "T2", "T2")),
  scenario("writeSkew", "Two on-call doctors each observe the other on call, then each goes off call on a different row.", { a: 1, b: 1 },
    [read("b"), write("a", 0), commit], [read("a"), write("b", 0), commit], schedule("T1", "T2", "T1", "T2", "T1", "T2")),
];
