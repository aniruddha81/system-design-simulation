import type { Model, Script, Violation } from "../types";
import { random } from "../random";

export type TransactionMode = "twoPhase" | "saga" | "outbox";
export interface SagaStep { id: string; compensatable: boolean }
export interface Participant { id: string; status: "idle" | "ready" | "prepared" | "committed" | "aborted" }
type TwoPhasePayload = { to: string } & (
  | { kind: "prepare" }
  | { kind: "vote"; participant: string; yes: boolean }
  | { kind: "decision"; decision: "commit" | "abort" }
);
export type TwoPhaseMessage = TwoPhasePayload & { id: number };
export interface TwoPhaseState {
  seed: number; mode: TransactionMode;
  coordinator: { alive: boolean; phase: "idle" | "preparing" | "decided"; decision: "commit" | "abort" | null; votes: Record<string, boolean> };
  participants: Participant[]; messages: TwoPhaseMessage[]; nextMessage: number;
  notices: string[];
  saga: { steps: SagaStep[]; completed: string[]; compensated: string[]; status: "running" | "compensating" | "completed" | "failed" | "stuck"; failedStep: string | null };
  outbox: { database: string[]; records: { id: number; value: string; acknowledged: boolean; attempts: number }[]; deliveries: { id: number; record: number }[]; consumed: number[]; values: string[]; nextDelivery: number };
}
export type TwoPhaseAction =
  | { type: "prepare" | "crashCoordinator" | "recoverCoordinator" | "coordinatorTimeout" }
  | { type: "vote"; participant: string; yes: boolean }
  | { type: "participantTimeout"; participant: string }
  | { type: "deliver" | "drop"; message: number }
  | { type: "sagaStep"; fail?: boolean }
  | { type: "compensate" }
  | { type: "outboxWrite"; value: string }
  | { type: "publish" | "acknowledge"; record: number }
  | { type: "consume"; delivery: number };
export interface TwoPhaseOptions { mode?: TransactionMode; participants?: string[]; steps?: SagaStep[] }

