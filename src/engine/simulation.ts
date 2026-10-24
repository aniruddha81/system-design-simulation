import { computeMonthlyCost, designHash, duration, ENGINE_VERSION, EventHeap, hash32, Histogram, PRIORITY, Random, REPLAY_COMPAT_ID } from './core';
import { LIMITS, validateDesign } from './validation';
import { createDataStore, dataCostUs, DataLimitError } from './data';
import type { DataValue } from './data';
import { arrivalRate, renderKey, sampleInput } from './workload';
import type { AdvanceOptions, ChaosEvent, DataOp, Design, Dist, EdgeSpec, EndpointSpec, EntitySpec, LiveEdit, LiveSnapshot, NodeSpec, NodeStats, Packet, RunMetrics, RunResult, RunSettings, Scenario, Simulation, Span, Status, Step, TraceInput, TraceResult, Violation } from './types';

type Reply = { status: Status; hit?: boolean; version?: number; found?: boolean; dedupHit?: boolean; source?: string };
type Root = { id: string; endpoint: EndpointSpec; key: string; start: number; deadline: number; cohort: boolean; done: boolean; rejected: boolean; invalid: boolean; good: boolean; trace?: TraceResult; session?: number; inputs?: Record<string, number | string>; required?: Map<string, number>; writes?: Map<string, number>; writeEpoch?: Map<string, number>; origin?: Root; background?: boolean; responseBytes?: number };
type RequestStep = Exclude<Step, { type: 'branch' | 'respond' | 'parallel' }>;
type Invocation = { source?: string; root: Root; node: RuntimeNode; arrival: number; started?: number; live: boolean; completed: boolean; wasted: boolean; released: boolean; abandoned: boolean; reply: (r: Reply) => void; children: Set<Invocation>; cancelChildren: Set<() => void>; parent?: Invocation; depth: number; op?: 'get' | 'set' | 'delete' | 'probe'; version: number; hit: boolean; found?: boolean; dedupHit?: boolean; step?: RequestStep; deadline?: number; dedupSeen?: boolean; virtual?: boolean; wait?: () => void; cleanup?: () => void };
type Entry = { bytes: number; version: number; expires: number; used: number; frequency: number; source?: string };
type Health = { up: boolean; good: number; bad: number; connections: number };
type Mutation = { op: DataOp; key: string; version: number; time: number; values?: Record<string, DataValue> };
type Stored = { entity: EntitySpec; stores: ReturnType<typeof createDataStore>[]; versions: Map<string, number>[]; log: Mutation[]; history: Mutation[][] };
type Message = { owner: RuntimeNode; root: Root; partition: number; sequence: number; ordered: boolean; accepted: number; deliveries: number; visible: boolean; removed: boolean; generation: number };
type RuntimeNode = {
  spec: NodeSpec; rng: Random; state: LiveSnapshot['nodeState'][string]; slow: number; errorRate: number;
  queue: Invocation[]; active: Set<Invocation>; detached: Set<Invocation>; busy: number; last: number; busyArea: number; queueArea: number; startQueue: number; endQueue?: number;
  stats: NodeStats; histogram: Histogram; waitSum: number; waits: number; round: number;
  store: Map<string, Entry>; bytes: number; clock: number; pending: Map<string, { owner: Root; until: number; waiters: Set<Invocation> }>;
  versions: Map<string, number>; effects: Set<string>; health: Map<string, Health>;
  tokens: number; tokenAt: number; windowAt: number; windowCount: number; accepted: number[]; acceptedHead: number;
  data: Map<string, Stored>; leader: number; term: number; unavailable: Set<number>; oldLeaders: Set<number>; generation: number; leaderWrites: Map<string, Map<number, Root>>;
  messages: Map<number, { items: Message[]; head: number }>; messageDepth: number; messageSeq: number; consumed: Map<string, number>;
  breaker: { mode: 'closed' | 'open' | 'halfOpen'; until: number; probes: number; passed: number; inflight: number; results: { time: number; ok: boolean }[] };
  dns?: { target: string; expires: number }; scaleAt: number; scalePending: boolean; ring?: { member: number; token: number }[];
  promotedEvents: Set<string>; failedLeader?: number;
  rowLocks: Set<string>;
  lagSum: number; lagCount: number;
};
type Link = { spec: EdgeSpec; forwardAt: number; reverseAt: number; forwardRng: Random; reverseRng: Random; forwardBusy: number; reverseBusy: number };
type Bucket = { offered: number; succeeded: number; failed: number; hist: Histogram; busy: Record<string, number>; hits: Record<string, number>; misses: Record<string, number> };
const defaultSettings: RunSettings = { traceSampleRate: .02 };
const success = (status: Status) => status >= 200 && status < 300;

export class ExactSimulation implements Simulation {
  private readonly design: Design;
  private readonly scenario: Scenario;
  private readonly settings: RunSettings;
  private readonly seed: number;
  private heap = new EventHeap();
  private nodes = new Map<string, RuntimeNode>();
  private links = new Map<string, Link>();
  private roots = new Set<Root>();
  private violations: Violation[] = [];
  private packets: Packet[] = [];
  private buckets: Bucket[];
  private successHist = new Histogram();
  private allHist = new Histogram();
  private counts = { offered: 0, admitted: 0, succeeded: 0, failed: 0, attempts: 0, good: 0 };
  private statusCounts: RunMetrics['statusCounts'] = {};
  private nextSeq = 0;
  private cursorSeq = -1;
  private requestSeq = 0;
  private eventCount = 0;
  private now = 0;
  private ended = false;
  private reason?: string;
  private liveTasks = 0;
  private queued = 0;
  private retries = 0;
  private endArrival: number;
  private end: number;
  private keyCDF?: Float64Array;
  private clients: Extract<NodeSpec, { kind: 'client' }>[];
  private workloadRng: Random;
  private keyRng: Random;
  private mixRng: Random;
  private mix: [EndpointSpec, number][];
  private ceilings = { ...LIMITS };
  private activeChaos = new Map<string, ChaosEvent>();
  private acknowledged = new Map<string, { version: number; root: Root }>();
  private sessions = new Map<number, Map<string, number>>();
  private sessionReads = new Map<number, Map<string, number>>();
  private edits: LiveEdit[] = [];
  private pendingEdits: { nodeId: string; path: string; value: unknown; acknowledge?: (edit: LiveEdit) => void }[] = [];
  private replayLog: LiveEdit[] = [];
  private originalHash: string;
  private originalChaos: ChaosEvent[];
  private egressCost = 0;
  private requestCost = 0;
  private operationSeq = 0;
  private operationIds = new WeakMap<Step, number>();
  private stateDirty = true;
  private storedMemory = 0;

