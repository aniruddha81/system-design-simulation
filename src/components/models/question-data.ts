import {
  generateRaftVariant, solveRaftVariant, generateClocksVariant, solveClocksVariant,
  generateTwoPhaseVariant, solveTwoPhaseVariant, generateGossipVariant, solveGossipVariant,
  generateQuorumVariant, solveQuorumVariant, generateCrdtVariant, solveCrdtVariant,
  generateMatchingVariant, solveMatchingVariant, generateSpatialVariant, solveSpatialVariant,
  generateSketchVariant, solveSketchVariant, generateWindowingVariant, solveWindowingVariant,
} from "@/models";
import { parseAnswer } from "@/lib/content/variants";

export const focusedModelNames = ["raft", "clocks", "twoPhase", "gossip", "quorum", "crdt", "matching", "spatial", "sketches", "windowing"] as const;
export type FocusedModelName = typeof focusedModelNames[number];
export type AnswerField = { label: string; answer: string | number | boolean | string[]; choices?: string[]; ordered?: boolean; tolerance?: number };
export type FocusedQuestionData = { prompt: string; context: unknown; actions: unknown[]; fields: AnswerField[]; explanation: string };

/** All answer keys come from the model generators/solvers, never a UI copy of their algorithms. */
export function focusedQuestion(model: FocusedModelName, seed: number): FocusedQuestionData {
  switch (model) {
    case "raft": {
      const v = generateRaftVariant(seed);
      return { ...v, context: { nodes: v.nodes, seed }, fields: [{ label: "Proposal committed?", answer: solveRaftVariant(v) }], explanation: "A leader commits a current-term entry only after a majority replicates it. A minority partition cannot acknowledge the proposal." };
    }
    case "clocks": {
      const v = generateClocksVariant(seed);
      return { ...v, context: { nodes: ["A", "B", "C"], pair: v.pair }, fields: [{ label: "Causal relation", answer: solveClocksVariant(v), choices: ["before", "after", "concurrent", "equal"] }], explanation: "Follow local-event edges and send-to-receive edges. Events with no causal path in either direction are concurrent." };
    }
    case "twoPhase": {
      const v = generateTwoPhaseVariant(seed);
      return { ...v, context: { mode: v.mode, participants: ["P1", "P2"], steps: v.steps, codeVocabulary: { atomicDecision: "mixed commit and abort", blocking: "prepared participant blocked by coordinator outage", compensationOrder: "compensation out of reverse order", nonCompensatable: "irreversible work needs manual recovery", outboxAtomicity: "missing outbox record or duplicate effect" } }, fields: [{ label: "Invariant or limitation codes (comma-separated, or none)", answer: solveTwoPhaseVariant(v) }], explanation: "Prepared participants can block on coordinator failure. Sagas compensate in reverse order; irreversible work can require manual recovery. Outbox consumers deduplicate redelivery." };
    }
    case "gossip": {
      const v = generateGossipVariant(seed);
      return { ...v, context: { nodes: v.nodes, mode: v.mode, fanout: v.fanout, seed, initiallyInfected: ["N0"] }, fields: [{ label: "Infected nodes", answer: solveGossipVariant(v) }], explanation: "Each seeded round uses the previous infection snapshot, so newly infected nodes cannot forward the rumor again in the same round." };
    }
    case "quorum": {
      const v = generateQuorumVariant(seed);
      return { ...v, context: { n: v.n, r: v.r, w: v.w, sloppy: v.sloppy, spares: 2 }, fields: [{ label: "Any stale read?", answer: solveQuorumVariant(v) }], explanation: "R+W>N guarantees overlap only with a fixed replica set and retained versions. Sloppy writes can acknowledge on spare replicas outside the read set." };
    }
    case "crdt": {
      const v = generateCrdtVariant(seed), answer = solveCrdtVariant(v);
      return { ...v, context: { replicas: ["A", "B", "C"], initialCounters: 0, initialSet: [], initialText: "" }, fields: [{ label: "G-counter", answer: answer.g }, { label: "PN-counter", answer: answer.pn }, { label: "Set (comma-separated, or none)", answer: answer.set }, { label: "Converged text", answer: answer.text }], explanation: "Operations merge by unique IDs. An observed-remove only removes tags it has seen, while RGA orders concurrent text edits by stable element IDs." };
    }
    case "matching": {
      const v = generateMatchingVariant(seed);
      return { ...v, context: { initialBook: "empty", priceUnit: "integer ticks" }, fields: [{ label: "Units traded", answer: solveMatchingVariant(v) }], explanation: "Sequence decides whether cancellation happens before a fill. Eligible resting orders execute in price-time order, at the maker price." };
    }
    case "spatial": {
      const v = generateSpatialVariant(seed);
      return { ...v, actions: [v.action], context: { points: v.points, distance: "planar coordinate units" }, fields: [{ label: "Point IDs in distance order (comma-separated)", answer: solveSpatialVariant(v), ordered: true }], explanation: "Visit cells by their minimum possible distance, then rank points by exact planar distance. Point IDs break distance ties." };
    }
    case "sketches": {
      const v = generateSketchVariant(seed), answer = solveSketchVariant(v);
      return { ...v, context: { options: v.options, key: v.key, seed }, fields: [{ label: "Bloom contains the queried key?", answer: answer.contains }, { label: "Count-min estimate", answer: answer.count }, { label: "HLL cardinality estimate (two decimals)", answer: answer.cardinality, tolerance: 0.01 }], explanation: "Bloom membership checks every hashed bit; count-min takes the smallest hashed counter. HLL estimates distinct cardinality from leading-zero registers." };
    }
    case "windowing": {
      const v = generateWindowingVariant(seed);
      return { ...v, prompt: "How many finalized windows does this event and watermark schedule emit?", context: { size: 10, slide: 5, gap: 10, ...v.options }, fields: [{ label: "Final windows emitted", answer: solveWindowingVariant(v).length }], explanation: "Final emission requires watermark strictly past window end plus allowed lateness. Sliding windows can overlap; session bridge events can merge open windows." };
    }
  }
}

export function checkFocusedAnswer(field: AnswerField, text: string): boolean {
  const answer = field.answer;
  if (typeof answer === "number") {
    const value = parseAnswer(text);
    return value !== null && Math.abs(value - answer) <= (field.tolerance ?? 0);
  }
  if (typeof answer === "boolean") return text === (answer ? "yes" : "no");
  if (Array.isArray(answer)) {
    if (!text.trim()) return false;
    const values = text.trim().toLowerCase() === "none" ? [] : text.trim().split(/[\s,]+/);
    return JSON.stringify(field.ordered ? values : values.sort()) === JSON.stringify(field.ordered ? answer : [...answer].sort());
  }
  return text.trim() === answer;
}

export const displayAnswer = (answer: AnswerField["answer"]) => Array.isArray(answer) ? answer.join(", ") || "none" : typeof answer === "boolean" ? answer ? "yes" : "no" : typeof answer === "number" ? String(Math.round(answer * 100) / 100) : answer;
