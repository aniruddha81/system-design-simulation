import type { Cell, MatchingState } from "@/models";

export function ringPoint(index: number, count: number) {
  const angle = index / count * 2 * Math.PI - Math.PI / 2;
  return { x: 300 + 200 * Math.cos(angle), y: 175 + 115 * Math.sin(angle) };
}

export function scale(value: number, min: number, max: number, start: number, end: number) {
  return max === min ? (start + end) / 2 : start + (value - min) / (max - min) * (end - start);
}

export function leafCells(cell: Cell): Cell[] {
  return cell.children.length ? cell.children.flatMap(leafCells) : [cell];
}

export function bookLadder(state: MatchingState) {
  const prices = [...new Set(state.orders.filter(o => o.remaining > 0).map(o => o.price))].sort((a, b) => b - a);
  return prices.map(price => ({ price,
    bids: state.orders.filter(o => o.price === price && o.side === "buy" && o.remaining > 0).sort((a, b) => a.sequence - b.sequence),
    asks: state.orders.filter(o => o.price === price && o.side === "sell" && o.remaining > 0).sort((a, b) => a.sequence - b.sequence),
  }));
}
