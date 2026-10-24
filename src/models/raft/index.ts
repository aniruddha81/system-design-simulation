import type { Model, Script, Violation } from "../types";
import { hash32, random } from "../random";

export interface RaftEntry { term: number; value: string | null }
export interface RaftNode {
  id: string;
  alive: boolean;
  term: number;
  role: "follower" | "candidate" | "leader";
  votedFor: string | null;
  log: RaftEntry[];
  commitIndex: number;
  applied: RaftEntry[];
  votes: string[];
  nextIndex: Record<string, number>;
  matchIndex: Record<string, number>;
  electionDeadline: number;
  heartbeatAt: number;
}
type Payload =
  | { kind: "RequestVote"; lastIndex: number; lastTerm: number }
  | { kind: "Vote"; granted: boolean }
  | { kind: "AppendEntries"; prevIndex: number; prevTerm: number; entries: RaftEntry[]; leaderCommit: number }
  | { kind: "AppendResponse"; success: boolean; matchIndex: number; prevIndex: number };
export type RaftMessage = Payload & { id: number; from: string; to: string; term: number; deliverAfter: number };
export interface RaftState {
  seed: number;
  now: number;
  cursor: number;
  nextMessage: number;
  nodes: Record<string, RaftNode>;
  messages: RaftMessage[];
  groups: string[][];
  leaders: { term: number; node: string; log: RaftEntry[] }[];
  committed: { index: number; entry: RaftEntry }[];
}
export type RaftAction =
  | { type: "tick"; ticks: number }
  | { type: "timeout" | "crash" | "recover"; node: string }
  | { type: "deliver" | "drop"; message: number }
  | { type: "delay"; message: number; ticks: number }
  | { type: "partition"; groups: string[][] }
  | { type: "heal" }
  | { type: "propose"; node: string; value: string };
export interface RaftOptions { nodes?: string[]; electionMin?: number; electionMax?: number; heartbeat?: number }

