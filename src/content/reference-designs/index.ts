import type { Design, EdgeSpec, EndpointSpec, NodeParams, NodeSpec, QueueParams, Scenario, Step } from '../../engine/types';

export type Assumption = { claim: string; value: string; source?: { title: string; url: string } };
export type ScenarioId = 'normal-day' | 'peak-event' | 'region-outage' | 'hot-key-celebrity' | 'dependency-brownout' | 'ddos';
export type ReferenceScenario = { id: ScenarioId; title: string; mode: 'scale'; description: string; scenario: Scenario };
export type ReferenceDesign = {
  id: string;
  title: string;
  label: 'illustrative';
  design: Design;
  assumptions: Assumption[];
  scenarios: ReferenceScenario[];
};

const regions = ['us-east', 'eu-west'];
const constant = (us: number) => ({ kind: 'constant' as const, us });
const queue = (region: string, concurrency: number): QueueParams => ({
  region, zone: `${region}-a`, concurrency, queueCapacity: 10_000, queueDiscipline: 'fifo', costPerHour: concurrency * .002,
});
const node = <K extends NodeSpec['kind']>(id: string, kind: K, label: string, params: NodeParams[K], x: number, y = 0): NodeSpec =>
  ({ id, kind, label, params, position: { x, y } }) as NodeSpec;
const service = (id: string, label: string, region: string, concurrency: number, us: number, handlers: NonNullable<NodeSpec['handlers']>, x = 700) =>
  ({ ...node(id, 'service', label, { ...queue(region, concurrency), serviceTime: constant(us) }, x, region === 'us-east' ? 0 : 400), handlers });
const database = (id: string, label: string, region: string, concurrency: number, us: number) =>
  node(id, 'database', label, { ...queue(region, concurrency), readTime: constant(us), writeTime: constant(us * 2), replicas: 1 }, 1000, region === 'us-east' ? 0 : 400);
const kv = (id: string, label: string, region: string, concurrency: number) => node(id, 'kvStore', label, {
  ...queue(region, concurrency), readTime: constant(1000), writeTime: constant(2000), members: 64, vnodes: 128,
  replicationFactor: 3, readQuorum: 1, writeQuorum: 2, hintedHandoff: true, readRepair: true, tombstoneGcUs: 86_400_000_000,
}, 1000, region === 'us-east' ? 0 : 400);
const call = (target: string): Step => ({ type: 'call', target, timeoutUs: 400_000 });
const ok: Step = { type: 'respond', status: 200 };
const parallel = (...targets: string[]): Step => ({ type: 'parallel', branches: targets.map(t => [call(t)]), join: { kind: 'all' }, cancelLosers: false });
const endpoint = (id: string, name: string, op: 'read' | 'write', bytes: number): EndpointSpec => ({
  id, name, op, keyTemplate: 'item:{id}', requestBytes: op === 'write' ? 1024 : 128, responseBytes: bytes, idempotent: op === 'read',
});
function connect(design: Design, from: string, ...targets: string[]) {
  design.edges.push(...targets.map((to): EdgeSpec => ({
    id: `${from}-${to}`, from, to, latency: constant(100), bandwidthBytesPerSec: 1_000_000_000_000, lossRate: 0,
  })));
}

function base(id: string, title: string, rps: number, endpoints: EndpointSpec[]): Design {
  const design: Design = {
    schemaVersion: 1, id, name: `${title} (illustrative)`, endpoints, nodes: [], edges: [],
    regions: { names: [...regions], latencyUs: [[0, 35_000], [35_000, 0]], egressCostPerGB: [[0, .02], [.02, 0]] },
    groups: regions.map((name, i) => ({ id: name, kind: 'region', name, position: { x: 0, y: i * 400 - 50 }, size: { w: 1400, h: 350 } })),
  };
  for (const [i, region] of regions.entries()) {
    const client = `client-${i}`, limit = `admission-${i}`;
    design.nodes.push(node(client, 'client', `${region} clients`, { entry: limit }, 0, i * 400),
      node(limit, 'rateLimiter', `${region} admission`, {
        ...queue(region, 100_000), serviceTime: constant(10), algorithm: 'tokenBucket', ratePerSec: rps * 4, burst: rps,
      }, 220, i * 400));
    connect(design, client, limit);
  }
  return design;
}

