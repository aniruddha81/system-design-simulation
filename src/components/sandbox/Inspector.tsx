"use client";
// Inspector: typed, unit-aware fields; endpoint editor; route (handler) step editor (§8, §8A).
import { useId, useState } from "react";
import type { ComponentKind, Design, Dist, EdgeSpec, EndpointSpec, NodeSpec, Status, Step } from "@/engine/types";
import { describeStep, getIn, nextId, reachableTargets, setIn, updateEdge, updateNode } from "./design-ops";
import { useDesign, useDesignApi } from "./design-store";
import { KIND_COLOR, KIND_LABEL, KindIcon } from "./kinds";
import { DEFAULT_UNIT, parseUnit, toUnit, type UnitKind } from "./units";
import type { DeleteRequest } from "./Whiteboard";

export const inputCls =
  "h-8 w-full rounded-(--radius-sm) border border-(--border) bg-(--bg) px-2 text-sm text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent) aria-invalid:border-(--danger)";
const smallBtn =
  "grid h-7 min-w-7 place-items-center rounded-(--radius-sm) px-1.5 text-xs text-(--text-muted) hover:bg-(--surface-2) hover:text-(--text) focus-visible:outline-2 focus-visible:outline-(--accent) disabled:opacity-40";

// ---------- fields ----------

