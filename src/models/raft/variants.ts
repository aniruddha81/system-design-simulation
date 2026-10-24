import { createRaftModel, drainRaft, type RaftAction } from ".";
import { random } from "../random";

export interface RaftVariant { id: string; seed: number; prompt: string; nodes: string[]; actions: RaftAction[] }
export function generateRaftVariant(seed: number): RaftVariant {
  const next = random(seed), nodes = Array.from({ length: next() < 0.5 ? 3 : 5 }, (_, i) => `N${i}`);
  const model = createRaftModel({ nodes });
  let state = model.init(seed);
  const actions: RaftAction[] = [{ type: "timeout", node: nodes[0] }];
  state = model.step(state, actions[0]);
  const election = drainRaft(model, state); state = election.state; actions.push(...election.actions);
  const size = 1 + Math.floor(next() * nodes.length);
  if (size < nodes.length) {
    const partition: RaftAction = { type: "partition", groups: [nodes.slice(0, size), nodes.slice(size)] };
    actions.push(partition); state = model.step(state, partition);
  }
  const proposal: RaftAction = { type: "propose", node: nodes[0], value: `command-${Math.floor(next() * 1000)}` };
  actions.push(proposal); state = model.step(state, proposal); actions.push(...drainRaft(model, state).actions);
  return { id: `raft:${seed}`, seed, nodes, actions, prompt: `Replay this ${nodes.length}-node message schedule. Is the final client proposal committed on ${nodes[0]}?` };
}
export function solveRaftVariant(v: RaftVariant): boolean {
  const model = createRaftModel({ nodes: v.nodes }), state = v.actions.reduce(model.step, model.init(v.seed)), leader = state.nodes[v.nodes[0]];
  return leader.commitIndex === leader.log.length;
}
