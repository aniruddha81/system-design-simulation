import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { anomalyNames, createIsolationModel, detectAnomalies, expectedOutcomes, isolationLevels, isolationScenarios, runIsolationScenario, type IsolationDefinition, type IsolationState, type Operation } from ".";
import { generateIsolationVariant, solveIsolationVariant } from "./variants";

function finish(definition: IsolationDefinition, state: IsolationState): IsolationState {
  const model = createIsolationModel(state.level, definition);
  for (let i = 0; i < 100 && model.actions(state).length; i++) {
    const next = model.actions(state).find(action => state.transactions.find(tx => tx.id === action.transaction)!.status !== "blocked");
    expect(next).toBeDefined();
    state = model.step(state, next!);
  }
  expect(model.actions(state)).toEqual([]);
  return state;
}

function permutations<T>(items: T[]): T[][] {
  return items.length ? items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map(tail => [item, ...tail])) : [[]];
}

function observationSignature(state: IsolationState) {
  return state.transactions.filter(tx => tx.status === "committed").map(tx => ({ id: tx.id,
    reads: state.reads.filter(read => read.transaction === tx.id).map(read => Object.fromEntries(Object.entries(read.values).map(([key, version]) => [key, version.value]))) })).sort((a, b) => a.id < b.id ? -1 : 1);
}
function databaseSignature(state: IsolationState) {
  return Object.fromEntries(Object.entries(state.database).map(([key, versions]) => [key, versions.at(-1)!.value]));
}

