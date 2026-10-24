"use client";

import { useId, useMemo, useState } from "react";
import { useStepDone } from "@/components/lesson/stepper";
import {
  anomalyNames,
  createIsolationModel,
  expectedOutcomes,
  isolationLevels,
  isolationScenarios,
  type Anomaly,
  type IsolationAction,
  type IsolationLevel,
  type IsolationScenario,
  type IsolationState,
  type Operation,
  type Violation,
} from "@/models";
import { Figure, nb } from "./notebook";
import { PlayerControls, usePlayer, Violations } from "./Player";

export const LEVEL_NAMES: Record<IsolationLevel, string> = { readCommitted: "Read Committed", snapshot: "Snapshot", serializable: "Serializable" };
export const ANOMALY_NAMES: Record<Anomaly, string> = {
  dirtyRead: "Dirty read",
  nonRepeatableRead: "Non-repeatable read",
  phantom: "Phantom",
  lostUpdate: "Lost update",
  writeSkew: "Write skew",
};

export function opText(op: Operation): string {
  switch (op.type) {
    case "read": return `read ${op.key}`;
    case "rangeRead": return `read range [${op.from}..${op.to}]`;
    case "write":
      if (op.value === null) return `delete ${op.key}`;
      if (typeof op.value === "number") return `write ${op.key} = ${op.value}`;
      return `write ${op.key} = ${op.value.read} ${op.value.delta < 0 ? "−" : "+"} ${Math.abs(op.value.delta)}`;
    default: return op.type;
  }
}

const touches = (op: Operation, keys: string[]) =>
  op.type === "read" || op.type === "write" ? keys.includes(op.key) : op.type === "rangeRead" ? keys.some((k) => op.from <= k && k <= op.to) : false;

