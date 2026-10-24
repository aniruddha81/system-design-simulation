import type { Design, EndpointSpec, NodeSpec, Scenario, Step } from '../types';
import { validateDesign } from '../validation';
import { dataCostUs } from '../data';
import { arrivalRate } from '../workload';
import { FluidCache } from './cache';
import { checkFidelity, routeSteps } from './fidelity';
import { regionPair, responseBytes, serviceTime } from './p2';
import { add, cdf, convolve, distribution, emptyPercentiles, mass, mean, mixture, moments, orderStatistic, percentiles, point, queueStep, scaled, shifted, split } from './math';
import type { Histogram, QueueStep } from './math';
import type { Conservation, ScaleMetrics, ScaleNode, ScaleOptions, ScalePoint, ScaleResult } from './types';

type Reply = { ok: Histogram; error: Histogram; throttle: Histogram; timeout: Histogram };
const reply = (ok = point()): Reply => ({ ok, error: new Map(), throttle: new Map(), timeout: new Map() });
const all = (r: Reply) => mixture(r.ok, r.error, r.throttle, r.timeout);
const keys = ['ok', 'error', 'throttle', 'timeout'] as const;
const weightReply = (r: Reply, p: number): Reply => Object.fromEntries(keys.map(k => [k, scaled(r[k], p)])) as Reply;
function plus(a: Reply, b: Reply): Reply { return Object.fromEntries(keys.map(k => [k, mixture(a[k], b[k])])) as Reply; }
function prefix(h: Histogram, r: Reply): Reply { return Object.fromEntries(keys.map(k => [k, convolve(h, r[k])])) as Reply; }
type Resource = {
  id: string; spec?: NodeSpec; workers: number; queueCapacity: number; backlog: number;
  rate: number; hold: number; cv2: number; gate: number; health: number; slow: number; wait: Histogram;
  totalRate: number; totalHold: number; totalSecond: number; hist: Histogram; errorsRate: number;
  q: QueueStep; arrivals: number; completions: number; drops: number; errors: number;
  utilArea: number; queueArea: number; maxQueue: number; measuredUs: number;
  latency: Histogram; unavailable?: string; down: boolean; tokens: number; tokenAt: number;
  writes: number; replicationBacklog: number; lagArea: number; lagMax: number; lagUs: number;
  messages: number; messageMax: number; published: number; consumerRate: number; consumerLagMaxUs: number;
  breakerUntil: number; failureRate: number; egress: number;
};
type CacheFlow = { gets: number; sets: number; originUs: number; hits: number };
const zeroQueue = () => queueStep(0, 1, 0, 1, 1, 0, 0, .01);

function validate(design: Design, scenario: Scenario, options: ScaleOptions) {
  // Reuse the shared trust boundary, lifting only Exact's duration/keyspace ceilings.
  const validationScenario = structuredClone(scenario), validationDesign = structuredClone(design);
  const durations = [scenario.warmupUs, scenario.measureUs, scenario.drainUs, ...scenario.chaos.flatMap(c => [c.atUs, ...(c.endUs === undefined ? [] : [c.endUs])])];
  if (durations.some(x => !Number.isSafeInteger(x) || x < 0) || scenario.measureUs <= 0 || !Number.isSafeInteger(scenario.workload.keys.n) || scenario.workload.keys.n < 1) throw new Error('Scale times and key count must be non-negative safe integers; measurement and key count must be positive.');
  if (!Number.isSafeInteger(scenario.warmupUs + scenario.measureUs + scenario.drainUs) || scenario.chaos.some(c => c.endUs !== undefined && c.endUs <= c.atUs)) throw new Error('Scale end time must be safe and chaos end must follow its start.');
  validationScenario.warmupUs = Math.min(scenario.warmupUs, 3_600_000_000);
  validationScenario.measureUs = Math.min(scenario.measureUs, 3_600_000_000);
  validationScenario.drainUs = Math.min(scenario.drainUs, 3_600_000_000);
  validationScenario.workload.keys.n = Math.min(scenario.workload.keys.n, 1_000_000);
  if (validationScenario.workload.arrival.kind === 'replay') {
    const points = validationScenario.workload.arrival.points;
    if (points.some((p, i) => !Number.isSafeInteger(p.atUs) || p.atUs < 0 || i > 0 && p.atUs <= points[i - 1].atUs)) throw new Error('Replay times must be ordered non-negative safe integers.');
    validationScenario.workload.arrival.points = points.map((p, i) => ({ ...p, atUs: i }));
  }
  for (const e of validationDesign.entities ?? []) {
    if (!Number.isSafeInteger(e.dataset.count) || e.dataset.count < 0) throw new Error('Scale entity counts must be non-negative safe integers.');
    e.dataset.count = Math.min(e.dataset.count, 1_000_000);
  }
  // Preserve ordering/overlap while bringing long chaos timelines into the shared validator's range.
  const times = [...new Set(scenario.chaos.flatMap(c => [c.atUs, ...(c.endUs === undefined ? [] : [c.endUs])]))].sort((a, b) => a - b);
  validationScenario.chaos = validationScenario.chaos.map(c => ({ ...c, atUs: times.indexOf(c.atUs), ...(c.endUs === undefined ? {} : { endUs: times.indexOf(c.endUs) }) }));
  const issues = validateDesign(validationDesign, validationScenario).filter(i => i.code !== 'DURATION_LIMIT' && i.code !== 'DATASET_LIMIT');
  if (issues.length) throw new Error(issues.map(i => `${i.code}: ${i.message}`).join('\n'));
  const min = options.minDtUs ?? 10_000, max = options.maxDtUs ?? 1_000_000;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 10_000 || max > 1_000_000 || min > max) throw new Error('Scale Δt must be between 10ms and 1s, with min ≤ max.');
  if (options.maxSteps !== undefined && (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 5_000_000)) throw new Error('maxSteps must be in [1, 5000000].');
  for (const n of design.nodes) for (const steps of Object.values(n.handlers ?? {})) for (const s of routeSteps(steps ?? [])) if ((s.type === 'call' || s.type === 'data') && (s.retry?.max ?? 0) > 64) throw new Error('Scale supports at most 64 retries per call; reduce the retry policy.');
}

export class ScaleSession {
  readonly resources = new Map<string, Resource>();
  readonly caches = new Map<string, FluidCache>();
  private cacheFlow = new Map<string, CacheFlow>();
  private extraAttempts = 0;
  private timeUs = 0;
  private dtUs: number;
  private seriesStride = 1;
  private warnings = new Set<string>();
  private lastEvaluation?: { key: string; response: Reply };
  private cancelBudgetUs = Number.MAX_SAFE_INTEGER;
  private scaling = new Map<string, { nextUs: number; lastUs: number; pending?: { atUs: number; values: Record<string, number> } }>();
  private trafficMultiplier = 1;