export function createTwoPhaseModel(options: TwoPhaseOptions = {}): Model<TwoPhaseState, TwoPhaseAction> {
  const mode = options.mode ?? "twoPhase", ids = [...(options.participants ?? ["P1", "P2"])];
  const steps = structuredClone(options.steps ?? [{ id: "reserve", compensatable: true }, { id: "charge", compensatable: true }, { id: "ship", compensatable: false }, { id: "notify", compensatable: true }]);
  if (!["twoPhase", "saga", "outbox"].includes(mode) || !ids.length || ids.length > 32 || ids.includes("coordinator") || ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error("Use a transaction mode and 1..32 distinct participants");
  if (!steps.length || steps.length > 64 || steps.some(s => !s.id || typeof s.compensatable !== "boolean") || new Set(steps.map(s => s.id)).size !== steps.length) throw new Error("Use 1..64 distinct saga steps");
  function send(s: TwoPhaseState, m: TwoPhasePayload) { s.messages.push({ ...m, id: s.nextMessage++ }); }
  function decide(s: TwoPhaseState, decision: "commit" | "abort") {
    if (s.coordinator.decision) return;
    s.coordinator.decision = decision; s.coordinator.phase = "decided";
    for (const id of ids) send(s, { to: id, kind: "decision", decision });
  }
  function participant(s: TwoPhaseState, id: string) { const p = s.participants.find(p => p.id === id); if (!p) throw new Error("Unknown participant"); return p; }
  const prepare: TwoPhaseAction[] = [{ type: "prepare" }, ...ids.map((_, i) => ({ type: "deliver" as const, message: i + 1 })), ...ids.map(participant => ({ type: "vote" as const, participant, yes: true }))];
  const voteDeliveries: TwoPhaseAction[] = ids.map((_, i) => ({ type: "deliver", message: ids.length + i + 1 }));
  const scenarios: Script<TwoPhaseAction>[] = mode === "saga" ? [
    { name: "saga failure and reverse compensation", description: "A failed step undoes completed work in reverse order.", actions: [...steps.slice(0, Math.min(2, steps.length - 1)).map(() => ({ type: "sagaStep" as const })), { type: "sagaStep", fail: true }, ...steps.slice(0, Math.min(2, steps.length - 1)).map(() => ({ type: "compensate" as const }))] },
    ...(steps.length > 2 ? [{ name: "non-compensatable step", description: "An irreversible completed step requires manual recovery if a later step fails.", actions: [...steps.slice(0, -1).map(() => ({ type: "sagaStep" as const })), { type: "sagaStep" as const, fail: true }, ...steps.slice(0, -1).map(() => ({ type: "compensate" as const }))] }] : []),
  ] : mode === "outbox" ? [
    { name: "transactional outbox", description: "A local write and outbox record are atomic; a crash before relay acknowledgement causes redelivery, handled by consumer deduplication.", actions: [{ type: "outboxWrite", value: "order-created" }, { type: "publish", record: 1 }, { type: "consume", delivery: 1 }, { type: "crashCoordinator" }, { type: "recoverCoordinator" }, { type: "publish", record: 1 }, { type: "consume", delivery: 2 }, { type: "acknowledge", record: 1 }] },
  ] : [
    { name: "2PC commit", description: "Commit follows unanimous durable prepare votes.", actions: [...prepare, ...voteDeliveries, ...ids.map((_, i) => ({ type: "deliver" as const, message: ids.length * 2 + i + 1 }))] },
    { name: "coordinator crash after prepare", description: "Prepared participants block until the coordinator recovers; a timeout cannot safely abort.", actions: [...prepare, { type: "crashCoordinator" }, { type: "participantTimeout", participant: ids[0] }] },
    { name: "participant timeout", description: "A participant that has not voted yes may abort; the coordinator then aborts everyone.", actions: [{ type: "prepare" }, { type: "participantTimeout", participant: ids[0] }, ...ids.map((_, i) => ({ type: "deliver" as const, message: i + 1 })), { type: "vote", participant: ids[0], yes: false }, { type: "deliver", message: ids.length + 1 }, ...ids.map((_, i) => ({ type: "deliver" as const, message: ids.length + i + 2 }))] },
  ];
  return {
    init(seed) {
      random(seed);
      return { seed, mode, coordinator: { alive: true, phase: "idle", decision: null, votes: {} }, participants: ids.map(id => ({ id, status: "idle" })), messages: [], nextMessage: 1, notices: [], saga: { steps: structuredClone(steps), completed: [], compensated: [], status: "running", failedStep: null }, outbox: { database: [], records: [], deliveries: [], consumed: [], values: [], nextDelivery: 1 } };
    },
    actions(s) {
      const common: TwoPhaseAction[] = [{ type: s.coordinator.alive ? "crashCoordinator" : "recoverCoordinator" }];
      if (mode === "saga") return [...common, ...(!s.coordinator.alive ? [] : s.saga.status === "running" ? [{ type: "sagaStep" as const }, { type: "sagaStep" as const, fail: true }] : s.saga.status === "compensating" ? [{ type: "compensate" as const }] : [])];
      if (mode === "outbox") return [...common, ...(s.coordinator.alive ? [{ type: "outboxWrite" as const, value: "order" }, ...s.outbox.records.filter(r => !r.acknowledged).flatMap(r => [{ type: "publish" as const, record: r.id }, ...(r.attempts ? [{ type: "acknowledge" as const, record: r.id }] : [])])] : []), ...s.outbox.deliveries.map(d => ({ type: "consume" as const, delivery: d.id }))];
      return [...common, ...(s.coordinator.alive ? [...(s.coordinator.phase === "idle" ? [{ type: "prepare" as const }] : []), ...(!s.coordinator.decision ? [{ type: "coordinatorTimeout" as const }] : [])] : []), ...s.participants.flatMap(p => [{ type: "participantTimeout" as const, participant: p.id }, ...(["ready", "aborted"].includes(p.status) ? [true, false].map(yes => ({ type: "vote" as const, participant: p.id, yes: p.status === "aborted" ? false : yes })) : [])]), ...s.messages.flatMap(m => [{ type: "drop" as const, message: m.id }, ...(m.to !== "coordinator" || s.coordinator.alive ? [{ type: "deliver" as const, message: m.id }] : [])])];
    },
    step(state, action) {
      const s = structuredClone(state); s.notices = [];
      if (action.type === "crashCoordinator") { s.coordinator.alive = false; return s; }
      if (action.type === "recoverCoordinator") {
        s.coordinator.alive = true;
        if (mode === "twoPhase") {
          if (s.coordinator.decision) for (const id of ids) send(s, { to: id, kind: "decision", decision: s.coordinator.decision });
          else if (s.coordinator.phase === "preparing") for (const p of s.participants) {
            if (p.status === "prepared" || p.status === "aborted") send(s, { to: "coordinator", kind: "vote", participant: p.id, yes: p.status === "prepared" });
            else send(s, { to: p.id, kind: "prepare" });
          }
        }
        return s;
      }
      if (action.type === "sagaStep" || action.type === "compensate") {
        if (mode !== "saga") throw new Error("Requires saga mode");
        if (!s.coordinator.alive) throw new Error("Saga orchestrator is offline");
        const saga = s.saga;
        if (action.type === "sagaStep") {
          if (saga.status !== "running") throw new Error("Saga is not running");
          const next = saga.steps[saga.completed.length];
          if (action.fail) { saga.failedStep = next.id; saga.status = saga.completed.length ? "compensating" : "failed"; }
          else { saga.completed.push(next.id); if (saga.completed.length === saga.steps.length) saga.status = "completed"; }
        } else if (saga.status === "compensating") {
          const id = saga.completed[saga.completed.length - saga.compensated.length - 1];
          if (!saga.steps.find(step => step.id === id)!.compensatable) { saga.status = "stuck"; s.notices.push(`Manual recovery required for ${id}`); }
          else { saga.compensated.push(id); if (saga.compensated.length === saga.completed.length) saga.status = "failed"; }
        }
        return s;
      }
      if (action.type === "outboxWrite" || action.type === "publish" || action.type === "acknowledge" || action.type === "consume") {
        if (mode !== "outbox") throw new Error("Requires outbox mode");
        const outbox = s.outbox;
        if (action.type === "consume") {
          const index = outbox.deliveries.findIndex(d => d.id === action.delivery); if (index < 0) throw new Error("Unknown outbox delivery");
          const [delivery] = outbox.deliveries.splice(index, 1), record = outbox.records.find(r => r.id === delivery.record)!;
          if (!outbox.consumed.includes(record.id)) { outbox.consumed.push(record.id); outbox.values.push(record.value); }
        } else {
          if (!s.coordinator.alive) throw new Error("Outbox producer/relay is offline");
          if (action.type === "outboxWrite") {
            if (typeof action.value !== "string") throw new Error("Use string outbox values");
            outbox.database.push(action.value); outbox.records.push({ id: outbox.records.length + 1, value: action.value, acknowledged: false, attempts: 0 });
          } else {
            const record = outbox.records.find(r => r.id === action.record); if (!record) throw new Error("Unknown outbox record");
            if (action.type === "publish" && !record.acknowledged) { record.attempts++; outbox.deliveries.push({ id: outbox.nextDelivery++, record: record.id }); }
            if (action.type === "acknowledge") { if (!record.attempts) throw new Error("Cannot acknowledge an unpublished record"); record.acknowledged = true; }
          }
        }
        return s;
      }
      if (mode !== "twoPhase") throw new Error("Requires twoPhase mode");
      switch (action.type) {
        case "prepare":
          if (!s.coordinator.alive || s.coordinator.phase !== "idle") throw new Error("Coordinator must be live and idle");
          s.coordinator.phase = "preparing"; for (const id of ids) send(s, { kind: "prepare", to: id }); break;
        case "vote": {
          const p = participant(s, action.participant);
          if (!["ready", "aborted", "prepared"].includes(p.status) || (p.status === "aborted" && action.yes) || (p.status === "prepared" && !action.yes)) throw new Error("Participant cannot change its durable vote");
          p.status = action.yes ? "prepared" : "aborted";
          send(s, { to: "coordinator", kind: "vote", participant: p.id, yes: action.yes }); break;
        }
        case "participantTimeout": {
          const p = participant(s, action.participant);
          if (p.status === "prepared") s.notices.push(`${p.id} is blocked awaiting the durable decision`);
          else if (p.status === "idle" || p.status === "ready") p.status = "aborted";
          break;
        }
        case "coordinatorTimeout": if (!s.coordinator.alive) throw new Error("Coordinator offline"); decide(s, "abort"); break;
        case "drop": case "deliver": {
          const index = s.messages.findIndex(m => m.id === action.message); if (index < 0) throw new Error("Unknown transaction message");
          const [m] = s.messages.splice(index, 1);
          if (action.type === "drop") break;
          if (m.to === "coordinator" && !s.coordinator.alive) throw new Error("Coordinator offline");
          if (m.kind === "prepare") { const p = participant(s, m.to); if (p.status === "idle") p.status = "ready"; }
          if (m.kind === "vote" && !s.coordinator.decision) {
            Object.defineProperty(s.coordinator.votes, m.participant, { value: m.yes, enumerable: true, configurable: true, writable: true });
            if (!m.yes) decide(s, "abort");
            else if (ids.every(id => Object.hasOwn(s.coordinator.votes, id) && s.coordinator.votes[id])) decide(s, "commit");
          }
          if (m.kind === "decision") {
            const p = participant(s, m.to);
            if (m.decision === "commit" && p.status !== "prepared" && p.status !== "committed") throw new Error("Cannot commit an unprepared participant");
            p.status = m.decision === "commit" ? "committed" : "aborted";
          }
        }
      }
      return s;
    },
    invariants: twoPhaseInvariants,
    scenarios,
  };
}

export function twoPhaseInvariants(s: TwoPhaseState): Violation[] {
  const issues: Violation[] = [];
  if (s.mode === "twoPhase") {
    if (s.participants.some(p => p.status === "committed") && s.participants.some(p => p.status === "aborted")) issues.push({ code: "atomicDecision", message: "No participant may commit while another aborts." });
    if (!s.coordinator.alive && s.participants.some(p => p.status === "prepared")) issues.push({ code: "blocking", message: "Prepared participants cannot decide while the coordinator is unavailable; this is a 2PC liveness limitation." });
  }
  if (s.mode === "saga") {
    if (s.saga.compensated.some((id, i) => id !== s.saga.completed[s.saga.completed.length - i - 1])) issues.push({ code: "compensationOrder", message: "Compensation must undo completed steps in reverse order." });
    if (s.saga.status === "stuck") issues.push({ code: "nonCompensatable", message: "An irreversible completed step needs manual recovery." });
  }
  if (s.mode === "outbox" && (s.outbox.database.length !== s.outbox.records.length || s.outbox.database.some((v, i) => v !== s.outbox.records[i].value) || new Set(s.outbox.consumed).size !== s.outbox.consumed.length)) issues.push({ code: "outboxAtomicity", message: "Each local write has one durable event; consumer effects are deduplicated." });
  return issues;
}