function integer(value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected an integer in ${min}..${max}`);
}
function equal(a: RaftEntry | undefined, b: RaftEntry | undefined) { return a?.term === b?.term && a?.value === b?.value; }
export function canDeliverRaft(state: RaftState, message: RaftMessage): boolean {
  return message.deliverAfter <= state.now && state.nodes[message.from].alive && state.nodes[message.to].alive && state.groups.some(group => group.includes(message.from) && group.includes(message.to));
}

export function createRaftModel(options: RaftOptions = {}): Model<RaftState, RaftAction> {
  const ids = [...(options.nodes ?? ["A", "B", "C"])];
  if (!ids.length || ids.length > 15 || new Set(ids).size !== ids.length || ids.some(id => !id)) throw new Error("Use 1..15 distinct named Raft nodes");
  const min = options.electionMin ?? 8, max = options.electionMax ?? 15, heartbeat = options.heartbeat ?? 2;
  integer(min, 2, 10000); integer(max, min, 10000); integer(heartbeat, 1, min - 1);
  const majority = Math.floor(ids.length / 2) + 1;
  function reset(s: RaftState, n: RaftNode) {
    n.electionDeadline = s.now + min + hash32(String(s.cursor++), s.seed) % (max - min + 1);
  }
  function send(s: RaftState, n: RaftNode, to: string, payload: Payload) {
    s.messages.push({ ...payload, id: s.nextMessage++, from: n.id, to, term: n.term, deliverAfter: s.now });
  }
  function append(s: RaftState, n: RaftNode, to: string) {
    const next = n.nextIndex[to];
    send(s, n, to, { kind: "AppendEntries", prevIndex: next - 1, prevTerm: n.log[next - 2]?.term ?? 0, entries: structuredClone(n.log.slice(next - 1)), leaderCommit: n.commitIndex });
  }
  function broadcast(s: RaftState, n: RaftNode) {
    for (const id of ids) if (id !== n.id) append(s, n, id);
    n.heartbeatAt = s.now + heartbeat;
  }
  function apply(s: RaftState, n: RaftNode) {
    while (n.applied.length < n.commitIndex) {
      const index = n.applied.length + 1, entry = n.log[index - 1];
      n.applied.push({ ...entry });
      if (!s.committed.some(c => c.index === index && equal(c.entry, entry))) s.committed.push({ index, entry: { ...entry } });
    }
  }
  function commit(s: RaftState, n: RaftNode) {
    for (let index = n.log.length; index > n.commitIndex; index--) {
      if (n.log[index - 1].term === n.term && ids.filter(id => id === n.id || n.matchIndex[id] >= index).length >= majority) {
        n.commitIndex = index; apply(s, n); break;
      }
    }
  }
  function lead(s: RaftState, n: RaftNode) {
    n.role = "leader";
    s.leaders.push({ term: n.term, node: n.id, log: structuredClone(n.log) });
    n.nextIndex = Object.fromEntries(ids.map(id => [id, n.log.length + 1]));
    n.matchIndex = Object.fromEntries(ids.map(id => [id, 0]));
    // A current-term no-op lets a new leader safely commit entries from earlier terms.
    n.log.push({ term: n.term, value: null });
    commit(s, n); broadcast(s, n);
  }
  function election(s: RaftState, n: RaftNode) {
    n.term++; n.role = "candidate"; n.votedFor = n.id; n.votes = [n.id]; reset(s, n);
    for (const id of ids) if (id !== n.id) send(s, n, id, { kind: "RequestVote", lastIndex: n.log.length, lastTerm: n.log.at(-1)?.term ?? 0 });
    if (n.votes.length >= majority) lead(s, n);
  }
  function receive(s: RaftState, m: RaftMessage) {
    const n = s.nodes[m.to];
    if (m.term > n.term) { n.term = m.term; n.role = "follower"; n.votedFor = null; n.votes = []; }
    switch (m.kind) {
      case "RequestVote": {
        const term = n.log.at(-1)?.term ?? 0;
        const upToDate = m.lastTerm > term || (m.lastTerm === term && m.lastIndex >= n.log.length);
        const granted = m.term === n.term && (n.votedFor === null || n.votedFor === m.from) && upToDate;
        if (granted) { n.votedFor = m.from; reset(s, n); }
        send(s, n, m.from, { kind: "Vote", granted }); break;
      }
      case "Vote":
        if (m.term === n.term && n.role === "candidate" && m.granted && !n.votes.includes(m.from)) {
          n.votes.push(m.from); if (n.votes.length >= majority) lead(s, n);
        }
        break;
      case "AppendEntries": {
        let success = false;
        if (m.term === n.term) {
          n.role = "follower"; reset(s, n);
          if (m.prevIndex === 0 || n.log[m.prevIndex - 1]?.term === m.prevTerm) {
            success = true;
            for (let offset = 0; offset < m.entries.length; offset++) {
              const index = m.prevIndex + offset;
              if (n.log[index]?.term !== m.entries[offset].term) {
                n.log.splice(index, n.log.length - index, ...structuredClone(m.entries.slice(offset))); break;
              }
            }
            n.commitIndex = Math.max(n.commitIndex, Math.min(m.leaderCommit, m.prevIndex + m.entries.length));
            apply(s, n);
          }
        }
        send(s, n, m.from, { kind: "AppendResponse", success, matchIndex: success ? m.prevIndex + m.entries.length : 0, prevIndex: m.prevIndex }); break;
      }
      case "AppendResponse":
        if (m.term === n.term && n.role === "leader") {
          if (m.success) {
            n.matchIndex[m.from] = Math.max(n.matchIndex[m.from], m.matchIndex);
            n.nextIndex[m.from] = Math.max(n.nextIndex[m.from], m.matchIndex + 1);
            const before = n.commitIndex; commit(s, n);
            if (n.commitIndex > before) broadcast(s, n);
          } else if (m.prevIndex >= n.matchIndex[m.from]) {
            n.nextIndex[m.from] = Math.max(n.matchIndex[m.from] + 1, Math.min(n.nextIndex[m.from] - 1, m.prevIndex));
            append(s, n, m.from);
          }
        }
    }
  }
  const model: Model<RaftState, RaftAction> = {
    init(seed) {
      random(seed);
      const s: RaftState = { seed, now: 0, cursor: 0, nextMessage: 1, nodes: {}, messages: [], groups: [ids.slice()], leaders: [], committed: [] };
      s.nodes = Object.fromEntries(ids.map(id => {
        const n: RaftNode = { id, alive: true, term: 0, role: "follower", votedFor: null, log: [], commitIndex: 0, applied: [], votes: [], nextIndex: {}, matchIndex: {}, electionDeadline: 0, heartbeatAt: 0 };
        reset(s, n); return [id, n];
      }));
      return s;
    },
    actions: s => [
      { type: "tick", ticks: 1 }, { type: "heal" },
      ...Object.values(s.nodes).flatMap<RaftAction>(n => n.alive
        ? [{ type: "crash" as const, node: n.id }, ...(n.role === "leader" ? [{ type: "propose" as const, node: n.id, value: `value-${n.log.length}` }] : [{ type: "timeout" as const, node: n.id }])]
        : [{ type: "recover" as const, node: n.id }]),
      ...s.messages.flatMap(m => [{ type: "drop" as const, message: m.id }, { type: "delay" as const, message: m.id, ticks: 2 }, ...(canDeliverRaft(s, m) ? [{ type: "deliver" as const, message: m.id }] : [])]),
      ...(ids.length > 1 ? [{ type: "partition" as const, groups: [[ids[0]], ids.slice(1)] }] : []),
    ],
    step(state, action) {
      const s = structuredClone(state);
      if ("node" in action && !Object.hasOwn(s.nodes, action.node)) throw new Error("Unknown Raft node");
      switch (action.type) {
        case "tick":
          integer(action.ticks, 1, 10000);
          for (let i = 0; i < action.ticks; i++) {
            s.now++;
            for (const id of ids) {
              const n = s.nodes[id]; if (!n.alive) continue;
              if (n.role === "leader") { if (n.heartbeatAt <= s.now) broadcast(s, n); }
              else if (n.electionDeadline <= s.now) election(s, n);
            }
          }
          break;
        case "timeout": { const n = s.nodes[action.node]; if (n.alive && n.role !== "leader") election(s, n); break; }
        case "crash": s.nodes[action.node].alive = false; break;
        case "recover": {
          const n = s.nodes[action.node];
          if (!n.alive) { n.alive = true; n.role = "follower"; n.votes = []; reset(s, n); }
          break;
        }
        case "propose": {
          const n = s.nodes[action.node];
          if (!n.alive || n.role !== "leader") throw new Error("Proposals require a live leader");
          if (typeof action.value !== "string") throw new Error("Use a string command");
          n.log.push({ term: n.term, value: action.value }); commit(s, n); broadcast(s, n); break;
        }
        case "partition": {
          const flat = action.groups.flat();
          if (!action.groups.length || action.groups.some(g => !g.length) || flat.length !== ids.length || new Set(flat).size !== ids.length || flat.some(id => !ids.includes(id))) throw new Error("Partition groups must cover each node once");
          s.groups = action.groups.map(g => g.slice()); break;
        }
        case "heal": s.groups = [ids.slice()]; break;
        case "deliver": case "drop": case "delay": {
          const index = s.messages.findIndex(m => m.id === action.message);
          if (index < 0) throw new Error("Unknown Raft message");
          const message = s.messages[index];
          if (action.type === "delay") { integer(action.ticks, 1, 10000); message.deliverAfter = Math.max(s.now, message.deliverAfter) + action.ticks; }
          else if (action.type === "drop") s.messages.splice(index, 1);
          else {
            if (!canDeliverRaft(s, message)) throw new Error("Message delayed, partitioned, or node offline");
            s.messages.splice(index, 1); receive(s, message);
          }
        }
      }
      return s;
    },
    invariants: raftInvariants,
    scenarios: [],
  };
  model.scenarios = buildScenarios(model, ids);
  return model;
}

export function raftInvariants(s: RaftState): Violation[] {
  const issues: Violation[] = [], nodes = Object.values(s.nodes);
  if (s.leaders.some((a, i) => s.leaders.slice(i + 1).some(b => a.term === b.term && a.node !== b.node))) issues.push({ code: "electionSafety", message: "At most one leader can be elected per term." });
  if (nodes.some(a => nodes.some(b => a.log.some((entry, i) => b.log[i]?.term === entry.term && a.log.slice(0, i + 1).some((e, j) => !equal(e, b.log[j])))))) issues.push({ code: "logMatching", message: "Matching index/term entries imply identical log prefixes." });
  if (s.leaders.some(leader => s.committed.some(c => c.entry.term < leader.term && !equal(leader.log[c.index - 1], c.entry)))) issues.push({ code: "leaderCompleteness", message: "Every later-term leader contains every committed entry from an earlier term." });
  if (nodes.some(a => a.applied.some((entry, i) => nodes.some(b => b.applied[i] && !equal(entry, b.applied[i])))) || s.committed.some((a, i) => s.committed.slice(i + 1).some(b => a.index === b.index && !equal(a.entry, b.entry)))) issues.push({ code: "stateMachineSafety", message: "No two applied commands at an index may differ." });
  return issues;
}

/** Deliver the currently reachable queue without advancing time; records every delivery for replay. */
export function drainRaft(model: Model<RaftState, RaftAction>, state: RaftState, limit = 10000): { state: RaftState; actions: RaftAction[] } {
  const actions: RaftAction[] = [];
  while (actions.length < limit) {
    const message = state.messages.find(m => canDeliverRaft(state, m)); if (!message) return { state, actions };
    const action: RaftAction = { type: "deliver", message: message.id };
    state = model.step(state, action); actions.push(action);
  }
  throw new Error("Raft delivery limit exceeded");
}

function buildScenarios(model: Model<RaftState, RaftAction>, ids: string[]): Script<RaftAction>[] {
  if (ids.length < 3) return [];
  function script(name: string, description: string, build: (act: (a: RaftAction) => void, drain: () => void) => void): Script<RaftAction> {
    let state = model.init(0); const actions: RaftAction[] = [];
    const act = (a: RaftAction) => { state = model.step(state, a); actions.push(a); };
    const drain = () => { const result = drainRaft(model, state); state = result.state; actions.push(...result.actions); };
    build(act, drain); return { name, description, actions };
  }
  const [a, b] = ids;
  const elect = (act: (a: RaftAction) => void, drain: () => void) => { act({ type: "timeout", node: a }); drain(); };
  return [
    script("normal election", "A majority elects a leader and commits a client proposal.", (act, drain) => { elect(act, drain); act({ type: "propose", node: a, value: "x" }); drain(); }),
    script("leader crash", "Persistent logs survive a leader crash; another up-to-date node wins.", (act, drain) => { elect(act, drain); act({ type: "crash", node: a }); act({ type: "timeout", node: b }); drain(); }),
    script("split vote", "Simultaneous candidates split votes; a later timeout resolves the tie.", (act, drain) => { ids.forEach(node => act({ type: "timeout", node })); drain(); act({ type: "timeout", node: b }); drain(); }),
    script("minority partition", "The isolated stale leader can append but cannot commit.", (act, drain) => { elect(act, drain); act({ type: "partition", groups: [[a], ids.slice(1)] }); act({ type: "propose", node: a, value: "uncommitted" }); drain(); act({ type: "timeout", node: b }); drain(); }),
    script("partition heal with log repair", "A majority commits a replacement; the old leader's uncommitted suffix is repaired.", (act, drain) => { elect(act, drain); act({ type: "partition", groups: [[a], ids.slice(1)] }); act({ type: "propose", node: a, value: "orphan" }); act({ type: "timeout", node: b }); drain(); act({ type: "propose", node: b, value: "replacement" }); drain(); act({ type: "heal" }); drain(); }),
  ];
}