/** Isolation-level scheduler (PLAN §6): transactions as columns, ops over time, anomalies highlighted. */
export function IsolationPlayer({ anomaly = "nonRepeatableRead", level: initialLevel = "readCommitted", seed = 0 }: { anomaly?: Anomaly; level?: IsolationLevel; seed?: number }) {
  const [name, setName] = useState<Anomaly>(anomaly);
  const [level, setLevel] = useState<IsolationLevel>(initialLevel);
  const id = useId();
  const scenario = isolationScenarios.find((s) => s.anomaly === name)!;
  return (
    <Figure no="M2" title="One schedule, three isolation levels" note={scenario.description}>
      <div className="flex flex-wrap gap-4 text-sm">
        <label htmlFor={`${id}-s`} className="flex items-center gap-2">
          Schedule
          <select id={`${id}-s`} className="field" value={name} onChange={(e) => setName(e.target.value as Anomaly)}>
            {isolationScenarios.map((s) => (
              <option key={s.anomaly} value={s.anomaly}>
                {ANOMALY_NAMES[s.anomaly]}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-l`} className="flex items-center gap-2">
          Isolation level
          <select id={`${id}-l`} className="field" value={level} onChange={(e) => setLevel(e.target.value as IsolationLevel)}>
            {isolationLevels.map((l) => (
              <option key={l} value={l}>
                {LEVEL_NAMES[l]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Session key={`${name}-${level}-${seed}`} scenario={scenario} level={level} seed={seed} />
      <OutcomeTable level={level} focus={name} />
    </Figure>
  );
}

function Session({ scenario, level, seed }: { scenario: IsolationScenario; level: IsolationLevel; seed: number }) {
  const done = useStepDone();
  const model = useMemo(() => createIsolationModel(level, scenario), [level, scenario]);
  const player = usePlayer(model, seed, scenario.actions, done);
  const { state } = player;
  const violations = model.invariants(state);
  const statusText = (txId: string) => {
    const tx = state.transactions.find((t) => t.id === txId)!;
    if (tx.status === "blocked") return `⏸ blocked, waiting for ${(state.waitFor[tx.id] ?? []).join(", ")}`;
    if (tx.status === "aborted") return `✕ aborted (${tx.reason === "writeConflict" ? "write conflict: first committer wins" : tx.reason === "deadlock" ? "deadlock victim" : "explicit"})`;
    if (tx.status === "committed") return "✓ committed";
    return tx.status === "pending" ? "not started" : "active";
  };
  const committed = Object.entries(state.database).map(([k, versions]) => `${k} = ${versions.at(-1)?.value ?? "missing"}`);
  const summary = `${state.transactions.map((t) => `${t.id} ${statusText(t.id)}`).join("; ")}. ${violations.length ? `Anomalies: ${violations.map((v) => v.code).join(", ")}.` : "No anomaly observed."}`;

  return (
    <>
      <PlayerControls player={player} describe={(a: IsolationAction) => `run the next operation of ${a.transaction}`} summary={summary} />
      <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Your actions">
        <span className="text-muted">Run the next operation of:</span>
        {state.transactions.map((tx) => (
          <button key={tx.id} type="button" className="btn min-h-9" disabled={!model.actions(state).some((a) => a.transaction === tx.id)} onClick={() => player.inject({ type: "execute", transaction: tx.id })}>
            {tx.id}: {tx.ops[tx.pc] ? opText(tx.ops[tx.pc]) : "done"}
          </button>
        ))}
      </div>
      <Timeline state={state} violations={violations} />
      <p className="text-sm">
        <span className="text-muted">Committed values:</span> <span className="num">{committed.join(", ") || "none"}</span>
      </p>
      <Violations list={violations} title={`Anomalies observed under ${LEVEL_NAMES[level]}`} />
    </>
  );
}

function Timeline({ state, violations }: { state: IsolationState; violations: Violation[] }) {
  const txs = state.transactions;
  // The k-th executed read of a transaction is its k-th read event.
  const seen: Record<string, number> = {};
  const rows = state.history.map((h, i) => {
    let value = "";
    if (h.outcome === "executed" && (h.op.type === "read" || h.op.type === "rangeRead")) {
      const k = (seen[h.transaction] = (seen[h.transaction] ?? -1) + 1);
      const ev = state.reads.filter((r) => r.transaction === h.transaction)[k];
      if (ev) {
        const vals = Object.entries(ev.values).map(([key, v]) => `${key}=${v.value ?? "missing"}`);
        value = h.op.type === "read" ? `→ ${ev.values[h.op.key]?.value ?? "missing"}` : `→ {${vals.join(", ")}}`;
      }
    }
    const flagged = violations.filter((v) => v.transactions?.includes(h.transaction) && touches(h.op, v.keys ?? []));
    return { i, h, value, flagged };
  });
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-md table-fixed text-sm">
        <caption className="mb-2 text-left text-sm text-muted">
          <span className="font-medium text-fg">Schedule</span> — time runs down; each lane is one transaction. Highlighted operations took part in an anomaly.
        </caption>
        <thead className="text-left">
          <tr>
            <th scope="col" className="w-10 px-2 py-1.5 font-mono text-xs font-normal text-muted">t</th>
            {txs.map((tx) => (
              <th key={tx.id} scope="col" className={`${nb.lane} px-3 py-1.5`}>
                <span className="font-semibold" style={{ fontFamily: "var(--font-display, var(--font-sans))" }}>
                  {tx.id}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ i, h, value, flagged }) => (
            <tr key={i} className="border-t border-dashed border-border">
              <th scope="row" className="num px-2 py-1.5 text-left text-xs font-normal text-muted">
                {i + 1}
              </th>
              {txs.map((tx) => (
                <td key={tx.id} className={`${nb.lane} px-3 py-1.5 align-top`}>
                  {tx.id === h.transaction && (
                    <span className="grid justify-items-start gap-1">
                      <span className={`${nb.op} ${h.outcome === "blocked" ? nb.opBlocked : ""} ${h.outcome === "aborted" ? nb.opAborted : ""}`}>
                        <span aria-hidden>{h.outcome === "executed" ? "✓" : h.outcome === "blocked" ? "⏸" : "✕"}</span>
                        <span className={flagged.length ? nb.marker : ""}>{opText(h.op)}</span>
                        {value && <span className="text-muted">{value}</span>}
                        {h.outcome !== "executed" && <span className="text-xs text-warning">{h.outcome}</span>}
                      </span>
                      {flagged.map((v) => (
                        <span key={v.code} className={nb.note}>
                          <span aria-hidden>⚠ </span>
                          {ANOMALY_NAMES[v.code as Anomaly] ?? v.code}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
          <tr className="border-t border-border text-muted">
            <th scope="row" className="px-2 py-1.5 text-left text-xs font-normal">
              next
            </th>
            {txs.map((tx) => (
              <td key={tx.id} className={`${nb.lane} px-3 py-1.5 align-top text-xs`}>
                {tx.status === "committed" || tx.status === "aborted" ? (
                  <span>{tx.status === "committed" ? "✓ committed" : `✕ aborted${tx.reason ? ` (${tx.reason})` : ""}`}</span>
                ) : (
                  <ol className="grid gap-0.5">
                    {tx.ops.slice(tx.pc).map((op, j) => (
                      <li key={j} className="num">
                        {j === 0 ? "▸ " : "  "}
                        {opText(op)}
                        {j === 0 && tx.status === "blocked" && ` (waiting for ${(state.waitFor[tx.id] ?? []).join(", ")})`}
                      </li>
                    ))}
                  </ol>
                )}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function OutcomeTable({ level, focus }: { level: IsolationLevel; focus: Anomaly }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="mb-2 text-left text-sm font-medium">What each level allows for these schedules</caption>
        <thead className="text-left text-muted">
          <tr>
            <th scope="col" className="px-2 py-1.5 font-medium">Anomaly</th>
            {isolationLevels.map((l) => (
              <th key={l} scope="col" className={`px-2 py-1.5 font-medium ${l === level ? "text-fg" : ""}`}>
                {LEVEL_NAMES[l]}
                {l === level && <span className="ml-1 text-xs text-accent">(selected)</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {anomalyNames.map((a) => (
            <tr key={a} className={`border-t border-border ${a === focus ? "bg-surface-2" : ""}`}>
              <th scope="row" className="px-2 py-1.5 text-left font-normal">
                {ANOMALY_NAMES[a]}
                {a === focus && <span className="sr-only"> (current schedule)</span>}
              </th>
              {isolationLevels.map((l) => {
                const allowed = expectedOutcomes[l][a] === "allowed";
                return (
                  <td key={l} className={`px-2 py-1.5 ${allowed ? "text-warning" : "text-success"} ${l === level ? "font-medium" : ""}`}>
                    {allowed ? "! allowed" : "✓ prevented"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
