import { random } from "../random";
import type { Model, Script, Violation } from "../types";

export type CrdtAction =
  | { type: "increment"; replica: string; counter: "g" | "pn"; amount: number }
  | { type: "add" | "remove"; replica: string; value: string }
  | { type: "insert"; replica: string; index: number; text: string }
  | { type: "delete"; replica: string; index: number; count: number }
  | { type: "deliver"; message: number }
  | { type: "duplicate"; message: number }
  | { type: "delay"; message: number }
  | { type: "deliverAll" };
interface OpBase { id: string; replica: string; clock: number; sequence: number }
export type CrdtOperation = OpBase & (
  | { kind: "g" | "pn"; amount: number }
  | { kind: "add"; value: string }
  | { kind: "remove"; tags: string[] }
  | { kind: "insert"; after: string | null; text: string }
  | { kind: "delete"; targets: string[] }
);
// shortcut: retain operation history for replay; compact only after adding causal-stability tracking.
export interface CrdtReplica { id: string; clock: number; sequence: number; operations: CrdtOperation[] }
export interface CrdtMessage { id: number; from: string; to: string; operations: CrdtOperation[]; delays: number }
export interface CrdtState { seed: number; replicas: CrdtReplica[]; messages: CrdtMessage[]; nextMessage: number }
export interface RgaElement { id: string; after: string | null; value: string; deleted: boolean; clock: number; replica: string; sequence: number; offset: number }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const opOrder = (a: OpBase, b: OpBase) => a.clock - b.clock || compare(a.replica, b.replica) || a.sequence - b.sequence;
export function crdtView(replica: CrdtReplica) {
  const g = new Map<string, number>(), positive = new Map<string, number>(), negative = new Map<string, number>();
  const removed = new Set(replica.operations.flatMap(op => op.kind === "remove" ? op.tags : []));
  const deleted = new Set(replica.operations.flatMap(op => op.kind === "delete" ? op.targets : []));
  const elements: RgaElement[] = [];
  for (const op of replica.operations) {
    if (op.kind === "g") g.set(op.replica, (g.get(op.replica) ?? 0) + op.amount);
    if (op.kind === "pn") { const map = op.amount > 0 ? positive : negative; map.set(op.replica, (map.get(op.replica) ?? 0) + Math.abs(op.amount)); }
    if (op.kind === "insert") {
      let after = op.after;
      Array.from(op.text).forEach((value, offset) => {
        const id = JSON.stringify([op.id, offset]);
        elements.push({ id, after, value, deleted: deleted.has(id), clock: op.clock, replica: op.replica, sequence: op.sequence, offset }); after = id;
      });
    }
  }
  const children = new Map<string | null, RgaElement[]>();
  for (const element of elements) children.set(element.after, [...(children.get(element.after) ?? []), element]);
  for (const siblings of children.values()) siblings.sort((a, b) => -opOrder(a, b) || a.offset - b.offset);
  const ordered: RgaElement[] = [], stack = [...(children.get(null) ?? [])].reverse();
  while (stack.length) { const e = stack.pop()!; ordered.push(e); stack.push(...[...(children.get(e.id) ?? [])].reverse()); }
  const vector = (map: Map<string, number>) => Object.fromEntries([...map].sort(([a], [b]) => compare(a, b)));
  const sum = (map: Map<string, number>) => [...map.values()].reduce((a, b) => a + b, 0);
  const set = [...new Set(replica.operations.flatMap(op => op.kind === "add" && !removed.has(op.id) ? [op.value] : []))].sort(compare);
  return { gCounter: vector(g), pnPositive: vector(positive), pnNegative: vector(negative), g: sum(g), pn: sum(positive) - sum(negative), set, elements: ordered, text: ordered.filter(e => !e.deleted).map(e => e.value).join("") };
}
export const crdtScenarios: Script<CrdtAction>[] = [
  { name: "counter messages reorder and duplicate", description: "Unique operation IDs make duplicate delivery idempotent for G- and PN-counters.", actions: [{ type: "increment", replica: "A", counter: "g", amount: 2 }, { type: "increment", replica: "B", counter: "pn", amount: -3 }, { type: "duplicate", message: 1 }, { type: "delay", message: 1 }, { type: "deliver", message: 3 }, { type: "deliverAll" }] },
  { name: "observed-remove add wins", description: "A remove tombstones only observed add tags; a concurrent add survives.", actions: [{ type: "add", replica: "A", value: "x" }, { type: "deliverAll" }, { type: "remove", replica: "A", value: "x" }, { type: "add", replica: "B", value: "x" }, { type: "deliverAll" }] },
  { name: "concurrent RGA edits", description: "Stable element IDs, parent links and tombstones preserve concurrent text edits.", actions: [{ type: "insert", replica: "A", index: 0, text: "hi" }, { type: "deliverAll" }, { type: "delete", replica: "A", index: 0, count: 1 }, { type: "insert", replica: "B", index: 1, text: "!" }, { type: "deliverAll" }] },
];
function deliver(state: CrdtState, id: number) {
  const message = state.messages.find(m => m.id === id);
  if (!message) throw new Error("Unknown message");
  const replica = state.replicas.find(r => r.id === message.to)!;
  replica.operations = [...new Map([...replica.operations, ...message.operations].map(op => [op.id, op])).values()].sort(opOrder);
  replica.clock = Math.max(replica.clock, ...message.operations.map(op => op.clock));
  state.messages = state.messages.filter(m => m.id !== id);
}
export function crdtInvariants(state: CrdtState): Violation[] {
  const issues: Violation[] = [];
  if (state.replicas.some(r => new Set(r.operations.map(o => o.id)).size !== r.operations.length)) issues.push({ code: "duplicateOperation", message: "Every operation is applied at most once per replica." });
  if (!state.messages.length && new Set(state.replicas.map(r => JSON.stringify(crdtView(r)))).size !== 1) issues.push({ code: "convergence", message: "Replicas must converge once all messages are delivered." });
  return issues;
}
export function createCrdtModel(options: { replicas?: string[] } = {}): Model<CrdtState, CrdtAction> {
  const names = [...(options.replicas ?? ["A", "B", "C"])];
  if (names.length < 2 || names.length > 32 || names.some(n => typeof n !== "string" || !n.length) || new Set(names).size !== names.length) throw new Error("Use 2..32 unique replica names");
  return {
    init(seed) { random(seed); return { seed, replicas: names.map(id => ({ id, clock: 0, sequence: 0, operations: [] })), messages: [], nextMessage: 1 }; },
    actions: state => [...state.replicas.flatMap(r => [{ type: "increment" as const, replica: r.id, counter: "g" as const, amount: 1 }, { type: "insert" as const, replica: r.id, index: 0, text: "x" }]), ...state.messages.map(m => ({ type: "deliver" as const, message: m.id })), ...(state.messages.length ? [{ type: "duplicate" as const, message: state.messages[0].id }, { type: "deliverAll" as const }] : [])],
    step(state, action) {
      const next = structuredClone(state);
      if (action.type === "deliverAll") { while (next.messages.length) deliver(next, next.messages[0].id); return next; }
      if (action.type === "deliver") { deliver(next, action.message); return next; }
      if (action.type === "duplicate" || action.type === "delay") {
        const message = next.messages.find(m => m.id === action.message);
        if (!message) throw new Error("Unknown message");
        if (action.type === "duplicate") next.messages.push({ ...structuredClone(message), id: next.nextMessage++ }); else message.delays++;
        return next;
      }
      const replica = next.replicas.find(r => r.id === action.replica);
      if (!replica) throw new Error("Unknown replica");
      const view = crdtView(replica), visible = view.elements.filter(e => !e.deleted);
      const base: OpBase = { id: JSON.stringify([replica.id, ++replica.sequence]), replica: replica.id, clock: ++replica.clock, sequence: replica.sequence };
      let op: CrdtOperation;
      switch (action.type) {
        case "increment":
          if (!Number.isSafeInteger(action.amount) || action.amount === 0 || (action.counter !== "g" && action.counter !== "pn") || (action.counter === "g" && action.amount < 0) || !Number.isSafeInteger((action.counter === "g" ? view.g : view.pn) + action.amount)) throw new Error("Invalid counter delta");
          op = { ...base, kind: action.counter, amount: action.amount }; break;
        case "add":
          if (typeof action.value !== "string") throw new Error("Use string set elements");
          op = { ...base, kind: "add", value: action.value }; break;
        case "remove":
          if (typeof action.value !== "string") throw new Error("Use string set elements");
          op = { ...base, kind: "remove", tags: replica.operations.flatMap(o => o.kind === "add" && o.value === action.value ? [o.id] : []) }; break;
        case "insert":
          if (!Number.isInteger(action.index) || action.index < 0 || action.index > visible.length || !action.text.length || Array.from(action.text).length > 1000) throw new Error("Invalid insertion");
          op = { ...base, kind: "insert", after: action.index ? visible[action.index - 1].id : null, text: action.text }; break;
        case "delete":
          if (!Number.isInteger(action.index) || !Number.isInteger(action.count) || action.index < 0 || action.count < 1 || action.index + action.count > visible.length) throw new Error("Invalid deletion");
          op = { ...base, kind: "delete", targets: visible.slice(action.index, action.index + action.count).map(e => e.id) }; break;
      }
      replica.operations.push(op); replica.operations.sort(opOrder);
      for (const to of names.filter(n => n !== replica.id)) next.messages.push({ id: next.nextMessage++, from: replica.id, to, operations: structuredClone(replica.operations), delays: 0 });
      return next;
    }, invariants: crdtInvariants, scenarios: structuredClone(crdtScenarios),
  };
}
export interface CrdtVariant { id: string; seed: number; prompt: string; actions: CrdtAction[] }
export function generateCrdtVariant(seed: number): CrdtVariant {
  const next = random(seed); return { id: `crdt:${seed}`, seed, prompt: "What are the G-counter, PN-counter, set and text at convergence?", actions: [{ type: "increment", replica: "A", counter: "g", amount: 1 + Math.floor(next() * 9) }, { type: "increment", replica: "B", counter: "pn", amount: -1 - Math.floor(next() * 9) }, { type: "insert", replica: "A", index: 0, text: String.fromCharCode(97 + Math.floor(next() * 26)) }, { type: "insert", replica: "B", index: 0, text: "!" }, { type: "add", replica: "A", value: "x" }, { type: "remove", replica: "B", value: "x" }, { type: "deliverAll" }] };
}
export function solveCrdtVariant(v: CrdtVariant) { const m = createCrdtModel(), s = v.actions.reduce(m.step, m.init(v.seed)), { g, pn, set, text } = crdtView(s.replicas[0]); return { g, pn, set, text }; }

export * from "./ot";