function scenarioPack(id: string, rps: number, mix: Record<string, number>, dependency: string, cached: boolean): ReferenceScenario[] {
  const normal: Scenario = {
    id: `${id}-normal-day`, version: 1, warmupUs: 2_000_000, measureUs: 8_000_000, drainUs: 250_000, chaos: [],
    workload: { arrival: { kind: 'constant', rps }, mix, keys: { kind: 'zipf', n: 100_000_000, s: 1.1 }, deadlineUs: 1_000_000 },
  };
  const specs: { id: ScenarioId; title: string; description: string }[] = [
    { id: 'normal-day', title: 'Normal day', description: 'A short constant-rate window; caches begin empty. This is not a full day or a steady-state claim.' },
    { id: 'peak-event', title: 'Peak event', description: '4x offered traffic from second 4 through second 8.' },
    { id: 'region-outage', title: 'Region outage', description: 'us-east is unavailable from second 4 through second 8; clients retain their original regional entry.' },
    { id: 'hot-key-celebrity', title: 'Hot key / celebrity', description: cached
      ? '4x traffic with stationary Zipf exponent 1.8 from the start; approximates concentrated demand, not a mid-run popularity shift.'
      : '4x traffic with 90% of requests on one key. Hot-row locks and shard affinity are not predicted; write contention disables affected Scale predictions. Use Exact for contention.' },
    { id: 'dependency-brownout', title: 'Dependency brownout', description: `${dependency} takes 10x its normal service time from second 4 through second 8.` },
    { id: 'ddos', title: 'DDoS', description: '50x application traffic from second 4 through second 8; all requests compete under the same admission budget. No attack detection or L3/L4 model.' },
  ];
  return specs.map(spec => {
    const scenario = structuredClone(normal);
    scenario.id = `${id}-${spec.id}`;
    const window = { atUs: 4_000_000, endUs: 8_000_000 };
    if (spec.id === 'peak-event' || spec.id === 'ddos') scenario.chaos = [{ id: spec.id, kind: 'trafficSpike', target: '', multiplier: spec.id === 'ddos' ? 50 : 4, ...window }];
    if (spec.id === 'region-outage') scenario.chaos = [{ id: spec.id, kind: 'regionOutage', target: 'us-east', ...window }];
    if (spec.id === 'dependency-brownout') scenario.chaos = [{ id: spec.id, kind: 'degrade', target: dependency, slowFactor: 10, ...window }];
    if (spec.id === 'hot-key-celebrity') {
      scenario.workload.arrival = { kind: 'constant', rps: rps * 4 };
      scenario.workload.keys = cached ? { kind: 'zipf', n: 100_000_000, s: 1.8 } : { kind: 'hotspot', n: 100_000_000, hotFraction: .9 };
    }
    return { ...spec, mode: 'scale', scenario };
  });
}

function reference(design: Design, title: string, rps: number, mix: Record<string, number>, dependency: string, anchor: Assumption): ReferenceDesign {
  return {
    id: design.id, title, label: 'illustrative', design,
    assumptions: [anchor,
      { claim: 'Illustrative workload assumption, not a measured production API rate', value: `${rps.toLocaleString('en-US')} logical requests/s globally, divided equally between two client groups; mix ${JSON.stringify(mix)}.` },
      { claim: 'Illustrative fixed-byte payload assumption', value: design.endpoints.map(e => `${e.id}: ${e.requestBytes} request bytes, ${e.responseBytes} response bytes`).join('; ') },
      { claim: 'Illustrative topology and capacity assumptions', value: 'Two regional aggregates, not individual machines; concurrency, service times and capacity are invented teaching budgets. No automatic traffic evacuation. 100 million keys; stationary Zipf s=1.1 normally; FIFO buffers of 10,000 attempts.' },
      { claim: 'Illustrative network and price assumptions', value: '35 ms one-way cross-region propagation, plus 0.1 ms per edge; 1 TB/s each direction per aggregate edge; $0.02/GB cross-region. Compute $0.002 per configured worker-hour; other prices are invented, not vendor quotes.' },
      { claim: 'Illustrative scenario assumptions', value: '2 s cold warm-up, 8 s measurement, 0.25 s drain; disturbances at 4–8 s. Peak 4x, brownout 10x service time, DDoS 50x; celebrity 4x with stationary concentration. No production forecast or correctness claim.' },
    ],
    scenarios: scenarioPack(design.id, rps, mix, dependency, design.nodes.some(n => n.kind === 'cdn')),
  };
}

