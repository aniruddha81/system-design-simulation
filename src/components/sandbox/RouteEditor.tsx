"use client";
// Route (handler) step editor (§5.2, §8A.2). Targets come only from the owner's outgoing edges (§8A.5).
import { useState } from "react";
import type { Condition, DataOp, Design, EntitySpec, Join, NodeSpec, RetryPolicy, Status, Step } from "@/engine/types";
import { describeStep, reachableTargets, STORE_KINDS, updateNode } from "./design-ops";
import { useDesign, useDesignApi } from "./design-store";
import { Check, inputCls, Select, sectionTitle, smallBtn, UnitField } from "./fields";

const STATUSES: Status[] = [200, 201, 404, 409, 429, 503, 504];
const NEW_STEP: Record<Step["type"], string> = {
  call: "Call", cacheGet: "Cache get", cacheSet: "Cache set", cacheDelete: "Cache delete", branch: "Branch", respond: "Respond",
  parallel: "Parallel", publish: "Publish to queue", data: "Data operation", dedup: "Dedup (idempotency)",
};
const COND: Record<Condition["kind"], string> = {
  cacheHit: "if the last cache get hit", prob: "with probability p", found: "if the last read found a record",
  dedupHit: "if the idempotency key was seen", leaderAlive: "if the store has a live leader", breakerClosed: "if the breaker is closed",
};
const DATA_OPS: [DataOp["kind"], string][] = [
  ["get", "get (point read)"], ["query", "query (index or scan)"], ["insert", "insert (409 on conflict)"], ["put", "put (upsert)"],
  ["update", "update a field"], ["delete", "delete"], ["conditionalPut", "conditional put (409 on version)"], ["decrementIfPositive", "decrement if positive"],
];
const DEFAULT_RETRY: RetryPolicy = { max: 2, backoffUs: 10_000, multiplier: 2, jitter: "full", retryOn: ["timeout", "5xx"] };
const T = 200_000;