export function UnitField({ label, value, kind, unit = DEFAULT_UNIT[kind], optional, onCommit, hint }: {
  label: string; value: number | undefined; kind: UnitKind; unit?: string; optional?: boolean; hint?: string;
  onCommit: (v: number | undefined) => void;
}) {
  const fmt = (v: number | undefined) => (v === undefined ? "" : toUnit(v, kind, unit));
  const [text, setText] = useState(fmt(value));
  const [synced, setSynced] = useState(value);
  const [error, setError] = useState<string | null>(null);
  if (value !== synced) {
    // External change (undo, insertion rule): show the new value.
    setSynced(value);
    setText(fmt(value));
    setError(null);
  }
  const id = useId();
  function commit() {
    if (optional && text.trim() === "") return onCommit(undefined);
    const r = parseUnit(text, kind, unit);
    if (!r.ok) return setError(r.error); // keep the last valid value in the design
    setError(null);
    if (r.value === value) setText(fmt(value));
    else onCommit(r.value);
  }
  return (
    <div className="grid grid-cols-[minmax(0,9rem)_1fr] items-start gap-x-3 gap-y-1">
      <label htmlFor={id} className="pt-1.5 text-xs text-(--text-muted)">{label}</label>
      <div>
        <div className="relative">
          <input
            id={id}
            value={text}
            inputMode="decimal"
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-err` : undefined}
            placeholder={optional ? "none" : undefined}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            className={`${inputCls} pr-12 tabular-nums`}
          />
          {unit && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-(--text-muted)">{unit}</span>}
        </div>
        {error ? (
          <p id={`${id}-err`} className="mt-1 text-xs text-(--danger)">⚠ {error}. Kept {fmt(value) || "none"} {unit}.</p>
        ) : hint ? <p className="mt-1 text-xs text-(--text-muted)">{hint}</p> : null}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[minmax(0,9rem)_1fr] items-center gap-x-3">
      <span className="text-xs text-(--text-muted)">{label}</span>
      {children}
    </label>
  );
}

function DistField({ label, value, onCommit }: { label: string; value: Dist; onCommit: (d: Dist) => void }) {
  const center = value.kind === "constant" ? value.us : value.kind === "exponential" ? value.meanUs : value.kind === "lognormal" ? value.medianUs : value.buckets[0]?.us ?? 1000;
  return (
    <fieldset className="flex flex-col gap-2 rounded-(--radius-sm) border border-(--border) p-2.5">
      <legend className="px-1 text-xs text-(--text)">{label}</legend>
      <Row label="Shape">
        <select
          className={inputCls}
          value={value.kind}
          onChange={(e) => {
            const k = e.target.value as Dist["kind"];
            onCommit(k === "constant" ? { kind: k, us: center } : k === "exponential" ? { kind: k, meanUs: center } : k === "lognormal" ? { kind: k, medianUs: center, sigma: 0.5 } : { kind: k, buckets: [{ us: center, weight: 1 }] });
          }}
        >
          <option value="constant">Constant</option>
          <option value="exponential">Exponential</option>
          <option value="lognormal">Log-normal (long tail)</option>
          <option value="empirical">Empirical</option>
        </select>
      </Row>
      {value.kind === "constant" && <UnitField label="Time" kind="duration" value={value.us} onCommit={(v) => onCommit({ ...value, us: Math.max(1, v!) })} />}
      {value.kind === "exponential" && <UnitField label="Mean" kind="duration" value={value.meanUs} onCommit={(v) => onCommit({ ...value, meanUs: Math.max(1, v!) })} />}
      {value.kind === "lognormal" && (
        <>
          <UnitField label="Median" kind="duration" value={value.medianUs} onCommit={(v) => onCommit({ ...value, medianUs: Math.max(1, v!) })} />
          <UnitField label="Spread σ" kind="number" value={value.sigma} hint="0 = no variation, 1 = heavy tail" onCommit={(v) => onCommit({ ...value, sigma: v! })} />
        </>
      )}
      {value.kind === "empirical" && <p className="text-xs text-(--text-muted)">{value.buckets.length} buckets (edit by importing a design file).</p>}
    </fieldset>
  );
}

type FieldDef =
  | { path: string[]; label: string; type: UnitKind; unit?: string; optional?: boolean; hint?: string }
  | { path: string[]; label: string; type: "text" | "bool" | "dist" | "entry" }
  | { path: string[]; label: string; type: "select"; options: [string, string][] };

const QUEUE: FieldDef[] = [
  { path: ["concurrency"], label: "Workers", type: "count" },
  { path: ["queueCapacity"], label: "Queue slots", type: "count", hint: "When full, new requests get 503" },
  { path: ["queueDiscipline"], label: "Queue order", type: "select", options: [["fifo", "FIFO"], ["lifo", "LIFO"]] },
  { path: ["costPerHour"], label: "Cost / hour", type: "money" },
  { path: ["region"], label: "Region", type: "text" },
  { path: ["zone"], label: "Zone", type: "text" },
];

const FIELDS: Record<ComponentKind, FieldDef[]> = {
  client: [{ path: ["entry"], label: "Sends traffic to", type: "entry" }],
  loadBalancer: [
    { path: ["algorithm"], label: "Algorithm", type: "select", options: [["roundRobin", "Round robin"], ["leastConnections", "Least connections"], ["p2c", "Power of two choices"], ["consistentHash", "Consistent hash"]] },
    { path: ["serviceTime"], label: "Service time", type: "dist" },
    { path: ["healthCheck", "intervalUs"], label: "Health-check every", type: "duration" },
    { path: ["healthCheck", "unhealthyThreshold"], label: "Unhealthy after", type: "count", hint: "failed checks" },
    { path: ["healthCheck", "healthyThreshold"], label: "Healthy after", type: "count", hint: "passed checks" },
    ...QUEUE,
  ],
  service: [{ path: ["serviceTime"], label: "Service time", type: "dist" }, ...QUEUE],
  cache: [
    { path: ["capacityBytes"], label: "Memory", type: "bytes" },
    { path: ["eviction"], label: "Eviction", type: "select", options: [["lru", "LRU"], ["lfu", "LFU"]] },
    { path: ["ttlUs"], label: "TTL", type: "duration", unit: "s", optional: true, hint: "Empty = entries never expire" },
    { path: ["coalesce"], label: "Coalesce concurrent misses", type: "bool" },
    { path: ["serviceTime"], label: "Service time", type: "dist" },
    ...QUEUE,
  ],
  database: [
    { path: ["readTime"], label: "Read time", type: "dist" },
    { path: ["writeTime"], label: "Write time", type: "dist" },
    { path: ["replicas"], label: "Replicas", type: "count", hint: "P1: adds capacity only" },
    ...QUEUE,
  ],
  rateLimiter: [
    { path: ["algorithm"], label: "Algorithm", type: "select", options: [["tokenBucket", "Token bucket"], ["leakyBucket", "Leaky bucket"], ["fixedWindow", "Fixed window"], ["slidingWindow", "Sliding window"]] },
    { path: ["ratePerSec"], label: "Rate", type: "rate" },
    { path: ["burst"], label: "Burst", type: "count" },
    { path: ["serviceTime"], label: "Service time", type: "dist" },
    ...QUEUE,
  ],
};

const EDGE_FIELDS: FieldDef[] = [
  { path: ["latency"], label: "One-way latency", type: "dist" },
  { path: ["bandwidthBytesPerSec"], label: "Bandwidth / s", type: "bytes" },
  { path: ["lossRate"], label: "Packet loss", type: "fraction", hint: "e.g. 0.1% or 0.001" },
];

function Fields({ defs, obj, design, ownerId, onSet }: {
  defs: FieldDef[]; obj: unknown; design: Design; ownerId: string; onSet: (path: string[], v: unknown, key?: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {defs.map((f) => {
        const v = getIn(obj, f.path);
        const k = f.path.join(".");
        switch (f.type) {
          case "dist": return <DistField key={k} label={f.label} value={v as Dist} onCommit={(d) => onSet(f.path, d)} />;
          case "bool":
            return (
              <label key={k} className="flex min-h-8 items-center gap-2 text-sm text-(--text)">
                <input type="checkbox" className="size-4 accent-(--accent)" checked={!!v} onChange={(e) => onSet(f.path, e.target.checked)} />
                {f.label}
              </label>
            );
          case "text":
            return (
              <Row key={k} label={f.label}>
                <input className={inputCls} value={String(v ?? "")} onChange={(e) => onSet(f.path, e.target.value, `${ownerId}.${k}`)} />
              </Row>
            );
          case "select":
            return (
              <Row key={k} label={f.label}>
                <select className={inputCls} value={String(v)} onChange={(e) => onSet(f.path, e.target.value)}>
                  {f.options.map(([val, text]) => <option key={val} value={val}>{text}</option>)}
                </select>
              </Row>
            );
          case "entry": {
            const targets = reachableTargets(design, ownerId);
            return (
              <Row key={k} label={f.label}>
                <select className={inputCls} value={String(v)} aria-invalid={!targets.some((t) => t.id === v)} onChange={(e) => onSet(f.path, e.target.value)}>
                  <option value="">— connect the client first —</option>
                  {targets.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </Row>
            );
          }
          default:
            return <UnitField key={k} label={f.label} kind={f.type} unit={f.unit} optional={f.optional} hint={f.hint} value={v as number | undefined} onCommit={(n) => onSet(f.path, n)} />;
        }
      })}
    </div>
  );
}

// ---------- route editor ----------

const STATUSES: Status[] = [200, 201, 404, 409, 429, 503, 504];
const NEW_STEP: Record<Step["type"], string> = {
  call: "Call", cacheGet: "Cache get", cacheSet: "Cache set", cacheDelete: "Cache delete", branch: "Branch", respond: "Respond",
};

function StepList({ steps, design, owner, onChange, depth = 0 }: {
  steps: Step[]; design: Design; owner: NodeSpec; onChange: (s: Step[]) => void; depth?: number;
}) {
  const reach = reachableTargets(design, owner.id);
  const caches = reach.filter((n) => n.kind === "cache");
  const callable = reach.filter((n) => n.kind !== "cache");
  const [adding, setAdding] = useState<Step["type"]>("call");
  const set = (i: number, s: Step) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, by: number) => {
    const next = [...steps];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onChange(next);
  };
  const make = (t: Step["type"]): Step | null => {
    switch (t) {
      case "call": return callable[0] ? { type: t, target: callable[0].id, timeoutUs: 200_000 } : null;
      case "cacheGet": case "cacheSet": case "cacheDelete": return caches[0] ? { type: t, cache: caches[0].id, timeoutUs: 50_000 } : null;
      case "branch": return { type: t, cond: { kind: "cacheHit" }, then: [], else: [] };
      case "respond": return { type: t, status: 200 };
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
            {s.type === "respond" && (
              <select aria-label="Status" className={`${inputCls} h-7 w-24`} value={s.status} onChange={(e) => set(i, { ...s, status: Number(e.target.value) as Status })}>
                {STATUSES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            {s.type === "branch" && (
              <select
                aria-label="Condition"
                className={`${inputCls} h-7 min-w-0 flex-1`}
                value={s.cond.kind}
                onChange={(e) => set(i, { ...s, cond: e.target.value === "prob" ? { kind: "prob", p: 0.5 } : { kind: "cacheHit" } })}
              >
                <option value="cacheHit">if the last cache get hit</option>
                <option value="prob">with probability p</option>
              </select>
            )}
            <span className="ml-auto flex">
              <button type="button" className={smallBtn} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}>↑</button>
              <button type="button" className={smallBtn} disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label={`Move step ${i + 1} down`}>↓</button>
              <button type="button" className={`${smallBtn} hover:text-(--danger)`} onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}: ${describeStep(design, s)}`}>✕</button>
            </span>
          </div>
          {"timeoutUs" in s && (
            <UnitField label="Timeout" kind="duration" value={s.timeoutUs} onCommit={(v) => set(i, { ...s, timeoutUs: Math.max(1, v!) })} />
          )}
          {s.type === "branch" && s.cond.kind === "prob" && (
            <UnitField label="p" kind="fraction" value={s.cond.p} onCommit={(v) => set(i, { ...s, cond: { kind: "prob", p: v! } })} />
          )}
          {s.type === "branch" && (
            <div className="flex flex-col gap-1.5 pl-1">
              <p className="text-xs text-(--success)">then</p>
              <StepList steps={s.then} design={design} owner={owner} depth={depth + 1} onChange={(then) => set(i, { ...s, then })} />
              <p className="text-xs text-(--warning)">else</p>
              <StepList steps={s.else} design={design} owner={owner} depth={depth + 1} onChange={(els) => set(i, { ...s, else: els })} />
            </div>
          )}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <select aria-label="New step type" className={`${inputCls} h-7 w-36`} value={adding} onChange={(e) => setAdding(e.target.value as Step["type"])}>
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

function RouteEditor({ node, design }: { node: NodeSpec; design: Design }) {
  const api = useDesignApi();
  const rewritten = useDesign((s) => s.rewritten);
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-(--text-muted)">Routes (what this service does per endpoint)</h3>
      <p className="text-xs text-(--text-muted)">Targets come from this service&apos;s outgoing connections — draw an arrow to offer a new one.</p>
      {design.endpoints.map((ep) => {
        const hot = rewritten.some((r) => r.owner === node.id && r.endpointId === ep.id);
        return (
          <div key={ep.id} className={`flex flex-col gap-2 rounded-(--radius-sm) border p-2 ${hot ? "border-(--accent)" : "border-(--border)"}`}>
            <p className="flex items-center gap-2 text-sm">
              <span className="font-mono text-xs">{ep.name}</span>
              <span className="rounded-full border border-(--border) px-1.5 text-[10px] uppercase text-(--text-muted)">{ep.op}</span>
              {hot && (
                <button type="button" className="ml-auto text-xs text-(--accent) underline" onClick={() => api.getState().setRewritten(rewritten.filter((r) => !(r.owner === node.id && r.endpointId === ep.id)))}>
                  ✓ Rewritten to cache-aside — mark reviewed
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

// ---------- endpoints (design-level) ----------

function EndpointEditor({ design }: { design: Design }) {
  const { commit, endGesture } = useDesignApi().getState();
  const set = (id: string, fn: (e: EndpointSpec) => EndpointSpec, key?: string) =>
    commit((d) => ({ ...d, endpoints: d.endpoints.map((e) => (e.id === id ? fn(e) : e)) }), key);
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-(--text-muted)">Endpoints</h3>
      {design.endpoints.map((ep) => (
        <fieldset key={ep.id} className="flex flex-col gap-2 rounded-(--radius-sm) border border-(--border) p-2.5">
          <legend className="px-1 font-mono text-xs text-(--text-muted)">{ep.id}</legend>
          <Row label="Name"><input className={inputCls} value={ep.name} onBlur={endGesture} onChange={(e) => set(ep.id, (x) => ({ ...x, name: e.target.value }), `ep.name.${ep.id}`)} /></Row>
          <Row label="Operation">
            <select className={inputCls} value={ep.op} onChange={(e) => set(ep.id, (x) => ({ ...x, op: e.target.value as "read" | "write" }))}>
              <option value="read">Read</option><option value="write">Write</option>
            </select>
          </Row>
          <Row label="Key template"><input className={`${inputCls} font-mono`} value={ep.keyTemplate} onBlur={endGesture} onChange={(e) => set(ep.id, (x) => ({ ...x, keyTemplate: e.target.value }), `ep.key.${ep.id}`)} /></Row>
          <UnitField label="Request size" kind="bytes" unit="B" value={ep.requestBytes} onCommit={(v) => set(ep.id, (x) => ({ ...x, requestBytes: v! }))} />
          <UnitField label="Response size" kind="bytes" unit="B" value={ep.responseBytes} onCommit={(v) => set(ep.id, (x) => ({ ...x, responseBytes: v! }))} />
          <label className="flex min-h-8 items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-(--accent)" checked={ep.idempotent} onChange={(e) => set(ep.id, (x) => ({ ...x, idempotent: e.target.checked }))} />
            Idempotent (safe to retry)
          </label>
          <button type="button" className={`${smallBtn} self-start hover:text-(--danger)`} onClick={() => commit((d) => ({ ...d, endpoints: d.endpoints.filter((e) => e.id !== ep.id) }))}>
            Remove endpoint
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="h-8 self-start rounded-(--radius-sm) border border-(--border) px-3 text-sm hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)"
        onClick={() => commit((d) => {
          const id = nextId(d.endpoints.map((e) => e.id), "endpoint");
          return { ...d, endpoints: [...d.endpoints, { id, name: `GET /${id}/:id`, op: "read", keyTemplate: `${id}:{id}`, requestBytes: 128, responseBytes: 1024, idempotent: true }] };
        })}
      >
        + Add endpoint
      </button>
      <p className="text-xs text-(--text-muted)">The scenario&apos;s traffic mix decides how often each endpoint is called.</p>
    </section>
  );
}

// ---------- inspector ----------

export function Inspector({ requestDelete }: { requestDelete: (r: DeleteRequest) => void }) {
  const design = useDesign((s) => s.design);
  const selection = useDesign((s) => s.selection);
  const { commit, endGesture } = useDesignApi().getState();
  const node = selection?.kind === "node" ? design.nodes.find((n) => n.id === selection.id) : undefined;
  const edge = selection?.kind === "edge" ? design.edges.find((e) => e.id === selection.id) : undefined;

  if (node) {
    return (
      <div className="flex flex-col gap-5" onBlur={endGesture}>
        <header className="flex items-center gap-2">
          <span style={{ color: KIND_COLOR[node.kind] }}><KindIcon kind={node.kind} /></span>
          <input
            aria-label="Component name"
            className={`${inputCls} text-base font-medium`}
            value={node.label}
            onChange={(e) => commit((d) => updateNode(d, node.id, (n) => ({ ...n, label: e.target.value })), `label:${node.id}`)}
          />
        </header>
        <p className="-mt-3 text-xs text-(--text-muted)">{KIND_LABEL[node.kind]} · <span className="font-mono">{node.id}</span></p>
        <Fields
          defs={FIELDS[node.kind]}
          obj={node.params}
          design={design}
          ownerId={node.id}
          onSet={(path, v, key) => commit((d) => updateNode(d, node.id, (n) => ({ ...n, params: setIn(n.params, path, v) }) as NodeSpec), key)}
        />
        {node.kind === "service" && <RouteEditor node={node} design={design} />}
        <button type="button" className="h-8 self-start rounded-(--radius-sm) border border-(--border) px-3 text-sm text-(--danger) hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)" onClick={() => requestDelete({ nodeIds: [node.id] })}>
          Delete component
        </button>
      </div>
    );
  }
  if (edge) {
    const name = (id: string) => design.nodes.find((n) => n.id === id)?.label ?? id;
    return (
      <div className="flex flex-col gap-5">
        <header>
          <h2 className="text-base font-medium">{name(edge.from)} → {name(edge.to)}</h2>
          <p className="text-xs text-(--text-muted)">Connection: {name(edge.from)} may call {name(edge.to)}.</p>
        </header>
        <Fields defs={EDGE_FIELDS} obj={edge} design={design} ownerId={edge.id} onSet={(path, v) => commit((d) => updateEdge(d, edge.id, (e) => setIn<EdgeSpec>(e, path, v)))} />
        <button type="button" className="h-8 self-start rounded-(--radius-sm) border border-(--border) px-3 text-sm text-(--danger) hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-(--accent)" onClick={() => requestDelete({ edgeIds: [edge.id] })}>
          Delete connection
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-(--text-muted)">Select a component or connection to edit it. Design-wide settings:</p>
      <EndpointEditor design={design} />
    </div>
  );
}