  constructor(design: Design, scenario: Scenario, seed: number, settings: RunSettings = defaultSettings, manual = false) {
    // Snapshot mutable UI inputs so subsequent editor changes cannot alter a run.
    this.design = structuredClone(design); this.scenario = structuredClone(scenario); this.settings = structuredClone(settings); this.seed = seed;
    this.originalHash = designHash(this.design); this.originalChaos = structuredClone(scenario.chaos);
    this.endArrival = scenario.warmupUs + scenario.measureUs;
    this.end = this.endArrival + scenario.drainUs;
    this.clients = this.design.nodes.filter((n): n is Extract<NodeSpec, { kind: 'client' }> => n.kind === 'client').sort((a, b) => a.id.localeCompare(b.id));
    this.workloadRng = new Random(seed, 'workload:arrivals'); this.keyRng = new Random(seed, 'workload:keys'); this.mixRng = new Random(seed, 'workload:mix');
    const total = Object.values(scenario.workload.mix).reduce((a, b) => a + b, 0);
    this.mix = this.design.endpoints.filter(e => (scenario.workload.mix[e.id] ?? 0) > 0).sort((a, b) => a.id.localeCompare(b.id)).map(e => [e, scenario.workload.mix[e.id] / total]);
    this.buckets = [];
    for (const [key, value] of Object.entries(settings.limits ?? {})) {
      const k = key as keyof NonNullable<RunSettings['limits']>;
      if (!Number.isSafeInteger(value) || value <= 0 || value > LIMITS[k]) throw new Error(`Invalid resource ceiling: ${key}`);
      this.ceilings[k] = value;
    }
    if (!Number.isFinite(seed) || !Number.isFinite(settings.traceSampleRate) || settings.traceSampleRate < 0 || settings.traceSampleRate > 1) throw new Error('Seed and traceSampleRate must be finite; sampling must be in [0,1].');
    const issues = validateDesign(this.design, this.scenario);
    if (issues.length) { this.stop(`Invalid design: ${issues.map(i => `${i.code}: ${i.message}`).join(' ')}`); return; }
    this.buckets = Array.from({ length: Math.ceil(scenario.measureUs / 1e6) }, () => ({ offered: 0, succeeded: 0, failed: 0, hist: new Histogram(), busy: {}, hits: {}, misses: {} }));
    for (const spec of [...this.design.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
      if (spec.kind === 'database' && (spec.params.failover || spec.params.readFromReplicas || spec.params.replicationLag)) spec.params.replication ??= 'async';
      const stats: NodeStats = { nodeId: spec.id, utilisation: 0, avgQueue: 0, maxQueue: 0, drops: 0, errors: 0, served: 0, latency: new Histogram().percentiles(), meanQueueWaitUs: null, inFlight: 0, wastedWork: 0 };
      if (spec.kind === 'cache' || spec.kind === 'cdn') stats.cache = { hits: 0, misses: 0, evictions: 0, hitRate: null };
      if (spec.kind === 'queue') stats.queue = { depthMax: 0, redelivered: 0, deadLettered: 0, consumerLagMax: 0 };
      if (spec.kind === 'circuitBreaker') stats.breaker = { opens: 0, shortCircuited: 0 };
      if (spec.kind === 'autoscaler') stats.autoscale = { minConcurrency: spec.params.max, maxConcurrency: spec.params.min, scaleEvents: 0 };
      this.nodes.set(spec.id, { spec, rng: new Random(seed, spec.id), state: 'up', slow: 1, errorRate: 0, queue: [], active: new Set(), detached: new Set(), busy: 0, last: 0, busyArea: 0, queueArea: 0, startQueue: 0, stats, histogram: new Histogram(), waitSum: 0, waits: 0, round: 0, store: new Map(), bytes: 0, clock: 0, pending: new Map(), versions: new Map(), effects: new Set(), health: new Map(), tokens: spec.kind === 'rateLimiter' ? spec.params.burst : 0, tokenAt: 0, windowAt: 0, windowCount: 0, accepted: [], acceptedHead: 0,
        data: new Map(), leader: 0, term: 0, unavailable: new Set(), oldLeaders: new Set(), generation: 0, leaderWrites: new Map(), messages: new Map(), messageDepth: 0, messageSeq: 0, consumed: new Map(), breaker: { mode: 'closed', until: 0, probes: 0, passed: 0, inflight: 0, results: [] }, scaleAt: -Infinity, scalePending: false, promotedEvents: new Set(), rowLocks: new Set(), lagSum: 0, lagCount: 0 });
    }
    const datasetBytes = (this.design.entities ?? []).reduce((sum, e) => { const n = this.nodes.get(e.store)!; return sum + e.dataset.count * (n.spec.kind === 'database' ? n.spec.params.replicas : n.spec.kind === 'kvStore' ? n.spec.params.members : 1) * (160 + e.fields.length * 48); }, 0);
    if (datasetBytes > this.ceilings.memoryBytes) { this.limit('estimated dataset memory'); return; }
    for (const e of [...this.design.entities ?? []].sort((a, b) => a.name.localeCompare(b.name))) {
      const n = this.nodes.get(e.store)!;
      n.data.set(e.name, this.makeStored(n, e));
      for (const index of this.nodes.values()) if (index.spec.kind === 'searchIndex' && index.spec.params.source === e.store) index.data.set(e.name, this.makeStored(index, e));
    }
    for (const spec of [...this.design.edges].sort((a, b) => a.id.localeCompare(b.id))) {
      const key = this.linkKey(spec.from, spec.to);
      if (!this.links.has(key)) this.links.set(key, { spec, forwardAt: 0, reverseAt: 0, forwardRng: new Random(seed, `edge:${spec.id}:forward`), reverseRng: new Random(seed, `edge:${spec.id}:reverse`), forwardBusy: 0, reverseBusy: 0 });
    }
    for (const c of [...this.scenario.chaos].sort((a, b) => a.atUs - b.atUs || a.id.localeCompare(b.id))) this.installChaos(c);
    if (!manual) {
      for (const n of this.nodes.values()) if (n.spec.kind === 'loadBalancer') this.healthTick(n);
      for (const n of this.nodes.values()) if (n.spec.kind === 'autoscaler') this.scaleTick(n);
      this.scheduleNextArrival(0);
    }
  }

  private linkKey(from: string, to: string) { return `${from.length}:${from}${to}`; }
  private at(time: number, priority: number, run: () => void) {
    if (this.ended) return;
    if (!Number.isSafeInteger(time) || time < this.now) { this.stop('resource limit safe integer time reached; reduce distribution tails or retry backoff.'); return; }
    if (time > this.end) return;
    if (this.heap.size >= this.ceilings.heap) { this.limit('event heap'); return; }
    this.heap.push({ time, priority, seq: this.nextSeq++, run });
  }
  private stop(reason: string) { this.reason = reason; this.ended = true; }
  private limit(name: string) { this.stop(`resource limit ${name} reached at t=${this.now}us; reduce traffic, queue sizes or retries, or use Scale mode.`); }
  private checkLimits() {
    if (this.roots.size + this.liveTasks + this.retries > this.ceilings.liveRequests) this.limit('live requests');
    if (this.queued > this.ceilings.queued) this.limit('queued messages');
    if (this.stateDirty) {
      let keys = 0, records = 0;
      for (const n of this.nodes.values()) {
        keys += n.store.size + n.versions.size + n.effects.size;
        let storeSize = 0;
        for (const d of n.data.values()) { storeSize += Math.max(...d.stores.map(s => s.size)); records += d.stores.reduce((sum, s) => sum + s.size, 0) + d.log.length; }
        if (storeSize > LIMITS.storedKeys || n.store.size > LIMITS.storedKeys || n.effects.size > LIMITS.storedKeys) this.limit('stored keys');
      }
      this.storedMemory = keys * 160 + records * 256; this.stateDirty = false;
    }
    // Reserve the bounded animation buffer: snapshot frequency must not affect limits.
    const bytes = this.heap.size * 192 + this.liveTasks * 512 + this.roots.size * 384 + this.storedMemory + this.acknowledged.size * 256 + 10000 * 128 + (this.keyCDF?.byteLength ?? 0);
    if (bytes > this.ceilings.memoryBytes) this.limit('estimated memory');
  }
  private bucket(time: number) { return this.buckets[Math.floor((time - this.scenario.warmupUs) / 1e6)]; }
  private cohort(time: number) { return time >= this.scenario.warmupUs && time < this.endArrival; }
  private span(root: Root, nodeId: string, kind: Span['kind'], startUs: number, endUs: number, note?: string) {
    if (root.trace && root.trace.spans.length < 10000) root.trace.spans.push({ nodeId, kind, startUs, endUs, ...(note ? { note } : {}) });
  }
  private data(root: Root, s: string) { if (root.trace && root.trace.dataOps.length < 10000) root.trace.dataOps.push(s); }

  private scheduleNextArrival(from: number, budget?: number) {
    const a = this.scenario.workload.arrival;
    let rate = arrivalRate(a, from, this.endArrival);
    let boundary = Infinity;
    if (a.kind === 'step') { if (from < a.stepAtUs) boundary = a.stepAtUs; else rate = a.stepRps; }
    if (a.kind === 'spike') {
      if (from < a.spikeAtUs) boundary = a.spikeAtUs;
      else if (from < a.spikeAtUs + a.spikeDurUs) { rate = a.spikeRps; boundary = a.spikeAtUs + a.spikeDurUs; }
    }
    for (const c of this.activeChaos.values()) if (c.kind === 'trafficSpike') rate *= c.multiplier;
    // shortcut: curves use 10ms rate segments; integrate analytically if finer arrival timing is needed.
    if (a.kind === 'ramp' || a.kind === 'diurnal' || a.kind === 'replay') boundary = Math.min(boundary, from + 10000);
    for (const c of this.scenario.chaos) if (c.kind === 'trafficSpike') for (const t of [c.atUs, c.endUs ?? Infinity]) if (t > from) boundary = Math.min(boundary, t);
    const remaining = budget ?? (a.kind === 'poisson' ? -Math.log(this.workloadRng.next()) * 1e6 : 1e6);
    const delta = rate > 0 ? duration(remaining / rate) : Infinity;
    if (from + delta >= boundary && boundary < this.endArrival) { this.at(boundary, PRIORITY.arrival, () => this.scheduleNextArrival(boundary, Math.max(0, remaining - rate * (boundary - from)))); return; }
    const time = from + delta;
    if (time >= this.endArrival || !Number.isFinite(time)) return;
    this.at(time, PRIORITY.arrival, () => {
      let choice = this.mixRng.next(), endpoint = this.mix[this.mix.length - 1][0];
      for (const [e, weight] of this.mix) { choice -= weight; if (choice <= 0) { endpoint = e; break; } }
      const inputs = endpoint.inputs ? Object.fromEntries(Object.entries(endpoint.inputs).sort(([a], [b]) => a.localeCompare(b)).map(([name, gen]) => [name, sampleInput(gen, this.keyRng)])) : undefined;
      const key = inputs ? renderKey(endpoint.keyTemplate, inputs) : endpoint.keyTemplate.replace(/\{[^}]+\}/g, String(this.nextKey()));
      this.inject(endpoint, key, undefined, inputs);
      this.scheduleNextArrival(this.now);
    });
  }
  private nextKey(): number {
    const d = this.scenario.workload.keys, u = this.keyRng.next();
    if (d.kind === 'sequential') return this.requestSeq % d.n;
    if (d.kind === 'hotspot') return u < d.hotFraction || d.n === 1 ? 0 : 1 + Math.floor((u - d.hotFraction) / (1 - d.hotFraction) * (d.n - 1));
    if (d.kind === 'zipf') {
      if (!this.keyCDF) {
        this.keyCDF = new Float64Array(d.n);
        let sum = 0;
        for (let i = 0; i < d.n; i++) { sum += 1 / (i + 1) ** d.s; this.keyCDF[i] = sum; }
        for (let i = 0; i < d.n; i++) this.keyCDF[i] /= sum;
      }
      let lo = 0, hi = d.n - 1;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (u <= this.keyCDF[mid]) hi = mid; else lo = mid + 1; }
      return lo;
    }
    return Math.floor(u * d.n);
  }

  private inject(endpoint: EndpointSpec, key: string, trace?: TraceResult, inputs?: Root['inputs']): Root {
    const root: Root = { id: `r${this.requestSeq++}`, endpoint, key, start: this.now, deadline: this.now + duration(this.scenario.workload.deadlineUs), cohort: this.cohort(this.now), done: false, rejected: false, invalid: false, good: false, trace };
    root.inputs = inputs;
    if (this.scenario.workload.sessions) root.session = (this.requestSeq - 1) % this.scenario.workload.sessions.count;
    root.required = this.requiredVersions(key, root.session);
    if (endpoint.responseFields) root.responseBytes = endpoint.responseFields.reduce((sum, name) => sum + (this.design.entities?.flatMap(e => e.fields).find(f => f.name === name)?.bytes.meanBytes ?? 0), 0);
    this.roots.add(root);
    if (root.cohort) { this.counts.offered++; this.counts.admitted++; this.counts.attempts++; this.bucket(this.now).offered++; }
    this.at(root.deadline, PRIORITY.timeout, () => {
      if (!root.done) { this.span(root, this.clients[0].id, 'timeout', root.start, this.now, 'logical deadline'); this.finish(root, 504); }
    });
    const client = this.clients[(this.requestSeq - 1) % this.clients.length];
    this.send(client.id, client.params.entry, root, 0, undefined, 0, reply => this.finish(root, reply.status));
    return root;
  }
  private finish(root: Root, status: Status) {
    if (root.done) return;
    root.done = true; this.roots.delete(root);
    if (root.trace) { root.trace.status = status; root.trace.totalUs = this.now - root.start; }
    if (success(status)) this.acknowledge(root);
    if (!root.cohort) return;
    const latency = this.now - root.start;
    this.allHist.add(latency); this.statusCounts[status] = (this.statusCounts[status] ?? 0) + 1;
    const bucket = this.bucket(root.start);
    bucket.hist.add(latency);
    if (success(status)) {
      this.counts.succeeded++; this.successHist.add(latency); bucket.succeeded++;
      root.good = !root.invalid && this.now <= root.deadline;
      if (root.good) this.counts.good++;
    } else { this.counts.failed++; bucket.failed++; }
  }
  private reject(root: Root) {
    if (!root.rejected) { root.rejected = true; if (root.cohort && !root.background) this.counts.admitted--; }
  }

  private network(from: string, to: string, root: Root, reverse: boolean, receive: () => void) {
    const link = this.links.get(this.linkKey(from, to));
    if (!link) return;
    const rng = reverse ? link.reverseRng : link.forwardRng;
    const bytes = reverse ? root.responseBytes ?? root.endpoint.responseBytes : root.endpoint.requestBytes;
    const serial = duration(bytes * 1e6 / link.spec.bandwidthBytesPerSec);
    const depart = this.now, start = Math.max(this.now, reverse ? link.reverseAt : link.forwardAt), ready = start + serial;
    if (reverse) link.reverseAt = ready; else link.forwardAt = ready;
    const busy = Math.max(0, Math.min(ready, this.endArrival) - Math.max(start, this.scenario.warmupUs));
    if (reverse) link.reverseBusy += busy; else link.forwardBusy += busy;
    const source = reverse ? to : from, target = reverse ? from : to;
    let latency = 0, survival = 1 - link.spec.lossRate, partition = false;
    for (const c of this.activeChaos.values()) {
      if (c.kind === 'linkLatency' && c.target === link.spec.id) latency += c.addUs;
      if (c.kind === 'linkLoss' && c.target === link.spec.id) survival *= 1 - c.lossRate;
      if (c.kind === 'partition' && c.links.some(l => l.from === source && l.to === target)) partition = true;
    }
    const regions = this.design.regions;
    if (regions) {
      const region = (id: string) => { const p = this.nodes.get(id)?.spec.params; return p && 'region' in p ? p.region : undefined; };
      const a = region(source), b = region(target);
      if (a && b && a !== b) {
        const i = regions.names.indexOf(a), j = regions.names.indexOf(b);
        if (i >= 0 && j >= 0) { latency += regions.latencyUs[i][j]; if (root.cohort) this.egressCost += bytes / 1e9 * regions.egressCostPerGB[i][j]; }
      }
    }
    const arrive = ready + rng.sample(link.spec.latency) + Math.ceil(latency), ok = rng.next() >= 1 - survival && !partition;
    this.span(root, target, 'network', depart, arrive, ok ? undefined : 'packet lost');
    if (hash32(`visual:${this.seed}:${root.id}`) / 4294967296 < this.settings.traceSampleRate && this.packets.length < 10000) this.packets.push({ requestId: root.id, from: source, to: target, departUs: depart, arriveUs: arrive, ok });
    if (ok) this.at(arrive, reverse ? PRIORITY.response : PRIORITY.arrival, receive);
  }
  private send(from: string, to: string, root: Root, depth: number, op: Invocation['op'], version: number, reply: (r: Reply) => void, parent?: Invocation, step?: RequestStep, deadline?: number): { cancel: () => void; abandon: () => void } {
    let invocation: Invocation | undefined, cancelled = false, abandoned = false;
    const handle = {
      cancel: () => { cancelled = true; parent?.cancelChildren.delete(handle.cancel); if (invocation) this.cancel(invocation); },
      abandon: () => { abandoned = true; if (invocation) { invocation.abandoned = true; if (invocation.completed) this.wasted(invocation); } },
    };
    parent?.cancelChildren.add(handle.cancel);
    this.network(from, to, root, false, () => {
      if (cancelled) return;
      const node = this.nodes.get(to);
      if (!node || node.state === 'down' || node.state === 'restarting') return;
      if (depth > 32) { this.limit('route recursion depth 32'); return; }
      invocation = { root, node, arrival: this.now, live: true, completed: false, wasted: false, released: false, abandoned, parent,
        reply: r => { parent?.cancelChildren.delete(handle.cancel); this.network(from, to, root, true, () => { if (!cancelled) reply(r); }); },
        children: new Set(), cancelChildren: new Set(), depth, op, version, hit: false, step, deadline };
      parent?.children.add(invocation);
      this.liveTasks++;
      this.admit(invocation);
    });
    return handle;
  }
  private capacity(n: RuntimeNode) {
    const s = n.spec;
    if (s.kind === 'client' || s.kind === 'autoscaler') return 0;
    if ('concurrency' in s.params) return s.kind === 'database' ? Math.min(s.params.connectionPool ?? Infinity, s.params.concurrency * (s.params.replication ? 1 : s.params.replicas)) : s.params.concurrency;
    if (s.kind === 'circuitBreaker') return this.ceilings.liveRequests;
    return this.ceilings.liveRequests;
  }
  private touch(n: RuntimeNode) {
    if (n.last < this.scenario.warmupUs && this.now >= this.scenario.warmupUs) { n.startQueue = n.queue.length; n.stats.maxQueue = Math.max(n.stats.maxQueue, n.queue.length); }
    if (n.last < this.endArrival && this.now >= this.endArrival) n.endQueue = n.queue.length;
    const start = Math.max(n.last, this.scenario.warmupUs), end = Math.min(this.now, this.endArrival);
    if (end > start) {
      n.busyArea += n.busy * (end - start); n.queueArea += n.queue.length * (end - start);
      let t = start;
      while (t < end) { const b = this.bucket(t); const e = Math.min(end, this.scenario.warmupUs + (Math.floor((t - this.scenario.warmupUs) / 1e6) + 1) * 1e6); b.busy[n.spec.id] = (b.busy[n.spec.id] ?? 0) + n.busy * (e - t); t = e; }
    }
    n.last = this.now;
  }
  private admit(inv: Invocation) {
    const n = inv.node;
    this.touch(n);
    if (n.spec.kind === 'client') { this.complete(inv, { status: 503 }); return; }
    if (n.busy < this.capacity(n) && !n.rowLocks.has(this.lockKey(inv) ?? '')) this.start(inv);
    else if ('queueCapacity' in n.spec.params && n.queue.length < n.spec.params.queueCapacity) {
      n.queue.push(inv); this.queued++;
      if (this.cohort(this.now)) n.stats.maxQueue = Math.max(n.stats.maxQueue, n.queue.length);
    } else {
      if (inv.root.cohort) n.stats.drops++;
      this.reject(inv.root); this.complete(inv, { status: 503 });
    }
  }
  private start(inv: Invocation) {
    if (!inv.live) return;
    const n = inv.node, s = n.spec;
    if (s.kind === 'client') return;
    this.touch(n); n.busy++; n.active.add(inv); inv.started = this.now;
    const lock = this.lockKey(inv); if (lock) n.rowLocks.add(lock);
    if (inv.root.cohort) { n.waitSum += this.now - inv.arrival; n.waits++; }
    this.span(inv.root, s.id, 'queue', inv.arrival, this.now);
    if (inv.deadline !== undefined && this.now >= inv.deadline) { this.complete(inv, { status: 504 }); return; }
    if (s.kind === 'dedupStore' && !s.params.atomic) inv.dedupSeen = this.dedupExists(n, inv.root);
    const isWrite = inv.step?.type === 'data' ? !['get', 'query'].includes(inv.step.op.kind) : inv.root.endpoint.op === 'write';
    const d: Dist = s.kind === 'database' || s.kind === 'kvStore' || s.kind === 'objectStore' ? (isWrite ? s.params.writeTime : s.params.readTime) : s.kind === 'dns' ? (n.dns && n.dns.expires > this.localTime(n) ? { kind: 'constant', us: 1 } : s.params.resolutionTime) : s.kind === 'queue' ? s.params.publishTime : 'serviceTime' in s.params ? s.params.serviceTime : { kind: 'constant', us: 1 };
    let serviceUs = n.rng.sample(d);
    if (s.kind === 'rateLimiter' && s.params.centralised) { const link = [...this.links.values()].find(l => l.spec.from === s.id); if (link) serviceUs += 2 * n.rng.sample(link.spec.latency); }
    if (inv.step?.type === 'data') { const e = n.data.get(inv.step.entity)?.entity; if (e) serviceUs = dataCostUs(inv.step.op, e, serviceUs); }
    const finish = this.now + duration(serviceUs * n.slow);
    this.at(finish, PRIORITY.completion, () => {
      if (!inv.live) return;
      this.span(inv.root, s.id, 'service', inv.started!, this.now);
      if (inv.op === 'probe') { this.complete(inv, { status: 200 }); return; }
      if (n.errorRate > 0 && n.rng.next() < n.errorRate) { this.complete(inv, { status: 503 }); return; }
      if (inv.step?.type === 'data') { this.storage(inv); return; }
      switch (s.kind) {
        case 'service': case 'worker': this.program(inv, s.handlers?.[inv.root.endpoint.id] ?? [{ type: 'respond', status: 200 }]); break;
        case 'database': this.database(inv); break;
        case 'kvStore': case 'objectStore': case 'searchIndex': this.storage(inv); break;
        case 'cache': this.cache(inv); break;
        case 'loadBalancer': this.balance(inv); break;
        case 'rateLimiter': this.rateLimit(inv); break;
        case 'dns': this.dns(inv); break;
        case 'cdn': this.cdn(inv); break;
        case 'apiGateway': if (inv.root.endpoint.requestBytes > s.params.maxRequestBytes) { this.reject(inv.root); this.complete(inv, { status: 409 }); } else this.forward(inv); break;
        case 'dedupStore': this.dedup(inv); break;
        case 'queue': this.publish(inv); break;
        case 'circuitBreaker': this.breaker(inv); break;
        case 'autoscaler': this.complete(inv, { status: 503 }); break;
      }
    });
  }
  private release(inv: Invocation) {
    if (inv.released) return;
    inv.released = true;
    const n = inv.node;
    this.touch(n);
    if (n.active.delete(inv)) { n.busy--; const lock = this.lockKey(inv); if (lock) n.rowLocks.delete(lock); }
    while (n.state !== 'down' && n.state !== 'restarting' && n.busy < this.capacity(n) && n.queue.length) {
      const next = this.pull(n); if (!next) break; this.start(next);
    }
  }
  private lockKey(inv: Invocation) {
    if (inv.node.spec.kind !== 'database' || !inv.node.spec.params.replication && !inv.node.data.size) return undefined;
    const write = inv.step?.type === 'data' ? !['get', 'query'].includes(inv.step.op.kind) : inv.root.endpoint.op === 'write';
    return write ? `${inv.step?.type === 'data' ? inv.step.entity : '__default'}:${inv.root.key}` : undefined;
  }
  private pull(n: RuntimeNode) {
    const eligible = (inv: Invocation) => !n.rowLocks.has(this.lockKey(inv) ?? '');
    const index = 'queueDiscipline' in n.spec.params && n.spec.params.queueDiscipline === 'lifo' ? n.queue.findLastIndex(eligible) : n.queue.findIndex(eligible);
    if (index < 0) return undefined;
    this.queued--; return n.queue.splice(index, 1)[0];
  }
  private complete(inv: Invocation, r: Reply) {
    if (!inv.live) return;
    inv.live = false; inv.completed = true; this.liveTasks--;
    inv.parent?.children.delete(inv); inv.cleanup?.();
    inv.node.detached.delete(inv); inv.wait?.(); this.release(inv);
    if (inv.root.cohort && !inv.virtual) {
      inv.node.stats.served++; inv.node.histogram.add(this.now - inv.arrival);
      if (!success(r.status)) inv.node.stats.errors++;
      if (inv.root.done || inv.abandoned) this.wasted(inv);
    }
    inv.reply(r);
  }
  private wasted(inv: Invocation) {
    if (!inv.wasted && inv.root.cohort) { inv.wasted = true; inv.node.stats.wastedWork!++; }
  }
  private cancel(inv: Invocation, cascade = true) {
    if (!inv.live) return;
    inv.live = false; this.liveTasks--; inv.wait?.(); inv.node.detached.delete(inv);
    inv.parent?.children.delete(inv); inv.cleanup?.();
    const n = inv.node, index = n.queue.indexOf(inv);
    if (index >= 0) { this.touch(n); n.queue.splice(index, 1); this.queued--; }
    if (cascade) {
      for (const child of inv.children) this.cancel(child);
      for (const cancel of inv.cancelChildren) cancel();
    } else for (const child of inv.children) { if (child.virtual) this.cancel(child, false); else { child.abandoned = true; if (child.completed) this.wasted(child); } }
    this.release(inv);
  }

  private program(inv: Invocation, steps: Step[], index = 0) {
    if (!inv.live) return;
    const s = steps[index];
    if (!s) { this.complete(inv, { status: 200, version: inv.version }); return; }
    const next = () => this.program(inv, steps, index + 1);
    if (s.type === 'respond') { this.complete(inv, { status: s.status, version: inv.version }); return; }
    if (s.type === 'branch') {
      const c = s.cond;
      const yes = c.kind === 'cacheHit' ? inv.hit : c.kind === 'found' ? inv.found === true : c.kind === 'dedupHit' ? inv.dedupHit === true : c.kind === 'leaderAlive' ? ['up', 'degraded', 'gray'].includes(this.nodes.get(c.store)?.state ?? 'down') : c.kind === 'breakerClosed' ? this.nodes.get(c.breaker)?.breaker.mode === 'closed' : inv.node.rng.next() < c.p;
      this.program(inv, [...(yes ? s.then : s.else), ...steps.slice(index + 1)]); return;
    }
    if (s.type === 'parallel') { this.parallel(inv, s, r => { if (success(r.status)) next(); else this.complete(inv, r); }); return; }
    const target = s.type === 'call' || s.type === 'data' ? s.target : s.type === 'publish' ? s.queue : s.type === 'dedup' ? s.store : s.cache;
    this.call(inv, target, s, r => {
      if (s.type === 'cacheGet') inv.hit = success(r.status) && r.hit === true;
      if (s.type === 'dedup') inv.dedupHit = r.dedupHit;
      if (s.type === 'data') inv.found = r.found;
      if (r.source) inv.source = r.source;
      if (r.version !== undefined) inv.version = r.version;
      if (s.type === 'data' && r.status === 404 && steps[index + 1]?.type === 'branch') next();
      else if (s.type !== 'cacheGet' && s.type !== 'cacheSet' && s.type !== 'cacheDelete' && !success(r.status)) this.complete(inv, r);
      else if (s.type === 'data' && index === steps.length - 1) this.complete(inv, r);
      else next();
    });
  }
  private parallel(inv: Invocation, s: Extract<Step, { type: 'parallel' }>, done: (r: Reply) => void) {
    let completed = 0, succeeded = 0, settled = false, failure: Reply | undefined;
    const children: Invocation[] = [];
    const required = s.join.kind === 'quorum' ? s.join.k : s.join.kind === 'firstN' ? s.join.n : s.join.kind === 'all' ? s.branches.length : 1;
    for (let i = 0; i < s.branches.length; i++) {
      const child: Invocation = { ...inv, parent: inv, live: true, completed: false, released: true, virtual: true, children: new Set(), cancelChildren: new Set(), cleanup: undefined, wait: undefined, reply: r => {
        completed++; if (success(r.status)) succeeded++; else failure ??= r;
        if (settled || !inv.live) return;
        const joined = s.join.kind === 'firstN' ? completed >= required : succeeded >= required;
        const impossible = s.join.kind !== 'firstN' && s.branches.length - completed + succeeded < required;
        if (joined || impossible) {
          settled = true;
          if (s.cancelLosers) for (const loser of children) if (loser.live) this.cancel(loser);
          if (r.version !== undefined) inv.version = r.version;
          done(joined && (s.join.kind !== 'firstN' || succeeded === required) ? { status: 200 } : failure ?? { status: 503 });
        }
      } };
      inv.children.add(child); inv.node.detached.add(child); this.liveTasks++; children.push(child);
    }
    children.forEach((child, i) => this.program(child, s.branches[i]));
  }
  private call(inv: Invocation, target: string, step: RequestStep, done: (r: Reply) => void) {
    let number = 0;
    const attempt = () => {
      if (!inv.live) return;
      const policy = step.type === 'call' || step.type === 'data' ? step.retry : undefined;
      const retry = policy ? { ...policy, retryOn: [...policy.retryOn] } : undefined;
      let settled = false;
      const start = this.now;
      const op = step.type === 'cacheGet' ? 'get' : step.type === 'cacheSet' ? 'set' : step.type === 'cacheDelete' ? 'delete' : undefined;
      const deadline = step.type === 'call' && step.propagateDeadline ? Math.min(inv.deadline ?? inv.root.deadline, this.now + step.timeoutUs) : inv.deadline;
      const handle = this.send(inv.node.spec.id, target, inv.root, inv.depth + 1, op, inv.version, r => settle(r), inv, step, deadline);
      const settle = (r: Reply, timedOut = false) => {
        if (settled || !inv.live) return;
        settled = true;
        if (timedOut) {
          handle.abandon();
          this.span(inv.root, inv.node.spec.id, 'timeout', start, this.now, `waiting for ${target}`);
          if (step.type === 'call' && step.cancelOnTimeout) handle.cancel();
        }
        const category = timedOut ? 'timeout' : r.status === 429 ? '429' : r.status >= 500 ? '5xx' : undefined;
        if (retry && category && retry.retryOn.includes(category) && number < retry.max && !inv.root.done) {
          let backoff = retry.backoffUs * retry.multiplier ** number;
          if (retry.jitter === 'full') backoff *= inv.node.rng.next();
          const at = this.now + duration(backoff);
          this.span(inv.root, inv.node.spec.id, 'retryBackoff', this.now, at);
          number++; this.retries++;
          this.at(at, PRIORITY.retry, () => { this.retries--; if (inv.live && !inv.root.done) { if (inv.root.cohort && !inv.root.background) this.counts.attempts++; attempt(); } });
        } else done(r);
      };
      this.at(Math.min(this.now + duration(step.timeoutUs), deadline ?? Infinity), PRIORITY.timeout, () => settle({ status: 504 }, true));
    };
    attempt();
  }

  private database(inv: Invocation) {
    const n = inv.node, root = inv.root;
    if (n.spec.kind === 'database' && (n.spec.params.replication || n.spec.params.walDurable !== undefined || n.data.size)) { this.storage(inv); return; }
    let version = n.versions.get(root.key) ?? 0;
    if (root.endpoint.op === 'write') {
      this.stateDirty = true;
      if (!root.endpoint.idempotent || !n.effects.has(root.id)) {
        if (!root.endpoint.idempotent && n.effects.has(root.id)) {
          this.violation('duplicateEffect', root, `Non-idempotent write applied again at ${n.spec.id} for ${root.key}.`);
        }
        version++; n.versions.set(root.key, version); n.effects.add(root.id);
        if (n.versions.size > LIMITS.storedKeys || n.effects.size > LIMITS.storedKeys) this.limit('stored keys');
      }
      this.data(root, `DB write ${root.key} v${version}`);
    } else this.data(root, `DB read ${root.key} v${version}`);
    this.complete(inv, { status: 200, version });
  }
  private makeStored(n: RuntimeNode, entity: EntitySpec): Stored {
    const count = n.spec.kind === 'database' ? n.spec.params.replicas : n.spec.kind === 'kvStore' ? n.spec.params.members : 1;
    return { entity, stores: Array.from({ length: count }, () => createDataStore(entity, new Random(this.seed, `dataset:${entity.name}`))), versions: Array.from({ length: count }, () => new Map()), log: [], history: Array.from({ length: count }, () => []) };
  }
  private violation(kind: Violation['kind'], root: Root, detail: string, others: Root[] = []) {
    const affected = [root, ...others].map(r => r.origin ?? r);
    this.violations.push({ kind, timeUs: this.now, requestIds: [...new Set(affected.map(r => r.id))], detail });
    for (const r of affected) { r.invalid = true; if (r.good) { r.good = false; if (r.cohort) this.counts.good--; } }
  }
  private acknowledge(root: Root) {
    for (const [key, version] of root.writes ?? []) {
      const old = this.acknowledged.get(key);
      if (!old || old.version < version) this.acknowledged.set(key, { version, root });
      if (root.session !== undefined) this.remember(root.session, key, version);
      for (const n of this.nodes.values()) if (n.spec.kind === 'database') for (const [name, d] of n.data) {
        const prefix = `${n.spec.id}:${name}:`;
        if (key.startsWith(prefix) && root.writeEpoch?.get(key) !== n.generation) this.checkAcknowledged(n, d, key, key.slice(prefix.length), { version, root });
      }
    }
  }
  private requiredVersions(key: string, session?: number) {
    const state = session === undefined ? undefined : this.sessions.get(session);
    if (!this.acknowledged.size && !state?.size) return undefined;
    const required = new Map<string, number>();
    for (const n of this.nodes.values()) for (const name of n.data.keys()) {
      const k = `${n.spec.id}:${name}:${key}`, version = Math.max(this.acknowledged.get(k)?.version ?? -1, state?.get(k) ?? -1);
      if (version >= 0) required.set(k, version);
    }
    return required;
  }
  private remember(session: number, key: string, version: number, read = false) {
    let state = this.sessions.get(session);
    if (!state) { state = new Map(); this.sessions.set(session, state); }
    state.set(key, Math.max(state.get(key) ?? -1, version));
    if (read) {
      let reads = this.sessionReads.get(session); if (!reads) { reads = new Map(); this.sessionReads.set(session, reads); }
      reads.set(key, Math.max(reads.get(key) ?? -1, version));
    }
  }
  private readVersion(inv: Invocation, key: string, version: number) {
    const r = inv.root, prior = r.required?.get(key) ?? -1, session = r.session === undefined ? -1 : this.sessionReads.get(r.session)?.get(key) ?? -1;
    if (version < Math.max(prior, session)) this.violation('staleRead', r, `${key} returned v${version}; required v${Math.max(prior, session)} (acked before read / session read-your-writes or monotonic read).`);
    if (r.session !== undefined) this.remember(r.session, key, version, true);
  }
  private owners(n: RuntimeNode, key: string): number[] {
    if (n.spec.kind !== 'kvStore') return [n.leader];
    const p = n.spec.params;
    if (!n.ring) n.ring = Array.from({ length: p.members }, (_, member) => Array.from({ length: p.vnodes }, (_, v) => ({ member, token: hash32(`${n.spec.id}:${member}:${v}`) }))).flat().sort((a, b) => a.token - b.token || a.member - b.member);
    const token = hash32(key), start = n.ring.findIndex(v => v.token >= token), result: number[] = [];
    for (let i = 0; i < n.ring.length && result.length < p.replicationFactor; i++) {
      const member = n.ring[((start < 0 ? 0 : start) + i) % n.ring.length].member;
      if (!result.includes(member)) result.push(member);
    }
    return result;
  }
  private applyReplica(d: Stored, member: number, record: Stored['log'][number]) {
    if (!d.stores[member] || (d.versions[member].get(record.key) ?? -1) >= record.version) return;
    const op: DataOp = record.op.kind === 'delete' ? { kind: 'delete' } : { kind: 'put', values: record.values };
    d.stores[member].apply(op, record.key, this.now);
    d.versions[member].set(record.key, record.version);
    d.history[member].push(record);
    this.stateDirty = true;
  }
  private storage(inv: Invocation) {
    const n = inv.node, s = n.spec, root = inv.root;
    const step = inv.step?.type === 'data' ? inv.step : undefined;
    const name = step?.entity ?? n.data.keys().next().value ?? '__default';
    let d = n.data.get(name);
    if (!d) {
      const entity: EntitySpec = { name, store: s.id, primaryKey: 'id', fields: [{ name: 'id', type: 'int', bytes: { meanBytes: 8, sdBytes: 0 } }], indexes: [], dataset: { count: 0, keys: { kind: 'uniform', n: 1 } } };
      d = this.makeStored(n, entity); n.data.set(name, d);
    }
    let op: DataOp = step?.op ?? (root.endpoint.op === 'write' ? { kind: 'put' } : { kind: 'get' });
    if (op.kind === 'conditionalPut' && op.expectedVersion === undefined) op = { ...op, expectedVersion: inv.version };
    const write = !['get', 'query'].includes(op.kind);
    const source = s.kind === 'searchIndex' ? s.params.source : s.id;
    const dataKey = `${source}:${name}:${root.key}`;
    let members = this.owners(n, root.key), member = n.leader;
    if (s.kind === 'kvStore') {
      const count = write ? s.params.writeQuorum : s.params.readQuorum;
      if (!write) { const shift = n.round++ % members.length; members = [...members.slice(shift), ...members.slice(0, shift)]; }
      members = members.filter(m => !n.unavailable.has(m));
      if (members.length < count) { this.complete(inv, { status: 503 }); return; }
      members = members.slice(0, count);
      member = members.reduce((best, m) => (d!.versions[m].get(root.key) ?? 0) > (d!.versions[best].get(root.key) ?? 0) ? m : best, members[0]);
    } else if (s.kind === 'database' && !write && s.params.readFromReplicas && s.params.replicas > 1) {
      const available = Array.from({ length: s.params.replicas }, (_, i) => i).filter(i => i !== n.leader && !n.unavailable.has(i));
      if (available.length) member = available[n.round++ % available.length];
    } else if (s.kind === 'database' && write && n.oldLeaders.size && !s.params.failover?.fencing && n.round++ % 2) member = [...n.oldLeaders][0];
    if (s.kind === 'searchIndex' && write) { this.complete(inv, { status: 409 }); return; }
    if (s.kind === 'objectStore' && root.cohort) this.requestCost += s.params.costPerMillionRequests / 1e6;
    const previousVersion = Math.max(...d.versions.map((v, i) => v.get(root.key) ?? d!.stores[i].snapshotVersion(root.key) ?? 0));
    if (op.kind === 'conditionalPut') {
      if (op.expectedVersion !== (d.versions[member].get(root.key) ?? d.stores[member].snapshotVersion(root.key))) { this.complete(inv, { status: 409, found: true }); return; }
      op = { ...op, expectedVersion: d.stores[member].snapshotVersion(root.key) };
    }
    const result = d.stores[member].apply(op, root.key, this.now);
    let version = d.versions[member].get(root.key) ?? result.version ?? 0;
    if (!write) {
      if (s.kind !== 'cache' || result.found) this.readVersion(inv, dataKey, result.found || d.versions[member].has(root.key) ? version : -1);
      const row = root.endpoint.responseFields ? d.stores[member].read(root.key) : undefined;
      if (row) root.responseBytes = root.endpoint.responseFields!.reduce((sum, name) => sum + (row.fieldBytes[name] ?? 0), 0);
      if (s.kind === 'kvStore' && s.params.readRepair) {
        const records = d.log.filter(r => r.key === root.key && r.version <= version);
        for (const m of members) for (const record of records) this.applyReplica(d, m, record);
      }
      this.data(root, `${s.kind} ${op.kind} ${name}/${root.key} member ${member} v${version}${result.found ? '' : ' MISSING'}`);
      this.complete(inv, { ...result, version, source: dataKey }); return;
    }
    if (!success(result.status)) { this.complete(inv, result); return; }
    this.stateDirty = true;
    version = previousVersion + 1;
    d.versions[member].set(root.key, version);
    const record: Mutation = { op, key: root.key, version, time: this.now, values: d.stores[member].read(root.key)?.values }; d.log.push(record); d.history[member].push(record);
    if (step && !this.operationIds.has(step)) this.operationIds.set(step, this.operationSeq++);
    const effect = `${root.id}:${name}:${step ? this.operationIds.get(step) : 'call'}`;
    if (n.effects.has(effect) && (op.kind === 'update' && op.op !== 'set' || op.kind === 'decrementIfPositive' || !step && !root.endpoint.idempotent)) this.violation('duplicateEffect', root, `Repeated logical effect at ${s.id}/${name}/${root.key}.`);
    n.effects.add(effect);
    if (op.kind === 'update' || op.kind === 'decrementIfPositive') {
      if (Number(d.stores[member].read(root.key)?.values[op.field]) < 0) this.violation('oversell', root, `${name}/${root.key}.${op.field} fell below zero.`);
    }
    if (s.kind === 'database') {
      let leaders = n.leaderWrites.get(root.key); if (!leaders) { leaders = new Map(); n.leaderWrites.set(root.key, leaders); }
      if (n.oldLeaders.size && !s.params.failover?.fencing && [...leaders.keys()].some(m => m !== member)) {
        this.violation('splitBrainWrite', root, `Leaders in overlapping terms accepted writes at ${s.id}/${root.key} without fencing.`, [...leaders.values()]);
        if (op.kind === 'insert' && d.entity.indexes.some(i => i.unique)) this.violation('uniquenessViolated', root, `Two unfenced leaders inserted the unique key ${root.key}.`, [...leaders.values()]);
      }
      leaders.set(member, root);
      if (n.oldLeaders.size && !s.params.failover?.fencing) for (const index of d.entity.indexes.filter(i => i.unique)) {
        const current = d.stores[member].read(root.key);
        for (const [otherKey, writers] of n.leaderWrites) for (const [otherMember, otherRoot] of writers) if (otherMember !== member && otherKey !== root.key) {
          const other = d.stores[otherMember].read(otherKey);
          if (current && other && index.fields.every(field => current.values[field] === other.values[field])) this.violation('uniquenessViolated', root, `Unfenced leaders accepted the same unique ${index.name} value.`, [otherRoot]);
        }
      }
    }
    root.writes ??= new Map(); root.writeEpoch ??= new Map();
    root.writes.set(dataKey, version); root.writeEpoch.set(dataKey, n.generation);
    const ack = () => { this.data(root, `${s.kind} ${op.kind} ${name}/${root.key} member ${member} v${version}`); this.complete(inv, { ...result, version }); };
    if (s.kind === 'database' && s.params.replication) {
      const generation = n.generation, lag = s.params.replicationLag ? n.rng.sample(s.params.replicationLag) : 1;
      const replicas = Array.from({ length: s.params.replicas }, (_, i) => i).filter(i => i !== member && !n.unavailable.has(i));
      const required = s.params.replication === 'sync' ? s.params.replicas - 1 : s.params.replication === 'semiSync' && s.params.replicas > 1 ? 1 : 0;
      if (required > replicas.length) return;
      let shipped = 0;
      for (const replica of replicas) this.at(this.now + lag, PRIORITY.completion, () => {
        if (generation !== n.generation || n.unavailable.has(replica)) return;
        this.applyReplica(d!, replica, record); shipped++;
        n.lagSum += lag; n.lagCount++;
        n.stats.replicationLagUs = { mean: n.lagSum / n.lagCount, max: Math.max(n.stats.replicationLagUs?.max ?? 0, lag) };
        if (required && shipped === required) ack();
      });
      if (!required) ack();
    } else {
      if (s.kind === 'kvStore') {
        for (const replica of members) if (replica !== member) this.applyReplica(d, replica, record);
        if (s.params.hintedHandoff) for (const replica of this.owners(n, root.key)) if (!members.includes(replica)) this.at(this.now + duration(n.rng.sample(s.params.writeTime) * 10), PRIORITY.completion, () => { if (!n.unavailable.has(replica)) this.applyReplica(d!, replica, record); });
        if (op.kind === 'delete') this.at(this.now + s.params.tombstoneGcUs, PRIORITY.completion, () => { for (const v of d!.versions) if (v.get(root.key) === version) v.delete(root.key); });
      }
      ack();
    }
    for (const index of this.nodes.values()) if (index.spec.kind === 'searchIndex' && index.spec.params.source === s.id) {
      const copy = index.data.get(name);
      if (copy) this.at(this.now + index.rng.sample(index.spec.params.indexLag), PRIORITY.completion, () => { if (index.state !== 'down' && index.state !== 'restarting') { this.applyReplica(copy, 0, record); copy.log.push(record); } });
    }
  }
  private localTime(n: RuntimeNode) {
    let time = this.now;
    for (const c of this.activeChaos.values()) if (c.kind === 'clockSkew' && c.target === n.spec.id) time += c.skewUs;
    return time;
  }
  private forward(inv: Invocation, target = this.outgoing(inv.node)[0], done = (r: Reply) => this.complete(inv, r)) {
    if (!target) { done({ status: 503 }); return; }
    this.call(inv, target, { type: 'call', target, timeoutUs: Math.max(1, (inv.deadline ?? inv.root.deadline) - this.now), propagateDeadline: inv.deadline !== undefined }, done);
  }
  private dns(inv: Invocation) {
    const n = inv.node;
    if (n.spec.kind !== 'dns') return;
    if (!n.dns || n.dns.expires <= this.localTime(n)) {
      const target = n.spec.params.records.find(id => { const state = this.nodes.get(id)?.state; return state !== 'down' && state !== 'restarting'; });
      if (!target) { this.complete(inv, { status: 503 }); return; }
      n.dns = { target, expires: this.localTime(n) + n.spec.params.ttlUs };
    }
    this.forward(inv, n.dns.target);
  }
  private dedupExists(n: RuntimeNode, root: Root) { return (n.store.get(String(root.inputs?.idempotencyKey ?? root.id))?.expires ?? -Infinity) > this.localTime(n); }
  private dedup(inv: Invocation) {
    const n = inv.node;
    if (n.spec.kind !== 'dedupStore') return;
    const hit = n.spec.params.atomic ? this.dedupExists(n, inv.root) : inv.dedupSeen === true;
    if (!hit) {
      this.stateDirty = true;
      const key = String(inv.root.inputs?.idempotencyKey ?? inv.root.id);
      n.store.set(key, { bytes: 64, version: 0, expires: this.localTime(n) + n.spec.params.ttlUs, used: ++n.clock, frequency: 1 });
      this.at(this.now + n.spec.params.ttlUs, PRIORITY.completion, () => { if ((n.store.get(key)?.expires ?? Infinity) <= this.localTime(n)) { n.store.delete(key); this.stateDirty = true; } });
    }
    this.data(inv.root, `dedup ${hit ? 'HIT' : 'INSERT'} ${inv.root.id}`);
    this.complete(inv, { status: 200, dedupHit: hit });
  }
  private cdn(inv: Invocation) {
    const n = inv.node;
    if (n.spec.kind !== 'cdn') return;
    const p = n.spec.params, root = inv.root;
    const parent = inv.parent?.node.spec.params;
    const region = parent && 'region' in parent ? parent.region : p.region;
    const prefix = `${region.length}:${region}:`, key = prefix + root.key;
    const entry = n.store.get(key), fresh = entry && entry.expires > this.localTime(n);
    if (root.cohort) this.egressCost += (root.responseBytes ?? root.endpoint.responseBytes) / 1e9 * p.costPerGB;
    if (fresh) { entry.used = ++n.clock; entry.frequency++; this.cacheCount(inv, true); if (entry.source) this.readVersion(inv, entry.source, entry.version); this.complete(inv, { status: 200, hit: true, version: entry.version, source: entry.source }); return; }
    this.cacheCount(inv, false);
    const fill = (waiter: Invocation, r: Reply) => {
      if (success(r.status)) {
        this.stateDirty = true;
        if (r.source) this.readVersion(waiter, r.source, r.version ?? 0);
        const origin = waiter.parent?.node.spec.params;
        const region = origin && 'region' in origin ? origin.region : p.region, prefix = `${region.length}:${region}:`, key = prefix + root.key;
        const bytes = (root.responseBytes ?? root.endpoint.responseBytes) + key.length * 2;
        const old = n.store.get(key); if (old) { n.bytes -= old.bytes; n.store.delete(key); }
        this.evict(n, p.capacityBytes - bytes, prefix);
        if (bytes <= p.capacityBytes) { n.store.set(key, { bytes, version: r.version ?? 0, source: r.source, expires: this.localTime(n) + (p.ttlUs ?? Number.MAX_SAFE_INTEGER - this.now), frequency: 1, used: ++n.clock }); n.bytes += bytes; }
      }
      if (!success(r.status) && entry?.source) this.readVersion(waiter, entry.source, entry.version);
      this.complete(waiter, !success(r.status) && entry ? { status: 200, hit: true, version: entry.version, source: entry.source } : r);
    };
    const pending = n.pending.get(root.key);
    if (p.originShield && pending) { pending.waiters.add(inv); n.detached.add(inv); inv.wait = () => pending.waiters.delete(inv); this.release(inv); return; }
    if (p.originShield) n.pending.set(root.key, { owner: root, until: root.deadline, waiters: new Set() });
    this.forward(inv, undefined, r => {
      const pending = n.pending.get(root.key); n.pending.delete(root.key);
      fill(inv, r); for (const waiter of pending?.waiters ?? []) fill(waiter, r);
    });
  }
  private evict(n: RuntimeNode, capacity: number, prefix = '') {
    this.stateDirty = true;
    const p = n.spec.params;
    if (!('eviction' in p)) return;
    const entries = [...n.store].filter(([key]) => key.startsWith(prefix));
    let bytes = entries.reduce((sum, [, e]) => sum + e.bytes, 0);
    entries.sort(([, a], [, b]) => (p.eviction === 'lfu' ? a.frequency - b.frequency : a.used - b.used) || a.used - b.used);
    for (const [key, entry] of entries) { if (bytes <= Math.max(0, capacity)) break; n.store.delete(key); n.bytes -= entry.bytes; bytes -= entry.bytes; if (this.cohort(this.now) && n.stats.cache) n.stats.cache.evictions++; }
  }
  private publish(inv: Invocation) {
    const n = inv.node;
    if (n.spec.kind !== 'queue') return;
    if (n.messageDepth >= n.spec.params.capacityMessages) { this.reject(inv.root); if (inv.root.cohort) n.stats.drops++; this.complete(inv, { status: 503 }); return; }
    const ordered = inv.step?.type === 'publish' && inv.step.orderedByKey;
    const m: Message = { owner: n, root: inv.root, partition: ordered ? hash32(inv.root.key) % n.spec.params.partitions : n.round++ % n.spec.params.partitions, sequence: n.messageSeq++, ordered, accepted: this.now, deliveries: 0, visible: true, removed: false, generation: 0 };
    let partition = n.messages.get(m.partition); if (!partition) { partition = { items: [], head: 0 }; n.messages.set(m.partition, partition); }
    partition.items.push(m); n.messageDepth++; this.queued++;
    n.stats.queue!.depthMax = Math.max(n.stats.queue!.depthMax, n.messageDepth);
    this.at(this.now + n.spec.params.retentionUs, PRIORITY.completion, () => { this.removeMessage(m); this.pump(n); });
    this.complete(inv, { status: 200 }); this.pump(n);
  }
  private removeMessage(m: Message) { if (!m.removed) { m.removed = true; m.owner.messageDepth--; this.queued--; } }
  private pump(queue: RuntimeNode) {
    if (queue.spec.kind !== 'queue' || queue.state === 'down' || queue.state === 'restarting') return;
    const p = queue.spec.params;
    const workers = [...this.nodes.values()].filter(n => n.spec.kind === 'worker' && n.spec.params.source === queue.spec.id && n.state !== 'down' && n.state !== 'restarting');
    for (const worker of workers) {
      if (worker.spec.kind !== 'worker') continue;
      let batch = 0;
      while (worker.busy < this.capacity(worker) && batch < worker.spec.params.batchSize) {
        let oldest: Message | undefined;
        for (const partition of queue.messages.values()) {
          let candidate = partition.items[partition.head];
          while (candidate && (candidate.removed || this.now - candidate.accepted >= p.retentionUs || candidate.visible && candidate.deliveries >= p.maxDeliveries)) {
            if (!candidate.removed && this.now - candidate.accepted < p.retentionUs) queue.stats.queue!.deadLettered++;
            this.removeMessage(candidate); partition.head++; candidate = partition.items[partition.head];
          }
          if (partition.head > 1024 && partition.head * 2 > partition.items.length) { partition.items = partition.items.slice(partition.head); partition.head = 0; }
          if (candidate?.visible && (!oldest || candidate.sequence < oldest.sequence)) oldest = candidate;
        }
        if (!oldest) break;
        const m = oldest;
        batch++; m.visible = false; m.deliveries++; const generation = ++m.generation;
        if (m.deliveries > 1) queue.stats.queue!.redelivered++;
        queue.stats.queue!.consumerLagMax = Math.max(queue.stats.queue!.consumerLagMax, this.now - m.accepted);
        const root: Root = { ...m.root, background: true, done: false, good: false, origin: m.root.origin ?? m.root, start: this.now, deadline: this.now + p.visibilityTimeoutUs, writes: new Map(), writeEpoch: new Map(), required: this.requiredVersions(m.root.key, m.root.session) };
        const inv: Invocation = { root, node: worker, arrival: this.now, live: true, completed: false, released: false, wasted: false, abandoned: false, depth: 0, version: 0, hit: false, children: new Set(), cancelChildren: new Set(), reply: r => {
          root.done = true;
          if (success(r.status)) {
            this.acknowledge(root);
            if (m.ordered) { const consumed = queue.consumed.get(root.key) ?? -1; if (m.sequence < consumed) this.violation('orderingViolated', root, `Consumed ${root.key} sequence ${m.sequence} after ${consumed}.`); queue.consumed.set(root.key, Math.max(consumed, m.sequence)); }
            if (!m.removed && m.generation === generation) this.removeMessage(m);
          }
          this.pump(queue);
        } };
        this.liveTasks++; this.admit(inv);
        this.at(this.now + p.visibilityTimeoutUs, PRIORITY.timeout, () => { if (!m.removed && m.generation === generation) { m.visible = true; this.pump(queue); } });
      }
    }
  }
  private breaker(inv: Invocation) {
    const n = inv.node;
    if (n.spec.kind !== 'circuitBreaker') return;
    const b = n.breaker, p = { ...n.spec.params };
    if (b.mode === 'open' && this.now >= b.until) { b.mode = 'halfOpen'; b.probes = 0; b.passed = 0; }
    if (b.mode === 'open' || b.mode === 'halfOpen' && b.probes >= p.halfOpenProbes || b.inflight >= (p.bulkheadMax ?? Infinity)) { n.stats.breaker!.shortCircuited++; this.complete(inv, { status: 503 }); return; }
    if (b.mode === 'halfOpen') b.probes++;
    const mode = b.mode; b.inflight++;
    inv.cleanup = () => { b.inflight--; };
    this.forward(inv, undefined, r => {
      const ok = success(r.status);
      b.results = b.results.filter(x => x.time > this.now - p.windowUs); b.results.push({ time: this.now, ok });
      if (mode === 'halfOpen' && ok) b.passed++;
      const open = mode === 'halfOpen' ? !ok : b.results.length >= p.minRequests && b.results.filter(x => !x.ok).length / b.results.length >= p.failureRateThreshold;
      if (open) { b.mode = 'open'; b.until = this.now + p.openUs; n.stats.breaker!.opens++; }
      else if (mode === 'halfOpen' && b.passed >= p.halfOpenProbes) { b.mode = 'closed'; b.results = []; }
      this.complete(inv, r);
    });
  }
  private scaleTick(n: RuntimeNode) {
    if (n.spec.kind !== 'autoscaler') return;
    const p = n.spec.params;
    this.at(this.now + p.evaluateEveryUs, PRIORITY.edit, () => {
      if (n.state !== 'down' && n.state !== 'restarting' && !n.scalePending && this.now - n.scaleAt >= p.cooldownUs) {
        for (const id of p.targets) {
          const target = this.nodes.get(id)!;
          if (!('concurrency' in target.spec.params)) continue;
          const current = target.spec.params.concurrency;
          const metric = p.metric === 'utilisation' ? target.busy / current : target.queue.length;
          const next = Math.max(p.min, Math.min(p.max, Math.ceil(current * metric / p.targetValue)));
          const stats = n.stats.autoscale!; stats.minConcurrency = Math.min(stats.minConcurrency, current); stats.maxConcurrency = Math.max(stats.maxConcurrency, current);
          if (next !== current) {
            n.scalePending = true; n.scaleAt = this.now;
            this.at(this.now + duration(p.provisionUs + p.warmupUs), PRIORITY.edit, () => {
              n.scalePending = false; this.resize(target, next); stats.scaleEvents++; stats.minConcurrency = Math.min(stats.minConcurrency, next); stats.maxConcurrency = Math.max(stats.maxConcurrency, next);
            });
          }
        }
      }
      this.scaleTick(n);
    });
  }
  private resize(n: RuntimeNode, concurrency: number) {
    if (!('concurrency' in n.spec.params)) return;
    this.touch(n); n.spec.params.concurrency = concurrency;
    while (n.state !== 'down' && n.state !== 'restarting' && n.busy < this.capacity(n) && n.queue.length) {
      const next = this.pull(n); if (!next) break; this.start(next);
    }
    if (n.spec.kind === 'worker') { const source = this.nodes.get(n.spec.params.source); if (source) this.pump(source); }
  }
  private cache(inv: Invocation) {
    const n = inv.node, s = n.spec;
    if (s.kind !== 'cache') return;
    const root = inv.root, key = root.key;
    let entry = n.store.get(key);
    if (entry && entry.expires <= this.localTime(n)) { n.bytes -= entry.bytes; n.store.delete(key); entry = undefined; this.stateDirty = true; }
    if (inv.op === 'delete') {
      this.stateDirty = true;
      if (entry) { n.bytes -= entry.bytes; n.store.delete(key); }
      this.data(root, `cache DELETE ${key}`); this.complete(inv, { status: 200 }); return;
    }
    if (inv.op === 'set') {
      this.stateDirty = true;
      if (entry) { n.bytes -= entry.bytes; n.store.delete(key); }
      const bytes = (root.responseBytes ?? root.endpoint.responseBytes) + key.length * 2;
      if (bytes <= s.params.capacityBytes) {
        while (n.bytes + bytes > s.params.capacityBytes && n.store.size) {
          let victim: string | undefined, rank = Infinity, used = Infinity;
          for (const [k, e] of n.store) {
            const r = s.params.eviction === 'lfu' ? e.frequency : e.used;
            if (r < rank || (r === rank && e.used < used)) { victim = k; rank = r; used = e.used; }
          }
          const old = n.store.get(victim!)!; n.bytes -= old.bytes; n.store.delete(victim!);
          if (root.cohort) n.stats.cache!.evictions++;
        }
        n.store.set(key, { bytes, version: inv.version, source: inv.parent?.source, expires: this.localTime(n) + (s.params.ttlUs ?? Number.MAX_SAFE_INTEGER - this.now), frequency: 1, used: ++n.clock }); n.bytes += bytes;
        if (n.store.size > LIMITS.storedKeys) this.limit('stored keys');
      }
      this.data(root, `cache SET ${key} v${inv.version}`);
      const pending = n.pending.get(key); n.pending.delete(key);
      for (const waiter of pending?.waiters ?? []) {
        this.cacheCount(waiter, true); this.data(waiter.root, `cache HIT ${key} (coalesced)`);
        if (inv.parent?.source) this.readVersion(waiter, inv.parent.source, inv.version);
        this.complete(waiter, { status: 200, hit: true, version: inv.version });
      }
      this.complete(inv, { status: 200 }); return;
    }
    if (entry) {
      entry.used = ++n.clock; entry.frequency++; this.cacheCount(inv, true);
      if (entry.source) this.readVersion(inv, entry.source, entry.version);
      this.data(root, `cache HIT ${key}`); this.complete(inv, { status: 200, hit: true, version: entry.version, source: entry.source }); return;
    }
    const pending = n.pending.get(key);
    if (s.params.coalesce && pending && pending.owner !== root && pending.until > this.now) {
      pending.waiters.add(inv); n.detached.add(inv);
      inv.wait = () => pending.waiters.delete(inv);
      // Waiting readers do not hold cache workers needed by the filling cacheSet.
      this.release(inv);
      this.at(Math.max(this.now, Math.min(root.deadline, pending.until)), PRIORITY.timeout, () => { if (inv.live) { this.cacheCount(inv, false); this.complete(inv, { status: 200, hit: false }); } });
      return;
    }
    if (s.params.coalesce) n.pending.set(key, { owner: root, until: root.deadline, waiters: new Set() });
    this.cacheCount(inv, false); this.data(root, `cache MISS ${key}`); this.complete(inv, { status: 200, hit: false });
  }
  private cacheCount(inv: Invocation, hit: boolean) {
    if (!inv.root.cohort) return;
    const c = inv.node.stats.cache!;
    if (hit) c.hits++; else c.misses++;
    const b = this.bucket((inv.root.origin ?? inv.root).start), field = hit ? b.hits : b.misses, id = inv.node.spec.id;
    field[id] = (field[id] ?? 0) + 1;
  }

  private outgoing(n: RuntimeNode) { return [...this.links.values()].filter(l => l.spec.from === n.spec.id).map(l => l.spec.to).sort(); }
  private healthTick(n: RuntimeNode) {
    if (n.spec.kind !== 'loadBalancer') return;
    for (const target of this.outgoing(n)) if (!n.health.has(target)) n.health.set(target, { up: true, good: 0, bad: 0, connections: 0 });
      const interval = duration(n.spec.params.healthCheck.intervalUs);
    this.at(this.now + interval, PRIORITY.completion, () => {
      if (n.spec.kind !== 'loadBalancer') return;
      const healthCheck = n.spec.params.healthCheck;
      if (n.state !== 'down' && n.state !== 'restarting') for (const [id, h] of n.health) {
        let settled = false;
        const root: Root = { id: `health:${n.spec.id}:${id}:${this.now}`, endpoint: { id: '__health', name: 'health', op: 'read', keyTemplate: '', requestBytes: 64, responseBytes: 64, idempotent: true }, key: '', start: this.now, deadline: this.now + interval, cohort: false, done: false, rejected: false, invalid: false, good: false };
        const settle = (ok: boolean) => {
          if (settled) return;
          settled = true; root.done = true;
          if (ok) { h.bad = 0; h.good++; if (h.good >= healthCheck.healthyThreshold) h.up = true; }
          else { h.good = 0; h.bad++; if (h.bad >= healthCheck.unhealthyThreshold) h.up = false; }
        };
        const probe = this.send(n.spec.id, id, root, 0, 'probe', 0, r => settle(success(r.status)));
        this.at(root.deadline, PRIORITY.timeout, () => { if (!settled) { settle(false); probe.cancel(); } });
      }
      this.healthTick(n);
    });
  }
  private balance(inv: Invocation) {
    const n = inv.node;
    if (n.spec.kind !== 'loadBalancer') return;
    const targets = this.outgoing(n).filter(id => n.health.get(id)?.up !== false);
    if (!targets.length) { this.complete(inv, { status: 503 }); return; }
    const connections = (id: string) => n.health.get(id)?.connections ?? 0;
    let target = targets[0];
    switch (n.spec.params.algorithm) {
      case 'roundRobin': target = targets[n.round++ % targets.length]; break;
      case 'leastConnections': for (const id of targets) if (connections(id) < connections(target)) target = id; break;
      case 'p2c': {
        const a = Math.floor(n.rng.next() * targets.length), b = targets.length > 1 ? (a + 1 + Math.floor(n.rng.next() * (targets.length - 1))) % targets.length : a;
        target = connections(targets[a]) <= connections(targets[b]) ? targets[a] : targets[b]; break;
      }
      case 'consistentHash': {
        const ring = targets.flatMap(id => Array.from({ length: 32 }, (_, i) => ({ id, token: hash32(`${id}:${i}`) }))).sort((a, b) => a.token - b.token || a.id.localeCompare(b.id));
        target = (ring.find(p => p.token >= hash32(inv.root.session === undefined ? inv.root.key : `session:${inv.root.session}`)) ?? ring[0]).id; break;
      }
    }
    const h = n.health.get(target);
    if (h) h.connections++;
    inv.cleanup = () => { if (h) h.connections--; };
    this.call(inv, target, { type: 'call', target, timeoutUs: Math.max(1, inv.root.deadline - this.now) }, r => this.complete(inv, r));
  }
  private rateLimit(inv: Invocation) {
    const n = inv.node;
    if (n.spec.kind !== 'rateLimiter') return;
    const p = n.spec.params, elapsed = this.now - n.tokenAt;
    let allowed = false;
    if (p.algorithm === 'tokenBucket' || p.algorithm === 'leakyBucket') {
      n.tokens = Math.min(p.burst, n.tokens + elapsed * p.ratePerSec / 1e6); n.tokenAt = this.now;
      allowed = n.tokens >= 1; if (allowed) n.tokens--;
    } else if (p.algorithm === 'fixedWindow') {
      const window = Math.floor(this.now / 1e6);
      if (window !== n.windowAt) { n.windowAt = window; n.windowCount = 0; }
      allowed = n.windowCount < Math.min(p.ratePerSec, p.burst); if (allowed) n.windowCount++;
    } else {
      while (n.acceptedHead < n.accepted.length && n.accepted[n.acceptedHead] <= this.now - 1e6) n.acceptedHead++;
      if (n.acceptedHead > 1024) { n.accepted = n.accepted.slice(n.acceptedHead); n.acceptedHead = 0; }
      allowed = n.accepted.length - n.acceptedHead < Math.min(p.ratePerSec, p.burst); if (allowed) n.accepted.push(this.now);
    }
    if (!allowed) { this.reject(inv.root); this.complete(inv, { status: 429 }); return; }
    const target = this.outgoing(n)[0];
    if (!target) { this.complete(inv, { status: 503 }); return; }
    this.call(inv, target, { type: 'call', target, timeoutUs: Math.max(1, inv.root.deadline - this.now) }, r => this.complete(inv, r));
  }
  private installChaos(c: ChaosEvent) {
    this.at(Math.ceil(c.atUs), PRIORITY.chaos, () => {
      if (this.scenario.chaos.find(e => e.id === c.id) !== c) return;
      this.activeChaos.set(c.id, c); for (const n of this.nodes.values()) this.refreshChaos(n);
    });
    if (c.endUs !== undefined) this.at(Math.ceil(c.endUs), PRIORITY.chaos, () => {
      if (this.activeChaos.get(c.id) !== c) return;
      this.activeChaos.delete(c.id); for (const n of this.nodes.values()) this.refreshChaos(n);
    });
  }
  private downEvents(n: RuntimeNode) {
    return [...this.activeChaos.values()].filter(c => c.kind === 'kill' && c.target === n.spec.id || c.kind === 'zoneOutage' && 'zone' in n.spec.params && c.target === n.spec.params.zone || c.kind === 'regionOutage' && 'region' in n.spec.params && c.target === n.spec.params.region);
  }
  private refreshChaos(n: RuntimeNode) {
    n.slow = 1; n.errorRate = 0;
    for (const c of this.activeChaos.values()) if (c.target === n.spec.id) {
      if (c.kind === 'degrade') n.slow *= c.slowFactor;
      if (c.kind === 'gray') n.errorRate = 1 - (1 - n.errorRate) * (1 - c.errorRate);
    }
    const down = this.downEvents(n);
    if (down.some(c => !n.promotedEvents.has(c.id))) {
      if (n.state !== 'down') this.takeDown(n);
      n.state = 'down'; return;
    }
    if (n.state === 'down') { this.recover(n); return; }
    if (n.failedLeader !== undefined && !down.length && n.state !== 'restarting') this.recover(n);
    else if (n.state !== 'restarting') n.state = n.slow > 1 ? 'degraded' : n.errorRate > 0 ? 'gray' : 'up';
  }
  private takeDown(n: RuntimeNode) {
    this.stateDirty = true;
    this.touch(n); n.state = 'down'; n.generation++;
    for (const inv of [...n.active, ...n.queue, ...n.detached]) this.cancel(inv, false);
    if (n.spec.kind === 'cache' || n.spec.kind === 'cdn' || n.spec.kind === 'dedupStore' && !n.spec.params.durable) { n.store.clear(); n.pending.clear(); n.bytes = 0; }
    if (n.spec.kind === 'cache') {
      for (const [name, d] of n.data) n.data.set(name, this.makeStored(n, { ...d.entity, dataset: { ...d.entity.dataset, count: 0 } }));
      this.lostWrites(n);
    }
    if (n.spec.kind === 'database') {
      const failed = n.leader; n.failedLeader = failed; n.unavailable.add(failed);
      if (n.spec.params.walDurable === false) for (const d of n.data.values()) { d.stores[failed] = createDataStore(d.entity, new Random(this.seed, `dataset:${d.entity.name}`)); d.versions[failed].clear(); d.history[failed] = []; }
      const f = n.spec.params.failover, generation = n.generation;
      const elect = () => {
        if (n.generation !== generation || !n.unavailable.has(failed)) return;
        const domains = this.downEvents(n).filter(c => c.kind === 'zoneOutage' || c.kind === 'regionOutage');
        if (domains.length) { const end = Math.min(...domains.map(c => c.endUs ?? Infinity)); if (Number.isFinite(end)) this.at(end, PRIORITY.chaos, elect); return; }
        const candidates = Array.from({ length: n.spec.kind === 'database' ? n.spec.params.replicas : 0 }, (_, i) => i).filter(i => !n.unavailable.has(i));
        const rank = (m: number) => [...n.data.values()].reduce((sum, d) => sum + [...d.versions[m].values()].reduce((a, b) => a + b, 0), 0);
        candidates.sort((a, b) => rank(b) - rank(a) || a - b);
        if (!candidates.length) return;
        n.leader = candidates[0]; n.oldLeaders.delete(n.leader); n.leaderWrites.clear(); n.term++; n.stats.failovers = (n.stats.failovers ?? 0) + 1;
        for (const c of this.downEvents(n)) n.promotedEvents.add(c.id);
        n.state = 'up'; this.lostWrites(n);
      };
      if (f && n.spec.params.replicas > 1) this.at(this.now + duration(f.heartbeatUs * f.missedHeartbeats + f.electionUs), PRIORITY.chaos, elect);
    }
  }
  private lostWrites(n: RuntimeNode) {
    for (const [name, d] of n.data) for (const [key, ack] of this.acknowledged) {
      const prefix = `${n.spec.id}:${name}:`;
      if (!key.startsWith(prefix)) continue;
      this.checkAcknowledged(n, d, key, key.slice(prefix.length), ack);
    }
  }
  private checkAcknowledged(n: RuntimeNode, d: Stored, key: string, recordKey: string, ack: { version: number; root: Root }) {
    const version = d.versions[n.leader].get(recordKey) ?? d.stores[n.leader].snapshotVersion(recordKey) ?? -1;
    if (version < ack.version) { this.violation('ackedWriteLost', ack.root, `Acknowledged ${key} v${ack.version} lost on failover/restart (available v${version}).`); this.acknowledged.delete(key); }
  }
  private recover(n: RuntimeNode) {
    n.state = 'restarting';
    const generation = n.generation, s = n.spec;
    const warmup = 'restartWarmupUs' in s.params ? s.params.restartWarmupUs ?? 1 : 1;
    const catchup = s.kind === 'database' && s.params.replicationLag ? n.rng.sample(s.params.replicationLag) : 0;
    this.at(this.now + duration(warmup + catchup), PRIORITY.chaos, () => {
      if (generation !== n.generation || this.downEvents(n).some(c => !n.promotedEvents.has(c.id))) return;
      if (s.kind === 'database' && n.failedLeader !== undefined) {
        const old = n.failedLeader; n.unavailable.delete(old);
        if (old !== n.leader) {
          if (!s.params.failover?.fencing) { n.oldLeaders.add(old); n.leaderWrites.clear(); }
          else for (const d of n.data.values()) {
            d.stores[old] = createDataStore(d.entity, new Random(this.seed, `dataset:${d.entity.name}`)); d.versions[old].clear(); d.history[old] = [];
            for (const record of d.history[n.leader]) this.applyReplica(d, old, record);
          }
        } else for (const d of n.data.values()) {
          for (let member = 0; member < d.stores.length; member++) if (member !== old && !n.unavailable.has(member)) for (const record of d.history[member]) this.applyReplica(d, old, record);
        }
        n.failedLeader = undefined; this.lostWrites(n);
      }
      n.state = n.slow > 1 ? 'degraded' : n.errorRate > 0 ? 'gray' : 'up';
      if (s.kind === 'queue') this.pump(n);
      if (s.kind === 'worker') { const source = this.nodes.get(s.params.source); if (source) this.pump(source); }
    });
  }

  private change(design: Design, scenario: Scenario, nodeId: string, path: string, value: unknown): string | undefined {
    const parts = path.split('.');
    if (parts.some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) return 'Invalid edit path.';
    if (nodeId === '@chaos') {
      const event = value as ChaosEvent;
      if (!event || typeof event !== 'object' || event.atUs <= this.now) return 'Chaos edits must start after the current cursor.';
      const old = scenario.chaos.find(c => c.id === path);
      if (old && old.atUs <= this.now) return 'Past or active chaos cannot be edited.';
      if (old) scenario.chaos.splice(scenario.chaos.indexOf(old), 1, structuredClone(event)); else scenario.chaos.push(structuredClone(event));
      return;
    }
    let object: Record<string, unknown>, optional = false;
    if (nodeId === '@workload') {
      if (!['arrival', 'mix'].includes(parts[0])) return 'Only workload arrival and mix can be edited.';
      object = scenario.workload as unknown as Record<string, unknown>;
      optional = parts[0] === 'mix' && parts.length === 2 && design.endpoints.some(e => e.id === parts[1]);
    } else {
      const node = design.nodes.find(n => n.id === nodeId);
      if (!node) return 'Structural edits are rejected: node does not exist.';
      if (parts[0] === 'handlers') {
        if (!parts.some(k => ['timeoutUs', 'retry'].includes(k))) return 'Only timeout and retry policy may be edited in handlers.';
        object = node as unknown as Record<string, unknown>;
      } else {
        if (parts[0] === 'params') parts.shift();
        if (['entry', 'source', 'targets', 'records', 'region', 'zone', 'partitions', 'replicas', 'replicationFactor', 'vnodes'].includes(parts[0])) return 'Structural parameter edits require a new run.';
        object = node.params as unknown as Record<string, unknown>;
        const fields = node.kind === 'database' ? ['replication', 'replicationLag', 'readFromReplicas', 'walDurable', 'connectionPool', 'failover', 'restartWarmupUs'] : node.kind === 'cache' || node.kind === 'cdn' ? ['ttlUs', 'restartWarmupUs'] : node.kind === 'rateLimiter' ? ['centralised', 'restartWarmupUs'] : node.kind === 'circuitBreaker' ? ['bulkheadMax'] : 'concurrency' in node.params ? ['restartWarmupUs'] : [];
        optional = parts.length === 1 && fields.includes(parts[0]);
      }
    }
    for (const part of parts.slice(0, -1)) {
      const next = object[part];
      if (!next || typeof next !== 'object') return 'Edit path does not exist.';
      object = next as Record<string, unknown>;
    }
    const last = parts.at(-1)!;
    if (!last || !(last in object) && !optional && !(last === 'retry' && (object.type === 'call' || object.type === 'data'))) return 'Structural edits are rejected: parameter does not exist.';
    object[last] = structuredClone(value);
  }
  liveEdit(nodeId: string, path: string, value: unknown, acknowledge?: (edit: LiveEdit) => void): string | undefined {
    if (this.ended) return 'The run has finished.';
    if (nodeId === '@chaos' && (value as ChaosEvent)?.atUs <= (this.heap.peek()?.time ?? this.now)) return 'Chaos must start after the next event boundary.';
    const design = structuredClone(this.design), scenario = structuredClone(this.scenario);
    for (const edit of this.pendingEdits) this.change(design, scenario, edit.nodeId, edit.path, edit.value);
    const reason = this.change(design, scenario, nodeId, path, value);
    if (reason) return reason;
    const issues = validateDesign(design, scenario);
    if (issues.length) return issues.map(i => i.message).join(' ');
    this.pendingEdits.push({ nodeId, path, value: structuredClone(value), acknowledge });
  }
  replayEdits(edits: LiveEdit[]) {
    if (edits.some(e => !Number.isSafeInteger(e.cursor?.timeUs) || e.cursor.timeUs < this.now || !Number.isSafeInteger(e.cursor.seq) || e.cursor.seq < 0)) throw new Error('Invalid replay edit cursor.');
    this.replayLog = structuredClone(edits);
  }
  private applyEdit(edit: LiveEdit) {
    this.stateDirty = true;
    const candidate = structuredClone(this.design), scenario = structuredClone(this.scenario);
    const reason = this.change(candidate, scenario, edit.nodeId, edit.path, edit.value);
    const issues = reason ? [] : validateDesign(candidate, scenario);
    if (reason || issues.length) throw new Error(`Invalid replay/live edit: ${reason ?? issues.map(i => i.message).join(' ')}`);
    const n = this.nodes.get(edit.nodeId), before = n ? structuredClone(n.spec.params) : undefined;
    this.change(this.design, this.scenario, edit.nodeId, edit.path, edit.value);
    if (edit.nodeId === '@workload' && edit.path.startsWith('mix')) {
      const mix = this.scenario.workload.mix, total = Object.values(mix).reduce((a, b) => a + b, 0);
      this.mix = this.design.endpoints.filter(e => (mix[e.id] ?? 0) > 0).sort((a, b) => a.id.localeCompare(b.id)).map(e => [e, mix[e.id] / total]);
    }
    if (n) {
      const p = n.spec.params;
      if ('concurrency' in p && before && 'concurrency' in before && p.concurrency !== before.concurrency) this.resize(n, p.concurrency);
      if ('queueCapacity' in p) while (n.queue.length > p.queueCapacity) {
        const dropped = n.queue.pop()!; this.touch(n); this.queued--; n.stats.drops++; n.stats.dropsOnEdit = (n.stats.dropsOnEdit ?? 0) + 1; this.reject(dropped.root); this.complete(dropped, { status: 503 });
      }
      if ((n.spec.kind === 'cache' || n.spec.kind === 'cdn') && before && 'capacityBytes' in before && typeof before.capacityBytes === 'number' && n.spec.params.capacityBytes < before.capacityBytes) {
        if (n.spec.kind === 'cdn') for (const prefix of new Set([...n.store.keys()].map(k => { const colon = k.indexOf(':'); return k.slice(0, colon + Number(k.slice(0, colon)) + 2); }))) this.evict(n, n.spec.params.capacityBytes, prefix);
        else this.evict(n, n.spec.params.capacityBytes);
      }
      if (n.spec.kind === 'kvStore' && before && 'members' in before && n.spec.params.members !== before.members) {
        n.ring = undefined;
        for (const [name, old] of n.data) {
          const next = this.makeStored(n, old.entity); next.log = old.log;
          for (const record of old.log) for (const owner of this.owners(n, record.key)) this.applyReplica(next, owner, record);
          n.data.set(name, next);
        }
      }
    }
    if (edit.nodeId === '@chaos') { const event = this.scenario.chaos.find(c => c.id === (edit.value as ChaosEvent).id); if (event) this.installChaos(event); }
    this.edits.push(structuredClone(edit));
  }
  private boundaryEdits(timeUs: number, seq: number) {
    if (this.replayLog.length) {
      const recorded = this.replayLog.filter(edit => edit.cursor.timeUs === timeUs && edit.cursor.seq === seq);
      for (const edit of recorded) this.applyEdit(edit);
      if (recorded.length) this.replayLog = this.replayLog.filter(edit => !recorded.includes(edit));
    }
    if (this.pendingEdits.length) for (const pending of this.pendingEdits.splice(0)) {
      const edit: LiveEdit = { cursor: { timeUs, seq }, nodeId: pending.nodeId, path: pending.path, value: pending.value };
      this.applyEdit(edit); pending.acknowledge?.(structuredClone(edit));
    }
  }
  advance(options: AdvanceOptions = {}): 'running' | 'done' {
    if (this.ended) return 'done';
    const until = Math.min(options.untilUs ?? this.end, this.end), maxEvents = options.maxEvents ?? Infinity;
    if ((options.untilUs !== undefined && !Number.isSafeInteger(options.untilUs)) || until < this.now ||
      (options.maxEvents !== undefined && (!Number.isSafeInteger(maxEvents) || maxEvents < 0)) ||
      (options.maxWallMs !== undefined && (!Number.isFinite(options.maxWallMs) || options.maxWallMs < 0))) throw new Error('Advance bounds must be finite and non-negative, event/time bounds must be integers, and time must be monotonic.');
    const start = performance.now();
    let processed = 0;
    while (!this.ended && this.heap.size && this.heap.peek().time <= until && processed < maxEvents) {
      if (options.maxWallMs !== undefined && performance.now() - start >= options.maxWallMs) break;
      if (this.eventCount >= this.ceilings.events) { this.limit('total events'); break; }
      const e = this.heap.pop()!;
      this.now = e.time; this.cursorSeq = e.seq; this.eventCount++; processed++;
      try {
        const editing = this.replayLog.length || this.pendingEdits.length;
        if (editing && e.priority !== PRIORITY.chaos) this.boundaryEdits(e.time, e.seq);
        e.run();
        if (editing && e.priority === PRIORITY.chaos && (this.heap.peek()?.time !== this.now || this.heap.peek()?.priority !== PRIORITY.chaos)) this.boundaryEdits(e.time, e.seq);
        this.checkLimits();
      }
      catch (error) { if (error instanceof DataLimitError) this.limit('stored keys'); else throw error; }
    }
    if (!this.ended && (!this.heap.size || this.heap.peek().time > until) && processed < maxEvents) {
      this.now = until;
      if (this.now >= this.end) this.ended = true;
    }
    if (this.ended && !this.reason && this.replayLog.length) this.stop('Replay edit cursor was not found; use the matching replay compatibility version.');
    return this.ended ? 'done' : 'running';
  }
  private metrics(): RunMetrics {
    const c = this.counts, seconds = Number.isFinite(this.scenario.measureUs) && this.scenario.measureUs > 0 ? this.scenario.measureUs / 1e6 : 1;
    const compute = computeMonthlyCost(this.design), monthly = 30 * 86400 / seconds;
    let storage = 0;
    for (const n of this.nodes.values()) if (n.spec.kind === 'objectStore') for (const d of n.data.values()) storage += d.stores[0].size * d.entity.fields.reduce((sum, f) => sum + f.bytes.meanBytes, 0) / 1e9 * n.spec.params.costPerGBMonth;
    const egress = this.egressCost * monthly, requests = this.requestCost * monthly;
    return {
      offered: c.offered, admitted: c.admitted, succeeded: c.succeeded, failed: c.failed, attempts: c.attempts, unfinished: c.offered - c.succeeded - c.failed,
      retryAmplification: c.offered ? c.attempts / c.offered : null, goodput: c.offered ? c.good / c.offered : null, availability: c.offered ? c.succeeded / c.offered : null,
      successLatency: this.successHist.percentiles(), allLatency: this.allHist.percentiles(),
      throughput: { offeredPerSec: c.offered / seconds, admittedPerSec: c.admitted / seconds, completedPerSec: (c.succeeded + c.failed) / seconds },
      costPerMonth: compute + egress + requests + storage,
      costBreakdown: { compute, egress, requests, storage },
      statusCounts: { ...this.statusCounts },
    };
  }
  private nodeStats(): NodeStats[] {
    return [...this.nodes.values()].map(n => {
      this.touch(n);
      const cache = n.stats.cache;
      return { ...structuredClone(n.stats), utilisation: this.capacity(n) ? n.busyArea / (this.capacity(n) * this.scenario.measureUs) : 0, avgQueue: n.queueArea / this.scenario.measureUs,
        latency: n.histogram.percentiles(), meanQueueWaitUs: n.waits ? n.waitSum / n.waits : null, inFlight: n.busy,
        ...(cache ? { cache: { ...cache, hitRate: cache.hits + cache.misses ? cache.hits / (cache.hits + cache.misses) : null } } : {}),
      };
    });
  }
  result(): RunResult {
    const nodes = this.nodeStats(), metrics = this.metrics();
    const stride = Math.max(1, Math.ceil(this.buckets.length / 600));
    const series: RunResult['series'] = [];
    for (let i = 0; i < this.buckets.length; i += stride) {
      const group = this.buckets.slice(i, i + stride), seconds = Math.min(this.scenario.measureUs / 1e6 - i, stride);
      const nodeUtil: Record<string, number> = {}, cacheHitRate: Record<string, number | null> = {};
      for (const n of this.nodes.values()) {
        nodeUtil[n.spec.id] = this.capacity(n) ? group.reduce((sum, b) => sum + (b.busy[n.spec.id] ?? 0), 0) / (seconds * 1e6 * this.capacity(n)) : 0;
        if (n.spec.kind === 'cache' || n.spec.kind === 'cdn') {
          const hits = group.reduce((sum, b) => sum + (b.hits[n.spec.id] ?? 0), 0), misses = group.reduce((sum, b) => sum + (b.misses[n.spec.id] ?? 0), 0);
          cacheHitRate[n.spec.id] = hits + misses ? hits / (hits + misses) : null;
        }
      }
      const histogram = new Histogram();
      for (const b of group) histogram.merge(b.hist);
      series.push({ tUs: this.scenario.warmupUs + i * 1e6, offeredPerSec: group.reduce((s, b) => s + b.offered, 0) / seconds, succeededPerSec: group.reduce((s, b) => s + b.succeeded, 0) / seconds, failedPerSec: group.reduce((s, b) => s + b.failed, 0) / seconds, p99Us: histogram.percentiles().p99, nodeUtil, cacheHitRate });
    }
    const top = [...nodes].filter(n => this.nodes.get(n.nodeId)!.spec.kind !== 'client').sort((a, b) => b.utilisation - a.utilisation || b.avgQueue - a.avgQueue || a.nodeId.localeCompare(b.nodeId))[0];
    const link = [...this.links.values()].sort((a, b) => Math.max(b.forwardBusy, b.reverseBusy) - Math.max(a.forwardBusy, a.reverseBusy))[0];
    const topNode = top ? this.nodes.get(top.nodeId)! : undefined;
    let bottleneck: RunResult['bottleneck'] = metrics.offered && top && topNode ? { nodeId: top.nodeId, utilisation: top.utilisation, queueGrowth: (topNode.endQueue ?? topNode.queue.length) - topNode.startQueue, retryAmplification: metrics.retryAmplification } : null;
    if (metrics.offered && link && Math.max(link.forwardBusy, link.reverseBusy) / this.scenario.measureUs > (top?.utilisation ?? 0)) bottleneck = { nodeId: `edge:${link.spec.id}`, utilisation: Math.max(link.forwardBusy, link.reverseBusy) / this.scenario.measureUs, queueGrowth: Math.max(0, link.forwardAt - this.now, link.reverseAt - this.now), retryAmplification: metrics.retryAmplification };
    return {
      runKey: { engineVersion: ENGINE_VERSION, scenarioVersion: this.scenario.version, designHash: this.originalHash, seed: this.seed, settings: structuredClone(this.settings), chaosTimeline: structuredClone(this.originalChaos), liveEditLog: structuredClone(this.edits) },
      replayCompatId: REPLAY_COMPAT_ID, outcome: this.reason ? 'inconclusive' : 'finished', ...(this.reason ? { inconclusiveReason: this.reason } : {}), metrics, nodes, series, violations: structuredClone(this.violations), bottleneck, eventsProcessed: this.eventCount, simEndUs: this.now,
    };
  }
  snapshot(): LiveSnapshot {
    const nodes = this.nodeStats();
    const snapshot = { cursor: { timeUs: this.now, seq: this.cursorSeq }, simTimeUs: this.now, metrics: this.metrics(), nodeUtil: Object.fromEntries(nodes.map(n => [n.nodeId, n.utilisation])), nodeState: Object.fromEntries([...this.nodes].map(([id, n]) => [id, n.state])), packets: this.packets };
    this.packets = [];
    return snapshot;
  }
  trace(input: TraceInput): TraceResult {
    if (this.ended) throw new Error('Trace session reached its resource limit. Reset the trace session.');
    const endpoint = this.design.endpoints.find(e => e.id === input.endpointId);
    if (!endpoint) throw new Error(`Unknown trace endpoint ${input.endpointId}`);
    const result: TraceResult = { status: 504, totalUs: 0, spans: [], dataOps: [] };
    const root = this.inject(endpoint, input.key, result);
    while (!root.done && !this.ended && this.heap.size) this.advance({ maxEvents: 1 });
    if (!root.done || this.reason) throw new Error(this.reason ?? 'Trace session exceeded one simulated hour. Reset the trace session.');
    return result;
  }
}