function video(id: string, title: string, rps: number, bytes: number, cachedObjects: number, anchor: Assumption): ReferenceDesign {
  const design = base(id, title, rps, [endpoint('get', 'GET /segments/:id', 'read', bytes)]);
  design.nodes.push(service('shield', 'Origin shield', 'us-east', 150_000, 1000, { get: [call('objects'), ok] }),
    node('objects', 'objectStore', 'Encoded segments', { readTime: constant(5000), writeTime: constant(10_000), costPerGBMonth: .02, costPerMillionRequests: .4, region: 'eu-west', zone: 'eu-west-a' }, 1000, 400));
  connect(design, 'shield', 'objects');
  for (const [i, region] of regions.entries()) {
    design.nodes.push(node(`edge-${i}`, 'cdn', `${region} video edge`, {
      ...queue(region, 150_000), serviceTime: constant(100), capacityBytes: bytes * cachedObjects, eviction: 'lru', originShield: true, costPerGB: .03,
    }, 450, i * 400));
    connect(design, `admission-${i}`, `edge-${i}`);
    connect(design, `edge-${i}`, 'shield');
  }
  const result = reference(design, title, rps, { get: 1 }, 'shield', anchor);
  result.assumptions.push({ claim: 'Illustrative cache assumption', value: `${cachedObjects} fixed-size segments per regional LRU cache, no TTL; starts empty. Object-store read time 5 ms, CDN egress $0.03/GB. Storage charges omit an unmodelled production catalog.` });
  return result;
}

function messaging(id: string, title: string, rps: number, readShare: number, anchor: Assumption): ReferenceDesign {
  const endpoints = [endpoint('send', 'POST /messages', 'write', 1024), ...(readShare ? [endpoint('get', 'GET /channels/:id/messages', 'read', 1024)] : [])];
  const design = base(id, title, rps, endpoints);
  design.nodes.push(kv('directory', 'Session / channel directory', 'us-east', 8000));
  for (const [i, region] of regions.entries()) {
    const inbox = `inbox-${i}`, log = `log-${i}`, delivery = `delivery-${i}`;
    const handlers = { send: [call('directory'), { type: 'publish' as const, queue: log, timeoutUs: 400_000, orderedByKey: true }, ok],
      ...(readShare ? { get: [parallel('directory', inbox), ok] } : {}) };
    design.nodes.push(service(`api-${i}`, readShare ? 'Channel history and sends' : 'Message ingress', region, 150_000, 100, handlers, 450),
      kv(inbox, readShare ? 'Channel message buckets' : 'Recipient mailboxes', region, readShare ? 500 : 2500),
      node(log, 'queue', 'Durable delivery queue', { partitions: 64, capacityMessages: 100_000, visibilityTimeoutUs: 30_000_000, maxDeliveries: 3, retentionUs: 86_400_000_000, publishTime: constant(100), costPerHour: 4, region, zone: `${region}-a` }, 700, i * 400 + 140),
      { ...node(delivery, 'worker', 'Delivery / fan-out workers', { ...queue(region, readShare ? 200 : 4000), source: log, batchSize: 1, serviceTime: constant(1000) }, 1000, i * 400 + 140),
        // Scale distributes consumer work by the global endpoint mix; both handlers represent one mailbox operation.
        handlers: Object.fromEntries(endpoints.map(e => [e.id, [call(inbox), ok]])) });
    connect(design, `admission-${i}`, `api-${i}`);
    connect(design, `api-${i}`, 'directory', log, ...(readShare ? [inbox] : []));
    connect(design, delivery, inbox);
  }
  const result = reference(design, title, rps, readShare ? { get: readShare, send: 1 - readShare } : { send: 1 }, 'directory', anchor);
  result.assumptions.push({ claim: 'Illustrative messaging abstraction', value: 'One mailbox operation per consumed message; recipient fan-out, sockets, encryption, ordering and redelivery correctness are omitted. Send success means queue acceptance, not recipient delivery. Discord consumers use the global read/write mix as a service-cost approximation.' });
  return result;
}

