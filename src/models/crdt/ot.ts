import { random } from "../random";
import type { Model, Script, Violation } from "../types";

export type TextComponent = { retain: number } | { insert: string } | { delete: number };
export interface TextOperation { id: string; components: TextComponent[] }
export type TextEdit = { type: "insert"; index: number; text: string } | { type: "delete"; index: number; count: number };
const length = (c: TextComponent) => "insert" in c ? c.insert.length : "retain" in c ? c.retain : c.delete;
function append(components: TextComponent[], component: TextComponent) {
  if (!length(component)) return;
  const last = components.at(-1);
  if (last && "insert" in last && "insert" in component) last.insert += component.insert;
  else if (last && "retain" in last && "retain" in component) last.retain += component.retain;
  else if (last && "delete" in last && "delete" in component) last.delete += component.delete;
  else components.push({ ...component });
}
function validate(operation: TextOperation) {
  if (!operation.id || operation.components.some(c => Object.keys(c).length !== 1 || !("retain" in c || "insert" in c || "delete" in c) || ("insert" in c ? typeof c.insert !== "string" || !c.insert.length : !Number.isSafeInteger(length(c)) || length(c) < 1))) throw new Error("Invalid text operation");
}
const inputLength = (op: TextOperation) => op.components.reduce((n, c) => n + ("insert" in c ? 0 : length(c)), 0);
export function textOperation(text: string, edit: TextEdit, id: string): TextOperation {
  if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index > text.length) throw new Error("Invalid edit position");
  const components: TextComponent[] = [];
  append(components, { retain: edit.index });
  if (edit.type === "insert") {
    if (!edit.text.length) throw new Error("Insert nonempty text");
    append(components, { insert: edit.text }); append(components, { retain: text.length - edit.index });
  } else {
    if (!Number.isInteger(edit.count) || edit.count < 1 || edit.index + edit.count > text.length) throw new Error("Invalid deletion range");
    append(components, { delete: edit.count }); append(components, { retain: text.length - edit.index - edit.count });
  }
  const op = { id, components }; validate(op); return op;
}
export function applyTextOperation(text: string, operation: TextOperation): string {
  validate(operation);
  if (inputLength(operation) !== text.length) throw new Error("Operation input length differs from document length");
  return applyNaively(text, operation);
}
function applyNaively(text: string, operation: TextOperation): string {
  let cursor = 0, output = "";
  for (const c of operation.components) {
    if ("insert" in c) output += c.insert;
    else { if ("retain" in c) output += text.slice(cursor, cursor + c.retain); cursor += length(c); }
  }
  return output + text.slice(cursor);
}
/** Returns [a after b, b after a]. Insert ties use stable unique operation IDs. */
export function transformPair(a: TextOperation, b: TextOperation): [TextOperation, TextOperation] {
  validate(a); validate(b);
  if (inputLength(a) !== inputLength(b) || a.id === b.id) throw new Error("Concurrent operations need the same base length and distinct IDs");
  const left = structuredClone(a.components), right = structuredClone(b.components), ap: TextComponent[] = [], bp: TextComponent[] = [];
  while (left.length || right.length) {
    const x = left[0], y = right[0];
    if (x && "insert" in x && (!(y && "insert" in y) || a.id < b.id)) { append(ap, x); append(bp, { retain: x.insert.length }); left.shift(); continue; }
    if (y && "insert" in y) { append(ap, { retain: y.insert.length }); append(bp, y); right.shift(); continue; }
    if (!x || !y) throw new Error("Concurrent operations have incompatible bases");
    const n = Math.min(length(x), length(y));
    if ("retain" in x && "retain" in y) { append(ap, { retain: n }); append(bp, { retain: n }); }
    else if ("delete" in x && "retain" in y) append(ap, { delete: n });
    else if ("retain" in x && "delete" in y) append(bp, { delete: n });
    const consume = (items: TextComponent[]) => { const c = items[0]; if (length(c) === n) items.shift(); else if ("retain" in c) c.retain -= n; else if ("delete" in c) c.delete -= n; };
    consume(left); consume(right);
  }
  return [{ id: a.id, components: ap }, { id: b.id, components: bp }];
}
export function transformOperation(operation: TextOperation, against: TextOperation): TextOperation { return transformPair(operation, against)[0]; }
export interface OtClient { id: string; text: string; revision: number; pending: TextOperation | null }
export interface OtState {
  seed: number; mode: "transform" | "naive"; serial: number; serverText: string;
  clients: OtClient[]; history: TextOperation[];
  messages: { client: string; revision: number; operation: TextOperation }[];
}
export type OtAction = { type: "edit"; client: string; edit: TextEdit } | { type: "server"; client: string } | { type: "receive"; client: string } | { type: "flush" };
export const otScenarios: Script<OtAction>[] = [
  { name: "concurrent insertion", description: "Run in naive and transform modes: equal-position inserts diverge without transformation.", actions: [{ type: "edit", client: "A", edit: { type: "insert", index: 0, text: "X" } }, { type: "edit", client: "B", edit: { type: "insert", index: 0, text: "Y" } }, { type: "server", client: "A" }, { type: "server", client: "B" }, { type: "flush" }] },
  { name: "insert inside concurrent deletion", description: "A deletion transforms into split components to preserve concurrently inserted text.", actions: [{ type: "edit", client: "A", edit: { type: "delete", index: 0, count: 2 } }, { type: "edit", client: "B", edit: { type: "insert", index: 1, text: "X" } }, { type: "flush" }] },
];
function server(state: OtState, client: string) {
  const message = state.messages.find(m => m.client === client);
  if (!message) throw new Error("No pending submission for client");
  let operation = message.operation;
  if (state.mode === "transform") for (const previous of state.history.slice(message.revision)) operation = transformOperation(operation, previous);
  state.serverText = state.mode === "transform" ? applyTextOperation(state.serverText, operation) : applyNaively(state.serverText, operation);
  state.history.push(operation); state.messages = state.messages.filter(m => m !== message);
}
function receive(state: OtState, id: string) {
  const client = state.clients.find(c => c.id === id);
  if (!client) throw new Error("Unknown client");
  const remote = state.history[client.revision];
  if (!remote) throw new Error("No next server revision");
  if (client.pending?.id === remote.id) client.pending = null;
  else if (state.mode === "transform") {
    let operation = remote;
    if (client.pending) [client.pending, operation] = transformPair(client.pending, remote);
    client.text = applyTextOperation(client.text, operation);
  } else client.text = applyNaively(client.text, remote);
  client.revision++;
}
export function otInvariants(state: OtState): Violation[] {
  const settled = !state.messages.length && state.clients.every(c => !c.pending && c.revision === state.history.length);
  return settled && state.clients.some(c => c.text !== state.serverText) ? [{ code: "otConvergence", message: "Acknowledged clients must agree with the central server." }] : [];
}
export interface OtOptions { text?: string; clients?: string[]; mode?: "transform" | "naive" }
export function createOtModel(options: OtOptions = {}): Model<OtState, OtAction> {
  const text = options.text ?? "ab", names = [...(options.clients ?? ["A", "B"])], mode = options.mode ?? "transform";
  if (typeof text !== "string" || names.length < 2 || names.length > 32 || names.some(n => !n) || new Set(names).size !== names.length || !["transform", "naive"].includes(mode)) throw new Error("Invalid OT configuration");
  return {
    init(seed) { random(seed); return { seed, mode, serial: 0, serverText: text, clients: names.map(id => ({ id, text, revision: 0, pending: null })), history: [], messages: [] }; },
    actions: s => [...s.clients.filter(c => !c.pending).map(c => ({ type: "edit" as const, client: c.id, edit: { type: "insert" as const, index: 0, text: "x" } })), ...s.messages.map(m => ({ type: "server" as const, client: m.client })), ...s.clients.filter(c => c.revision < s.history.length).map(c => ({ type: "receive" as const, client: c.id })), { type: "flush" }],
    step(state, action) {
      const next = structuredClone(state);
      switch (action.type) {
        case "edit": {
          const client = next.clients.find(c => c.id === action.client);
          // shortcut: one outstanding edit per client; add a composed buffer for continuous editor input.
          if (!client || client.pending) throw new Error("A client may have one outstanding edit until acknowledgement");
          const operation = textOperation(client.text, action.edit, JSON.stringify([client.id, ++next.serial]));
          client.pending = operation; client.text = applyTextOperation(client.text, operation);
          next.messages.push({ client: client.id, revision: client.revision, operation: structuredClone(operation) }); break;
        }
        case "server": server(next, action.client); break;
        case "receive": receive(next, action.client); break;
        case "flush":
          while (next.messages.length) server(next, next.messages[0].client);
          for (const client of next.clients) while (client.revision < next.history.length) receive(next, client.id);
      }
      return next;
    }, invariants: otInvariants, scenarios: structuredClone(otScenarios),
  };
}
export interface OtVariant { id: string; seed: number; prompt: string; text: string; actions: OtAction[] }
export function generateOtVariant(seed: number): OtVariant {
  const next = random(seed), text = "abcdef".slice(0, 2 + Math.floor(next() * 5));
  const edit = (): TextEdit => next() < 0.5 ? { type: "insert", index: Math.floor(next() * (text.length + 1)), text: String.fromCharCode(88 + Math.floor(next() * 3)) } : { type: "delete", index: Math.floor(next() * text.length), count: 1 };
  return { id: `ot:${seed}`, seed, text, prompt: "What text does the central OT server converge to after these concurrent edits?", actions: [{ type: "edit", client: "A", edit: edit() }, { type: "edit", client: "B", edit: edit() }, { type: "flush" }] };
}
export function solveOtVariant(v: OtVariant): string { const m = createOtModel({ text: v.text }); return v.actions.reduce(m.step, m.init(v.seed)).serverText; }
