"use client";
// Inspector: typed, unit-aware fields for every component kind; endpoints, data model, regions (§8, §8A).
import { useId } from "react";
import type { ComponentKind, Design, Dist, EdgeSpec, EndpointSpec, FailoverParams, NodeSpec, RegionMatrix } from "@/engine/types";
import { InputsEditor, ResponseFieldsEditor, EntitiesEditor } from "./DataModel";
import { getIn, HANDLER_KINDS, nextId, placeNames, reachableTargets, setIn, STORE_KINDS, updateEdge, updateNode } from "./design-ops";
import { useDesign, useDesignApi } from "./design-store";
import { btn, Check, DistField, inputCls, Row, sectionTitle, smallBtn, UnitField } from "./fields";
import { KIND_LABEL, KindSwatch, Legend } from "./kinds";
import { RouteEditor } from "./RouteEditor";
import type { UnitKind } from "./units";
import type { DeleteRequest } from "./Whiteboard";

export { inputCls, UnitField } from "./fields";

// ---------- data-driven fields ----------

type Base = { path: string[]; label: string; hint?: string };
type FieldDef = Base & (
  | { type: UnitKind; unit?: string; optional?: boolean; slider?: [number, number] }
  | { type: "text" | "entry" | "place" }
  | { type: "bool"; dflt?: boolean }
  | { type: "dist"; optional?: Dist }
  | { type: "select"; options: [string, string][]; optional?: boolean }
  | { type: "nodeRef" | "nodeRefs"; kinds?: ComponentKind[]; reachable?: boolean }
  | { type: "group"; fields: FieldDef[]; make: () => unknown }
);

const ms = (x: number) => x * 1000;
const QUEUE: FieldDef[] = [
  { path: ["concurrency"], label: "Workers", type: "count", slider: [1, 256] },
  { path: ["queueCapacity"], label: "Queue slots", type: "count", hint: "When full, new requests get 503" },
  { path: ["queueDiscipline"], label: "Queue order", type: "select", options: [["fifo", "FIFO"], ["lifo", "LIFO"]] },
  { path: ["costPerHour"], label: "Cost / hour", type: "money" },
  { path: ["restartWarmupUs"], label: "Restart warm-up", type: "duration", optional: true, hint: "Time spent restarting after a kill ends" },
  { path: ["region"], label: "Region", type: "place" },
  { path: ["zone"], label: "Zone", type: "place" },
];
const PLACE: FieldDef[] = QUEUE.slice(-2);
const sec = (path: string, label: string, hint?: string): FieldDef => ({ path: [path], label, type: "duration", unit: "s", hint });
const count = (path: string, label: string, hint?: string): FieldDef => ({ path: [path], label, type: "count", hint });
const dist = (path: string, label: string): FieldDef => ({ path: [path], label, type: "dist" });
const bool = (path: string, label: string, dflt?: boolean): FieldDef => ({ path: [path], label, type: "bool", dflt });
const EVICTION: FieldDef = { path: ["eviction"], label: "Eviction", type: "select", options: [["lru", "LRU"], ["lfu", "LFU"]] };
const FAILOVER_DEFAULT: FailoverParams = { heartbeatUs: ms(500), missedHeartbeats: 3, electionUs: ms(1000), fencing: true };