function uber(): ReferenceDesign {
  const design = base('uber', 'Uber', 200_000, [endpoint('match', 'POST /matches', 'write', 2048)]);
  design.nodes.push(service('pricing', 'Pricing dependency', 'us-east', 1000, 2000, { match: [ok] }), database('trips', 'Trip commitments', 'us-east', 2000, 2000));
  for (const [i, region] of regions.entries()) {
    design.nodes.push(kv(`geo-${i}`, 'Nearby-driver cells', region, 500),
      service(`api-${i}`, 'Match coordinator', region, 20_000, 500, { match: [parallel(`geo-${i}`, 'pricing'), call('trips'), ok] }, 450));
    connect(design, `admission-${i}`, `api-${i}`);
    connect(design, `api-${i}`, `geo-${i}`, 'pricing', 'trips');
  }
  return reference(design, 'Uber', 200_000, { match: 1 }, 'pricing', {
    claim: 'Reported Q4 2024 platform trips, including Mobility and Delivery; not API requests', value: 'Approximately 33 million trips/day.',
    source: { title: 'Uber Q4 and full-year 2024 results', url: 'https://investor.uber.com/news-events/news/press-release-details/2025/Uber-Announces-Results-for-Fourth-Quarter-and-Full-Year-2024/default.aspx' },
  });
}

function timeline(): ReferenceDesign {
  const design = base('twitter-timeline', 'Twitter/X timeline', 300_000, [endpoint('get', 'GET /timeline', 'read', 8192), endpoint('post', 'POST /posts', 'write', 8192)]);
  design.nodes.push(kv('timelines', 'Materialized home timelines', 'us-east', 1000), database('posts', 'Post storage', 'eu-west', 1000, 2000));
  for (const [i, region] of regions.entries()) {
    design.nodes.push(service(`api-${i}`, 'Timeline merge / post ingress', region, 30_000, 500, {
      get: [parallel('timelines', 'posts'), ok], post: [call('posts'), { type: 'publish', queue: `fanout-${i}`, timeoutUs: 400_000, orderedByKey: true }, ok],
    }, 450), node(`fanout-${i}`, 'queue', 'Fan-out queue', { partitions: 64, capacityMessages: 100_000, visibilityTimeoutUs: 30_000_000, maxDeliveries: 3, retentionUs: 86_400_000_000, publishTime: constant(100), costPerHour: 4, region, zone: `${region}-a` }, 700, i * 400 + 140),
    { ...node(`worker-${i}`, 'worker', 'Fan-out workers', { ...queue(region, 200), serviceTime: constant(1000), source: `fanout-${i}`, batchSize: 1 }, 1000, i * 400 + 140), handlers: { get: [call('timelines'), ok], post: [call('timelines'), ok] } });
    connect(design, `admission-${i}`, `api-${i}`);
    connect(design, `api-${i}`, 'timelines', 'posts', `fanout-${i}`);
    connect(design, `worker-${i}`, 'timelines');
  }
  const result = reference(design, 'Twitter/X timeline', 300_000, { get: .98, post: .02 }, 'posts', {
    claim: 'Historical public Tweet volume in February 2014; not timeline reads or current X traffic', value: 'More than 500 million Tweets/day.',
    source: { title: 'Introducing Twitter Data Grants', url: 'https://blog.x.com/engineering/en_us/a/2014/introducing-twitter-data-grants' },
  });
  result.assumptions.push({ claim: 'Illustrative fan-out abstraction', value: 'One materialized-timeline operation per queued post; real follower-degree amplification and per-user ordering are omitted. Consumer cost uses the global endpoint mix.' });
  return result;
}

