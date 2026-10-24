import type { Model, Script, Violation } from "../types";
import { random } from "../random";

export type Side = "buy" | "sell";
export type MatchingAction =
  | { type: "limit"; id: string; side: Side; price: number; quantity: number }
  | { type: "market"; id: string; side: Side; quantity: number }
  | { type: "cancel"; id: string };
export interface Order { id: string; side: Side; price: number; quantity: number; remaining: number; sequence: number; filled: number; cancelled: number }
export interface Trade { sequence: number; maker: string; taker: string; price: number; quantity: number }
export interface MatchingState {
  seed: number; sequence: number; orders: Order[]; tape: Trade[];
  history: { sequence: number; action: MatchingAction; makers: string[] }[];
}
const priority = (side: Side) => (a: Order, b: Order) => (side === "buy" ? b.price - a.price : a.price - b.price) || a.sequence - b.sequence;
export function orderBook(state: MatchingState) {
  return { bids: state.orders.filter(o => o.side === "buy" && o.remaining > 0).sort(priority("buy")), asks: state.orders.filter(o => o.side === "sell" && o.remaining > 0).sort(priority("sell")) };
}
export const matchingScenarios: Script<MatchingAction>[] = [
  { name: "simple cross", description: "The resting order sets the execution price.", actions: [{ type: "limit", id: "a", side: "sell", price: 100, quantity: 5 }, { type: "limit", id: "b", side: "buy", price: 101, quantity: 5 }] },
  { name: "partial fills across levels", description: "Best price first, then earliest sequence at equal price.", actions: [{ type: "limit", id: "a", side: "sell", price: 100, quantity: 3 }, { type: "limit", id: "b", side: "sell", price: 100, quantity: 4 }, { type: "limit", id: "c", side: "sell", price: 101, quantity: 8 }, { type: "market", id: "d", side: "buy", quantity: 10 }] },
  { name: "cancel wins sequence race", description: "A cancel sequenced before the taker prevents the fill.", actions: [{ type: "limit", id: "a", side: "sell", price: 100, quantity: 5 }, { type: "cancel", id: "a" }, { type: "market", id: "b", side: "buy", quantity: 5 }] },
  { name: "fill wins sequence race", description: "A cancel sequenced after the taker cannot undo the trade.", actions: [{ type: "limit", id: "a", side: "sell", price: 100, quantity: 5 }, { type: "market", id: "b", side: "buy", quantity: 5 }, { type: "cancel", id: "a" }] },
];
function execute(state: MatchingState, action: MatchingAction): MatchingState {
  if (!action.id) throw new Error("Order ID required");
  const next = structuredClone(state), sequence = ++next.sequence;
  const makers: string[] = [];
  if (action.type === "cancel") {
    const order = next.orders.find(o => o.id === action.id);
    if (order) { order.cancelled += order.remaining; order.remaining = 0; }
  } else {
    if (next.orders.some(o => o.id === action.id)) throw new Error("Order IDs cannot be reused");
    if (!Number.isSafeInteger(action.quantity) || action.quantity <= 0 || (action.side !== "buy" && action.side !== "sell")) throw new Error("Use a side and positive integer quantity");
    if (action.type === "limit" && (!Number.isSafeInteger(action.price) || action.price <= 0)) throw new Error("Use positive integer price ticks");
    const order: Order = { ...action, price: action.type === "limit" ? action.price : (action.side === "buy" ? Infinity : 0), remaining: action.quantity, sequence, filled: 0, cancelled: 0 };
    const opposite = next.orders.filter(o => o.side !== order.side && o.remaining > 0).sort(priority(order.side === "buy" ? "sell" : "buy"));
    for (const maker of opposite) {
      if (!order.remaining || (order.side === "buy" ? maker.price > order.price : maker.price < order.price)) break;
      const quantity = Math.min(order.remaining, maker.remaining);
      makers.push(maker.id);
      maker.remaining -= quantity; maker.filled += quantity;
      order.remaining -= quantity; order.filled += quantity;
      next.tape.push({ sequence, maker: maker.id, taker: order.id, price: maker.price, quantity });
    }
    if (action.type === "market") { order.cancelled = order.remaining; order.remaining = 0; }
    next.orders.push(order);
  }
  next.history.push({ sequence, action: { ...action }, makers });
  return next;
}
export function matchingInvariants(state: MatchingState): Violation[] {
  const issues: Violation[] = [], { bids, asks } = orderBook(state);
  if (bids.length && asks.length && bids[0].price >= asks[0].price) issues.push({ code: "crossedBook", message: "Best bid must be below best ask after matching." });
  if (state.orders.some(o => o.remaining < 0 || o.quantity !== o.remaining + o.filled + o.cancelled || o.filled !== state.tape.filter(t => t.maker === o.id || t.taker === o.id).reduce((n, t) => n + t.quantity, 0))) issues.push({ code: "conservation", message: "Submitted quantity equals filled, cancelled and resting quantity." });
  let replay: MatchingState = { seed: state.seed, sequence: 0, orders: [], tape: [], history: [] };
  for (const entry of state.history) replay = execute(replay, entry.action);
  if (JSON.stringify(replay.tape) !== JSON.stringify(state.tape) || JSON.stringify(replay.history) !== JSON.stringify(state.history)) issues.push({ code: "priceTime", message: "Trades must consume eligible makers in price-time sequence." });
  return issues;
}
export function createMatchingModel(): Model<MatchingState, MatchingAction> {
  return {
    init(seed) { random(seed); return { seed, sequence: 0, orders: [], tape: [], history: [] }; },
    step: execute, invariants: matchingInvariants, scenarios: structuredClone(matchingScenarios),
    actions(s) {
      let id = `order-${s.sequence + 1}`;
      while (s.orders.some(o => o.id === id)) id += "-new";
      return [{ type: "limit", id, side: "buy", price: 100, quantity: 5 }, { type: "market", id, side: "sell", quantity: 2 }, ...s.orders.filter(o => o.remaining).map(o => ({ type: "cancel" as const, id: o.id }))];
    },
  };
}
export interface MatchingVariant { id: string; seed: number; prompt: string; actions: MatchingAction[] }
export function generateMatchingVariant(seed: number): MatchingVariant {
  const next = random(seed), quantity = 2 + Math.floor(next() * 8), take = 1 + Math.floor(next() * 12);
  return { id: `matching:${seed}`, seed, prompt: "How many units trade? Replay these sequenced orders.", actions: [{ type: "limit", id: "ask", side: "sell", price: 100, quantity }, ...(next() < 0.5 ? [{ type: "cancel" as const, id: "ask" }] : []), { type: "market", id: "buy", side: "buy", quantity: take }] };
}
export function solveMatchingVariant(v: MatchingVariant): number { const m = createMatchingModel(); return v.actions.reduce(m.step, m.init(v.seed)).tape.reduce((n, t) => n + t.quantity, 0); }
