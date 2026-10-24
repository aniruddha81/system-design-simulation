import { describe, expect, it } from "vitest";
import { createMatchingModel, createSpatialModel, createRaftModel, createClocksModel, createTwoPhaseModel, createGossipModel, createQuorumModel, createCrdtModel, createOtModel, createSketchModel, createWindowingModel, type Model } from "@/models";
import { bookLadder, leafCells, ringPoint, scale, spatialViewport } from "./view-logic";
import { checkFocusedAnswer, displayAnswer, focusedModelNames, focusedQuestion } from "./question-data";

describe("focused model view geometry", () => {
  it("places nodes around a bounded ring, starting at twelve o'clock", () => {
    expect(ringPoint(0, 4).x).toBeCloseTo(300);
    expect(ringPoint(0, 4).y).toBeCloseTo(60);
    expect(ringPoint(1, 4)).toEqual({ x: 500, y: 175 });
    for (let count = 1; count <= 15; count++) for (let i = 0; i < count; i++) {
      const p = ringPoint(i, count);
      expect(((p.x - 300) / 200) ** 2 + ((p.y - 175) / 115) ** 2).toBeCloseTo(1);
    }
  });

  it("maps chart endpoints and handles a collapsed domain", () => {
    expect(scale(-10, -10, 10, 300, 30)).toBe(300);
    expect(scale(10, -10, 10, 300, 30)).toBe(30);
    expect(scale(0, -10, 10, 300, 30)).toBe(165);
    expect(scale(7, 7, 7, 300, 30)).toBe(165);
  });

  it("keeps spatial boundaries visible at world and tiny geohash scales", () => {
    expect(spatialViewport([])).toEqual({ minX: -180, maxX: 180, minY: -90, maxY: 90 });
    const points = [{ id: "west", x: -0.0001, y: 1 }, { id: "east", x: 0.0001, y: 1 }];
    const bounds = spatialViewport(points, { type: "radius", center: points[0], radius: 0.001 });
    expect(bounds.minX).toBeLessThan(-0.0011);
    expect(bounds.maxX).toBeGreaterThan(0.0009);
    expect(bounds.minY).toBeLessThan(0.999);
    expect(bounds.maxY).toBeGreaterThan(1.001);
    const single = spatialViewport([points[0]]);
    expect(single.minX).toBeLessThan(single.maxX);
    expect(single.minY).toBeLessThan(single.maxY);
  });

  it("draws each quadtree leaf exactly once", () => {
    const model = createSpatialModel({ capacity: 1, points: [{ id: "a", x: -1, y: -1 }, { id: "b", x: 1, y: 1 }] });
    const leaves = leafCells(model.init(1).tree);
    expect(leaves).toHaveLength(4);
    expect(leaves.every(c => !c.children.length)).toBe(true);
    expect(leaves.flatMap(c => c.points).map(p => p.id).sort()).toEqual(["a", "b"]);
  });

  it("aggregates price levels without losing FIFO or counting filled/cancelled orders", () => {
    const m = createMatchingModel();
    const s = [
      { type: "limit", id: "a", side: "sell", price: 100, quantity: 3 },
      { type: "limit", id: "b", side: "sell", price: 100, quantity: 4 },
      { type: "limit", id: "c", side: "sell", price: 101, quantity: 8 },
      { type: "limit", id: "bid", side: "buy", price: 99, quantity: 2 },
      { type: "market", id: "taker", side: "buy", quantity: 4 },
      { type: "cancel", id: "c" },
    ] as const;
    const state = s.reduce(m.step, m.init(1)), before = structuredClone(state);
    const ladder = bookLadder(state);
    expect(ladder.map(l => l.price)).toEqual([100, 99]);
    expect(ladder[0].asks.map(o => [o.id, o.remaining])).toEqual([["b", 3]]);
    expect(ladder[1].bids.map(o => [o.id, o.remaining])).toEqual([["bid", 2]]);
    expect(state).toEqual(before);
  });
});

describe("seeded model question grading", () => {
  it.each(focusedModelNames)("generates replay inputs and accepts its solver's displayed answer for %s", model => {
    for (const seed of [0, 1, 17, -1234, Number.MAX_SAFE_INTEGER]) {
      const q = focusedQuestion(model, seed);
      expect(q).toEqual(focusedQuestion(model, seed));
      expect(q.actions.length).toBeGreaterThan(0);
      for (const field of q.fields) {
        expect(checkFocusedAnswer(field, displayAnswer(field.answer))).toBe(true);
        expect(checkFocusedAnswer(field, "not-an-answer")).toBe(false);
      }
    }
  });

  it("requires explicit absence, preserves spatial result ordering, and handles numeric rounding", () => {
    expect(checkFocusedAnswer({ label: "codes", answer: [] }, "")).toBe(false);
    expect(checkFocusedAnswer({ label: "codes", answer: [] }, "none")).toBe(true);
    expect(checkFocusedAnswer({ label: "codes", answer: ["a", "b"] }, "b, a")).toBe(true);
    expect(checkFocusedAnswer({ label: "points", answer: ["p1", "p2"], ordered: true }, "p2, p1")).toBe(false);
    expect(checkFocusedAnswer({ label: "estimate", answer: 12.345, tolerance: 0.01 }, "12.35")).toBe(true);
    expect(checkFocusedAnswer({ label: "count", answer: 12 }, "12.1")).toBe(false);
  });
});

function replay<S, A>(model: Model<S, A>) {
  for (const seed of [0, 1, 17]) for (const script of model.scenarios) {
    let state = model.init(seed);
    for (const action of script.actions) {
      state = model.step(state, action);
      expect(model.invariants(state)).toBeInstanceOf(Array);
    }
  }
}

it("can eagerly replay every player script and mode without throwing", () => {
  replay(createRaftModel());
  replay(createClocksModel());
  for (const mode of ["twoPhase", "saga", "outbox"] as const) replay(createTwoPhaseModel({ mode }));
  replay(createGossipModel());
  for (const sloppy of [false, true]) replay(createQuorumModel({ sloppy }));
  replay(createCrdtModel());
  for (const mode of ["transform", "naive"] as const) replay(createOtModel({ mode }));
  replay(createMatchingModel());
  replay(createSpatialModel());
  replay(createSketchModel({ bloomBits: 64, bloomHashes: 3, width: 12, depth: 3, hllPrecision: 4 }));
  for (const kind of ["tumbling", "sliding", "session"] as const) for (const latePolicy of ["update", "drop", "sideOutput"] as const) replay(createWindowingModel({ kind, latePolicy }));
});
