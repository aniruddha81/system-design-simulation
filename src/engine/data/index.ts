import { canonical, hash32, Random } from '../core';
import type { DataOp, EntitySpec, Status } from '../types';
import { sampleInput, sampleKey } from '../workload';

export const MAX_RECORDS = 1_000_000;
export class DataLimitError extends RangeError {
  readonly code = 'DATASET_LIMIT';
  constructor() { super('Exact mode supports at most 1M records per store. Use Scale mode.'); this.name = 'DataLimitError'; }
}
export type DataValue = string | number | boolean;
/** Optional payload supplies the operands omitted by the P2 route DataOp contract. */
export type DataOperation = DataOp & { values?: Record<string, DataValue>; value?: DataValue; expectedVersion?: number };
export type DataRecord = { version: number; values: Record<string, DataValue>; fieldBytes: Record<string, number> };
export type DataResult = { status: Status; version?: number; found: boolean; rowsScanned: number; costUnits: number };

export function dataCostUs(op: DataOp, entity: EntitySpec, base: number): number {
  if (op.kind !== 'query') return base;
  const indexed = op.index === entity.primaryKey || entity.indexes.some(index => index.name === op.index);
  return base + (indexed ? Math.log2(Math.max(1, entity.dataset.count)) + op.limit : entity.dataset.count);
}

export interface DataStore {
  readonly size: number;
  apply(op: DataOperation, key: string, nowUs: number): DataResult;
  snapshotVersion(key: string): number | undefined;
  read(key: string): DataRecord | undefined;
  shardFor(key: string, shards: number): number;
}