describe("isolation scheduler", () => {
  for (const level of isolationLevels) for (const scenario of isolationScenarios) {
    it(`${level}: ${scenario.name} is ${expectedOutcomes[level][scenario.anomaly]}`, () => {
      const state = runIsolationScenario(level, scenario, 9);
      const expected = expectedOutcomes[level][scenario.anomaly] === "allowed" ? [scenario.anomaly] : [];
      expect([...new Set(state.anomalies.map(item => item.code))]).toEqual(expected);
      expect(detectAnomalies(state)).toEqual(state.anomalies);
      expect(state.transactions.every(tx => tx.status === "committed" || tx.status === "aborted")).toBe(true);
    });
  }

  it("every scenario replays deterministically with immutable steps and scrub prefixes", () => {
    for (const level of isolationLevels) for (const scenario of isolationScenarios) {
      const model = createIsolationModel(level, scenario);
      let state = model.init(7);
      for (let i = 0; i < scenario.actions.length; i++) {
        const before = structuredClone(state);
        const next = model.step(state, scenario.actions[i]);
        expect(state).toEqual(before);
        expect(next).not.toBe(state);
        expect(next).toEqual(scenario.actions.slice(0, i + 1).reduce(model.step, model.init(7)));
        state = next;
      }
      expect(runIsolationScenario(level, scenario, 7)).toEqual(runIsolationScenario(level, scenario, 7));
    }
  });

  it("snapshot starts on the first scheduled op, sees own writes, and aborts a concurrent writer", () => {
    const lost = isolationScenarios.find(s => s.anomaly === "lostUpdate")!;
    const state = runIsolationScenario("snapshot", lost);
    expect(state.transactions.find(tx => tx.id === "T2")!.reason).toBe("writeConflict");
    expect(databaseSignature(state)).toEqual({ x: 1 });
    const definition: IsolationDefinition = { initial: { x: 1 }, transactions: [
      { id: "T1", ops: [{ type: "write", key: "x", value: 2 }, { type: "read", key: "x" }, { type: "commit" }] },
      { id: "T2", ops: [{ type: "read", key: "x" }, { type: "commit" }] },
    ] };
    const model = createIsolationModel("snapshot", definition);
    let own = model.init(0);
    for (const id of ["T1", "T1", "T1", "T2", "T2"]) own = model.step(own, { type: "execute", transaction: id });
    expect(own.reads.map(r => r.values.x.value)).toEqual([2, 2]);
    expect(own.anomalies).toEqual([]);
  });

  it("holds range locks over absent keys, blocks inserts, and releases on commit", () => {
    const scenario = isolationScenarios.find(s => s.anomaly === "phantom")!;
    const model = createIsolationModel("serializable", scenario);
    let state = model.step(model.init(0), scenario.actions[0]);
    state = model.step(state, scenario.actions[1]);
    expect(state.transactions[1].pc).toBe(0);
    expect(state.waitFor).toEqual({ T2: ["T1"] });
    state = finish(scenario, state);
    expect(state.reads.filter(r => r.transaction === "T1").map(r => Object.keys(r.values))).toEqual([["a"], ["a"]]);
    expect(databaseSignature(state)).toEqual({ a: 1, b: 2 });
    expect(state.locks).toEqual([]);
  });

  it("detects upgrade deadlocks, aborts the requester and unblocks the survivor", () => {
    const definition: IsolationDefinition = { initial: { x: 0 }, transactions: ["T1", "T2"].map(id => ({ id, ops: [
      { type: "read", key: "x" }, { type: "write", key: "x", value: 1 }, { type: "commit" },
    ] })) };
    const model = createIsolationModel("serializable", definition);
    let state = model.init(0);
    for (const id of ["T1", "T2", "T1", "T2"]) state = model.step(state, { type: "execute", transaction: id });
    expect(state.transactions[1].reason).toBe("deadlock");
    expect(state.transactions[0].status).toBe("active");
    expect(finish(definition, state).anomalies).toEqual([]);
  });

  it("read committed cannot read staged writes, even when the writer later commits", () => {
    const definition: IsolationDefinition = { initial: { x: 1 }, transactions: [
      { id: "T1", ops: [{ type: "write", key: "x", value: 2 }, { type: "commit" }] },
      { id: "T2", ops: [{ type: "read", key: "x" }, { type: "commit" }] },
    ] };
    const model = createIsolationModel("readCommitted", definition);
    let state = model.init(1);
    for (const id of ["T1", "T2", "T1", "T2"]) state = model.step(state, { type: "execute", transaction: id });
    expect(state.reads[0].values.x.value).toBe(1);
    expect(state.anomalies).toEqual([]);
    const corrupt = structuredClone(state);
    corrupt.reads[0].values.x = { value: 2, writer: "T1", commit: 3 };
    expect(detectAnomalies(corrupt).map(v => v.code)).toContain("dirtyRead");
  });

  it("does not label a refreshed read-modify-write as a lost update", () => {
    const definition: IsolationDefinition = { initial: { x: 0 }, transactions: [
      { id: "T1", ops: [{ type: "read", key: "x" }, { type: "read", key: "x" }, { type: "write", key: "x", value: { read: "x", delta: 1 } }, { type: "commit" }] },
      { id: "T2", ops: [{ type: "write", key: "x", value: 1 }, { type: "commit" }] },
    ] };
    const model = createIsolationModel("readCommitted", definition);
    let state = model.init(0);
    for (const id of ["T1", "T2", "T2", "T1", "T1", "T1"]) state = model.step(state, { type: "execute", transaction: id });
    expect(state.anomalies.map(v => v.code)).toEqual(["nonRepeatableRead"]);
    expect(databaseSignature(state)).toEqual({ x: 2 });
  });

  it("detects write skew in a three-transaction cycle", () => {
    const definition: IsolationDefinition = { initial: { a: 1, b: 1, c: 1 }, transactions: [
      { id: "T1", ops: [{ type: "read", key: "b" }, { type: "write", key: "a", value: 0 }, { type: "commit" }] },
      { id: "T2", ops: [{ type: "read", key: "c" }, { type: "write", key: "b", value: 0 }, { type: "commit" }] },
      { id: "T3", ops: [{ type: "read", key: "a" }, { type: "write", key: "c", value: 0 }, { type: "commit" }] },
    ] };
    for (const level of isolationLevels) {
      const model = createIsolationModel(level, definition);
      let state = model.init(1);
      for (let op = 0; op < 3; op++) for (const transaction of ["T1", "T2", "T3"]) state = model.step(state, { type: "execute", transaction });
      state = finish(definition, state);
      expect(state.anomalies.map(v => v.code)).toEqual(level === "serializable" ? [] : ["writeSkew"]);
      if (level !== "serializable") expect(state.anomalies[0].transactions).toEqual(["T1", "T2", "T3"]);
    }
  });

  it("handles deletion phantoms and excludes a transaction's own inserts/deletes", () => {
    const definition: IsolationDefinition = { initial: { a: 1 }, transactions: [
      { id: "T1", ops: [{ type: "rangeRead", from: "a", to: "z" }, { type: "rangeRead", from: "a", to: "z" }, { type: "commit" }] },
      { id: "T2", ops: [{ type: "write", key: "a", value: null }, { type: "commit" }] },
    ] };
    for (const level of isolationLevels) {
      const model = createIsolationModel(level, definition);
      let state = model.init(0);
      for (const transaction of ["T1", "T2", "T2", "T1", "T1"]) state = model.step(state, { type: "execute", transaction });
      state = finish(definition, state);
      expect(state.anomalies.map(v => v.code)).toEqual(level === "readCommitted" ? ["phantom"] : []);
      const ownDefinition: IsolationDefinition = { initial: {}, transactions: [{ id: "T1", ops: [
        { type: "rangeRead", from: "a", to: "z" }, { type: "write", key: "a", value: 1 },
        { type: "rangeRead", from: "a", to: "z" }, { type: "write", key: "a", value: null },
        { type: "rangeRead", from: "a", to: "z" }, { type: "commit" },
      ] }] };
      const ownModel = createIsolationModel(level, ownDefinition);
      expect(finish(ownDefinition, ownModel.init(0)).anomalies).toEqual([]);
    }
  });

  it("a failed expression leaves the previous state unchanged", () => {
    const model = createIsolationModel("snapshot", { initial: {}, transactions: [{ id: "T1", ops: [
      { type: "write", key: "x", value: { read: "missing", delta: 1 } }, { type: "commit" },
    ] }] });
    const state = model.init(0), copy = structuredClone(state);
    expect(() => model.step(state, { type: "execute", transaction: "T1" })).toThrow("Read a numeric missing");
    expect(state).toEqual(copy);
  });

  it("serializable random interleavings have no anomaly and match a serial execution", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ read: fc.constantFrom("a", "b", "c"), write: fc.constantFrom("a", "b", "c"), value: fc.integer({ min: -3, max: 3 }), range: fc.boolean(), abort: fc.boolean() }), { minLength: 1, maxLength: 4 }),
      fc.array(fc.nat({ max: 99 }), { maxLength: 40 }),
      (programs, picks) => {
        const definition: IsolationDefinition = { initial: { a: 0, b: 0, c: 0 }, transactions: programs.map((program, i) => ({ id: `T${i}`, ops: [
          { type: "read", key: program.read }, ...(program.range ? [{ type: "rangeRead", from: "a", to: "z" } as Operation] : []),
          { type: "write", key: program.write, value: program.value }, { type: "read", key: program.read }, { type: program.abort ? "abort" : "commit" },
        ] })) };
        const model = createIsolationModel("serializable", definition);
        let state = model.init(1);
        for (const pick of picks) {
          const choices = model.actions(state);
          if (choices.length) state = model.step(state, choices[pick % choices.length]);
          expect(model.invariants(state)).toEqual([]);
        }
        state = finish(definition, state);
        expect(state.anomalies).toEqual([]);
        const committed = state.transactions.filter(tx => tx.status === "committed");
        const equivalent = permutations(committed).some(order => {
          if (!order.length) return observationSignature(state).length === 0 && JSON.stringify(databaseSignature(state)) === JSON.stringify(definition.initial);
          const reference = createIsolationModel("readCommitted", { initial: definition.initial, transactions: order.map(tx => ({ id: tx.id, ops: tx.ops })) });
          let serial = reference.init(1);
          for (const tx of order) for (let i = 0; i < tx.ops.length; i++) serial = reference.step(serial, { type: "execute", transaction: tx.id });
          return JSON.stringify(observationSignature(serial)) === JSON.stringify(observationSignature(state)) &&
            JSON.stringify(databaseSignature(serial)) === JSON.stringify(databaseSignature(state));
        });
        expect(equivalent).toBe(true);
      }), { numRuns: 100 });
  });

  it("generated variant solvers agree with replay and the expected scenario table", () => {
    const coverage = new Set<string>();
    fc.assert(fc.property(fc.integer(), seed => {
      const variant = generateIsolationVariant(seed);
      coverage.add(`${variant.level}:${variant.scenario.anomaly}`);
      expect(variant).toEqual(generateIsolationVariant(seed));
      const state = runIsolationScenario(variant.level, variant.scenario, seed);
      expect(solveIsolationVariant(variant)).toEqual([...new Set(state.anomalies.map(a => a.code))].sort());
      expect(solveIsolationVariant(variant)).toEqual(expectedOutcomes[variant.level][variant.scenario.anomaly] === "allowed" ? [variant.scenario.anomaly] : []);
      expect(state.anomalies.every(a => anomalyNames.includes(a.code as typeof anomalyNames[number]))).toBe(true);
    }), { numRuns: 200, seed: 42 });
    expect(coverage.size).toBe(15);
  });

  it("rejects malformed programs and unknown actions without mutating input", () => {
    expect(() => createIsolationModel("snapshot", { initial: { x: NaN }, transactions: [] })).toThrow();
    expect(() => createIsolationModel("snapshot", { initial: {}, transactions: [{ id: "T1", ops: [{ type: "read", key: "x" }] }] })).toThrow();
    const model = createIsolationModel("snapshot");
    const state = model.init(1);
    expect(() => model.step(state, { type: "execute", transaction: "unknown" })).toThrow();
    expect(state.clock).toBe(0);
  });
});