export function createSimulation(design: Design, scenario: Scenario, seed: number, settings: RunSettings = defaultSettings): Simulation {
  return new ExactSimulation(design, scenario, seed, settings);
}
export function runToCompletion(design: Design, scenario: Scenario, seed: number, settings: RunSettings = defaultSettings): RunResult {
  const simulation = createSimulation(design, scenario, seed, settings);
  while (simulation.advance() !== 'done') { /* deterministic event budget */ }
  return simulation.result();
}
export function traceRequest(design: Design, endpointId: string, key: string, seed: number, priorInputs: TraceInput[] = []): TraceResult {
  if (priorInputs.length > 10000) throw new Error('Trace retention is limited to 10,000 prior inputs. Reset the trace session.');
  const scenario: Scenario = { id: 'trace', version: 1, warmupUs: 0, measureUs: 3_500_000_000, drainUs: 100_000_000, chaos: [], workload: { arrival: { kind: 'constant', rps: 0 }, mix: { [endpointId]: 1 }, keys: { kind: 'uniform', n: 1 }, deadlineUs: 30_000_000 } };
  const issues = validateDesign(design, scenario);
  if (issues.length) throw new Error(issues.map(i => i.message).join(' '));
  const sim = new ExactSimulation(design, scenario, seed, { traceSampleRate: 0 }, true);
  for (const input of priorInputs) sim.trace(input);
  return sim.trace({ endpointId, key });
}