export function createDataStore(entity: EntitySpec, rng: Random): DataStore {
  if (entity.dataset.count > MAX_RECORDS || entity.dataset.keys.n > MAX_RECORDS) throw new DataLimitError();
  if (!Number.isSafeInteger(entity.dataset.count) || entity.dataset.count < 0) throw new RangeError('Dataset count must be a non-negative integer.');
  if (!Number.isSafeInteger(entity.dataset.keys.n) || entity.dataset.keys.n < 1 || entity.dataset.count > entity.dataset.keys.n) throw new RangeError('Dataset keyspace must contain at least count distinct keys.');
  const records = new Map<string, DataRecord>();
  const versions = new Map<string, number>();
  const fieldTypes = new Map(entity.fields.map(field => [field.name, field.type]));
  for (const index of entity.indexes) if (index.unique && index.fields.every(field => fieldTypes.get(field) === 'bool') && entity.dataset.count > 2 ** index.fields.length) throw new RangeError(`Dataset cannot satisfy unique index ${index.name}.`);
  // Seeded keys accept endpoint prefixes (e.g. user:42); explicit inserts outside the dataset retain their full key.
  const recordKey = (key: string) => {
    const suffix = key.match(/(?:^|:)(\d+)$/)?.[1];
    return suffix !== undefined && versions.has(String(Number(suffix))) ? String(Number(suffix)) : key;
  };
  const indexes = new Map(entity.indexes.map(index => [index.name, new Map<string, Set<string>>() ]));
  const token = (record: DataRecord, fields: string[]) => canonical(fields.map(field => record.values[field]));
  const indexRecord = (key: string, record: DataRecord, add: boolean) => {
    for (const index of entity.indexes) {
      const map = indexes.get(index.name)!, value = token(record, index.fields);
      if (add) { let keys = map.get(value); if (!keys) { keys = new Set(); map.set(value, keys); } keys.add(key); }
      else { const keys = map.get(value); keys?.delete(key); if (!keys?.size) map.delete(value); }
    }
  };
  const conflict = (key: string, record: DataRecord) => entity.indexes.some(index => index.unique && [...(indexes.get(index.name)!.get(token(record, index.fields)) ?? [])].some(other => other !== key));
  const makeRecord = (key: string, ordinal: number): DataRecord => {
    const values: Record<string, DataValue> = {}, fieldBytes: Record<string, number> = {};
    const sampled = sampleKey(entity.dataset.keys, rng, ordinal);
    for (const field of entity.fields) {
      fieldBytes[field.name] = Number(sampleInput({ kind: 'size', ...field.bytes }, rng));
      values[field.name] = entity.dataset.initial?.[field.name] ?? (field.type === 'bool' ? rng.next() < .5 : field.type === 'string' ? String(sampled) : sampled);
    }
    // Unique fields receive stable distinct values; skew belongs to non-unique/shard fields and requests.
    for (const index of entity.indexes) if (index.unique && index.fields.length) {
      const field = index.fields.find(field => fieldTypes.get(field) !== 'bool');
      if (field) values[field] = fieldTypes.get(field) === 'string' ? key : Number.isFinite(Number(key)) ? Number(key) : hash32(key);
      else index.fields.forEach((field, bit) => { values[field] = Math.floor(ordinal / 2 ** bit) % 2 === 1; });
    }
    values[entity.primaryKey] = fieldTypes.get(entity.primaryKey) === 'int' ? Number.isFinite(Number(key)) ? Number(key) : hash32(key) : key;
    return { version: 1, values, fieldBytes };
  };
  let nextUnused = 0;
  for (let i = 0; i < entity.dataset.count; i++) {
    let candidate = entity.dataset.count === entity.dataset.keys.n ? i : sampleKey(entity.dataset.keys, rng, i);
    // Sampling without replacement must still terminate when a hotspot repeatedly picks an existing key.
    if (records.has(String(candidate))) {
      while (records.has(String(nextUnused))) nextUnused++;
      candidate = nextUnused;
    }
    const key = String(candidate), record = makeRecord(key, i);
    records.set(key, record); versions.set(key, 1); indexRecord(key, record, true);
  }
  const result = (op: DataOp, status: Status, found: boolean, version?: number, rowsScanned = 1): DataResult => ({ status, found, ...(version === undefined ? {} : { version }), rowsScanned, costUnits: dataCostUs(op, { ...entity, dataset: { ...entity.dataset, count: records.size } }, 1) });
  return {
    get size() { return records.size; },
    snapshotVersion: key => records.get(recordKey(key))?.version,
    read: key => { const record = records.get(recordKey(key)); return record ? structuredClone(record) : undefined; },
    shardFor(key, shards) {
      if (!Number.isSafeInteger(shards) || shards < 1) throw new RangeError('Shard count must be a positive integer.');
      key = recordKey(key);
      const value = entity.shardKey ? records.get(key)?.values[entity.shardKey] ?? key : key;
      return hash32(String(value)) % shards;
    },
    apply(op, key, nowUs) {
      void nowUs;
      key = recordKey(key);
      const old = records.get(key);
      if (op.kind === 'get') return result(op, old ? 200 : 404, !!old, old?.version);
      if (op.kind === 'query') {
        const index = entity.indexes.find(index => index.name === op.index);
        const matched = index ? indexes.get(index.name)!.get(key) ?? indexes.get(index.name)!.get(canonical(index.fields.map(field => fieldTypes.get(field) === 'string' ? key : fieldTypes.get(field) === 'bool' ? key === 'true' : Number(key)))) : undefined;
        const rows = index ? matched?.size ?? 0 : op.index === entity.primaryKey ? Number(!!old) : records.size;
        return result(op, 200, rows > 0 && op.limit > 0, undefined, index || op.index === entity.primaryKey ? Math.min(rows, op.limit) : records.size);
      }
      if (op.kind === 'insert' && old) return result(op, 409, true, old.version);
      if (!old && op.kind !== 'insert' && op.kind !== 'put') return result(op, 404, false);
      if (op.kind === 'conditionalPut' && old!.version !== op.expectedVersion) return result(op, 409, true, old!.version);
      if (op.kind === 'delete') { indexRecord(key, old!, false); records.delete(key); return result(op, 200, true, old!.version); }
      const next = old ? structuredClone(old) : makeRecord(key, records.size);
      const primary = next.values[entity.primaryKey];
      if (op.values) Object.assign(next.values, op.values);
      next.values[entity.primaryKey] = primary;
      if (op.kind === 'update') {
        const value = next.values[op.field];
        next.values[op.field] = op.op === 'increment' ? Number(value ?? 0) + Number(op.value ?? 1) : op.op === 'append' ? String(value ?? '') + String(op.value ?? '') : op.value ?? 0;
      }
      if (Object.values(next.values).some(value => typeof value === 'number' && !Number.isFinite(value))) return result(op, 409, !!old, old?.version);
      if (op.kind === 'decrementIfPositive') {
        const value = Number(next.values[op.field]);
        if (!Number.isFinite(value) || value < 1) return result(op, 409, true, old!.version);
        next.values[op.field] = value - 1;
      }
      if (conflict(key, next)) return result(op, 409, !!old, old?.version);
      if (!old && records.size >= MAX_RECORDS) throw new DataLimitError();
      if (old) indexRecord(key, old, false);
      next.version = (versions.get(key) ?? 0) + 1;
      versions.set(key, next.version); records.set(key, next); indexRecord(key, next, true);
      return result(op, old ? 200 : 201, true, next.version);
    },
  };
}
