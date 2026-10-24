import type { Design, Dist, EndpointSpec, NodeSpec } from '../types';

export function serviceTime(n: NodeSpec, e?: EndpointSpec): Dist {
  if ('readTime' in n.params) return e?.op === 'write' ? n.params.writeTime : n.params.readTime;
  if ('serviceTime' in n.params) return n.params.serviceTime;
  if (n.kind === 'dns') return n.params.resolutionTime;
  if (n.kind === 'queue') return n.params.publishTime;
  return { kind: 'constant', us: 1 };
}

export function responseBytes(design: Design, e: EndpointSpec): number {
  if (!e.responseFields?.length) return e.responseBytes;
  return e.responseFields.reduce((sum, name) => sum + (design.entities?.flatMap(entity => entity.fields).find(f => f.name === name)?.bytes.meanBytes ?? 0), 0);
}

export function regionPair(design: Design, from: string, to: string): [number, number] | undefined {
  const region = (id: string) => { const p = design.nodes.find(n => n.id === id)?.params; return p && 'region' in p ? p.region : undefined; };
  const a = region(from), b = region(to), m = design.regions;
  if (!m || a === undefined || b === undefined || a === b) return;
  const i = m.names.indexOf(a), j = m.names.indexOf(b);
  if (i >= 0 && j >= 0) return [i, j];
}

