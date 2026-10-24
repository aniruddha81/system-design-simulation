import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canDeliverRaft, createRaftModel, drainRaft, type RaftAction } from ".";
import { generateRaftVariant, solveRaftVariant } from "./variants";

describe("Raft", () => {
  it("replays every scenario without mutation and preserves all four safety properties", () => {
    const model = createRaftModel();
    for (const script of model.scenarios) {
      let state = model.init(19);
      for (const action of script.actions) {
        const before = structuredClone(state), next = model.step(state, action);
        expect(state).toEqual(before); expect(next).not.toBe(state);
        expect(model.invariants(next)).toEqual([]); state = next;
      }
      expect(state).toEqual(script.actions.reduce(model.step, model.init(19)));
    }
  });

  it("elects, fails over, resolves a split vote, prevents minority commits, and repairs logs", () => {
    const model = createRaftModel();
    const states = model.scenarios.map(script => script.actions.reduce(model.step, model.init(0)));
    expect(states[0].nodes.A.applied.map(e => e.value)).toContain("x");
    expect(states[1].nodes.B.role).toBe("leader");
    expect(states[2].nodes.B.role).toBe("leader");
    expect(states[3].nodes.A.role).toBe("leader");
    expect(states[3].nodes.A.log.at(-1)?.value).toBe("uncommitted");
    expect(states[3].nodes.A.commitIndex).toBe(1);
    expect(states[4].nodes.A.role).toBe("follower");
    expect(states[4].nodes.A.log).toEqual(states[4].nodes.B.log);
    expect(states[4].nodes.A.applied.map(e => e.value)).not.toContain("orphan");
    expect(states[4].nodes.A.applied.map(e => e.value)).toContain("replacement");
  });

  it("keeps a healthy leader sticky through repeated heartbeats and retains durable state on restart", () => {
    const model = createRaftModel();
    let s = drainRaft(model, model.step(model.init(10), { type: "timeout", node: "A" })).state;
    for (let i = 0; i < 60; i++) s = drainRaft(model, model.step(s, { type: "tick", ticks: 1 })).state;
    expect(s.leaders.map(l => l.node)).toEqual(["A"]);
    const before = structuredClone(s.nodes.A);
    s = model.step(s, { type: "crash", node: "A" }); s = model.step(s, { type: "recover", node: "A" });
    expect(s.nodes.A.log).toEqual(before.log); expect(s.nodes.A.term).toBe(before.term); expect(s.nodes.A.votedFor).toBe(before.votedFor);
  });

  it("uses seeded randomized election deadlines and supports one-node majorities", () => {
    const model = createRaftModel();
    expect(model.init(1)).toEqual(model.init(1));
    expect(Object.values(model.init(1).nodes).map(n => n.electionDeadline)).not.toEqual(Object.values(model.init(2).nodes).map(n => n.electionDeadline));
    const solo = createRaftModel({ nodes: ["only"] });
    let s = solo.step(solo.init(1), { type: "timeout", node: "only" });
    s = solo.step(s, { type: "propose", node: "only", value: "x" });
    expect(s.nodes.only.commitIndex).toBe(2); expect(solo.invariants(s)).toEqual([]);
  });

  it("preserves election safety and log matching under random partitions, drops, delays and crashes", () => {
    fc.assert(fc.property(fc.integer(), fc.array(fc.tuple(fc.integer({ min: 0, max: 10 }), fc.nat(1000)), { minLength: 40, maxLength: 160 }), (seed, choices) => {
      const model = createRaftModel({ nodes: ["A", "B", "C", "D", "E"] });
      let s = drainRaft(model, model.step(model.init(seed), { type: "timeout", node: "A" })).state;
      s = drainRaft(model, model.step(s, { type: "propose", node: "A", value: "initial committed command" })).state;
      for (const [kind, choice] of choices) {
        const nodes = Object.values(s.nodes), node = nodes[choice % nodes.length];
        let action: RaftAction;
        const m = s.messages[choice % s.messages.length];
        if (kind === 0) action = { type: "tick", ticks: 1 + choice % 4 };
        else if (kind === 1) action = { type: "partition", groups: [nodes.filter((_, i) => (choice >> i) & 1).map(n => n.id), nodes.filter((_, i) => !((choice >> i) & 1)).map(n => n.id)].filter(g => g.length) };
        else if (kind === 2) action = { type: "heal" };
        else if (kind === 3) action = { type: node.alive ? "crash" : "recover", node: node.id };
        else if (kind === 4 && node.alive && node.role === "leader") action = { type: "propose", node: node.id, value: String(choice) };
        else if (kind === 5 && node.alive) action = { type: "timeout", node: node.id };
        else if (m && kind === 6) action = { type: "delay", message: m.id, ticks: 1 + choice % 6 };
        else if (m && kind === 7) action = { type: "drop", message: m.id };
        else {
          const deliverable = s.messages.filter(m => canDeliverRaft(s, m));
          action = deliverable.length ? { type: "deliver", message: deliverable[choice % deliverable.length].id } : { type: "tick", ticks: 1 };
        }
        s = model.step(s, action); expect(model.invariants(s)).toEqual([]);
      }
    }), { numRuns: 80 });
  });

  it("detects corrupted safety witnesses and validates action boundaries", () => {
    const model = createRaftModel(), s = model.scenarios[0].actions.reduce(model.step, model.init(0));
    const election = structuredClone(s); election.leaders.push({ ...election.leaders[0], node: "B" });
    expect(model.invariants(election).map(i => i.code)).toContain("electionSafety");
    const logs = structuredClone(s); logs.nodes.B.log[0].value = "corrupt";
    expect(model.invariants(logs).map(i => i.code)).toContain("logMatching");
    const complete = structuredClone(s); complete.leaders.push({ term: 10, node: "B", log: [] });
    expect(model.invariants(complete).map(i => i.code)).toContain("leaderCompleteness");
    const applied = structuredClone(s); applied.nodes.B.applied[0].value = "corrupt";
    expect(model.invariants(applied).map(i => i.code)).toContain("stateMachineSafety");
    expect(() => model.step(s, { type: "partition", groups: [["A"], ["A", "B"]] })).toThrow();
    expect(() => model.step(s, { type: "propose", node: "B", value: "bad" })).toThrow();
    let delayed = model.step(model.init(0), { type: "timeout", node: "A" });
    delayed = model.step(delayed, { type: "delay", message: 1, ticks: 3 });
    expect(() => model.step(delayed, { type: "deliver", message: 1 })).toThrow();
    expect(() => model.init(NaN)).toThrow();
  });

  it("solves variants from their actual message schedules", () => {
    fc.assert(fc.property(fc.integer(), seed => {
      const v = generateRaftVariant(seed), model = createRaftModel({ nodes: v.nodes });
      const s = v.actions.reduce(model.step, model.init(seed)), proposal = s.nodes[v.nodes[0]].log.at(-1)!;
      expect(v).toEqual(generateRaftVariant(seed));
      expect(solveRaftVariant(v)).toBe(s.nodes[v.nodes[0]].applied.some(e => e.value === proposal.value));
      expect(model.invariants(s)).toEqual([]);
    }), { numRuns: 40 });
  });
});
