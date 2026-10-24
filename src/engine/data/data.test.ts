import { describe, expect, it } from 'vitest';
import { Random } from '../core';
import type { DataOp, EntitySpec } from '../types';
import { createDataStore, dataCostUs, DataLimitError } from './index';

export const entity: EntitySpec = {
  name: 'users', store: 'db', primaryKey: 'id', shardKey: 'tenant',
  fields: [
    { name: 'id', type: 'string', bytes: { meanBytes: 8, sdBytes: 0 } },
    { name: 'email', type: 'string', bytes: { meanBytes: 32, sdBytes: 4 } },
    { name: 'tenant', type: 'int', bytes: { meanBytes: 8, sdBytes: 0 } },
    { name: 'stock', type: 'int', bytes: { meanBytes: 8, sdBytes: 0 } },
  ],
  indexes: [{ name: 'email', fields: ['email'], unique: true }, { name: 'tenant', fields: ['tenant'], unique: false }],
  dataset: { count: 100, keys: { kind: 'hotspot', n: 100, hotFraction: .9 }, initial: { stock: 1 } },
};
const store = (seed = 42) => createDataStore(entity, new Random(seed, 'data'));

describe('deterministic data store', () => {
  it('resets values, sizes, versions and indexes per run', () => {
    const a = store(), b = store(), c = store(43);
    expect(Array.from({ length: 100 }, (_, i) => a.read(String(i)))).toEqual(Array.from({ length: 100 }, (_, i) => b.read(String(i))));
    expect(a.read('0')).not.toEqual(c.read('0'));
    a.apply({ kind: 'put' }, '0', 1);
    expect(a.snapshotVersion('0')).toBe(2);
    expect(b.snapshotVersion('0')).toBe(1);
    expect(b.snapshotVersion('user:0')).toBe(1);
    expect(b.apply({ kind: 'get' }, 'user:0', 0).status).toBe(200);
    expect(b.shardFor('user:0', 16)).toBe(b.shardFor('0', 16));
    const copy = a.read('0')!; copy.values.stock = -1;
    expect(a.read('0')!.values.stock).toBe(1);
  });

  it('implements insert/upsert, version conflicts, update operands, delete and missing keys', () => {
    const s = store();
    expect(s.apply({ kind: 'insert' }, '0', 0).status).toBe(409);
    expect(s.apply({ kind: 'insert', values: { email: 'new' } }, 'new', 0)).toMatchObject({ status: 201, version: 1 });
    expect(s.apply({ kind: 'conditionalPut', expectedVersion: 2 }, 'new', 1).status).toBe(409);
    expect(s.apply({ kind: 'conditionalPut' }, 'new', 1).status).toBe(409);
    expect(s.apply({ kind: 'conditionalPut', expectedVersion: 1 }, 'new', 1)).toMatchObject({ status: 200, version: 2 });
    expect(s.apply({ kind: 'update', field: 'stock', op: 'increment', value: 3 }, 'new', 2).status).toBe(200);
    expect(s.read('new')!.values.stock).toBe(4);
    expect(s.apply({ kind: 'update', field: 'stock', op: 'increment', value: 'invalid' }, 'new', 2).status).toBe(409);
    s.apply({ kind: 'update', field: 'stock', op: 'set', value: 8 }, 'new', 2);
    s.apply({ kind: 'update', field: 'email', op: 'append', value: '.com' }, 'new', 2);
    expect(s.read('new')!.values).toMatchObject({ stock: 8, email: 'new.com' });
    expect(s.apply({ kind: 'delete' }, 'new', 3).status).toBe(200);
    expect(s.snapshotVersion('new')).toBeUndefined();
    expect(s.apply({ kind: 'put', values: { email: 'new' } }, 'new', 4)).toMatchObject({ status: 201, version: 6 });
    for (const op of [{ kind: 'get' }, { kind: 'delete' }, { kind: 'conditionalPut' }, { kind: 'update', field: 'stock', op: 'increment' }, { kind: 'decrementIfPositive', field: 'stock' }] as DataOp[]) expect(s.apply(op, 'missing', 5).status).toBe(404);
  });

  it('enforces secondary uniqueness atomically and maintains non-unique indexes', () => {
    const s = store();
    expect(s.apply({ kind: 'put', values: { email: s.read('0')!.values.email } }, '1', 0).status).toBe(409);
    expect(s.snapshotVersion('1')).toBe(1);
    expect(s.apply({ kind: 'query', index: 'tenant', limit: 100 }, '0', 0).rowsScanned).toBeGreaterThan(50);
    s.apply({ kind: 'delete' }, '0', 0);
    expect(s.apply({ kind: 'put', values: { email: '0' } }, '1', 0).status).toBe(200);
    expect(s.apply({ kind: 'query', index: 'email', limit: 1 }, '["0"]', 0).found).toBe(true);
  });

  it('never decrements below zero and leaves version unchanged on conflict', () => {
    const s = store();
    expect(s.apply({ kind: 'decrementIfPositive', field: 'stock' }, '0', 1)).toMatchObject({ status: 200, version: 2 });
    expect(s.apply({ kind: 'decrementIfPositive', field: 'stock' }, '0', 2)).toMatchObject({ status: 409, version: 2 });
    expect(s.read('0')!.values.stock).toBe(0);
  });

  it('charges scans for absent indexes and routes skewed shard fields deterministically', () => {
    const s = store();
    expect(dataCostUs({ kind: 'query', index: 'email', limit: 2 }, entity, 10)).toBeCloseTo(10 + Math.log2(100) + 2);
    expect(dataCostUs({ kind: 'query', limit: 2 }, entity, 10)).toBe(110);
    expect(s.apply({ kind: 'query', index: 'missing', limit: 1 }, '', 0)).toMatchObject({ rowsScanned: 100, costUnits: 101 });
    const shards = Array.from({ length: 100 }, (_, i) => s.shardFor(String(i), 16));
    expect(shards).toEqual(Array.from({ length: 100 }, (_, i) => store().shardFor(String(i), 16)));
    expect(Math.max(...Array.from({ length: 16 }, (_, shard) => shards.filter(x => x === shard).length))).toBeGreaterThan(50);
  });

  it('rejects counts above 1M with a typed error', () => {
    expect(() => createDataStore({ ...entity, dataset: { ...entity.dataset, count: 1_000_001 } }, new Random(1, 'data'))).toThrow(DataLimitError);
    expect(() => createDataStore({ ...entity, dataset: { count: 1, keys: { kind: 'zipf', n: 1_000_001, s: 1 } } }, new Random(1, 'data'))).toThrow(DataLimitError);
    expect(() => createDataStore({ ...entity, dataset: { ...entity.dataset, count: -1 } }, new Random(1, 'data'))).toThrow(RangeError);
    expect(() => createDataStore({ ...entity, dataset: { count: 10, keys: { kind: 'uniform', n: 9 } } }, new Random(1, 'data'))).toThrow(RangeError);
  });

  it('accepts exactly 1M records but rejects an insert beyond that bound', () => {
    const s = createDataStore({ ...entity, fields: [], indexes: [], dataset: { count: 1_000_000, keys: { kind: 'sequential', n: 1_000_000 } } }, new Random(1, 'limit'));
    expect(s.size).toBe(1_000_000);
    expect(() => s.apply({ kind: 'insert' }, 'extra', 0)).toThrow(DataLimitError);
    expect(s.size).toBe(1_000_000);
    expect(s.apply({ kind: 'put' }, '0', 0).status).toBe(200);
  }, 20_000);

  it('builds valid unique boolean indexes and protects primary key values', () => {
    const bool: EntitySpec = { ...entity, fields: [{ name: 'flag', type: 'bool', bytes: { meanBytes: 1, sdBytes: 0 } }], indexes: [{ name: 'flag', fields: ['flag'], unique: true }], dataset: { count: 2, keys: { kind: 'sequential', n: 2 } } };
    const s = createDataStore(bool, new Random(1, 'bool'));
    expect([s.read('0')!.values.flag, s.read('1')!.values.flag]).toEqual([false, true]);
    expect(s.apply({ kind: 'query', index: 'flag', limit: 1 }, 'true', 0).found).toBe(true);
    expect(() => createDataStore({ ...bool, dataset: { count: 3, keys: { kind: 'sequential', n: 3 } } }, new Random(1, 'bool'))).toThrow(RangeError);
    s.apply({ kind: 'put', values: { id: 'changed' } }, '0', 0);
    expect(s.read('0')!.values.id).toBe('0');
  });

  it('samples sparse datasets from the declared key distribution without duplicate records', () => {
    const make = (kind: 'uniform' | 'sequential') => createDataStore({ ...entity, indexes: [], dataset: { count: 10, keys: { kind, n: 100 } } }, new Random(42, 'sparse'));
    const uniform = make('uniform'), sequential = make('sequential');
    expect(uniform.size).toBe(10);
    expect(Array.from({ length: 100 }, (_, i) => uniform.snapshotVersion(String(i))).filter(v => v !== undefined)).toHaveLength(10);
    expect(Array.from({ length: 100 }, (_, i) => uniform.snapshotVersion(String(i)))).not.toEqual(Array.from({ length: 100 }, (_, i) => sequential.snapshotVersion(String(i))));
  });
});