const FIELDS: Record<ComponentKind, FieldDef[]> = {
  client: [{ path: ["entry"], label: "Sends traffic to", type: "entry" }],
  loadBalancer: [
    { path: ["algorithm"], label: "Algorithm", type: "select", options: [["roundRobin", "Round robin"], ["leastConnections", "Least connections"], ["p2c", "Power of two choices"], ["consistentHash", "Consistent hash"]] },
    dist("serviceTime", "Service time"),
    { path: ["healthCheck", "intervalUs"], label: "Health-check every", type: "duration" },
    { path: ["healthCheck", "unhealthyThreshold"], label: "Unhealthy after", type: "count", hint: "failed checks" },
    { path: ["healthCheck", "healthyThreshold"], label: "Healthy after", type: "count", hint: "passed checks" },
    ...QUEUE,
  ],
  service: [dist("serviceTime", "Service time"), ...QUEUE],
  cache: [
    { path: ["capacityBytes"], label: "Memory", type: "bytes" }, EVICTION,
    { path: ["ttlUs"], label: "TTL", type: "duration", unit: "s", optional: true, hint: "Empty = entries never expire" },
    bool("coalesce", "Coalesce concurrent misses"), dist("serviceTime", "Service time"), ...QUEUE,
  ],
  database: [
    dist("readTime", "Read time"), dist("writeTime", "Write time"),
    count("replicas", "Replicas"),
    { path: ["replication"], label: "Replication", type: "select", optional: true, options: [["sync", "Synchronous"], ["semiSync", "Semi-synchronous"], ["async", "Asynchronous"]], hint: "Off = replicas add capacity only" },
    { path: ["replicationLag"], label: "Replication lag", type: "dist", optional: { kind: "lognormal", medianUs: ms(50), sigma: 0.5 } },
    bool("readFromReplicas", "Read from replicas (read/write split)"),
    bool("walDurable", "Committed WAL survives a kill", true),
    { path: ["connectionPool"], label: "Connection pool", type: "count", optional: true, hint: "Empty = unlimited; excess waits" },
    {
      path: ["failover"], label: "Automatic failover", type: "group", make: () => FAILOVER_DEFAULT,
      fields: [
        { path: ["heartbeatUs"], label: "Heartbeat every", type: "duration" },
        count("missedHeartbeats", "Detect after", "missed heartbeats"),
        { path: ["electionUs"], label: "Election takes", type: "duration" },
        bool("fencing", "Fence the old leader (prevents split brain)"),
      ],
    },
    ...QUEUE,
  ],
  rateLimiter: [
    { path: ["algorithm"], label: "Algorithm", type: "select", options: [["tokenBucket", "Token bucket"], ["leakyBucket", "Leaky bucket"], ["fixedWindow", "Fixed window"], ["slidingWindow", "Sliding window"]] },
    { path: ["ratePerSec"], label: "Rate", type: "rate" },
    count("burst", "Burst"),
    bool("centralised", "Centralised state (shared, one extra round trip)"),
    dist("serviceTime", "Service time"), ...QUEUE,
  ],
  dns: [
    dist("resolutionTime", "Resolution time"), sec("ttlUs", "TTL"),
    { path: ["records"], label: "Records (first = primary)", type: "nodeRefs", reachable: true, hint: "Connect DNS to a component to add it" },
  ],
  cdn: [
    { path: ["capacityBytes"], label: "Memory per region", type: "bytes" }, EVICTION,
    { path: ["ttlUs"], label: "TTL", type: "duration", unit: "s", optional: true },
    bool("originShield", "Origin shield"), { path: ["costPerGB"], label: "Egress $ / GB", type: "money" },
    dist("serviceTime", "Service time"), ...QUEUE,
  ],
  apiGateway: [
    dist("serviceTime", "Auth latency"),
    { path: ["maxRequestBytes"], label: "Max request size", type: "bytes", unit: "KB", hint: "Larger requests are rejected" },
    ...QUEUE,
  ],
  kvStore: [
    dist("readTime", "Read time"), dist("writeTime", "Write time"),
    { path: ["members"], label: "Ring members", type: "count", slider: [1, 32], hint: "Adding or removing members rebalances" },
    count("vnodes", "Virtual nodes", "per member"),
    count("replicationFactor", "Replication factor N"), count("readQuorum", "Read quorum R"), count("writeQuorum", "Write quorum W"),
    bool("hintedHandoff", "Hinted handoff"), bool("readRepair", "Read repair"), sec("tombstoneGcUs", "Tombstone GC after"),
    ...QUEUE,
  ],
  queue: [
    count("partitions", "Partitions"),
    count("capacityMessages", "Capacity", "messages; publish gets 503 when full"),
    sec("visibilityTimeoutUs", "Visibility timeout", "Unacked messages reappear after this"),
    count("maxDeliveries", "Max deliveries", "then the dead-letter queue"),
    { path: ["retentionUs"], label: "Retention", type: "duration", unit: "h" },
    dist("publishTime", "Publish time"),
    { path: ["costPerHour"], label: "Cost / hour", type: "money" }, ...PLACE,
  ],
  worker: [
    { path: ["source"], label: "Consumes from", type: "nodeRef", kinds: ["queue"] },
    count("batchSize", "Batch size"), dist("serviceTime", "Service time"), ...QUEUE,
  ],
  objectStore: [
    dist("readTime", "Read time"), dist("writeTime", "Write time"),
    { path: ["costPerGBMonth"], label: "$ / GB-month", type: "money" }, { path: ["costPerMillionRequests"], label: "$ / million requests", type: "money" },
    ...PLACE,
  ],
  searchIndex: [
    { path: ["source"], label: "Indexes", type: "nodeRef", kinds: ["database", "kvStore", "objectStore"] },
    dist("indexLag", "Index lag"), dist("serviceTime", "Query time"), ...QUEUE,
  ],
  dedupStore: [
    sec("ttlUs", "Remember keys for"), bool("atomic", "Atomic check-and-record"), bool("durable", "Survives a restart"),
    dist("serviceTime", "Service time"), ...QUEUE,
  ],
  autoscaler: [
    { path: ["targets"], label: "Scales", type: "nodeRefs", kinds: ["service", "worker"] },
    { path: ["metric"], label: "Metric", type: "select", options: [["utilisation", "Utilisation"], ["queueLength", "Queue length"]] },
    { path: ["targetValue"], label: "Target value", type: "number", hint: "Utilisation 0–1, or queued requests" },
    count("min", "Min workers"), count("max", "Max workers"),
    sec("evaluateEveryUs", "Evaluate every"), sec("cooldownUs", "Cooldown"), sec("provisionUs", "Provisioning delay"), sec("warmupUs", "Warm-up"),
  ],
  circuitBreaker: [
    { path: ["failureRateThreshold"], label: "Open at failure rate", type: "fraction" },
    sec("windowUs", "Window"), count("minRequests", "Min requests", "in the window before it can open"),
    sec("openUs", "Stay open for"), count("halfOpenProbes", "Half-open probes"),
    { path: ["bulkheadMax"], label: "Bulkhead", type: "count", optional: true, hint: "Max concurrent calls; empty = no limit" },
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
  const listId = useId();
  const places = placeNames(design);
  const nodeOptions = (f: { kinds?: ComponentKind[]; reachable?: boolean }) =>
    (f.reachable ? reachableTargets(design, ownerId) : design.nodes).filter((n) => n.id !== ownerId && (!f.kinds || f.kinds.includes(n.kind)));
  return (
    <div className="flex flex-col gap-2.5">
      <datalist id={`${listId}-region`}>{places.regions.map((r) => <option key={r} value={r} />)}</datalist>
      <datalist id={`${listId}-zone`}>{places.zones.map((z) => <option key={z} value={z} />)}</datalist>
      {defs.map((f) => {
        const v = getIn(obj, f.path);
        const k = f.path.join(".");
        switch (f.type) {
          case "dist":
            if (f.optional) {
              return (
                <div key={k} className="flex flex-col gap-1.5">
                  <Check label={f.label} checked={v !== undefined} onChange={(on) => onSet(f.path, on ? f.optional : undefined)} />
                  {v !== undefined && <DistField label={f.label} value={v as Dist} onCommit={(d) => onSet(f.path, d)} />}
                </div>
              );
            }
            return <DistField key={k} label={f.label} value={v as Dist} onCommit={(d) => onSet(f.path, d)} />;
          case "bool":
            return <Check key={k} label={f.label} checked={v === undefined ? !!f.dflt : !!v} onChange={(on) => onSet(f.path, on)} />;
          case "text":
          case "place":
            return (
              <Row key={k} label={f.label}>
                <input className={inputCls} list={f.type === "place" ? `${listId}-${k}` : undefined} value={String(v ?? "")} onChange={(e) => onSet(f.path, e.target.value, `${ownerId}.${k}`)} />
              </Row>
            );
          case "select":
            return (
              <Row key={k} label={f.label}>
                <select className={inputCls} value={String(v ?? "")} onChange={(e) => onSet(f.path, e.target.value || undefined)}>
                  {f.optional && <option value="">Off</option>}
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
          case "nodeRef": {
            const opts = nodeOptions(f);
            return (
              <Row key={k} label={f.label}>
                <select className={inputCls} value={String(v ?? "")} aria-invalid={!opts.some((t) => t.id === v)} onChange={(e) => onSet(f.path, e.target.value)}>
                  <option value="">— none —</option>
                  {opts.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </Row>
            );
          }
          case "nodeRefs": {
            const list = (v as string[]) ?? [];
            const opts = nodeOptions(f);
            const name = (id: string) => design.nodes.find((n) => n.id === id)?.label ?? `${id} (deleted)`;
            return (
              <fieldset key={k} className="flex flex-col gap-1 rounded-(--radius-sm) border border-(--border) p-2.5">
                <legend className="px-1 text-xs text-(--text)">{f.label}</legend>
                <ol className="flex flex-col gap-1">
                  {list.map((id, i) => (
                    <li key={id} className="flex items-center gap-1 text-sm">
                      <span className="flex-1 truncate">{i + 1}. {name(id)}</span>
                      <button type="button" className={smallBtn} disabled={i === 0} onClick={() => onSet(f.path, [list[i], ...list.filter((_, j) => j !== i)])} aria-label={`Make ${name(id)} first`}>↑</button>
                      <button type="button" className={`${smallBtn} hover:text-(--danger)`} onClick={() => onSet(f.path, list.filter((x) => x !== id))} aria-label={`Remove ${name(id)}`}>✕</button>
                    </li>
                  ))}
                </ol>
                <select aria-label={`Add to ${f.label}`} className={`${inputCls} h-7`} value="" onChange={(e) => e.target.value && onSet(f.path, [...list, e.target.value])}>
                  <option value="">+ Add…</option>
                  {opts.filter((o) => !list.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                {f.hint && <p className="text-xs text-(--text-muted)">{f.hint}</p>}
              </fieldset>
            );
          }
          case "group":
            return (
              <div key={k} className="flex flex-col gap-1.5">
                <Check label={f.label} checked={v !== undefined} onChange={(on) => onSet(f.path, on ? f.make() : undefined)} />
                {v !== undefined && (
                  <div className="border-l border-(--border) pl-2.5">
                    <Fields defs={f.fields} obj={v} design={design} ownerId={ownerId} onSet={(p, x, key) => onSet([...f.path, ...p], x, key)} />
                  </div>
                )}
              </div>
            );
          default:
            return <UnitField key={k} label={f.label} kind={f.type} unit={f.unit} optional={f.optional} hint={f.hint} slider={f.slider} value={v as number | undefined} onCommit={(n) => onSet(f.path, n, f.slider ? `${ownerId}.${k}` : undefined)} />;
        }
      })}
    </div>
  );
}

// ---------- endpoints (design-level) ----------

function EndpointEditor({ design }: { design: Design }) {
  const { commit, endGesture } = useDesignApi().getState();
  const set = (id: string, fn: (e: EndpointSpec) => EndpointSpec, key?: string) =>
    commit((d) => ({ ...d, endpoints: d.endpoints.map((e) => (e.id === id ? fn(e) : e)) }), key);
  return (
    <section className="flex flex-col gap-3">
      <h3 className={sectionTitle}>Endpoints</h3>
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
          <InputsEditor ep={ep} onChange={(next) => set(ep.id, () => next)} />
          <UnitField label="Request size" kind="bytes" unit="B" value={ep.requestBytes} onCommit={(v) => set(ep.id, (x) => ({ ...x, requestBytes: v! }))} />
          <UnitField label="Response size" kind="bytes" unit="B" value={ep.responseBytes} onCommit={(v) => set(ep.id, (x) => ({ ...x, responseBytes: v! }))} />
          <ResponseFieldsEditor ep={ep} design={design} onChange={(next) => set(ep.id, () => next)} />
          <Check label="Idempotent (safe to retry)" checked={ep.idempotent} onChange={(v) => set(ep.id, (x) => ({ ...x, idempotent: v }))} />
          <button type="button" className={`${smallBtn} self-start hover:text-(--danger)`} onClick={() => commit((d) => ({ ...d, endpoints: d.endpoints.filter((e) => e.id !== ep.id) }))}>
            Remove endpoint
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className={`${btn} self-start`}
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

// ---------- regions (latency + egress between regions) ----------

/** Rebuild the matrix over `names`, keeping known pairs; unknown pairs default to 70 ms and $0.02/GB. */
export function matrixFor(names: string[], prev?: RegionMatrix): RegionMatrix {
  const at = (m: number[][] | undefined, a: string, b: string, dflt: number) => {
    const i = prev?.names.indexOf(a) ?? -1, j = prev?.names.indexOf(b) ?? -1;
    return i >= 0 && j >= 0 ? m![i][j] : a === b ? 0 : dflt;
  };
  return {
    names,
    latencyUs: names.map((a) => names.map((b) => at(prev?.latencyUs, a, b, 70_000))),
    egressCostPerGB: names.map((a) => names.map((b) => at(prev?.egressCostPerGB, a, b, 0.02))),
  };
}

function RegionsEditor({ design }: { design: Design }) {
  const { commit } = useDesignApi().getState();
  const names = placeNames(design).regions;
  const m = matrixFor(names, design.regions);
  const set = (field: "latencyUs" | "egressCostPerGB", i: number, j: number, v: number) => {
    const next = matrixFor(names, design.regions);
    next[field][i][j] = v;
    next[field][j][i] = v; // symmetric
    commit((d) => ({ ...d, regions: next }), `regions.${field}.${i}.${j}`);
  };
  return (
    <section className="flex flex-col gap-2">
      <h3 className={sectionTitle}>Regions</h3>
      {names.length < 2 ? (
        <p className="text-xs text-(--text-muted)">Everything is in {names[0] ?? "one region"}. Set a component&apos;s region to another name to add cross-region latency and egress cost.</p>
      ) : (
        <>
          <p className="text-xs text-(--text-muted)">One-way latency (ms) and egress ($/GB) added to calls that cross regions. Both directions share a value.</p>
          <div className="overflow-x-auto">
            <table className="text-xs tabular-nums">
              <thead><tr><th className="p-1" /><th className="p-1 text-left font-medium text-(--text-muted)">to →</th>{names.map((n) => <th key={n} className="p-1 text-left font-mono font-medium">{n}</th>)}</tr></thead>
              <tbody>
                {names.map((a, i) => (
                  <tr key={a}>
                    <th className="p-1 text-left font-mono font-medium">{a}</th>
                    <td className="p-1 text-(--text-muted)">ms / $</td>
                    {names.map((b, j) => (
                      <td key={b} className="p-1">
                        {j <= i ? <span className="text-(--text-muted)">{j === i ? "—" : `${m.latencyUs[i][j] / 1000} / ${m.egressCostPerGB[i][j]}`}</span> : (
                          <span className="flex gap-1">
                            <input aria-label={`Latency ${a} to ${b} in ms`} inputMode="decimal" className={`${inputCls} h-7 w-14`} value={m.latencyUs[i][j] / 1000} onChange={(e) => Number.isFinite(+e.target.value) && e.target.value !== "" && set("latencyUs", i, j, Math.round(+e.target.value * 1000))} />
                            <input aria-label={`Egress cost ${a} to ${b} in dollars per GB`} inputMode="decimal" className={`${inputCls} h-7 w-14`} value={m.egressCostPerGB[i][j]} onChange={(e) => Number.isFinite(+e.target.value) && e.target.value !== "" && set("egressCostPerGB", i, j, +e.target.value)} />
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!design.regions && <button type="button" className={`${btn} self-start`} onClick={() => commit((d) => ({ ...d, regions: m }))}>Use these defaults</button>}
        </>
      )}
    </section>
  );
}

// ---------- inspector ----------

export function Inspector({ requestDelete }: { requestDelete: (r: DeleteRequest) => void }) {
  const design = useDesign((s) => s.design);
  const selection = useDesign((s) => s.selection);
  const { commit, endGesture, select } = useDesignApi().getState();
  const node = selection?.kind === "node" ? design.nodes.find((n) => n.id === selection.id) : undefined;
  const edge = selection?.kind === "edge" ? design.edges.find((e) => e.id === selection.id) : undefined;
  const group = selection?.kind === "group" ? design.groups?.find((g) => g.id === selection.id) : undefined;

  if (node) {
    return (
      <div className="flex flex-col gap-5" onBlur={endGesture}>
        <header className="flex items-center gap-2">
          <KindSwatch kind={node.kind} />
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
        {HANDLER_KINDS.includes(node.kind) && <RouteEditor node={node} design={design} />}
        {STORE_KINDS.includes(node.kind) && <EntitiesEditor node={node} design={design} />}
        <button type="button" className={`${btn} self-start text-(--danger)`} onClick={() => requestDelete({ nodeIds: [node.id] })}>
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
        <button type="button" className={`${btn} self-start text-(--danger)`} onClick={() => requestDelete({ edgeIds: [edge.id] })}>
          Delete connection
        </button>
      </div>
    );
  }
  if (group) {
    const places = placeNames(design)[group.kind === "zone" ? "zones" : "regions"];
    const setGroup = (patch: Partial<typeof group>, key?: string) =>
      commit((d) => ({ ...d, groups: (d.groups ?? []).map((g) => (g.id === group.id ? { ...g, ...patch } : g)) }), key);
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-base font-medium">{group.kind === "zone" ? "Zone" : "Region"} frame</h2>
        <p className="text-xs text-(--text-muted)">Components whose {group.kind} is “{group.name}” sit inside this frame. Drag a component into the frame to move it to this {group.kind}.</p>
        <Row label="Kind">
          <select className={inputCls} value={group.kind} onChange={(e) => setGroup({ kind: e.target.value as "region" | "zone" })}>
            <option value="region">Region</option><option value="zone">Zone</option>
          </select>
        </Row>
        <Row label="Name">
          <input className={`${inputCls} font-mono`} list={`places-${group.id}`} value={group.name} onChange={(e) => setGroup({ name: e.target.value }, `group:${group.id}`)} />
        </Row>
        <datalist id={`places-${group.id}`}>{places.map((p) => <option key={p} value={p} />)}</datalist>
        <button type="button" className={`${btn} self-start text-(--danger)`} onClick={() => { commit((d) => ({ ...d, groups: (d.groups ?? []).filter((g) => g.id !== group.id) })); select(null); }}>
          Delete frame
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-(--text-muted)">Select a component or connection to edit it. Design-wide settings:</p>
      <Legend kinds={[...new Set(design.nodes.map((n) => n.kind))]} />
      <EndpointEditor design={design} />
      <RegionsEditor design={design} />
    </div>
  );
}
