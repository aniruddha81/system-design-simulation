"use client";
// Data model designer (§8A.1) and endpoint input generators / response fields (§8A.2).
import type { Design, EndpointSpec, EntitySpec, FieldSpec, InputGen, NodeSpec } from "@/engine/types";
import { useDesignApi } from "./design-store";
import { btn, Check, inputCls, KeyDistField, Row, Select, sectionTitle, smallBtn, UnitField } from "./fields";

export const MAX_EXACT_RECORDS = 1_000_000;
const FIELD_TYPES = [["string", "string"], ["int", "int"], ["float", "float"], ["bool", "bool"], ["timestamp", "timestamp"]] as const;
const DEFAULT_BYTES: Record<FieldSpec["type"], number> = { string: 32, int: 8, float: 8, bool: 1, timestamp: 8 };

function EntityEditor({ entity, onChange, onRemove, storeTotal }: {
  entity: EntitySpec; onChange: (e: EntitySpec) => void; onRemove: () => void; storeTotal: number;
}) {
  const names = entity.fields.map((f) => f.name);
  const setField = (i: number, f: FieldSpec) => {
    const old = entity.fields[i].name;
    const rename = (n: string) => (n === old ? f.name : n);
    onChange({
      ...entity,
      fields: entity.fields.map((x, j) => (j === i ? f : x)),
      primaryKey: rename(entity.primaryKey),
      shardKey: entity.shardKey && rename(entity.shardKey),
      indexes: entity.indexes.map((ix) => ({ ...ix, fields: ix.fields.map(rename) })),
    });
  };
  const removeField = (i: number) => {
    const gone = entity.fields[i].name;
    const initial = { ...entity.dataset.initial };
    delete initial[gone];
    onChange({
      ...entity,
      fields: entity.fields.filter((_, j) => j !== i),
      indexes: entity.indexes.map((ix) => ({ ...ix, fields: ix.fields.filter((f) => f !== gone) })).filter((ix) => ix.fields.length),
      shardKey: entity.shardKey === gone ? undefined : entity.shardKey,
      dataset: { ...entity.dataset, initial },
    });
  };
  return (
    <fieldset className="flex flex-col gap-2.5 rounded-(--radius-sm) border border-(--border) p-2.5">
      <legend className="px-1 font-mono text-xs text-(--text)">{entity.name}</legend>
      <Row label="Entity name">
        <input className={`${inputCls} font-mono`} value={entity.name} onChange={(e) => onChange({ ...entity, name: e.target.value.replace(/\s/g, "") })} />
      </Row>

      <table className="w-full text-xs">
        <caption className="mb-1 text-left text-(--text-muted)">Fields</caption>
        <thead><tr className="text-left text-(--text-muted)"><th className="font-medium">Name</th><th className="font-medium">Type</th><th className="font-medium">Bytes ± sd</th><th className="font-medium">Initial</th><th><span className="sr-only">Remove</span></th></tr></thead>
        <tbody>
          {entity.fields.map((f, i) => (
            <tr key={i} className="align-top">
              <td className="py-0.5 pr-1"><input aria-label={`Field ${i + 1} name`} className={`${inputCls} h-7 font-mono`} value={f.name} onChange={(e) => setField(i, { ...f, name: e.target.value.replace(/\s/g, "") })} /></td>
              <td className="py-0.5 pr-1"><Select label={`Field ${f.name} type`} value={f.type} options={FIELD_TYPES} className="h-7" onChange={(type) => setField(i, { ...f, type, bytes: { meanBytes: DEFAULT_BYTES[type], sdBytes: 0 } })} /></td>
              <td className="py-0.5 pr-1">
                <span className="flex gap-1">
                  <input aria-label={`Field ${f.name} mean bytes`} inputMode="numeric" className={`${inputCls} h-7 w-14 tabular-nums`} value={f.bytes.meanBytes} onChange={(e) => Number.isFinite(+e.target.value) && setField(i, { ...f, bytes: { ...f.bytes, meanBytes: Math.max(0, Math.round(+e.target.value)) } })} />
                  <input aria-label={`Field ${f.name} bytes spread`} inputMode="numeric" className={`${inputCls} h-7 w-12 tabular-nums`} value={f.bytes.sdBytes} onChange={(e) => Number.isFinite(+e.target.value) && setField(i, { ...f, bytes: { ...f.bytes, sdBytes: Math.max(0, Math.round(+e.target.value)) } })} />
                </span>
              </td>
              <td className="py-0.5 pr-1">
                {(f.type === "int" || f.type === "float") && (
                  <input
                    aria-label={`Initial value of ${f.name}`}
                    inputMode="decimal"
                    placeholder="—"
                    className={`${inputCls} h-7 w-16 tabular-nums`}
                    value={entity.dataset.initial?.[f.name] ?? ""}
                    onChange={(e) => {
                      const initial = { ...entity.dataset.initial };
                      if (e.target.value === "" || !Number.isFinite(+e.target.value)) delete initial[f.name];
                      else initial[f.name] = +e.target.value;
                      onChange({ ...entity, dataset: { ...entity.dataset, initial } });
                    }}
                  />
                )}
              </td>
              <td className="py-0.5"><button type="button" className={`${smallBtn} hover:text-(--danger)`} disabled={f.name === entity.primaryKey} onClick={() => removeField(i)} aria-label={`Remove field ${f.name}`} title={f.name === entity.primaryKey ? "The primary key can't be removed" : undefined}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" className={`${smallBtn} self-start border border-(--border)`} onClick={() => {
        let i = entity.fields.length + 1;
        while (names.includes(`field${i}`)) i++;
        onChange({ ...entity, fields: [...entity.fields, { name: `field${i}`, type: "string", bytes: { meanBytes: 32, sdBytes: 8 } }] });
      }}>+ Add field</button>

      <Row label="Primary key"><Select label="Primary key" value={entity.primaryKey} options={names.map((n) => [n, n] as const)} onChange={(primaryKey) => onChange({ ...entity, primaryKey })} /></Row>
      <Row label="Shard key">
        <Select label="Shard key" value={entity.shardKey ?? ""} options={[["", "none (single shard)"], ...names.map((n) => [n, n] as const)]} onChange={(k) => onChange({ ...entity, shardKey: k || undefined })} />
      </Row>

      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-(--text-muted)">Secondary indexes</p>
        {entity.indexes.map((ix, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-(--radius-sm) bg-(--bg) p-1.5">
            <input aria-label={`Index ${i + 1} name`} className={`${inputCls} h-7 w-28 font-mono`} value={ix.name} onChange={(e) => onChange({ ...entity, indexes: entity.indexes.map((x, j) => (j === i ? { ...x, name: e.target.value.replace(/\s/g, "") } : x)) })} />
            <span className="flex flex-wrap gap-x-2">
              {names.map((n) => (
                <Check key={n} label={<span className="font-mono text-xs">{n}</span>} checked={ix.fields.includes(n)} onChange={(on) => onChange({ ...entity, indexes: entity.indexes.map((x, j) => (j === i ? { ...x, fields: on ? [...x.fields, n] : x.fields.filter((y) => y !== n) } : x)) })} />
              ))}
            </span>
            <Check label="unique" checked={ix.unique} onChange={(unique) => onChange({ ...entity, indexes: entity.indexes.map((x, j) => (j === i ? { ...x, unique } : x)) })} />
            <button type="button" className={`${smallBtn} ml-auto hover:text-(--danger)`} onClick={() => onChange({ ...entity, indexes: entity.indexes.filter((_, j) => j !== i) })} aria-label={`Remove index ${ix.name}`}>✕</button>
            {ix.fields.length === 0 && <p className="w-full text-xs text-(--danger)">⚠ Pick at least one field.</p>}
          </div>
        ))}
        <button type="button" className={`${smallBtn} self-start border border-(--border)`} onClick={() => onChange({ ...entity, indexes: [...entity.indexes, { name: `by_${names.find((n) => n !== entity.primaryKey) ?? names[0]}`, fields: [names.find((n) => n !== entity.primaryKey) ?? names[0]], unique: false }] })}>
          + Add index
        </button>
      </div>

      <UnitField
        label="Records"
        kind="count"
        value={entity.dataset.count}
        max={MAX_EXACT_RECORDS}
        maxError="Exact mode holds at most 1,000,000 records per store — use Scale mode, or a reduced scenario with fewer records"
        hint="Generated from the run seed and reset at every run."
        onCommit={(count) => onChange({ ...entity, dataset: { ...entity.dataset, count: count! } })}
      />
      {storeTotal > MAX_EXACT_RECORDS && <p className="text-xs text-(--danger)">⚠ This store holds {storeTotal.toLocaleString("en")} records in total; Exact mode allows 1,000,000.</p>}
      <KeyDistField label="Key distribution of reads" value={entity.dataset.keys} onCommit={(keys) => onChange({ ...entity, dataset: { ...entity.dataset, keys } })} />
      <button type="button" className={`${smallBtn} self-start hover:text-(--danger)`} onClick={onRemove}>Remove entity</button>
    </fieldset>
  );
}

/** Entities stored on one node (database, KV store, cache, search index, object store). */
export function EntitiesEditor({ node, design }: { node: NodeSpec; design: Design }) {
  const { commit } = useDesignApi().getState();
  const all = design.entities ?? [];
  const mine = all.filter((e) => e.store === node.id);
  const total = mine.reduce((s, e) => s + e.dataset.count, 0);
  const replace = (old: EntitySpec, next: EntitySpec | null) =>
    commit((d) => ({ ...d, entities: (d.entities ?? []).flatMap((e) => (e === old || (e.store === old.store && e.name === old.name) ? (next ? [next] : []) : [e])) }), next ? `entity:${node.id}:${old.name}` : undefined);
  return (
    <section className="flex flex-col gap-3">
      <h3 className={sectionTitle}>Data model</h3>
      {mine.length === 0 && <p className="text-xs text-(--text-muted)">No entities yet. Define one so data steps can read and write real records here.</p>}
      {mine.map((e, i) => {
        const dup = mine.findIndex((x) => x.name === e.name) !== i;
        return (
          <div key={i}>
            <EntityEditor entity={e} storeTotal={total} onChange={(next) => replace(e, next)} onRemove={() => replace(e, null)} />
            {dup && <p className="mt-1 text-xs text-(--danger)">⚠ Another entity on this store is also called “{e.name}”.</p>}
          </div>
        );
      })}
      <button
        type="button"
        className={`${btn} self-start`}
        onClick={() => {
          let name = "items", i = 1;
          while (mine.some((e) => e.name === name)) name = `items${++i}`;
          const entity: EntitySpec = {
            name, store: node.id, primaryKey: "id", indexes: [],
            fields: [{ name: "id", type: "string", bytes: { meanBytes: 16, sdBytes: 0 } }, { name: "body", type: "string", bytes: { meanBytes: 512, sdBytes: 128 } }],
            dataset: { count: 10_000, keys: { kind: "uniform", n: 10_000 } },
          };
          commit((d) => ({ ...d, entities: [...all, entity] }));
        }}
      >
        + Add entity
      </button>
    </section>
  );
}

// ---------- endpoints: input generators and response fields (§8A.2) ----------

const GEN_KINDS = [["zipf", "zipf(min..max, s)"], ["uniform", "uniform(min..max)"], ["sequence", "sequence(start…)"], ["size", "size(mean ± sd bytes)"]] as const;

function makeGen(kind: InputGen["kind"]): InputGen {
  switch (kind) {
    case "zipf": return { kind, min: 1, max: 1_000_000, s: 1.1 };
    case "uniform": return { kind, min: 1, max: 1_000_000 };
    case "sequence": return { kind, start: 1 };
    case "size": return { kind, meanBytes: 200, sdBytes: 50 };
  }
}

export function InputsEditor({ ep, onChange }: { ep: EndpointSpec; onChange: (ep: EndpointSpec) => void }) {
  const inputs = ep.inputs ?? {};
  const names = Object.keys(inputs);
  const placeholders = [...ep.keyTemplate.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  const missing = names.length ? placeholders.filter((p) => !(p in inputs)) : [];
  const set = (next: Record<string, InputGen>) => onChange({ ...ep, inputs: Object.keys(next).length ? next : undefined });
  const num = (label: string, v: number, put: (x: number) => void) => (
    <input aria-label={label} inputMode="decimal" className={`${inputCls} h-7 w-20 tabular-nums`} value={v} onChange={(e) => Number.isFinite(+e.target.value) && e.target.value !== "" && put(+e.target.value)} />
  );
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-(--text-muted)">Input fields {names.length === 0 && "— none: the scenario's key distribution picks the key"}</p>
      {names.map((name) => {
        const g = inputs[name];
        const rename = (to: string) => set(Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k === name ? to : k, v])));
        const put = (gen: InputGen) => set({ ...inputs, [name]: gen });
        return (
          <div key={name} className="flex flex-wrap items-center gap-1.5 rounded-(--radius-sm) bg-(--bg) p-1.5">
            <input aria-label="Input name" className={`${inputCls} h-7 w-24 font-mono`} defaultValue={name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== name && !(v in inputs)) rename(v); else e.target.value = name; }} />
            <Select label={`${name} generator`} value={g.kind} options={GEN_KINDS} className="h-7 w-44" onChange={(k) => put(makeGen(k))} />
            {(g.kind === "zipf" || g.kind === "uniform") && (
              <>
                {num(`${name} min`, g.min, (min) => put({ ...g, min }))}<span aria-hidden="true">..</span>{num(`${name} max`, g.max, (max) => put({ ...g, max }))}
                {g.kind === "zipf" && num(`${name} skew`, g.s, (s) => put({ ...g, s }))}
                {g.max < g.min && <span className="text-xs text-(--danger)">⚠ max &lt; min</span>}
              </>
            )}
            {g.kind === "sequence" && num(`${name} start`, g.start, (start) => put({ ...g, start }))}
            {g.kind === "size" && <>{num(`${name} mean bytes`, g.meanBytes, (meanBytes) => put({ ...g, meanBytes }))}<span className="text-xs">B ±</span>{num(`${name} sd bytes`, g.sdBytes, (sdBytes) => put({ ...g, sdBytes }))}</>}
            <button type="button" className={`${smallBtn} ml-auto hover:text-(--danger)`} aria-label={`Remove input ${name}`} onClick={() => { const next = { ...inputs }; delete next[name]; set(next); }}>✕</button>
          </div>
        );
      })}
      {missing.length > 0 && <p className="text-xs text-(--danger)">⚠ The key template uses {missing.map((m) => `{${m}}`).join(", ")} with no input of that name.</p>}
      <button type="button" className={`${smallBtn} self-start border border-(--border)`} onClick={() => {
        const name = placeholders.find((p) => !(p in inputs)) ?? `input${names.length + 1}`;
        set({ ...inputs, [name]: makeGen("zipf") });
      }}>+ Add input</button>
    </div>
  );
}

/** Response fields are "entity.field"; the response size is the sum of their sizes (else responseBytes). */
export function ResponseFieldsEditor({ ep, design, onChange }: { ep: EndpointSpec; design: Design; onChange: (ep: EndpointSpec) => void }) {
  const all = (design.entities ?? []).flatMap((e) => e.fields.map((f) => ({ id: `${e.name}.${f.name}`, bytes: f.bytes.meanBytes })));
  if (all.length === 0) return null;
  const chosen = ep.responseFields ?? [];
  const size = all.filter((f) => chosen.includes(f.id)).reduce((s, f) => s + f.bytes, 0);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-(--text-muted)">Response fields {chosen.length ? `(≈ ${size} B, replaces the response size)` : "— none: uses the response size above"}</p>
      <div className="flex flex-wrap gap-x-3">
        {all.map((f) => (
          <Check key={f.id} label={<span className="font-mono text-xs">{f.id}</span>} checked={chosen.includes(f.id)} onChange={(on) => {
            const next = on ? [...chosen, f.id] : chosen.filter((x) => x !== f.id);
            onChange({ ...ep, responseFields: next.length ? next : undefined });
          }} />
        ))}
      </div>
    </div>
  );
}