function payments(): ReferenceDesign {
  const design = base('stripe-payments', 'Stripe-style payments', 50_000, [endpoint('pay', 'POST /payments', 'write', 1024)]);
  design.nodes.push(service('risk', 'Risk scoring', 'us-east', 500, 5000, { pay: [ok] }),
    service('processor', 'External payment processor', 'eu-west', 1000, 10_000, { pay: [ok] }),
    database('ledger', 'Ledger capacity aggregate', 'us-east', 1000, 3000));
  for (const [i, region] of regions.entries()) {
    design.nodes.push(service(`api-${i}`, 'Payment orchestration', region, 20_000, 1000, { pay: [call('risk'), call('processor'), call('ledger'), ok] }, 450));
    connect(design, `admission-${i}`, `api-${i}`);
    connect(design, `api-${i}`, 'risk', 'processor', 'ledger');
  }
  const result = reference(design, 'Stripe-style payments', 50_000, { pay: 1 }, 'processor', {
    claim: 'Reported 2024 total payment volume, dollars rather than transaction count', value: 'Approximately $1.4 trillion/year; no API RPS is inferred from dollars.',
    source: { title: 'Stripe 2024 update', url: 'https://stripe.com/newsroom/news/stripe-2024-update' },
  });
  result.assumptions.push({ claim: 'Illustrative payments capacity abstraction', value: 'No retries or simulated deduplication, transactions, balances, settlement or exactly-once claim. Call steps approximate dependency cost; use Exact payment fixtures for correctness experiments.' });
  return result;
}

function search(): ReferenceDesign {
  const design = base('google-search', 'Google-style search', 500_000, [endpoint('get', 'GET /search?q=:id', 'read', 32_768)]);
  design.nodes.push(node('documents', 'objectStore', 'Crawled document corpus', { readTime: constant(5000), writeTime: constant(10_000), costPerGBMonth: .02, costPerMillionRequests: .4, region: 'us-east', zone: 'us-east-a' }, 1250, 200),
    service('ranker', 'Final ranking', 'eu-west', 3000, 2000, { get: [ok] }, 1250));
  for (const [i, region] of regions.entries()) {
    design.nodes.push(node(`index-${i}`, 'searchIndex', `Index shard ${i}`, { ...queue(region, 2000), serviceTime: constant(3000), indexLag: constant(1_000_000), source: 'documents' }, 700, i * 400),
      service(`api-${i}`, 'Query scatter / gather', region, 50_000, 500, { get: [parallel('index-0', 'index-1'), call('ranker'), call('documents'), ok] }, 450));
    connect(design, `admission-${i}`, `api-${i}`);
    connect(design, `api-${i}`, 'index-0', 'index-1', 'ranker', 'documents');
  }
  return reference(design, 'Google-style search', 500_000, { get: 1 }, 'index-0', {
    claim: 'Historical 1998 prototype corpus, not the size or throughput of modern Google', value: 'At least 24 million pages.',
    source: { title: 'The Anatomy of a Large-Scale Hypertextual Web Search Engine', url: 'https://research.google/pubs/the-anatomy-of-a-large-scale-hypertextual-web-search-engine/' },
  });
}

/** Capacity sketches for Scale mode; these are not reconstructions of private production architectures. */
export const referenceDesigns: ReferenceDesign[] = [
  video('youtube', 'YouTube', 1_000_000, 262_144, 100_000, {
    claim: 'Historical viewing milestone reported in February 2017; watch time is not segment request count', value: 'Approximately one billion watch-hours/day.',
    source: { title: "You know what's cool? A billion hours.", url: 'https://india.googleblog.com/2017/02/you-know-whats-cool-billion-hours.html' },
  }),
  messaging('whatsapp', 'WhatsApp', 1_200_000, 0, {
    claim: 'Reported messaging scale in April 2021; deliveries and group fan-out are separate work', value: 'More than 100 billion messages/day (about 1.16 million/s averaged over a day).',
    source: { title: 'DIT — enabling de-identified data collection on WhatsApp', url: 'https://engineering.fb.com/2021/04/16/security/dit/' },
  }),
  uber(), timeline(),
  video('netflix-cdn', 'Netflix-style CDN', 500_000, 1_048_576, 500_000, {
    claim: 'Public Open Connect deployment scale; not a measured video request rate', value: 'More than 1,000 ISP partners localize traffic with embedded appliances.',
    source: { title: 'Netflix Open Connect', url: 'https://openconnect.netflix.com/en/' },
  }),
  payments(),
  messaging('discord', 'Discord', 200_000, .8, {
    claim: 'Message-storage migration described in March 2023; machine counts are not API throughput', value: 'Approximately 177 Cassandra nodes replaced by 72 ScyllaDB nodes.',
    source: { title: 'How Discord Stores Trillions of Messages', url: 'https://discord.com/blog/how-discord-stores-trillions-of-messages' },
  }),
  search(),
];