  constructor(readonly design: Design, readonly scenario: Scenario, readonly options: ScaleOptions = {}) {
    validate(design, scenario, options);
    this.dtUs = options.maxDtUs ?? 1_000_000;
    for (const n of [...design.nodes].sort((a, b) => a.id.localeCompare(b.id))) if (n.kind !== 'client') {
      if (n.kind === 'autoscaler') { this.scaling.set(n.id, { nextUs: n.params.evaluateEveryUs, lastUs: -Infinity }); continue; }
      const d = serviceTime(n);
      const m = moments(d);
      const workers = 'concurrency' in n.params ? n.params.concurrency : n.kind === 'circuitBreaker' && n.params.bulkheadMax ? n.params.bulkheadMax : 250_000;
      this.resource(n.id, Math.min(workers, n.kind === 'database' ? n.params.connectionPool ?? workers : workers) * (n.kind === 'database' && !n.params.replication ? n.params.replicas : 1), 'queueCapacity' in n.params ? n.params.queueCapacity : Number.MAX_SAFE_INTEGER, m.mean, m.cv2, n);
      if (n.kind === 'cache' || n.kind === 'cdn') {
        const e = design.endpoints.find(e => scenario.workload.mix[e.id] > 0)!;
        const key = e.keyTemplate.replace(/\{[^}]+\}/g, '0');
        const inputs = Object.values(e.inputs ?? {}), input = inputs.length === 1 ? inputs[0] : undefined;
        const cacheScenario = input?.kind === 'zipf' ? { ...scenario, workload: { ...scenario.workload, keys: { kind: 'zipf' as const, n: input.max - input.min + 1, s: input.s } } } : scenario;
        this.caches.set(n.id, new FluidCache(n, cacheScenario, responseBytes(design, e) + key.length * 2));
        if (n.kind === 'cdn') for (const edge of design.edges.filter(e => e.to === n.id)) {
          const parent = design.nodes.find(n => n.id === edge.from)?.params;
          const region = parent && 'region' in parent ? parent.region : n.params.region;
          if (region !== n.params.region) this.caches.set(`${n.id}:region:${region}`, new FluidCache(n, cacheScenario, responseBytes(design, e) + key.length * 2));
        }
      }
    }
    for (const e of [...design.edges].sort((a, b) => a.id.localeCompare(b.id))) this.resource(`edge:${e.id}`, 1, Number.MAX_SAFE_INTEGER, 1, 0);
    for (const n of design.nodes) if (n.kind === 'autoscaler') for (const id of n.params.targets) this.resources.get(id)!.workers = Math.max(n.params.min, Math.min(n.params.max, this.resources.get(id)!.workers));
  }

  private resource(id: string, workers: number, queueCapacity: number, hold: number, cv2: number, spec?: NodeSpec) {
    this.resources.set(id, { id, spec, workers, queueCapacity, backlog: 0, rate: 0, hold, cv2, gate: 1, health: 1, slow: 1, wait: point(), totalRate: 0, totalHold: 0, totalSecond: 0, hist: new Map(), errorsRate: 0, q: zeroQueue(), arrivals: 0, completions: 0, drops: 0, errors: 0, utilArea: 0, queueArea: 0, maxQueue: 0, measuredUs: 0, latency: new Map(), down: false, tokens: spec?.kind === 'rateLimiter' ? spec.params.burst : 0, tokenAt: 0, writes: 0, replicationBacklog: 0, lagArea: 0, lagMax: 0, lagUs: 0, messages: 0, messageMax: 0, published: 0, consumerRate: 0, consumerLagMaxUs: 0, breakerUntil: 0, failureRate: 0, egress: 0 });
  }

  private chaos(tUs: number) {
    this.trafficMultiplier = 1;
    for (const c of this.scenario.chaos) if (c.kind === 'trafficSpike' && c.atUs <= tUs && tUs < (c.endUs ?? Infinity)) this.trafficMultiplier *= c.multiplier;
    for (const r of this.resources.values()) {
      const previous = r.down; r.down = false; r.slow = 1; r.health = 1;
      for (const c of this.scenario.chaos) if (c.target === r.id && c.atUs <= tUs && tUs < (c.endUs ?? Number.MAX_SAFE_INTEGER)) {
        if (c.kind === 'kill') r.down = true;
        if (c.kind === 'degrade') r.slow = c.slowFactor;
        if (c.kind === 'gray') r.health = 1 - c.errorRate;
      }
      if (r.spec?.kind === 'database' && r.spec.params.failover && r.spec.params.replicas > 1) {
        const f = r.spec.params.failover;
        for (const c of this.scenario.chaos) if (c.kind === 'kill' && c.target === r.id && c.atUs + f.heartbeatUs * f.missedHeartbeats + f.electionUs <= tUs && tUs < (c.endUs ?? Infinity)) r.down = false;
      }
      const p = r.spec?.params;
      for (const c of this.scenario.chaos) if (c.atUs <= tUs && tUs < (c.endUs ?? Infinity)) {
        if ((c.kind === 'zoneOutage' && p && 'zone' in p && p.zone === c.target) || (c.kind === 'regionOutage' && p && 'region' in p && p.region === c.target)) r.down = true;
      }
      if (r.spec && 'restartWarmupUs' in r.spec.params) for (const c of this.scenario.chaos) if (c.kind === 'kill' && c.target === r.id && c.endUs !== undefined && tUs >= c.endUs && tUs < c.endUs + (r.spec.params.restartWarmupUs ?? 1)) r.down = true;
      if (r.down && !previous) for (const c of this.caches.values()) if (c.spec.id === r.id) c.reset(tUs);
    }
  }

  private record(r: Resource, rate: number, hold: Histogram, response: Reply) {
    const m = mean(hold), second = [...hold].reduce((a, [x, p]) => a + x * x * p, 0) / Math.max(1e-30, mass(hold));
    r.totalRate += rate; r.totalHold += rate * m; r.totalSecond += rate * second;
    add(r.hist, all(response), rate); r.errorsRate += rate * (1 - mass(response.ok));
  }

  private send(from: string, target: string, e: EndpointSpec, rate: number, op?: 'get' | 'set' | 'delete', depth = 0, costFactor = 1): Reply {
    const edge = this.design.edges.find(edge => edge.from === from && edge.to === target)!;
    const r = this.resources.get(`edge:${edge.id}`)!;
    const bytes = responseBytes(this.design, e);
    const serial = (e.requestBytes + bytes) * 1e6 / edge.bandwidthBytesPerSec;
    const capacityUs = Math.max(1, Math.max(e.requestBytes, bytes) * 1e6 / edge.bandwidthBytesPerSec);
    let latency = 0, loss = edge.lossRate, requestPartition = false, responsePartition = false;
    for (const c of this.scenario.chaos) if (c.atUs <= this.timeUs && this.timeUs < (c.endUs ?? Infinity)) {
      if (c.kind === 'linkLatency' && c.target === edge.id) latency += c.addUs;
      if (c.kind === 'linkLoss' && c.target === edge.id) loss = 1 - (1 - loss) * (1 - c.lossRate);
      if (c.kind === 'partition') {
        requestPartition ||= c.links.some(l => l.from === from && l.to === target);
        responsePartition ||= c.links.some(l => l.from === target && l.to === from);
      }
    }
    const pair = regionPair(this.design, from, target);
    const regionalLatency = pair ? this.design.regions!.latencyUs[pair[0]][pair[1]] + this.design.regions!.latencyUs[pair[1]][pair[0]] : 0;
    const net = convolve(convolve(distribution(edge.latency), distribution(edge.latency)), shifted(r.wait, serial + 2 * latency + regionalLatency));
    const requestPass = requestPartition ? 0 : 1 - loss, p = requestPass * (responsePartition ? 0 : 1 - loss);
    const response = prefix(net, this.visit(target, e, rate * requestPass * r.gate, op, depth + 1, costFactor, from));
    const result = plus(weightReply(response, p * r.gate), { ...reply(new Map()), timeout: point(this.scenario.workload.deadlineUs, 1 - p * r.gate) });
    this.record(r, rate, point(capacityUs), result);
    return result;
  }

  private call(from: string, target: string, e: EndpointSpec, rate: number, step: Extract<Step, { timeoutUs: number }>, depth: number): Reply {
    const policy = 'retry' in step ? step.retry : undefined;
    let accumulated: Reply = reply(new Map()), previous = point(), elapsed = 0;
    for (let attempt = 0; attempt <= (policy?.max ?? 0) && mass(previous) > 1e-10; attempt++) {
      if (attempt > 0) this.extraAttempts += rate * mass(previous);
      const op = step.type === 'cacheGet' ? 'get' : step.type === 'cacheSet' ? 'set' : step.type === 'cacheDelete' ? 'delete' : undefined;
      const previousBudget = this.cancelBudgetUs;
      if (step.type === 'call' && step.cancelOnTimeout) this.cancelBudgetUs = Math.min(previousBudget, step.timeoutUs);
      let factor = 1;
      if (step.type === 'data' && step.op.kind === 'query') {
        const entity = this.design.entities!.find(entity => entity.name === step.entity)!;
        const base = moments(serviceTime(this.resources.get(target)!.spec!, e)).mean;
        factor = dataCostUs(step.op, entity, base) / base;
      }
      const response = this.send(from, target, e, rate * mass(previous), op, depth, factor);
      this.cancelBudgetUs = previousBudget;
      let tail = 0;
      for (const k of keys) { const [within, outside] = split(response[k], step.timeoutUs); response[k] = within; tail += outside; }
      add(response.timeout, point(step.timeoutUs, tail));
      const retry: Histogram = new Map();
      if (policy && attempt < policy.max && elapsed < this.scenario.workload.deadlineUs) {
        for (const [k, category] of [['timeout', 'timeout'], ['error', '5xx'], ['throttle', '429']] as const) if (policy.retryOn.includes(category)) { add(retry, response[k]); response[k] = new Map(); }
      }
      accumulated = plus(accumulated, prefix(previous, response));
      if (mass(retry) <= 1e-10) break;
      const backoff = (policy?.backoffUs ?? 0) * (policy?.multiplier ?? 1) ** attempt;
      const backoffHist = policy?.jitter === 'full' ? new Map(Array.from({ length: 16 }, (_, i) => [backoff * (i + .5) / 16, 1 / 16])) : point(backoff);
      previous = convolve(convolve(previous, retry), backoffHist);
      elapsed = mean(previous);
      if (elapsed >= this.scenario.workload.deadlineUs) { add(accumulated.timeout, point(this.scenario.workload.deadlineUs, mass(previous))); break; }
    }
    return accumulated;
  }

  private program(id: string, e: EndpointSpec, steps: Step[], rate: number, depth: number, hit = 0, cacheId?: string, fillDelay = 0, found = 0): Reply {
    const [s, ...rest] = steps;
    if (!s) return reply();
    if (s.type === 'respond') {
      const k = s.status < 300 ? 'ok' : s.status === 429 ? 'throttle' : s.status === 504 ? 'timeout' : 'error';
      return { ...reply(new Map()), [k]: point() };
    }
    if (s.type === 'branch') {
      const cond = s.cond;
      const p = cond.kind === 'cacheHit' ? hit : cond.kind === 'found' ? found : cond.kind === 'prob' ? cond.p : cond.kind === 'leaderAlive' ? (this.resources.get(cond.store)?.down ? 0 : 1) : cond.kind === 'breakerClosed' ? ((this.resources.get(cond.breaker)?.breakerUntil ?? 0) > this.timeUs ? 0 : 1) : .5;
      return plus(weightReply(this.program(id, e, [...s.then, ...rest], rate * p, depth, hit, cacheId, fillDelay, found), p), weightReply(this.program(id, e, [...s.else, ...rest], rate * (1 - p), depth, hit, cacheId, fillDelay, found), 1 - p));
    }
    if (s.type === 'parallel') {
      const branches = s.branches.map(b => this.program(id, e, b, rate, depth + 1, hit, cacheId, fillDelay, found));
      const k = s.join.kind === 'all' ? branches.length : s.join.kind === 'any' ? 1 : s.join.kind === 'quorum' ? s.join.k : s.join.n;
      const ok = orderStatistic(branches.map(b => s.join.kind === 'firstN' ? all(b) : b.ok), k);
      const failure = s.join.kind === 'firstN' ? new Map() : orderStatistic(branches.map(b => mixture(b.error, b.throttle, b.timeout)), branches.length - k + 1);
      const next = this.program(id, e, rest, rate * mass(ok), depth, hit, cacheId, fillDelay + mean(ok), found);
      const result = prefix(ok, next); add(result.error, failure); return result;
    }
    const target = s.type === 'call' || s.type === 'data' ? s.target : s.type === 'publish' ? s.queue : s.type === 'dedup' ? s.store : s.cache;
    const operation = s.type === 'data' ? { ...e, op: s.op.kind === 'get' || s.op.kind === 'query' ? 'read' as const : 'write' as const } : e;
    const response = this.call(id, target, operation, rate, s, depth);
    let nextHit = hit, nextCache = cacheId, nextFound = found;
    if (s.type === 'data') {
      const entity = this.design.entities!.find(entity => entity.name === s.entity)!;
      nextFound = Math.min(1, entity.dataset.count / Math.max(1, entity.dataset.keys.n, this.scenario.workload.keys.n));
      if (s.op.kind === 'query' && !s.op.index) nextFound = entity.dataset.count > 0 ? 1 : 0;
      if (s.op.kind === 'put' || s.op.kind === 'insert') nextFound = 1;
      if ((s.op.kind === 'get' && rest[0]?.type !== 'branch') || s.op.kind === 'delete') {
        add(response.error, response.ok, 1 - nextFound); response.ok = scaled(response.ok, nextFound);
      }
    }
    if (s.type === 'cacheGet') {
      const flow = this.cacheFlow.get(s.cache)!;
      const c = this.caches.get(s.cache)!;
      const predicted = c.rates(Math.max(c.lookupRate, rate), s.timeoutUs, this.dtUs / 1e6);
      if (predicted.coalesced > 0 && c.originUs > 0) {
        // Independent residual-fill mixture; cache-hit branches share the same conditional approximation.
        const residual = new Map(Array.from({ length: 16 }, (_, i) => [c.originUs * (i + .5) / 16, 1 / 16]));
        response.ok = mixture(scaled(response.ok, 1 - predicted.coalesced), scaled(convolve(response.ok, residual), predicted.coalesced));
      }
      nextHit = predicted.hit * mass(response.ok);
      flow.gets += rate; flow.hits += rate * nextHit; nextCache = s.cache; fillDelay = 0;
    }
    if (s.type === 'cacheSet') {
      const flow = this.cacheFlow.get(s.cache)!;
      flow.sets += rate * cdf(response.ok, s.timeoutUs);
      flow.originUs = Math.max(flow.originUs, fillDelay + mean(all(response)));
    }
    const stopsOnError = s.type === 'call' || s.type === 'data' || s.type === 'publish' || s.type === 'dedup';
    const continuing = stopsOnError ? response.ok : all(response);
    const next = this.program(id, e, rest, rate * mass(continuing), depth, nextHit, nextCache, fillDelay + (nextCache ? mean(continuing) : 0), nextFound);
    const result = prefix(continuing, next);
    if (stopsOnError) { add(result.error, response.error); add(result.throttle, response.throttle); add(result.timeout, response.timeout); }
    return result;
  }

  private visit(id: string, e: EndpointSpec, rate: number, op: 'get' | 'set' | 'delete' | undefined, depth: number, costFactor = 1, from?: string): Reply {
    if (depth > 32) throw new Error('Scale route depth exceeds 32.');
    const r = this.resources.get(id)!, n = r.spec!;
    if (n.kind === 'client') return reply(new Map());
    const d = serviceTime(n, e);
    let extraUs = 0;
    if (n.kind === 'database' && e.op === 'write' && n.params.replication && n.params.replication !== 'async') extraUs = moments(n.params.replicationLag ?? { kind: 'constant', us: 1 }).mean + moments(n.params.writeTime).mean;
    const local = shifted(distribution(d, r.slow * costFactor), extraUs);
    const breakerOpen = n.kind === 'circuitBreaker' && r.breakerUntil > this.timeUs;
    let accepted = r.down || breakerOpen ? 0 : r.gate * r.health;
    if (n.kind === 'apiGateway' && e.requestBytes > n.params.maxRequestBytes) accepted = 0;
    if (n.kind === 'queue') accepted *= Math.max(0, Math.min(1, (n.params.capacityMessages - r.messages + r.consumerRate * this.dtUs / 1e6) / Math.max(1e-30, rate * this.dtUs / 1e6)));
    let downstream = reply();
    if (accepted * rate > 1e-12) {
      if (n.kind === 'service' || n.kind === 'worker') downstream = this.program(id, e, n.handlers?.[e.id] ?? [], rate * accepted, depth);
      if (n.kind === 'cdn') {
        const parent = this.design.nodes.find(n => n.id === from)?.params;
        const region = parent && 'region' in parent ? parent.region : n.params.region;
        const key = region === n.params.region ? id : `${id}:region:${region}`;
        const c = this.caches.get(key)!, flow = this.cacheFlow.get(key)!;
        const hit = c.rates(rate * accepted, this.scenario.workload.deadlineUs, this.dtUs / 1e6).hit;
        const edge = this.design.edges.find(edge => edge.from === id);
        const origin = edge ? this.send(id, edge.to, e, rate * accepted * (1 - hit), undefined, depth) : { ...reply(new Map()), error: point() };
        downstream = plus(reply(point(0, hit)), weightReply(origin, 1 - hit));
        flow.gets += rate * accepted; flow.hits += rate * accepted * hit;
        flow.sets += rate * accepted * (1 - hit) * cdf(origin.ok, this.scenario.workload.deadlineUs);
        flow.originUs = mean(all(origin));
      }
      if (n.kind === 'loadBalancer' || n.kind === 'rateLimiter' || n.kind === 'apiGateway' || n.kind === 'dns' || n.kind === 'circuitBreaker') {
        let targets = this.design.edges.filter(edge => edge.from === id).map(edge => edge.to).sort().filter(id => !this.resources.get(id)?.down);
        if (n.kind === 'dns') targets = n.params.records.filter(id => !this.resources.get(id)?.down).slice(0, 1);
        else if (n.kind !== 'loadBalancer') targets = targets.slice(0, 1);
        if (!targets.length) downstream = { ...reply(new Map()), error: point() };
        else {
          let permitted = 1;
          if (n.kind === 'rateLimiter') {
            const p = n.params, dt = this.dtUs / 1e6;
            const limit = p.algorithm === 'fixedWindow' || p.algorithm === 'slidingWindow' ? Math.min(p.ratePerSec, p.burst) : p.ratePerSec + r.tokens / dt;
            permitted = rate * accepted > 0 ? Math.min(1, limit / (rate * accepted)) : 1;
          }
          downstream = reply(new Map());
          const weights = targets.map(target => {
            const node = this.resources.get(target)!;
            return n.kind === 'loadBalancer' && (n.params.algorithm === 'leastConnections' || n.params.algorithm === 'p2c') ? Math.max(1e-9, node.workers / node.hold) : 1;
          });
          const sum = weights.reduce((a, b) => a + b, 0);
          targets.forEach((target, i) => { const p = weights[i] / sum; downstream = plus(downstream, weightReply(this.send(id, target, e, rate * accepted * permitted * p, undefined, depth), permitted * p)); });
          add(downstream.throttle, point(0, 1 - permitted));
        }
      }
    }
    let hold = convolve(local, all(downstream));
    if (this.cancelBudgetUs < Number.MAX_SAFE_INTEGER) {
      const [within, tail] = split(hold, Math.max(0, this.cancelBudgetUs - mean(r.wait)));
      hold = add(within, point(Math.max(1, this.cancelBudgetUs - mean(r.wait)), tail));
    }
    const response = prefix(convolve(r.wait, local), downstream);
    let result = weightReply(response, accepted);
    if (r.down) result = { ...reply(new Map()), timeout: point(this.scenario.workload.deadlineUs) };
    else add(result.error, point(0, 1 - accepted));
    if ((n.kind === 'cache' || n.kind === 'cdn') && op === 'delete') this.warnings.add('Cache invalidation predictions disabled by fidelity checks.');
    if (n.kind === 'database' && e.op === 'write') r.writes += rate * accepted * mass(downstream.ok);
    if (n.kind === 'queue') r.published += rate * accepted;
    if (n.kind === 'circuitBreaker' && !breakerOpen) r.failureRate = rate > 0 ? 1 - mass(downstream.ok) : 0;
    this.record(r, rate, hold, result);
    return result;
  }

  private evaluate(tUs: number, dtUs: number, offered: number): { response: Reply; maxChange: number } {
    const key = JSON.stringify([offered, dtUs, this.scenario.chaos.length ? tUs : 0, [...this.resources.values()].map(r => [r.backlog, r.slow, r.health, r.down, r.tokens, r.workers, r.messages, r.breakerUntil]), [...this.caches.values()].map(c => [c.occupancy, c.hitRate, c.originSuccess, c.originUs])]);
    if (this.lastEvaluation?.key === key) {
      const maxChange = Math.max(0, ...[...this.resources.values()].map(r => Math.abs(r.totalRate - r.rate) / Math.max(1, r.totalRate, r.rate)));
      return { response: this.lastEvaluation.response, maxChange };
    }
    let result = reply(new Map()), maxChange = 0;
    this.dtUs = dtUs;
    for (let iteration = 0; iteration < 12; iteration++) {
      this.cacheFlow = new Map([...this.caches.keys()].map(id => [id, { gets: 0, sets: 0, originUs: 0, hits: 0 }]));
      this.extraAttempts = 0;
      for (const r of this.resources.values()) { r.totalRate = 0; r.totalHold = 0; r.totalSecond = 0; r.hist = new Map(); r.errorsRate = 0; r.writes = 0; r.published = 0; }
      result = reply(new Map());
      const clients = this.design.nodes.filter(n => n.kind === 'client').sort((a, b) => a.id.localeCompare(b.id));
      const total = Object.values(this.scenario.workload.mix).reduce((a, b) => a + b, 0);
      for (const e of [...this.design.endpoints].sort((a, b) => a.id.localeCompare(b.id))) {
        const p = (this.scenario.workload.mix[e.id] ?? 0) / total / clients.length;
        if (p <= 0) continue;
        for (const c of clients) result = plus(result, weightReply(this.send(c.id, c.params.entry, e, offered * p), p));
      }
      for (const q of this.resources.values()) if (q.spec?.kind === 'queue') {
        const consumers = this.design.nodes.filter(n => n.kind === 'worker' && n.params.source === q.id);
        const available = q.down ? 0 : q.published + q.messages / (dtUs / 1e6);
        let remaining = available; q.consumerRate = 0;
        for (const worker of consumers) {
          const r = this.resources.get(worker.id)!;
          const rate = r.down ? 0 : Math.min(remaining, r.workers * 1e6 / Math.max(1, r.hold));
          let succeeded = 0;
          for (const endpoint of this.design.endpoints) {
            const p = (this.scenario.workload.mix[endpoint.id] ?? 0) / total;
            succeeded += p * mass(this.visit(worker.id, endpoint, rate * p, undefined, 0).ok);
          }
          q.consumerRate += rate * succeeded; remaining -= rate;
        }
      }
      let convergence = 0;
      for (const r of this.resources.values()) {
        const hold = r.totalRate > 0 ? r.totalHold / r.totalRate : r.hold;
        const cv2 = r.totalRate > 0 ? Math.max(0, r.totalSecond / r.totalRate / hold ** 2 - 1) : r.cv2;
        const q = queueStep(r.totalRate, hold, cv2, this.scenario.workload.arrival.kind === 'poisson' ? 1 : 0, r.down ? 0 : r.workers, r.queueCapacity, r.backlog, dtUs / 1e6);
        const gate = r.totalRate > 0 ? Math.min(1, q.completions / (r.totalRate * dtUs / 1e6)) : 1;
        convergence = Math.max(convergence, Math.abs(gate - r.gate), Math.abs(hold - r.hold) / Math.max(1, hold));
        r.q = q; r.wait = q.wait; r.hold = hold; r.cv2 = cv2;
        // Damping prevents a capacity/feedback two-cycle under overload and retries.
        r.gate = iteration < 10 ? (r.gate + gate) / 2 : gate;
      }
      for (const [id, flow] of this.cacheFlow) {
        const c = this.caches.get(id)!;
        c.learn(flow.sets, flow.originUs);
        c.rates(flow.gets, this.scenario.workload.deadlineUs, dtUs / 1e6);
      }
      if (iteration >= 2 && convergence < .001) break;
      if (iteration === 11 && convergence > .05) this.warnings.add('Flow feedback did not converge within 12 iterations; predictions are low-confidence.');
    }
    for (const r of this.resources.values()) {
      maxChange = Math.max(maxChange, Math.abs(r.totalRate - r.rate) / Math.max(1, r.totalRate, r.rate), Math.abs(r.q.backlog - r.backlog) / Math.max(1, r.backlog, r.q.backlog));
    }
    for (const [id, f] of this.cacheFlow) maxChange = Math.max(maxChange, this.caches.get(id)!.change(dtUs / 1e6, f.sets, f.gets));
    this.lastEvaluation = { key, response: result };
    return { response: result, maxChange };
  }

  run(options: ScaleOptions = this.options, multiple = 1, warmupUs = this.scenario.warmupUs, measureUs = this.scenario.measureUs, drainUs = this.scenario.drainUs): ScaleResult {
    const fidelity = checkFidelity(this.design, this.scenario);
    const startUs = this.timeUs, arrivalEndUs = startUs + warmupUs + measureUs, endUs = arrivalEndUs + drainUs, measureAt = startUs + warmupUs;
    const minDt = options.minDtUs ?? 10_000, maxDt = options.maxDtUs ?? 1_000_000;
    const maxSteps = options.maxSteps ?? 5_000_000;
    let steps = 0, stableSteps = 0, offeredCount = 0, successCount = 0, timelyCount = 0, attempts = 0, timeoutCount = 0;
    let measuredUs = 0, admittedCount = 0, unfinishedCount = 0;
    let outcome: ScaleResult['outcome'] = 'finished';
    const successHist: Histogram = new Map(), allHist: Histogram = new Map();
    let series: ScalePoint[] = [];
    this.seriesStride = 1;
    for (const r of this.resources.values()) { r.arrivals = 0; r.completions = 0; r.drops = 0; r.errors = 0; r.utilArea = 0; r.queueArea = 0; r.maxQueue = 0; r.latency = new Map(); r.unavailable = undefined; r.lagArea = 0; r.lagMax = 0; r.egress = 0; r.messageMax = r.messages; }
    while (this.timeUs < endUs) {
      if (options.signal?.aborted) { outcome = 'cancelled'; break; }
      if (steps >= maxSteps) { outcome = 'step-limit'; break; }
      this.chaos(this.timeUs);
      for (const n of this.design.nodes) if (n.kind === 'autoscaler') {
        const state = this.scaling.get(n.id)!, p = n.params;
        if (state.pending && state.pending.atUs <= this.timeUs) {
          for (const id of p.targets) this.resources.get(id)!.workers = state.pending.values[id];
          state.pending = undefined;
        }
        if (state.nextUs <= this.timeUs) {
          state.nextUs = this.timeUs + p.evaluateEveryUs;
          const down = this.scenario.chaos.some(c => c.kind === 'kill' && c.target === n.id && c.atUs <= this.timeUs && this.timeUs < (c.endUs ?? Infinity));
          if (!down && !state.pending && this.timeUs >= state.lastUs + p.cooldownUs) {
            const desired = Object.fromEntries(p.targets.map(id => {
              const r = this.resources.get(id)!;
              const metric = p.metric === 'utilisation' ? r.q.utilisation : Math.max(r.backlog, r.q.stationaryQueue);
              return [id, Math.max(p.min, Math.min(p.max, Math.ceil(r.workers * metric / p.targetValue)))];
            }));
            if (p.targets.some(id => this.resources.get(id)!.workers !== desired[id])) {
              state.pending = { values: desired, atUs: this.timeUs + p.provisionUs + p.warmupUs }; state.lastUs = this.timeUs;
              if (state.pending.atUs === this.timeUs) { for (const id of p.targets) this.resources.get(id)!.workers = desired[id]; state.pending = undefined; }
            }
          }
        }
      }
      for (const r of this.resources.values()) if (r.spec?.kind === 'circuitBreaker' && r.rate * r.spec.params.windowUs / 1e6 >= r.spec.params.minRequests && r.failureRate >= r.spec.params.failureRateThreshold && r.breakerUntil <= this.timeUs) {
        r.breakerUntil = this.timeUs + r.spec.params.openUs; r.failureRate = 0;
      }
      let dt = Math.min(this.dtUs, maxDt, endUs - this.timeUs);
      const a = this.scenario.workload.arrival;
      const recoveryTimes = this.scenario.chaos.flatMap(c => {
        const n = this.design.nodes.find(n => n.id === c.target);
        return c.kind === 'kill' && n ? [c.endUs === undefined ? 0 : c.endUs + ('restartWarmupUs' in n.params ? n.params.restartWarmupUs ?? 1 : 1), ...(n.kind === 'database' && n.params.failover ? [c.atUs + n.params.failover.heartbeatUs * n.params.failover.missedHeartbeats + n.params.failover.electionUs] : [])] : [];
      });
      const boundaries = [measureAt, arrivalEndUs, endUs, ...recoveryTimes, ...[...this.scaling.values()].flatMap(s => [s.nextUs, s.pending?.atUs ?? 0]), ...[...this.resources.values()].map(r => r.breakerUntil), ...this.scenario.chaos.flatMap(c => [c.atUs, ...(c.endUs === undefined ? [] : [c.endUs])]), ...(a.kind === 'step' ? [a.stepAtUs] : a.kind === 'spike' ? [a.spikeAtUs, a.spikeAtUs + a.spikeDurUs] : a.kind === 'replay' ? a.points.map(p => p.atUs) : [])];
      for (const b of boundaries) if (b > this.timeUs) dt = Math.min(dt, b - this.timeUs);
      let rate = arrivalRate(a, this.timeUs + dt / 2, this.scenario.warmupUs + this.scenario.measureUs) * multiple * this.trafficMultiplier;
      if (this.timeUs >= arrivalEndUs) rate = 0;
      let prediction = this.evaluate(this.timeUs, dt, rate);
      while (prediction.maxChange > .1 && dt > minDt) {
        dt = Math.max(minDt, dt / 2);
        rate = this.timeUs >= arrivalEndUs ? 0 : arrivalRate(a, this.timeUs + dt / 2, this.scenario.warmupUs + this.scenario.measureUs) * multiple * this.trafficMultiplier;
        prediction = this.evaluate(this.timeUs, dt, rate);
      }
      this.dtUs = dt;
      if (prediction.maxChange < .05) stableSteps++; else stableSteps = 0;
      const measured = this.timeUs >= measureAt && this.timeUs < arrivalEndUs, seconds = dt / 1e6;
      const response = prediction.response;
      const within = cdf(response.ok, this.scenario.workload.deadlineUs);
      const pointNodes: ScalePoint['nodes'] = {}, conservation: Conservation[] = [];
      for (const r of this.resources.values()) {
        const q = r.q, backlogStart = r.backlog;
        r.backlog = q.backlog; r.rate = r.totalRate;
        conservation.push({ nodeId: r.id, tUs: this.timeUs, dtUs: dt, backlogStart, arrivals: q.arrivals, completions: q.completions, drops: q.drops, backlogEnd: q.backlog });
        pointNodes[r.id] = { utilisation: q.utilisation, backlog: q.backlog, arrivalsPerSec: r.rate, completionsPerSec: q.completions / seconds, dropsPerSec: q.drops / seconds, concurrency: r.workers };
        const regionalCaches = [...this.caches.entries()].filter(([, c]) => c.spec.id === r.id);
        if (regionalCaches.length) {
          let gets = 0, hits = 0, occupancy = 0;
          for (const [key, cache] of regionalCaches) {
            const cf = this.cacheFlow.get(key)!;
            gets += cf.gets; hits += cf.hits; occupancy += cache.occupancy;
            if (!r.down) { cache.schedule(this.timeUs, seconds, cf.sets, cf.gets, cf.originUs); cache.advance(this.timeUs + dt, seconds); }
          }
          if (fidelity.predictions.hitRate.enabled) { pointNodes[r.id].cacheHitRate = gets > 0 ? hits / gets : 0; pointNodes[r.id].occupancy = occupancy; }
        }
        if (r.spec?.kind === 'rateLimiter') r.tokens = Math.max(0, Math.min(r.spec.params.burst, r.tokens + (r.spec.params.ratePerSec - r.rate * r.gate) * seconds));
        if (r.spec?.kind === 'queue') {
          const start = r.messages;
          r.messages = Math.max(0, Math.min(r.spec.params.capacityMessages, r.messages + (r.published - r.consumerRate) * seconds));
          conservation.push({ nodeId: `messages:${r.id}`, tUs: this.timeUs, dtUs: dt, backlogStart: start, arrivals: r.published * seconds, completions: Math.min(start + r.published * seconds, r.consumerRate * seconds), drops: Math.max(0, start + (r.published - r.consumerRate) * seconds - r.spec.params.capacityMessages), backlogEnd: r.messages });
          r.messageMax = Math.max(r.messageMax, r.messages);
          if (measured && r.consumerRate > 0) r.consumerLagMaxUs = Math.max(r.consumerLagMaxUs, r.messages / Math.max(r.published, r.consumerRate) * 1e6);
          pointNodes[r.id].consumerLag = r.messages;
        }
        if (r.spec?.kind === 'database' && r.spec.params.replication && r.spec.params.replicas > 1) {
          const applyRate = r.down ? 0 : r.workers * 1e6 / moments(r.spec.params.writeTime).mean;
          r.replicationBacklog = Math.max(0, r.replicationBacklog + (r.writes - applyRate) * seconds);
          const shipping = moments(r.spec.params.replicationLag ?? { kind: 'constant', us: 1 }).mean;
          r.lagUs = shipping + (applyRate > 0 ? r.replicationBacklog / applyRate * 1e6 : 0);
          if (measured) { r.lagArea += r.lagUs * dt; r.lagMax = Math.max(r.lagMax, r.lagUs); }
          pointNodes[r.id].replicationLagUs = r.lagUs;
        }
        if (!r.spec && measured) {
          const edge = this.design.edges.find(e => `edge:${e.id}` === r.id)!;
          const pair = regionPair(this.design, edge.from, edge.to);
          if (pair) {
            const total = Object.values(this.scenario.workload.mix).reduce((a, b) => a + b, 0);
            const bytes = this.design.endpoints.reduce((sum, e) => sum + (this.scenario.workload.mix[e.id] ?? 0) / total * (e.requestBytes * this.design.regions!.egressCostPerGB[pair[0]][pair[1]] + responseBytes(this.design, e) * this.design.regions!.egressCostPerGB[pair[1]][pair[0]]), 0);
            r.egress += r.rate * seconds * bytes / 1e9;
          }
        }
        if (measured) {
          r.arrivals += q.arrivals; r.completions += q.completions; r.drops += q.drops; r.errors += r.errorsRate * seconds;
          r.utilArea += q.utilisation * dt; r.queueArea += (q.regime === 'stable' ? q.stationaryQueue : (backlogStart + q.backlog) / 2) * dt;
          r.maxQueue = Math.max(r.maxQueue, q.backlog, q.stationaryQueue); add(r.latency, r.hist, seconds);
          if (r.rate > 0 && (r.down || r.cv2 > 16 || r.rate / Math.max(1e-30, q.capacity) > .95)) r.unavailable = r.down ? 'Capacity is zero during an outage.' : r.cv2 > 16 ? 'Service CV exceeds 4.' : 'Utilisation exceeds the validated 0.95 envelope.';
          if (r.spec?.kind === 'loadBalancer') {
            const interval = r.spec.params.healthCheck.intervalUs;
            if (this.design.edges.filter(e => e.from === r.id).some(e => {
              const target = this.resources.get(e.to)!;
              return mean(target.wait) + target.hold > interval;
            })) {
              r.unavailable = 'Congested health probes can change routing outside the validated envelope.';
              this.warnings.add('Congested LB health-probe routing and failure-ladder order are low-confidence; validate in Exact.');
            }
          }
        }
      }
      if (measured) {
        const count = rate * seconds;
        // Integrate arrival cohorts through the drain horizon, without treating unfinished work as failure.
        const deadline = this.scenario.workload.deadlineUs;
        const horizon = Math.max(0, endUs - (this.timeUs + dt / 2));
        const [boundedAll, deadlineTail] = split(all(response), deadline);
        add(boundedAll, point(deadline, deadlineTail));
        const [completed] = split(boundedAll, horizon);
        const [ok] = split(response.ok, Math.min(deadline, horizon));
        measuredUs += dt; offeredCount += count; successCount += count * mass(ok); timelyCount += count * mass(ok);
        unfinishedCount += count * Math.max(0, 1 - mass(completed));
        timeoutCount += count * (cdf(response.timeout, Math.min(deadline, horizon)) + (horizon >= deadline ? deadlineTail : 0));
        attempts += count + this.extraAttempts * seconds;
        admittedCount += Math.max(0, count * (1 - mass(response.throttle)) - [...this.resources.values()].filter(r => r.spec).reduce((sum, r) => sum + r.q.drops, 0));
        add(successHist, ok, count);
        add(allHist, completed, count);
      }
      const step: ScalePoint = { tUs: this.timeUs, dtUs: dt, offeredPerSec: rate, succeededPerSec: rate * within, estimatedTimelySuccessRatio: rate > 0 && fidelity.predictions.timelySuccess.enabled ? within : null, retryAmplification: rate > 0 ? 1 + this.extraAttempts / rate : null, nodes: pointNodes };
      if (steps % this.seriesStride === 0) series.push(step);
      if (series.length > 600) { series = series.filter((_, i) => i % 2 === 0); this.seriesStride *= 2; }
      options.onStep?.(step, conservation);
      this.timeUs += dt; steps++;
      if (stableSteps >= 4) { this.dtUs = Math.min(maxDt, dt * 2); stableSteps = 0; }
    }
    const dynamicUnavailable = [...this.resources.values()].some(r => r.unavailable);
    const latencyEnabled = fidelity.predictions.latency.enabled && !dynamicUnavailable;
    const nodes: ScaleNode[] = [...this.resources.values()].map(r => {
      const c = this.caches.get(r.id), enabled = !c || fidelity.predictions.hitRate.enabled;
      const regions = [...this.caches.values()].filter(c => c.spec.id === r.id);
      const lookupRate = regions.reduce((sum, c) => sum + c.lookupRate, 0);
      const weighted = (field: 'hitRate' | 'steadyHitRate') => lookupRate > 0 ? regions.reduce((sum, c) => sum + c[field] * c.lookupRate, 0) / lookupRate : 0;
      return { nodeId: r.id, concurrency: r.workers, utilisation: measuredUs > 0 ? r.utilArea / measuredUs : 0, backlog: r.backlog, avgQueue: measuredUs > 0 ? r.queueArea / measuredUs : 0, maxQueue: r.maxQueue, arrivals: r.arrivals, completions: r.completions, drops: r.drops, errors: r.errors, capacityPerSec: r.q.capacity,
        latency: !r.unavailable && latencyEnabled ? percentiles(r.latency, r.completions) : emptyPercentiles(), ...(r.unavailable ? { unavailableReason: r.unavailable } : {}),
        ...(c ? { cache: { occupancy: regions.reduce((sum, c) => sum + c.occupancy, 0), hitRate: enabled ? weighted('hitRate') : null, steadyHitRate: weighted('steadyHitRate'), timeTo90Us: c.timeTo90Us, originPerSec: regions.reduce((sum, c) => sum + c.originPerSec, 0) } } : {}),
        ...(r.spec?.kind === 'queue' ? { queue: { depth: r.messages, depthMax: r.messageMax, consumerPerSec: r.consumerRate, consumerLagMaxUs: r.consumerLagMaxUs } } : {}),
        ...(r.spec?.kind === 'database' && r.spec.params.replication ? { replication: { backlog: r.replicationBacklog, lagUs: r.lagUs, meanLagUs: measuredUs > 0 ? r.lagArea / measuredUs : 0, maxLagUs: r.lagMax } } : {}) };
    });
    const seconds = measuredUs / 1e6;
    const compute = this.design.nodes.reduce((sum, n) => sum + ('costPerHour' in n.params ? n.params.costPerHour * (n.kind === 'database' ? n.params.replicas : 1) : 0), 0) * 24 * 30;
    const egress = seconds > 0 ? [...this.resources.values()].reduce((sum, r) => sum + r.egress, 0) / seconds * 30 * 24 * 3600 : 0;
    const requestAndStorage = this.design.nodes.reduce((sum, n) => {
      const r = this.resources.get(n.id);
      if (n.kind === 'cdn') return sum + (seconds > 0 ? (r?.completions ?? 0) / seconds * this.design.endpoints.reduce((bytes, e) => bytes + responseBytes(this.design, e) * (this.scenario.workload.mix[e.id] ?? 0), 0) / Object.values(this.scenario.workload.mix).reduce((a, b) => a + b, 0) / 1e9 * n.params.costPerGB * 30 * 24 * 3600 : 0);
      if (n.kind !== 'objectStore') return sum;
      const storedBytes = (this.design.entities ?? []).filter(e => e.store === n.id).reduce((sum, e) => sum + e.dataset.count * e.fields.reduce((size, f) => size + f.bytes.meanBytes, 0), 0);
      return sum + storedBytes / 1e9 * n.params.costPerGBMonth + (seconds > 0 ? (r?.arrivals ?? 0) / seconds / 1e6 * n.params.costPerMillionRequests * 30 * 24 * 3600 : 0);
    }, 0);
    const monthly = compute + egress + requestAndStorage;
    const metrics: ScaleMetrics = {
      offered: offeredCount, admitted: admittedCount, succeeded: successCount, failed: Math.max(0, offeredCount - successCount - unfinishedCount), unfinished: unfinishedCount, attempts,
      estimatedTimelySuccessRatio: offeredCount > 0 && fidelity.predictions.timelySuccess.enabled ? timelyCount / offeredCount : null,
      availability: offeredCount > 0 ? successCount / offeredCount : null, retryAmplification: offeredCount > 0 ? attempts / offeredCount : null,
      timeoutTailFraction: offeredCount > 0 ? timeoutCount / offeredCount : null,
      successLatency: latencyEnabled ? percentiles(successHist, successCount) : emptyPercentiles(), allLatency: latencyEnabled ? percentiles(allHist, offeredCount) : emptyPercentiles(),
      throughput: { offeredPerSec: seconds > 0 ? offeredCount / seconds : 0, admittedPerSec: seconds > 0 ? admittedCount / seconds : 0, completedPerSec: seconds > 0 ? (offeredCount - unfinishedCount) / seconds : 0 },
      costPerMonth: monthly, costPerMillionRequests: offeredCount > 0 ? monthly / (30 * 24 * 3600) * seconds / offeredCount * 1e6 : null,
    };
    for (const state of Object.values(fidelity.predictions)) if (!state.enabled) for (const reason of state.reasons) if (!reason.includes('correctness')) this.warnings.add(reason);
    if (dynamicUnavailable) this.warnings.add('Percentiles unavailable in Scale mode: at least one visited resource is outside the validated envelope.');
    const saturated = nodes.filter(n => n.arrivals > 0).sort((a, b) => b.utilisation - a.utilisation || a.nodeId.localeCompare(b.nodeId));
    return { mode: 'scale', correctness: 'unknown', confidence: this.warnings.size ? 'low-confidence' : 'validated-envelope', assumptions: ['Independent hops, parallel branches and retry attempts; parallel loser work is retained.', 'Replication is a write/apply rate backlog; per-key correctness and quorum staleness are unknown.', 'Circuit breakers use rate thresholds; DNS, gateway and rate-limiter admission are approximate.', 'Fluid outcomes are quasi-stationary arrival-cohort estimates; drain transients are low-confidence.'], warnings: [...this.warnings].sort(), fidelity, outcome, metrics, nodes, series, steps, simEndUs: this.timeUs, bottleneck: fidelity.predictions.utilisation.enabled ? saturated[0]?.nodeId ?? null : null };
  }
}

export function runScale(design: Design, scenario: Scenario, options: ScaleOptions = {}): ScaleResult {
  return new ScaleSession(structuredClone(design), structuredClone(scenario), options).run();
}
