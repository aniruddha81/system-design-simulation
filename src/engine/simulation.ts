import { designHash, duration, ENGINE_VERSION, EventHeap, hash32, Histogram, PRIORITY, Random, REPLAY_COMPAT_ID } from './core';
import { LIMITS, validateDesign } from './validation';
import type { AdvanceOptions, ChaosEvent, Design, EdgeSpec, EndpointSpec, LiveSnapshot, NodeSpec, NodeStats, Packet, RunMetrics, RunResult, RunSettings, Scenario, Simulation, Span, Status, Step, TraceInput, TraceResult, Violation } from './types';

type Reply = { status: Status; hit?: boolean; version?: number };
type Root = { id: string; endpoint: EndpointSpec; key: string; start: number; deadline: number; cohort: boolean; done: boolean; rejected: boolean; invalid: boolean; good: boolean; trace?: TraceResult };
type Invocation = { root: Root; node: RuntimeNode; arrival: number; started?: number; live: boolean; completed: boolean; wasted: boolean; released: boolean; abandoned: boolean; reply: (r: Reply) => void; children: Set<Invocation>; cancelChildren: Set<() => void>; parent?: Invocation; depth: number; op?: 'get' | 'set' | 'delete' | 'probe'; version: number; hit: boolean; wait?: () => void; cleanup?: () => void };
type Entry = { bytes: number; version: number; expires: number; used: number; frequency: number };
type Health = { up: boolean; good: number; bad: number; connections: number };
type RuntimeNode = {
  spec: NodeSpec; rng: Random; state: LiveSnapshot['nodeState'][string]; slow: number; errorRate: number;
  queue: Invocation[]; active: Set<Invocation>; detached: Set<Invocation>; busy: number; last: number; busyArea: number; queueArea: number; startQueue: number; endQueue?: number;
  stats: NodeStats; histogram: Histogram; waitSum: number; waits: number; round: number;
  store: Map<string, Entry>; bytes: number; clock: number; pending: Map<string, { owner: Root; until: number; waiters: Set<Invocation> }>;
  versions: Map<string, number>; effects: Set<string>; health: Map<string, Health>;
  tokens: number; tokenAt: number; windowAt: number; windowCount: number; accepted: number[]; acceptedHead: number;
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

  constructor(design: Design, scenario: Scenario, seed: number, settings: RunSettings = defaultSettings, manual = false) {
    // Snapshot mutable UI inputs so subsequent editor changes cannot alter a run.
    this.design = structuredClone(design); this.scenario = structuredClone(scenario); this.settings = structuredClone(settings); this.seed = seed;
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
      const stats: NodeStats = { nodeId: spec.id, utilisation: 0, avgQueue: 0, maxQueue: 0, drops: 0, errors: 0, served: 0, latency: new Histogram().percentiles(), meanQueueWaitUs: null, inFlight: 0, wastedWork: 0 };
      if (spec.kind === 'cache') stats.cache = { hits: 0, misses: 0, evictions: 0, hitRate: null };
      this.nodes.set(spec.id, { spec, rng: new Random(seed, spec.id), state: 'up', slow: 1, errorRate: 0, queue: [], active: new Set(), detached: new Set(), busy: 0, last: 0, busyArea: 0, queueArea: 0, startQueue: 0, stats, histogram: new Histogram(), waitSum: 0, waits: 0, round: 0, store: new Map(), bytes: 0, clock: 0, pending: new Map(), versions: new Map(), effects: new Set(), health: new Map(), tokens: spec.kind === 'rateLimiter' ? spec.params.burst : 0, tokenAt: 0, windowAt: 0, windowCount: 0, accepted: [], acceptedHead: 0 });
    }
    for (const spec of [...this.design.edges].sort((a, b) => a.id.localeCompare(b.id))) {
      const key = this.linkKey(spec.from, spec.to);
      if (!this.links.has(key)) this.links.set(key, { spec, forwardAt: 0, reverseAt: 0, forwardRng: new Random(seed, `edge:${spec.id}:forward`), reverseRng: new Random(seed, `edge:${spec.id}:reverse`), forwardBusy: 0, reverseBusy: 0 });
    }
    for (const c of [...scenario.chaos].sort((a, b) => a.atUs - b.atUs || a.id.localeCompare(b.id))) this.installChaos(c);
    if (!manual) {
      for (const n of this.nodes.values()) if (n.spec.kind === 'loadBalancer') this.healthTick(n);
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
    let keys = 0;
    for (const n of this.nodes.values()) keys += n.store.size + n.versions.size + n.effects.size;
    // Reserve the bounded animation buffer: snapshot frequency must not affect limits.
    const bytes = this.heap.size * 192 + this.liveTasks * 512 + this.roots.size * 384 + keys * 160 + 10000 * 128 + (this.keyCDF?.byteLength ?? 0);
    if (bytes > this.ceilings.memoryBytes) this.limit('estimated memory');
  }
  private bucket(time: number) { return this.buckets[Math.floor((time - this.scenario.warmupUs) / 1e6)]; }
  private cohort(time: number) { return time >= this.scenario.warmupUs && time < this.endArrival; }
  private span(root: Root, nodeId: string, kind: Span['kind'], startUs: number, endUs: number, note?: string) {
    if (root.trace && root.trace.spans.length < 10000) root.trace.spans.push({ nodeId, kind, startUs, endUs, ...(note ? { note } : {}) });
  }
  private data(root: Root, s: string) { if (root.trace && root.trace.dataOps.length < 10000) root.trace.dataOps.push(s); }

  private scheduleNextArrival(from: number) {
    const a = this.scenario.workload.arrival;
    let rate = a.rps;
    let boundary = Infinity;
    if (a.kind === 'step') { if (from < a.stepAtUs) boundary = a.stepAtUs; else rate = a.stepRps; }
    if (a.kind === 'spike') {
      if (from < a.spikeAtUs) boundary = a.spikeAtUs;
      else if (from < a.spikeAtUs + a.spikeDurUs) { rate = a.spikeRps; boundary = a.spikeAtUs + a.spikeDurUs; }
    }
    const delta = rate > 0 ? duration(a.kind === 'poisson' ? -Math.log(this.workloadRng.next()) * 1e6 / rate : 1e6 / rate) : Infinity;
    if (from + delta >= boundary && boundary < this.endArrival) { this.at(boundary, PRIORITY.arrival, () => this.scheduleNextArrival(boundary)); return; }
    const time = from + delta;
    if (time >= this.endArrival || !Number.isFinite(time)) return;
    this.at(time, PRIORITY.arrival, () => {
      let choice = this.mixRng.next(), endpoint = this.mix[this.mix.length - 1][0];
      for (const [e, weight] of this.mix) { choice -= weight; if (choice <= 0) { endpoint = e; break; } }
      const key = endpoint.keyTemplate.replace(/\{[^}]+\}/g, String(this.nextKey()));
      this.inject(endpoint, key);
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

  private inject(endpoint: EndpointSpec, key: string, trace?: TraceResult): Root {
    const root: Root = { id: `r${this.requestSeq++}`, endpoint, key, start: this.now, deadline: this.now + duration(this.scenario.workload.deadlineUs), cohort: this.cohort(this.now), done: false, rejected: false, invalid: false, good: false, trace };
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
    if (!root.rejected) { root.rejected = true; if (root.cohort) this.counts.admitted--; }
  }

  private network(from: string, to: string, root: Root, reverse: boolean, receive: () => void) {
    const link = this.links.get(this.linkKey(from, to));
    if (!link) return;
    const rng = reverse ? link.reverseRng : link.forwardRng;
    const bytes = reverse ? root.endpoint.responseBytes : root.endpoint.requestBytes;
    const serial = duration(bytes * 1e6 / link.spec.bandwidthBytesPerSec);
    const depart = this.now, start = Math.max(this.now, reverse ? link.reverseAt : link.forwardAt), ready = start + serial;
    if (reverse) link.reverseAt = ready; else link.forwardAt = ready;
    const busy = Math.max(0, Math.min(ready, this.endArrival) - Math.max(start, this.scenario.warmupUs));
    if (reverse) link.reverseBusy += busy; else link.forwardBusy += busy;
    const arrive = ready + rng.sample(link.spec.latency), ok = rng.next() >= link.spec.lossRate;
    const source = reverse ? to : from, target = reverse ? from : to;
    this.span(root, target, 'network', depart, arrive, ok ? undefined : 'packet lost');
    if (hash32(`visual:${this.seed}:${root.id}`) / 4294967296 < this.settings.traceSampleRate && this.packets.length < 10000) this.packets.push({ requestId: root.id, from: source, to: target, departUs: depart, arriveUs: arrive, ok });
    if (ok) this.at(arrive, reverse ? PRIORITY.response : PRIORITY.arrival, receive);
  }
  private send(from: string, to: string, root: Root, depth: number, op: Invocation['op'], version: number, reply: (r: Reply) => void, parent?: Invocation): { cancel: () => void; abandon: () => void } {
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
        children: new Set(), cancelChildren: new Set(), depth, op, version, hit: false };
      parent?.children.add(invocation);
      this.liveTasks++;
      this.admit(invocation);
    });
    return handle;
  }
  private capacity(n: RuntimeNode) { return n.spec.kind === 'client' ? 0 : n.spec.params.concurrency * (n.spec.kind === 'database' ? n.spec.params.replicas : 1); }
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
    if (n.busy < this.capacity(n)) this.start(inv);
    else if (n.queue.length < n.spec.params.queueCapacity) {
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
    if (inv.root.cohort) { n.waitSum += this.now - inv.arrival; n.waits++; }
    this.span(inv.root, s.id, 'queue', inv.arrival, this.now);
    const d = s.kind === 'database' ? (inv.root.endpoint.op === 'write' ? s.params.writeTime : s.params.readTime) : s.params.serviceTime;
    const finish = this.now + duration(n.rng.sample(d) * n.slow);
    this.at(finish, PRIORITY.completion, () => {
      if (!inv.live) return;
      this.span(inv.root, s.id, 'service', inv.started!, this.now);
      if (inv.op === 'probe') { this.complete(inv, { status: 200 }); return; }
      if (n.state === 'gray' && n.rng.next() < n.errorRate) { this.complete(inv, { status: 503 }); return; }
      switch (s.kind) {
        case 'service': this.program(inv, s.handlers?.[inv.root.endpoint.id] ?? [{ type: 'respond', status: 200 }]); break;
        case 'database': this.database(inv); break;
        case 'cache': this.cache(inv); break;
        case 'loadBalancer': this.balance(inv); break;
        case 'rateLimiter': this.rateLimit(inv); break;
      }
    });
  }
  private release(inv: Invocation) {
    if (inv.released) return;
    inv.released = true;
    const n = inv.node;
    this.touch(n);
    if (n.active.delete(inv)) n.busy--;
    while (n.state !== 'down' && n.state !== 'restarting' && n.busy < this.capacity(n) && n.queue.length) {
      const next = n.spec.kind !== 'client' && n.spec.params.queueDiscipline === 'lifo' ? n.queue.pop()! : n.queue.shift()!;
      this.queued--;
      this.start(next);
    }
  }
  private complete(inv: Invocation, r: Reply) {
    if (!inv.live) return;
    inv.live = false; inv.completed = true; this.liveTasks--;
    inv.parent?.children.delete(inv); inv.cleanup?.();
    inv.node.detached.delete(inv); inv.wait?.(); this.release(inv);
    if (inv.root.cohort) {
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
    } else for (const child of inv.children) { child.abandoned = true; if (child.completed) this.wasted(child); }
    this.release(inv);
  }

  private program(inv: Invocation, steps: Step[], index = 0) {
    if (!inv.live) return;
    const s = steps[index];
    if (!s) { this.complete(inv, { status: 200, version: inv.version }); return; }
    const next = () => this.program(inv, steps, index + 1);
    if (s.type === 'respond') { this.complete(inv, { status: s.status, version: inv.version }); return; }
    if (s.type === 'branch') {
      const yes = s.cond.kind === 'cacheHit' ? inv.hit : inv.node.rng.next() < s.cond.p;
      this.program(inv, [...(yes ? s.then : s.else), ...steps.slice(index + 1)]); return;
    }
    const target = s.type === 'call' ? s.target : s.cache;
    this.call(inv, target, s, r => {
      if (s.type === 'cacheGet') inv.hit = success(r.status) && r.hit === true;
      if (r.version !== undefined) inv.version = r.version;
      if (s.type === 'call' && !success(r.status)) this.complete(inv, r);
      else next();
    });
  }
  private call(inv: Invocation, target: string, step: Exclude<Step, { type: 'branch' | 'respond' }>, done: (r: Reply) => void) {
    const retry = step.type === 'call' ? step.retry : undefined;
    let number = 0;
    const attempt = () => {
      if (!inv.live) return;
      let settled = false;
      const start = this.now;
      const op = step.type === 'cacheGet' ? 'get' : step.type === 'cacheSet' ? 'set' : step.type === 'cacheDelete' ? 'delete' : undefined;
      const handle = this.send(inv.node.spec.id, target, inv.root, inv.depth + 1, op, inv.version, r => settle(r), inv);
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
          this.at(at, PRIORITY.retry, () => { this.retries--; if (inv.live && !inv.root.done) { if (inv.root.cohort) this.counts.attempts++; attempt(); } });
        } else done(r);
      };
      this.at(this.now + duration(step.timeoutUs), PRIORITY.timeout, () => settle({ status: 504 }, true));
    };
    attempt();
  }

  private database(inv: Invocation) {
    const n = inv.node, root = inv.root;
    let version = n.versions.get(root.key) ?? 0;
    if (root.endpoint.op === 'write') {
      if (!root.endpoint.idempotent || !n.effects.has(root.id)) {
        if (!root.endpoint.idempotent && n.effects.has(root.id)) {
          this.violations.push({ kind: 'duplicateEffect', timeUs: this.now, requestIds: [root.id], detail: `Non-idempotent write applied again at ${n.spec.id} for ${root.key}.` });
          root.invalid = true;
          if (root.good) { root.good = false; this.counts.good--; }
        }
        version++; n.versions.set(root.key, version); n.effects.add(root.id);
        if (n.versions.size > LIMITS.storedKeys || n.effects.size > LIMITS.storedKeys) this.limit('stored keys');
      }
      this.data(root, `DB write ${root.key} v${version}`);
    } else this.data(root, `DB read ${root.key} v${version}`);
    this.complete(inv, { status: 200, version });
  }
  private cache(inv: Invocation) {
    const n = inv.node, s = n.spec;
    if (s.kind !== 'cache') return;
    const root = inv.root, key = root.key;
    let entry = n.store.get(key);
    if (entry && entry.expires <= this.now) { n.bytes -= entry.bytes; n.store.delete(key); entry = undefined; }
    if (inv.op === 'delete') {
      if (entry) { n.bytes -= entry.bytes; n.store.delete(key); }
      this.data(root, `cache DELETE ${key}`); this.complete(inv, { status: 200 }); return;
    }
    if (inv.op === 'set') {
      if (entry) { n.bytes -= entry.bytes; n.store.delete(key); }
      const bytes = root.endpoint.responseBytes + key.length * 2;
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
        n.store.set(key, { bytes, version: inv.version, expires: this.now + (s.params.ttlUs ?? Number.MAX_SAFE_INTEGER - this.now), frequency: 1, used: ++n.clock }); n.bytes += bytes;
        if (n.store.size > LIMITS.storedKeys) this.limit('stored keys');
      }
      this.data(root, `cache SET ${key} v${inv.version}`);
      const pending = n.pending.get(key); n.pending.delete(key);
      for (const waiter of pending?.waiters ?? []) {
        this.cacheCount(waiter, true); this.data(waiter.root, `cache HIT ${key} (coalesced)`);
        this.complete(waiter, { status: 200, hit: true, version: inv.version });
      }
      this.complete(inv, { status: 200 }); return;
    }
    if (entry) {
      entry.used = ++n.clock; entry.frequency++; this.cacheCount(inv, true);
      this.data(root, `cache HIT ${key}`); this.complete(inv, { status: 200, hit: true, version: entry.version }); return;
    }
    const pending = n.pending.get(key);
    if (s.params.coalesce && pending && pending.owner !== root && pending.until > this.now) {
      pending.waiters.add(inv); n.detached.add(inv);
      inv.wait = () => pending.waiters.delete(inv);
      // Waiting readers do not hold cache workers needed by the filling cacheSet.
      this.release(inv);
      this.at(Math.min(root.deadline, pending.until), PRIORITY.timeout, () => { if (inv.live) { this.cacheCount(inv, false); this.complete(inv, { status: 200, hit: false }); } });
      return;
    }
    if (s.params.coalesce) n.pending.set(key, { owner: root, until: root.deadline, waiters: new Set() });
    this.cacheCount(inv, false); this.data(root, `cache MISS ${key}`); this.complete(inv, { status: 200, hit: false });
  }
  private cacheCount(inv: Invocation, hit: boolean) {
    if (!inv.root.cohort) return;
    const c = inv.node.stats.cache!;
    if (hit) c.hits++; else c.misses++;
    const b = this.bucket(inv.root.start), field = hit ? b.hits : b.misses, id = inv.node.spec.id;
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
        target = (ring.find(p => p.token >= hash32(inv.root.key)) ?? ring[0]).id; break;
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
    this.at(duration(c.atUs) - (c.atUs === 0 ? 1 : 0), PRIORITY.chaos, () => {
      const n = this.nodes.get(c.target)!;
      if (c.kind === 'kill') {
        n.state = 'down'; this.touch(n);
        for (const inv of [...n.active, ...n.queue, ...n.detached]) this.cancel(inv, false);
        n.store.clear(); n.pending.clear(); n.bytes = 0;
      } else if (c.kind === 'degrade') { n.state = 'degraded'; n.slow = c.slowFactor; }
      else { n.state = 'gray'; n.errorRate = c.errorRate; }
    });
    if (c.endUs !== undefined) this.at(Math.ceil(c.endUs), PRIORITY.chaos, () => {
      const n = this.nodes.get(c.target)!;
      if (c.kind === 'kill') {
        n.state = 'restarting';
        this.at(this.now + 1, PRIORITY.chaos, () => { n.state = 'up'; });
      } else n.state = 'up';
      n.slow = 1; n.errorRate = 0;
    });
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
      e.run(); this.checkLimits();
    }
    if (!this.ended && (!this.heap.size || this.heap.peek().time > until) && processed < maxEvents) {
      this.now = until;
      if (this.now >= this.end) this.ended = true;
    }
    return this.ended ? 'done' : 'running';
  }
  private metrics(): RunMetrics {
    const c = this.counts, seconds = Number.isFinite(this.scenario.measureUs) && this.scenario.measureUs > 0 ? this.scenario.measureUs / 1e6 : 1;
    return {
      offered: c.offered, admitted: c.admitted, succeeded: c.succeeded, failed: c.failed, attempts: c.attempts, unfinished: c.offered - c.succeeded - c.failed,
      retryAmplification: c.offered ? c.attempts / c.offered : null, goodput: c.offered ? c.good / c.offered : null, availability: c.offered ? c.succeeded / c.offered : null,
      successLatency: this.successHist.percentiles(), allLatency: this.allHist.percentiles(),
      throughput: { offeredPerSec: c.offered / seconds, admittedPerSec: c.admitted / seconds, completedPerSec: (c.succeeded + c.failed) / seconds },
      costPerMonth: [...this.nodes.values()].reduce((sum, n) => sum + (n.spec.kind === 'client' ? 0 : n.spec.params.costPerHour * (n.spec.kind === 'database' ? n.spec.params.replicas : 1)), 0) * 24 * 30,
      statusCounts: { ...this.statusCounts },
    };
  }
  private nodeStats(): NodeStats[] {
    return [...this.nodes.values()].map(n => {
      this.touch(n);
      const cache = n.stats.cache;
      return { ...n.stats, utilisation: this.capacity(n) ? n.busyArea / (this.capacity(n) * this.scenario.measureUs) : 0, avgQueue: n.queueArea / this.scenario.measureUs,
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
        if (n.spec.kind === 'cache') {
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
      runKey: { engineVersion: ENGINE_VERSION, scenarioVersion: this.scenario.version, designHash: designHash(this.design), seed: this.seed, settings: structuredClone(this.settings), chaosTimeline: structuredClone(this.scenario.chaos), liveEditLog: [] },
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
