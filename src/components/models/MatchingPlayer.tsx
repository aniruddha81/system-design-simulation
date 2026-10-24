"use client";

import { useState } from "react";
import { createMatchingModel, type MatchingAction, type MatchingState, type Side } from "@/models";
import { FocusedPlayer, ModelTable } from "./FocusedPlayer";
import { bookLadder } from "./view-logic";

const model = createMatchingModel();
const summary = (s: MatchingState) => `Sequence ${s.sequence}. ${s.orders.filter(o => o.remaining).length} resting orders. ${s.tape.length} trades, ${s.tape.reduce((n, t) => n + t.quantity, 0)} units traded.`;

export function MatchingPlayer({ seed = 1 }: { seed?: number }) {
  return <FocusedPlayer model={model} seed={seed} no="M9" title="Price-time priority in the order book" summary={summary}>{p => <>
    <OrderForm state={p.state} inject={p.inject} />
    <ModelTable caption="Order book ladder · highest price first · FIFO at each price" headers={["Bid quantity / FIFO orders", "Price (ticks)", "Ask quantity / FIFO orders"]} rows={bookLadder(p.state).map(l => [l.bids.length ? `${l.bids.reduce((n, o) => n + o.remaining, 0)} / ${l.bids.map(o => `${o.id}(${o.remaining})`).join(", ")}` : "—", l.price, l.asks.length ? `${l.asks.reduce((n, o) => n + o.remaining, 0)} / ${l.asks.map(o => `${o.id}(${o.remaining})`).join(", ")}` : "—"])} />
    <ModelTable caption="Trade tape" headers={["Sequence", "Maker → taker", "Price (ticks)", "Quantity"]} rows={p.state.tape.map(t => [t.sequence, `${t.maker} → ${t.taker}`, t.price, t.quantity])} />
    <ModelTable caption="Order accounting" headers={["ID / side", "Submitted", "Filled", "Resting", "Cancelled", "Action"]} rows={p.state.orders.map(o => [o.id + " / " + o.side, o.quantity, o.filled, o.remaining, o.cancelled, <button key="cancel" type="button" className="btn min-h-9" disabled={!o.remaining} onClick={() => p.inject({ type: "cancel", id: o.id })}>Cancel {o.id}</button>])} />
  </>}</FocusedPlayer>;
}

function OrderForm({ state, inject }: { state: MatchingState; inject: (a: MatchingAction) => void }) {
  const [side, setSide] = useState<Side>("buy"), [kind, setKind] = useState("limit"), [price, setPrice] = useState(100), [quantity, setQuantity] = useState(5);
  return <form className="flex flex-wrap items-end gap-2 text-sm" onSubmit={e => {
    e.preventDefault();
    const id = model.actions(state).find(a => a.type === "limit")!.id;
    inject(kind === "limit" ? { type: "limit", id, side, price, quantity } : { type: "market", id, side, quantity });
  }}>
    <label>Order type<select className="field block" value={kind} onChange={e => setKind(e.target.value)}><option>limit</option><option>market</option></select></label>
    <label>Side<select className="field block" value={side} onChange={e => setSide(e.target.value as Side)}><option>buy</option><option>sell</option></select></label>
    <label>Price (ticks)<input className="field block w-28" type="number" required min={1} step={1} value={price} disabled={kind === "market"} onChange={e => setPrice(e.target.valueAsNumber)} /></label>
    <label>Quantity<input className="field block w-24" type="number" required min={1} step={1} value={quantity} onChange={e => setQuantity(e.target.valueAsNumber)} /></label>
    <button type="submit" className="btn min-h-9">Place order</button>
  </form>;
}
