"use client";

import { useMemo, useState } from "react";
import { createTwoPhaseModel, type TransactionMode, type TwoPhaseState } from "@/models";
import { FocusedPlayer, Diagram, ModelTable, describeAction } from "./FocusedPlayer";

const summary = (s: TwoPhaseState) => `${s.mode}. Coordinator ${s.coordinator.alive ? s.coordinator.phase : "offline"}, decision ${s.coordinator.decision ?? "pending"}. ${s.participants.map(p => `${p.id} ${p.status}`).join("; ")}. Saga ${s.saga.status}, completed ${s.saga.completed.join(", ") || "none"}, compensated ${s.saga.compensated.join(", ") || "none"}. ${s.notices.join(" ")}`;

export function TwoPhasePlayer({ seed = 1 }: { seed?: number }) {
  const [mode, setMode] = useState<TransactionMode>("twoPhase");
  const model = useMemo(() => createTwoPhaseModel({ mode }), [mode]);
  return <>
    <label className="flex items-center gap-2 text-sm">Transaction protocol
      <select className="field" value={mode} onChange={e => setMode(e.target.value as TransactionMode)}>
        <option value="twoPhase">Two-phase commit</option><option value="saga">Saga</option><option value="outbox">Transactional outbox</option>
      </select>
    </label>
    <FocusedPlayer key={mode} model={model} seed={seed} no="M5" title="Commit, block, or compensate" summary={summary}>{p => {
      const s = p.state;
      const lanes = mode === "saga" ? ["coordinator", ...s.saga.steps.map(step => step.id)] : ["coordinator", ...s.participants.map(part => part.id)];
      const width = Math.max(600, lanes.length * 145 + 90), height = Math.max(200, (p.cursor + 1) * 45 + 80);
      const status = (state: TwoPhaseState, lane: string) => lane === "coordinator" ? (state.coordinator.alive ? (mode === "saga" ? state.saga.status : state.coordinator.decision ?? state.coordinator.phase) : "offline") : mode === "saga" ? (state.saga.compensated.includes(lane) ? "↶ compensated" : state.saga.failedStep === lane ? "✕ failed" : state.saga.completed.includes(lane) ? "✓ completed" : "waiting") : state.participants.find(part => part.id === lane)!.status;
      return <>
        <Diagram label={`Coordinator and participant swimlanes. ${summary(s)}`} width={width} height={height}>
          {lanes.map((lane, i) => <g key={lane}>
            <text x={90 + i * 145} y={25} textAnchor="middle" fill="currentColor" fontSize={13}>{lane}</text>
            <line x1={90 + i * 145} x2={90 + i * 145} y1={40} y2={height - 20} stroke="var(--rule)" />
            {p.states.slice(0, p.cursor + 1).map((state, j) => <g key={j}>
              <rect x={30 + i * 145} y={50 + j * 45} width={120} height={27} rx={3} fill="var(--surface)" stroke={status(state, lane).includes("compensated") ? "var(--accent)" : "var(--border)"} />
              <text x={90 + i * 145} y={68 + j * 45} textAnchor="middle" fontSize={12} fill="currentColor">{status(state, lane)}</text>
            </g>)}
          </g>)}
          {s.saga.compensated.map((step, i) => {
            const x = 90 + lanes.indexOf(step) * 145, next = s.saga.compensated[i + 1];
            return next && <path key={step} d={`M${x},${height - 12}H${90 + lanes.indexOf(next) * 145}l8,-6 m-8,6 l8,6`} fill="none" stroke="var(--accent)" strokeWidth={2} />;
          })}
        </Diagram>
        {mode === "saga" && <p className="text-sm">Compensation path: {s.saga.compensated.join(" ← ") || "no compensation yet"}. Completed work is undone in reverse order; irreversible work can require manual recovery.</p>}
        <ModelTable caption="Lane states (text alternative)" headers={["Lane", "State"]} rows={lanes.map(lane => [lane, status(s, lane)])} />
        <ModelTable caption="Executed schedule" headers={["Step", "Action"]} rows={p.timeline.slice(0, p.cursor).map((a, i) => [i + 1, describeAction(a)])} />
        {mode === "outbox" && <ModelTable caption="Outbox relay and deduplicated consumer" headers={["Record", "Value", "Attempts", "Acknowledged", "Consumed"]} rows={s.outbox.records.map(r => [r.id, r.value, r.attempts, r.acknowledged ? "yes" : "no", s.outbox.consumed.includes(r.id) ? "yes" : "no"])} />}
      </>;
    }}</FocusedPlayer>
  </>;
}
