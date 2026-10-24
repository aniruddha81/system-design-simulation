import type { Design, EdgeSpec, NodeSpec, Scenario } from '@/engine/types';

export const benchmarkSizes = { S: { nodes: 5, rps: 500 }, M: { nodes: 25, rps: 5000 }, L: { nodes: 100, rps: 20_000 } } as const;
export type BenchmarkSize = keyof typeof benchmarkSizes;

/** Direct client/service pools keep the L case within Exact's 50M-event ceiling. */
export function benchmarkFixture(size: BenchmarkSize): { design: Design; scenario: Scenario } {
  const spec = benchmarkSizes[size];
  const queue = { concurrency: 128, queueCapacity: 1000, queueDiscipline: 'fifo' as const, costPerHour: .1, region: 'east', zone: 'a' };
  const dist = { kind: 'constant' as const, us: 100 };
  const nodes: NodeSpec[] = [];
  const edge = (from: string, to: string): EdgeSpec => ({ id: `${from}-${to}`, from, to, latency: dist, bandwidthBytesPerSec: 1e10, lossRate: 0 });
  const edges: EdgeSpec[] = [];
  const services = Math.floor(spec.nodes / 2), clients = spec.nodes - services;
  for (let i = 0; i < services; i++) {
    const id = `svc${i}`;
    nodes.push({ id, kind: 'service', label: id, position: { x: 2, y: i }, params: { ...queue, serviceTime: dist }, handlers: { get: [{ type: 'respond', status: 200 }] } });
  }
  for (let i = 0; i < clients; i++) {
    const id = `client${i}`, entry = `svc${i % services}`;
    nodes.push({ id, kind: 'client', label: id, position: { x: 0, y: i }, params: { entry } });
    edges.push(edge(id, entry));
  }
  return {
    design: { schemaVersion: 1, id: `bench-${size}`, name: `Benchmark ${size}`, nodes, edges, endpoints: [{ id: 'get', name: 'GET', op: 'read', keyTemplate: 'user:{id}', requestBytes: 128, responseBytes: 1024, idempotent: true }] },
    scenario: { id: `bench-${size}`, version: 1, workload: { arrival: { kind: 'constant', rps: spec.rps }, mix: { get: 1 }, keys: { kind: 'uniform', n: 10_000 }, deadlineUs: 100_000 }, chaos: [], warmupUs: 0, measureUs: 300_000_000, drainUs: 100_000 },
  };
}