function RetryEditor({ value, onChange }: { value: RetryPolicy | undefined; onChange: (r: RetryPolicy | undefined) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Check label="Retry on failure" checked={!!value} onChange={(on) => onChange(on ? DEFAULT_RETRY : undefined)} />
      {value && (
        <div className="flex flex-col gap-1.5 border-l border-(--border) pl-2.5">
          <UnitField label="Max retries" kind="count" value={value.max} onCommit={(v) => onChange({ ...value, max: v! })} />
          <UnitField label="First backoff" kind="duration" value={value.backoffUs} onCommit={(v) => onChange({ ...value, backoffUs: v! })} />
          <UnitField label="Backoff ×" kind="number" value={value.multiplier} onCommit={(v) => onChange({ ...value, multiplier: Math.max(1, v!) })} />
          <div className="flex flex-wrap items-center gap-x-3">
            <Select label="Jitter" value={value.jitter} options={[["none", "No jitter"], ["full", "Full jitter"]]} onChange={(jitter) => onChange({ ...value, jitter })} className="h-7 w-32" />
            {(["timeout", "5xx", "429"] as const).map((k) => (
              <Check key={k} label={`on ${k}`} checked={value.retryOn.includes(k)} onChange={(on) => onChange({ ...value, retryOn: on ? [...value.retryOn, k] : value.retryOn.filter((x) => x !== k) })} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DataOpEditor({ op, entity, onChange }: { op: DataOp; entity: EntitySpec | undefined; onChange: (op: DataOp) => void }) {
  const fields = entity?.fields ?? [];
  const numeric = fields.filter((f) => f.type === "int" || f.type === "float");
  const make = (k: DataOp["kind"]): DataOp => {
    switch (k) {
      case "query": return { kind: k, index: entity?.indexes[0]?.name, limit: 20 };
      case "update": return { kind: k, field: fields[0]?.name ?? "", op: "set" };
      case "decrementIfPositive": return { kind: k, field: numeric[0]?.name ?? "" };
      default: return { kind: k };
    }
  };
  const fieldSelect = (value: string, list: typeof fields, set: (f: string) => void) => (
    <select aria-label="Field" aria-invalid={!list.some((f) => f.name === value)} className={`${inputCls} h-7`} value={value} onChange={(e) => set(e.target.value)}>
      {!list.some((f) => f.name === value) && <option value={value}>{value || "— pick a field —"}</option>}
      {list.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
    </select>
  );
  return (
    <div className="flex flex-col gap-1.5">
      <Select label="Operation" value={op.kind} options={DATA_OPS} onChange={(k) => onChange(make(k))} className="h-7" />
      {op.kind === "query" && (
        <>
          <select aria-label="Index" className={`${inputCls} h-7`} value={op.index ?? ""} onChange={(e) => onChange({ ...op, index: e.target.value || undefined })}>
            <option value="">No index — full scan (cost grows with the dataset)</option>
            {entity?.indexes.map((i) => <option key={i.name} value={i.name}>index {i.name} ({i.fields.join(", ")})</option>)}
          </select>
          <UnitField label="Limit" kind="count" value={op.limit} onCommit={(v) => onChange({ ...op, limit: Math.max(1, v!) })} />
        </>
      )}
      {op.kind === "update" && (
        <div className="flex flex-wrap gap-1.5">
          {fieldSelect(op.field, fields, (field) => onChange({ ...op, field }))}
          <Select label="Update" value={op.op} options={[["set", "set"], ["increment", "increment"], ["append", "append"]]} onChange={(o) => onChange({ ...op, op: o })} className="h-7 w-28" />
          <input aria-label="Value" placeholder="value (optional)" className={`${inputCls} h-7 w-32`} value={op.value === undefined ? "" : String(op.value)} onChange={(e) => {
            const v = e.target.value;
            onChange({ ...op, value: v === "" ? undefined : v === "true" || v === "false" ? v === "true" : Number.isFinite(Number(v)) ? Number(v) : v });
          }} />
        </div>
      )}
      {op.kind === "decrementIfPositive" && fieldSelect(op.field, numeric, (field) => onChange({ ...op, field }))}
      {op.kind === "conditionalPut" && (
        <UnitField label="Expected version" kind="count" optional value={op.expectedVersion} hint="Empty = the version the route read earlier" onCommit={(v) => onChange({ ...op, expectedVersion: v })} />
      )}
    </div>
  );
}

function JoinEditor({ join, branches, onChange }: { join: Join; branches: number; onChange: (j: Join) => void }) {
  const n = join.kind === "quorum" ? join.k : join.kind === "firstN" ? join.n : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <Select
        label="Wait for"
        value={join.kind}
        className="h-7"
        options={[["all", "all branches"], ["any", "the first success"], ["quorum", "a quorum of k successes"], ["firstN", "the first n results"]]}
        onChange={(k) => onChange(k === "quorum" ? { kind: k, k: Math.max(1, Math.ceil(branches / 2)) } : k === "firstN" ? { kind: k, n: 1 } : { kind: k })}
      />
      {(join.kind === "quorum" || join.kind === "firstN") && (
        <>
          <UnitField label={join.kind === "quorum" ? "k" : "n"} kind="count" value={n} onCommit={(v) => onChange(join.kind === "quorum" ? { kind: "quorum", k: Math.max(1, v!) } : { kind: "firstN", n: Math.max(1, v!) })} />
          {n > branches && <p className="text-xs text-(--danger)">⚠ Needs {n} but there are only {branches} branches.</p>}
        </>
      )}
    </div>
  );
}

export function StepList({ steps, design, owner, onChange, depth = 0 }: {
  steps: Step[]; design: Design; owner: NodeSpec; onChange: (s: Step[]) => void; depth?: number;
}) {
  const reach = reachableTargets(design, owner.id);
  const of = (...kinds: string[]) => reach.filter((n) => kinds.includes(n.kind));
  const caches = of("cache");
  const queues = of("queue");
  const dedups = of("dedupStore");
  const stores = reach.filter((n) => STORE_KINDS.includes(n.kind));
  const leaders = of("database", "kvStore");
  const breakers = of("circuitBreaker");
  const callable = reach.filter((n) => !["cache", "queue", "dedupStore"].includes(n.kind));
  const entitiesOf = (store: string) => (design.entities ?? []).filter((e) => e.store === store);
  const [adding, setAdding] = useState<Step["type"]>("call");
  const set = (i: number, s: Step) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, by: number) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  const make = (t: Step["type"]): Step | null => {
    switch (t) {
      case "call": return callable[0] ? { type: t, target: callable[0].id, timeoutUs: T } : null;
      case "cacheGet": case "cacheSet": case "cacheDelete": return caches[0] ? { type: t, cache: caches[0].id, timeoutUs: 50_000 } : null;
      case "branch": return { type: t, cond: { kind: "cacheHit" }, then: [], else: [] };
      case "respond": return { type: t, status: 200 };
      case "parallel": return { type: t, branches: [[], []], join: { kind: "all" }, cancelLosers: false };
      case "publish": return queues[0] ? { type: t, queue: queues[0].id, timeoutUs: 50_000, orderedByKey: false } : null;
      case "data": return stores[0] ? { type: t, target: stores[0].id, entity: entitiesOf(stores[0].id)[0]?.name ?? "", op: { kind: "get" }, timeoutUs: T } : null;
      case "dedup": return dedups[0] ? { type: t, store: dedups[0].id, timeoutUs: 50_000 } : null;
    }
  };
  const makeCond = (k: Condition["kind"]): Condition | null => {
    switch (k) {
      case "prob": return { kind: k, p: 0.5 };
      case "leaderAlive": return leaders[0] ? { kind: k, store: leaders[0].id } : null;
      case "breakerClosed": return breakers[0] ? { kind: k, breaker: breakers[0].id } : null;
      default: return { kind: k };
    }
  };
  const targetSelect = (current: string, options: NodeSpec[], onPick: (id: string) => void, what: string) => {
    const ok = options.some((o) => o.id === current);
    return (
      <select aria-label={what} aria-invalid={!ok} className={`${inputCls} h-7 min-w-0 flex-1`} value={current} onChange={(e) => onPick(e.target.value)}>
        {!ok && <option value={current}>{design.nodes.find((n) => n.id === current)?.label ?? current} — no connection!</option>}
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    );
  };

  return (
    <ol className={`flex flex-col gap-1.5 ${depth ? "border-l border-(--border) pl-3" : ""}`}>
      {steps.map((s, i) => (
        <li key={i} className="flex flex-col gap-1.5 rounded-(--radius-sm) bg-(--bg) p-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-24 shrink-0 font-mono text-xs text-(--text-muted)">{i + 1}. {s.type}</span>
            {s.type === "call" && targetSelect(s.target, callable, (id) => set(i, { ...s, target: id }), "Call target")}
            {(s.type === "cacheGet" || s.type === "cacheSet" || s.type === "cacheDelete") && targetSelect(s.cache, caches, (id) => set(i, { ...s, cache: id }), "Cache")}
            {s.type === "publish" && targetSelect(s.queue, queues, (id) => set(i, { ...s, queue: id }), "Queue")}
            {s.type === "dedup" && targetSelect(s.store, dedups, (id) => set(i, { ...s, store: id }), "Dedup store")}
            {s.type === "data" && targetSelect(s.target, stores, (id) => set(i, { ...s, target: id, entity: entitiesOf(id)[0]?.name ?? "" }), "Store")}
            {s.type === "respond" && (
              <select aria-label="Status" className={`${inputCls} h-7 w-24`} value={s.status} onChange={(e) => set(i, { ...s, status: Number(e.target.value) as Status })}>
                {STATUSES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            {s.type === "branch" && (
              <select aria-label="Condition" className={`${inputCls} h-7 min-w-0 flex-1`} value={s.cond.kind} onChange={(e) => {
                const c = makeCond(e.target.value as Condition["kind"]);
                if (c) set(i, { ...s, cond: c });
              }}>
                {(Object.keys(COND) as Condition["kind"][]).map((k) => (
                  <option key={k} value={k} disabled={!makeCond(k)}>{COND[k]}{!makeCond(k) ? " (connect one first)" : ""}</option>
                ))}
              </select>
            )}
            <span className="ml-auto flex">
              <button type="button" className={smallBtn} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}>↑</button>
              <button type="button" className={smallBtn} disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label={`Move step ${i + 1} down`}>↓</button>
              <button type="button" className={`${smallBtn} hover:text-(--danger)`} onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}: ${describeStep(design, s)}`}>✕</button>
            </span>
          </div>
          {s.type === "data" && (() => {
            const ents = entitiesOf(s.target);
            const entity = ents.find((e) => e.name === s.entity);
            return (
              <>
                <select aria-label="Entity" aria-invalid={!entity} className={`${inputCls} h-7`} value={s.entity} onChange={(e) => set(i, { ...s, entity: e.target.value })}>
                  {!entity && <option value={s.entity}>{s.entity ? `${s.entity} — not on this store!` : "— define an entity on this store first —"}</option>}
                  {ents.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
                </select>
                <DataOpEditor op={s.op} entity={entity} onChange={(op) => set(i, { ...s, op })} />
              </>
            );
          })()}
          {"timeoutUs" in s && <UnitField label="Timeout" kind="duration" value={s.timeoutUs} onCommit={(v) => set(i, { ...s, timeoutUs: Math.max(1, v!) })} />}
          {s.type === "call" && (
            <div className="flex flex-wrap gap-x-4">
              <Check label="Cancel callee on timeout" checked={!!s.cancelOnTimeout} onChange={(v) => set(i, { ...s, cancelOnTimeout: v || undefined })} />
              <Check label="Propagate deadline" checked={!!s.propagateDeadline} onChange={(v) => set(i, { ...s, propagateDeadline: v || undefined })} />
            </div>
          )}
          {(s.type === "call" || s.type === "data") && <RetryEditor value={s.retry} onChange={(retry) => set(i, { ...s, retry })} />}
          {s.type === "publish" && <Check label="Ordered by key (one partition per key)" checked={s.orderedByKey} onChange={(v) => set(i, { ...s, orderedByKey: v })} />}
          {s.type === "branch" && s.cond.kind === "prob" && (
            <UnitField label="p" kind="fraction" value={s.cond.p} onCommit={(v) => set(i, { ...s, cond: { kind: "prob", p: v! } })} />
          )}
          {s.type === "branch" && s.cond.kind === "leaderAlive" && targetSelect(s.cond.store, leaders, (store) => set(i, { ...s, cond: { kind: "leaderAlive", store } }), "Store")}
          {s.type === "branch" && s.cond.kind === "breakerClosed" && targetSelect(s.cond.breaker, breakers, (breaker) => set(i, { ...s, cond: { kind: "breakerClosed", breaker } }), "Breaker")}
          {s.type === "branch" && (
            <div className="flex flex-col gap-1.5 pl-1">
              <p className="text-xs text-(--success)">then</p>
              <StepList steps={s.then} design={design} owner={owner} depth={depth + 1} onChange={(then) => set(i, { ...s, then })} />
              <p className="text-xs text-(--warning)">else</p>
              <StepList steps={s.else} design={design} owner={owner} depth={depth + 1} onChange={(els) => set(i, { ...s, else: els })} />
            </div>
          )}
          {s.type === "parallel" && (
            <div className="flex flex-col gap-1.5 pl-1">
              <JoinEditor join={s.join} branches={s.branches.length} onChange={(join) => set(i, { ...s, join })} />
              <Check label="Cancel the losers once the join is met" checked={s.cancelLosers} onChange={(v) => set(i, { ...s, cancelLosers: v })} />
              {s.branches.map((b, k) => (
                <div key={k} className="flex flex-col gap-1">
                  <p className="flex items-center text-xs text-(--accent-2)">
                    branch {k + 1}
                    <button type="button" className={`${smallBtn} ml-auto hover:text-(--danger)`} disabled={s.branches.length <= 1} onClick={() => set(i, { ...s, branches: s.branches.filter((_, j) => j !== k) })} aria-label={`Remove branch ${k + 1}`}>✕</button>
                  </p>
                  <StepList steps={b} design={design} owner={owner} depth={depth + 1} onChange={(nb) => set(i, { ...s, branches: s.branches.map((x, j) => (j === k ? nb : x)) })} />
                </div>
              ))}
              <button type="button" className={`${smallBtn} self-start border border-(--border)`} onClick={() => set(i, { ...s, branches: [...s.branches, []] })}>+ Add branch</button>
            </div>
          )}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <select aria-label="New step type" className={`${inputCls} h-7 w-44`} value={adding} onChange={(e) => setAdding(e.target.value as Step["type"])}>
          {(Object.keys(NEW_STEP) as Step["type"][]).map((t) => (
            <option key={t} value={t} disabled={!make(t)}>{NEW_STEP[t]}{!make(t) ? " (connect a target first)" : ""}</option>
          ))}
        </select>
        <button type="button" className={`${smallBtn} border border-(--border)`} disabled={!make(adding)} onClick={() => onChange([...steps, make(adding)!])}>
          + Add step
        </button>
      </li>
    </ol>
  );
}

export function RouteEditor({ node, design }: { node: NodeSpec; design: Design }) {
  const api = useDesignApi();
  const rewritten = useDesign((s) => s.rewritten);
  return (
    <section className="flex flex-col gap-3">
      <h3 className={sectionTitle}>Routes (what this {node.kind === "worker" ? "worker does per message" : "service does per endpoint"})</h3>
      <p className="text-xs text-(--text-muted)">Targets come from this component&apos;s outgoing connections — draw an arrow to offer a new one.</p>
      {design.endpoints.map((ep) => {
        const hot = rewritten.some((r) => r.owner === node.id && r.endpointId === ep.id);
        return (
          <div key={ep.id} className={`flex flex-col gap-2 rounded-(--radius-sm) border p-2 ${hot ? "border-(--accent) bg-[color-mix(in_oklab,var(--accent)_6%,transparent)]" : "border-(--border)"}`}>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono text-xs">{ep.name}</span>
              <span className="rounded-full border border-(--border) px-1.5 text-[10px] uppercase text-(--text-muted)">{ep.op}</span>
              {hot && (
                <button type="button" className="ml-auto min-h-6 text-xs text-(--accent) underline" onClick={() => api.getState().setRewritten(rewritten.filter((r) => !(r.owner === node.id && r.endpointId === ep.id)))}>
                  ✓ Rewritten by an insertion rule — mark reviewed
                </button>
              )}
            </p>
            <StepList
              steps={node.handlers?.[ep.id] ?? []}
              design={design}
              owner={node}
              onChange={(steps) => api.getState().commit((d) => updateNode(d, node.id, (n) => ({ ...n, handlers: { ...n.handlers, [ep.id]: steps } }) as NodeSpec))}
            />
          </div>
        );
      })}
    </section>
  );
}
