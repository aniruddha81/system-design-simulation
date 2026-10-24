import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createTwoPhaseModel, type TwoPhaseAction, type TransactionMode } from ".";
import { generateTwoPhaseVariant, solveTwoPhaseVariant } from "./variants";

describe("transactions", () => {
  it.each(["twoPhase", "saga", "outbox"] as TransactionMode[])("replays %s scripts immutably and deterministically", mode => {
    const model = createTwoPhaseModel({ mode });
    for (const script of model.scenarios) {
      let s = model.init(23);
      for (const action of script.actions) {
        const before = structuredClone(s), next = model.step(s, action);
        expect(s).toEqual(before); expect(next).not.toBe(s); s = next;
        expect(model.invariants(s).filter(i => !["blocking", "nonCompensatable"].includes(i.code))).toEqual([]);
      }
      expect(s).toEqual(script.actions.reduce(model.step, model.init(23)));
    }
  });
  it("commits unanimously, blocks on coordinator failure, and recovers the durable decision", () => {
    const model = createTwoPhaseModel();
    const committed = model.scenarios[0].actions.reduce(model.step, model.init(0));
    expect(committed.participants.map(p => p.status)).toEqual(["committed", "committed"]);
    let s = model.scenarios[1].actions.reduce(model.step, model.init(0));
    expect(s.participants.map(p => p.status)).toEqual(["prepared", "prepared"]);
    expect(model.invariants(s).map(i => i.code)).toEqual(["blocking"]);
    expect(s.notices[0]).toContain("blocked");
    s = model.step(s, { type: "recoverCoordinator" });
    while (s.messages.length) s = model.step(s, { type: "deliver", message: s.messages[0].id });
    expect(s.participants.map(p => p.status)).toEqual(["committed", "committed"]);
    expect(model.invariants(s)).toEqual([]);
    const abort = model.scenarios[2].actions.reduce(model.step, model.init(0));
    expect(abort.participants.every(p => p.status === "aborted")).toBe(true);
  });
  it("never commits one participant while another aborts under arbitrary message schedules and timeouts", () => {
    fc.assert(fc.property(fc.integer(), fc.array(fc.nat(10000), { minLength: 30, maxLength: 100 }), (seed, choices) => {
      const model = createTwoPhaseModel({ participants: ["P1", "P2", "P3"] });
      let s = model.step(model.init(seed), { type: "prepare" });
      for (const choice of choices) {
        const actions = model.actions(s); s = model.step(s, actions[choice % actions.length]);
        expect(s.participants.some(p => p.status === "committed") && s.participants.some(p => p.status === "aborted")).toBe(false);
        expect(model.invariants(s).filter(i => i.code !== "blocking")).toEqual([]);
      }
    }), { numRuns: 100 });
  });
  it("cannot reverse a durable yes vote and can abort an undecided transaction after coordinator recovery", () => {
    const model = createTwoPhaseModel();
    let s = model.scenarios[1].actions.reduce(model.step, model.init(0));
    expect(() => model.step(s, { type: "vote", participant: "P1", yes: false })).toThrow();
    s = model.step(s, { type: "recoverCoordinator" }); s = model.step(s, { type: "coordinatorTimeout" });
    while (s.messages.length) s = model.step(s, { type: "deliver", message: s.messages[0].id });
    expect(s.participants.every(p => p.status === "aborted")).toBe(true);
    expect(model.invariants(s)).toEqual([]);
  });
  it("treats dictionary-like participant IDs as data and reports corrupted atomic decisions", () => {
    const model = createTwoPhaseModel({ participants: ["__proto__", "constructor"] });
    const s = model.scenarios[0].actions.reduce(model.step, model.init(0));
    expect(s.participants.every(p => p.status === "committed")).toBe(true);
    s.participants[1].status = "aborted";
    expect(model.invariants(s).map(i => i.code)).toContain("atomicDecision");
  });
  it("compensates exactly in reverse and stops at an irreversible step", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 20 }), fc.nat(100), (length, failAt) => {
      const model = createTwoPhaseModel({ mode: "saga", steps: Array.from({ length }, (_, i) => ({ id: `S${i}`, compensatable: true })) });
      const completed = failAt % length;
      let s = model.init(2);
      for (let i = 0; i < completed; i++) s = model.step(s, { type: "sagaStep" });
      s = model.step(s, { type: "sagaStep", fail: true });
      for (let i = 0; i < completed; i++) s = model.step(s, { type: "compensate" });
      expect(s.saga.compensated).toEqual(s.saga.completed.slice().reverse()); expect(s.saga.status).toBe("failed");
      expect(model.invariants(s)).toEqual([]);
    }));
    const model = createTwoPhaseModel({ mode: "saga" });
    const s = model.scenarios[1].actions.reduce(model.step, model.init(2));
    expect(s.saga.status).toBe("stuck"); expect(s.saga.compensated).not.toContain("ship");
    expect(model.invariants(s).map(i => i.code)).toContain("nonCompensatable");
    const bad = model.scenarios[0].actions.reduce(model.step, model.init(2));
    bad.saga.compensated.reverse();
    expect(model.invariants(bad).map(i => i.code)).toContain("compensationOrder");
  });
  it("atomically writes an outbox event and deduplicates relay redelivery after a crash", () => {
    const model = createTwoPhaseModel({ mode: "outbox" });
    const s = model.scenarios[0].actions.reduce(model.step, model.init(1));
    expect(s.outbox.database).toEqual(["order-created"]); expect(s.outbox.values).toEqual(["order-created"]);
    expect(s.outbox.records[0]).toMatchObject({ acknowledged: true, attempts: 2 });
    expect(model.invariants(s)).toEqual([]);
    expect(() => model.step(model.init(0), { type: "sagaStep" })).toThrow();
    expect(() => model.step(model.init(0), { type: "outboxWrite", value: 3 } as unknown as TwoPhaseAction)).toThrow();
  });
  it("solves seeded schedules in all three modes", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      const v = generateTwoPhaseVariant(seed), model = createTwoPhaseModel(v);
      expect(v).toEqual(generateTwoPhaseVariant(seed));
      expect(solveTwoPhaseVariant(v)).toEqual(model.invariants(v.actions.reduce(model.step, model.init(seed))).map(i => i.code).sort());
    }));
  });
});
