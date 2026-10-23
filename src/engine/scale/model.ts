import type { Design, EndpointSpec, NodeSpec, Scenario, Step } from '../types';
import { validateDesign } from '../validation';
import { FluidCache } from './cache';
import { checkFidelity, routeSteps } from './fidelity';
import { add, cdf, convolve, distribution, emptyPercentiles, mass, mean, mixture, moments, percentiles, point, queueStep, scaled, shifted, split } from './math';
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
};
type CacheFlow = { gets: number; sets: number; originUs: number; hits: number };
const zeroQueue = () => queueStep(0, 1, 0, 1, 1, 0, 0, .01);

function validate(design: Design, scenario: Scenario, options: ScaleOptions) {
  // Reuse the shared trust boundary, lifting only Exact's duration/keyspace ceilings.
  const validationScenario = structuredClone(scenario);
  const durations = [scenario.warmupUs, scenario.measureUs, scenario.drainUs, ...scenario.chaos.flatMap(c => [c.atUs, ...(c.endUs === undefined ? [] : [c.endUs])])];
  if (durations.some(x => !Number.isSafeInteger(x) || x < 0) || scenario.measureUs <= 0 || !Number.isSafeInteger(scenario.workload.keys.n) || scenario.workload.keys.n < 1) throw new Error('Scale times and key count must be non-negative safe integers; measurement and key count must be positive.');
  if (!Number.isSafeInteger(scenario.warmupUs + scenario.measureUs + scenario.drainUs) || scenario.chaos.some(c => c.endUs !== undefined && c.endUs <= c.atUs)) throw new Error('Scale end time must be safe and chaos end must follow its start.');
  validationScenario.warmupUs = Math.min(scenario.warmupUs, 3_600_000_000);
  validationScenario.measureUs = Math.min(scenario.measureUs, 3_600_000_000);
  validationScenario.drainUs = Math.min(scenario.drainUs, 3_600_000_000);
  validationScenario.workload.keys.n = Math.min(scenario.workload.keys.n, 1_000_000);
  // Preserve ordering/overlap while bringing long chaos timelines into the shared validator's range.
  const times = [...new Set(scenario.chaos.flatMap(c => [c.atUs, ...(c.endUs === undefined ? [] : [c.endUs])]))].sort((a, b) => a - b);
  validationScenario.chaos = scenario.chaos.map(c => ({ ...c, atUs: times.indexOf(c.atUs), ...(c.endUs === undefined ? {} : { endUs: times.indexOf(c.endUs) }) }));
  const issues = validateDesign(design, validationScenario).filter(i => i.code !== 'DURATION_LIMIT');
  if (issues.length) throw new Error(issues.map(i => `${i.code}: ${i.message}`).join('\n'));
  const min = options.minDtUs ?? 10_000, max = options.maxDtUs ?? 1_000_000;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 10_000 || max > 1_000_000 || min > max) throw new Error('Scale Δt must be between 10ms and 1s, with min ≤ max.');
  if (options.maxSteps !== undefined && (!Number.isInteger(options.maxSteps) || options.maxSteps < 1 || options.maxSteps > 5_000_000)) throw new Error('maxSteps must be in [1, 5000000].');
  for (const n of design.nodes) for (const steps of Object.values(n.handlers ?? {})) for (const s of routeSteps(steps ?? [])) if (s.type === 'call' && (s.retry?.max ?? 0) > 64) throw new Error('Scale supports at most 64 retries per call; reduce the retry policy.');
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

  constructor(readonly design: Design, readonly scenario: Scenario, readonly options: ScaleOptions = {}) {
    validate(design, scenario, options);
    this.dtUs = options.maxDtUs ?? 1_000_000;
    for (const n of [...design.nodes].sort((a, b) => a.id.localeCompare(b.id))) if (n.kind !== 'client') {
      const d = n.kind === 'database' ? n.params.readTime : n.params.serviceTime;
      const m = moments(d);
      this.resource(n.id, n.params.concurrency * (n.kind === 'database' ? n.params.replicas : 1), n.params.queueCapacity, m.mean, m.cv2, n);
      if (n.kind === 'cache') {
        const e = design.endpoints.find(e => scenario.workload.mix[e.id] > 0)!;
        const key = e.keyTemplate.replace(/\{[^}]+\}/g, '0');
        this.caches.set(n.id, new FluidCache(n, scenario, e.responseBytes + key.length * 2));
      }
    }
    for (const e of [...design.edges].sort((a, b) => a.id.localeCompare(b.id))) this.resource(`edge:${e.id}`, 1, Number.MAX_SAFE_INTEGER, 1, 0);
  }

  private resource(id: string, workers: number, queueCapacity: number, hold: number, cv2: number, spec?: NodeSpec) {
    this.resources.set(id, { id, spec, workers, queueCapacity, backlog: 0, rate: 0, hold, cv2, gate: 1, health: 1, slow: 1, wait: point(), totalRate: 0, totalHold: 0, totalSecond: 0, hist: new Map(), errorsRate: 0, q: zeroQueue(), arrivals: 0, completions: 0, drops: 0, errors: 0, utilArea: 0, queueArea: 0, maxQueue: 0, measuredUs: 0, latency: new Map(), down: false, tokens: spec?.kind === 'rateLimiter' ? spec.params.burst : 0, tokenAt: 0 });
  }

  private chaos(tUs: number) {
    for (const r of this.resources.values()) {
      const previous = r.down; r.down = false; r.slow = 1; r.health = 1;
      for (const c of this.scenario.chaos) if (c.target === r.id && c.atUs <= tUs && tUs < (c.endUs ?? Number.MAX_SAFE_INTEGER)) {
        if (c.kind === 'kill') r.down = true;
        if (c.kind === 'degrade') r.slow = c.slowFactor;
        if (c.kind === 'gray') r.health = 1 - c.errorRate;
      }
      if (r.down && !previous) this.caches.get(r.id)?.reset(tUs);
    }
  }

  private record(r: Resource, rate: number, hold: Histogram, response: Reply) {
    const m = mean(hold), second = [...hold].reduce((a, [x, p]) => a + x * x * p, 0) / Math.max(1e-30, mass(hold));
    r.totalRate += rate; r.totalHold += rate * m; r.totalSecond += rate * second;
    add(r.hist, all(response), rate); r.errorsRate += rate * (1 - mass(response.ok));
  }

  private send(from: string, target: string, e: EndpointSpec, rate: number, op?: 'get' | 'set' | 'delete', depth = 0): Reply {
    const edge = this.design.edges.find(edge => edge.from === from && edge.to === target)!;
    const r = this.resources.get(`edge:${edge.id}`)!;
    const serial = (e.requestBytes + e.responseBytes) * 1e6 / edge.bandwidthBytesPerSec;
    const capacityUs = Math.max(1, Math.max(e.requestBytes, e.responseBytes) * 1e6 / edge.bandwidthBytesPerSec);
    const net = convolve(convolve(distribution(edge.latency), distribution(edge.latency)), shifted(r.wait, serial));
    const p = (1 - edge.lossRate) ** 2;
    const response = prefix(net, this.visit(target, e, rate * p * r.gate, op, depth + 1));
    const result = plus(weightReply(response, p * r.gate), { ...reply(new Map()), timeout: point(this.scenario.workload.deadlineUs, 1 - p * r.gate) });
    this.record(r, rate, point(capacityUs), result);
    return result;
  }

  private call(from: string, target: string, e: EndpointSpec, rate: number, step: Extract<Step, { type: 'call' | 'cacheGet' | 'cacheSet' | 'cacheDelete' }>, depth: number): Reply {
    const policy = step.type === 'call' ? step.retry : undefined;
    let accumulated: Reply = reply(new Map()), previous = point(), elapsed = 0;
    for (let attempt = 0; attempt <= (policy?.max ?? 0) && mass(previous) > 1e-10; attempt++) {
      if (attempt > 0) this.extraAttempts += rate * mass(previous);
      const op = step.type === 'cacheGet' ? 'get' : step.type === 'cacheSet' ? 'set' : step.type === 'cacheDelete' ? 'delete' : undefined;
      const previousBudget = this.cancelBudgetUs;
      if (step.type === 'call' && step.cancelOnTimeout) this.cancelBudgetUs = Math.min(previousBudget, step.timeoutUs);
      const response = this.send(from, target, e, rate * mass(previous), op, depth);
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

  private program(id: string, e: EndpointSpec, steps: Step[], rate: number, depth: number, hit = 0, cacheId?: string, fillDelay = 0): Reply {
    const [s, ...rest] = steps;
    if (!s) return reply();
    if (s.type === 'respond') {
      const k = s.status < 300 ? 'ok' : s.status === 429 ? 'throttle' : s.status === 504 ? 'timeout' : 'error';
      return { ...reply(new Map()), [k]: point() };
    }
    if (s.type === 'branch') {
      const p = s.cond.kind === 'cacheHit' ? hit : s.cond.p;
      return plus(weightReply(this.program(id, e, [...s.then, ...rest], rate * p, depth, hit, cacheId, fillDelay), p), weightReply(this.program(id, e, [...s.else, ...rest], rate * (1 - p), depth, hit, cacheId, fillDelay), 1 - p));
    }
    const target = s.type === 'call' ? s.target : s.cache;
    const response = this.call(id, target, e, rate, s, depth);
    let nextHit = hit, nextCache = cacheId;
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
    const continuing = s.type === 'call' ? response.ok : all(response);
    const next = this.program(id, e, rest, rate * mass(continuing), depth, nextHit, nextCache, fillDelay + (nextCache ? mean(continuing) : 0));
    const result = prefix(continuing, next);
    if (s.type === 'call') { add(result.error, response.error); add(result.throttle, response.throttle); add(result.timeout, response.timeout); }
    return result;
  }

  private visit(id: string, e: EndpointSpec, rate: number, op: 'get' | 'set' | 'delete' | undefined, depth: number): Reply {
    if (depth > 32) throw new Error('Scale route depth exceeds 32.');
    const r = this.resources.get(id)!, n = r.spec!;
    if (n.kind === 'client') return reply(new Map());
    const d = n.kind === 'database' ? (e.op === 'write' ? n.params.writeTime : n.params.readTime) : n.params.serviceTime;
    const local = distribution(d, r.slow), accepted = r.down ? 0 : r.gate * r.health;
    let downstream = reply();
    if (accepted * rate > 1e-12) {
      if (n.kind === 'service') downstream = this.program(id, e, n.handlers?.[e.id] ?? [], rate * accepted, depth);
      if (n.kind === 'loadBalancer' || n.kind === 'rateLimiter') {
        let targets = this.design.edges.filter(edge => edge.from === id).map(edge => edge.to).sort().filter(id => !this.resources.get(id)?.down);
        if (n.kind === 'rateLimiter') targets = targets.slice(0, 1);
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
    if (n.kind === 'cache' && op === 'delete') this.warnings.add('Cache invalidation predictions disabled by fidelity checks.');
    this.record(r, rate, hold, result);
    return result;
  }

  private evaluate(tUs: number, dtUs: number, offered: number): { response: Reply; maxChange: number } {
    const key = JSON.stringify([offered, dtUs, [...this.resources.values()].map(r => [r.backlog, r.slow, r.health, r.down, r.tokens]), [...this.caches.values()].map(c => [c.occupancy, c.hitRate, c.originSuccess, c.originUs])]);
    if (this.lastEvaluation?.key === key) {
      const maxChange = Math.max(0, ...[...this.resources.values()].map(r => Math.abs(r.totalRate - r.rate) / Math.max(1, r.totalRate, r.rate)));
      return { response: this.lastEvaluation.response, maxChange };
    }
    let result = reply(new Map()), maxChange = 0;
    this.dtUs = dtUs;
    for (let iteration = 0; iteration < 12; iteration++) {
      this.cacheFlow = new Map([...this.caches.keys()].map(id => [id, { gets: 0, sets: 0, originUs: 0, hits: 0 }]));
      this.extraAttempts = 0;
      for (const r of this.resources.values()) { r.totalRate = 0; r.totalHold = 0; r.totalSecond = 0; r.hist = new Map(); r.errorsRate = 0; }
      result = reply(new Map());
      const clients = this.design.nodes.filter(n => n.kind === 'client').sort((a, b) => a.id.localeCompare(b.id));
      const total = Object.values(this.scenario.workload.mix).reduce((a, b) => a + b, 0);
      for (const e of [...this.design.endpoints].sort((a, b) => a.id.localeCompare(b.id))) {
        const p = (this.scenario.workload.mix[e.id] ?? 0) / total / clients.length;
        if (p <= 0) continue;
        for (const c of clients) result = plus(result, weightReply(this.send(c.id, c.params.entry, e, offered * p), p));
      }
      let convergence = 0;
      for (const r of this.resources.values()) {
        const hold = r.totalRate > 0 ? r.totalHold / r.totalRate : r.hold;
        const cv2 = r.totalRate > 0 ? Math.max(0, r.totalSecond / r.totalRate / hold ** 2 - 1) : r.cv2;
        const q = queueStep(r.totalRate, hold, cv2, this.scenario.workload.arrival.kind === 'constant' ? 0 : 1, r.down ? 0 : r.workers, r.queueCapacity, r.backlog, dtUs / 1e6);
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
    const startUs = this.timeUs, arrivalEndUs = startUs + warmupUs + measureUs, endUs = arrivalEndUs + drainUs, measureAt = startUs + warmupUs;
    const minDt = options.minDtUs ?? 10_000, maxDt = options.maxDtUs ?? 1_000_000;
    const maxSteps = options.maxSteps ?? 5_000_000;
    let steps = 0, stableSteps = 0, offeredCount = 0, successCount = 0, timelyCount = 0, attempts = 0, timeoutCount = 0;
    let measuredUs = 0, admittedCount = 0, unfinishedCount = 0;
    let outcome: ScaleResult['outcome'] = 'finished';
    const successHist: Histogram = new Map(), allHist: Histogram = new Map();
    let series: ScalePoint[] = [];
    this.seriesStride = 1;
    for (const r of this.resources.values()) { r.arrivals = 0; r.completions = 0; r.drops = 0; r.errors = 0; r.utilArea = 0; r.queueArea = 0; r.maxQueue = 0; r.latency = new Map(); r.unavailable = undefined; }
    while (this.timeUs < endUs) {
      if (options.signal?.aborted) { outcome = 'cancelled'; break; }
      if (steps >= maxSteps) { outcome = 'step-limit'; break; }
      this.chaos(this.timeUs);
      let dt = Math.min(this.dtUs, maxDt, endUs - this.timeUs);
      const a = this.scenario.workload.arrival;
      const boundaries = [measureAt, arrivalEndUs, endUs, ...this.scenario.chaos.flatMap(c => [c.atUs, ...(c.endUs === undefined ? [] : [c.endUs])]), ...(a.kind === 'step' ? [a.stepAtUs] : a.kind === 'spike' ? [a.spikeAtUs, a.spikeAtUs + a.spikeDurUs] : [])];
      for (const b of boundaries) if (b > this.timeUs) dt = Math.min(dt, b - this.timeUs);
      let rate = a.rps;
      if (a.kind === 'step' && this.timeUs >= a.stepAtUs) rate = a.stepRps;
      if (a.kind === 'spike' && this.timeUs >= a.spikeAtUs && this.timeUs < a.spikeAtUs + a.spikeDurUs) rate = a.spikeRps;
      rate *= multiple;
      if (this.timeUs >= arrivalEndUs) rate = 0;
      let prediction = this.evaluate(this.timeUs, dt, rate);
      while (prediction.maxChange > .1 && dt > minDt) {
        dt = Math.max(minDt, dt / 2); prediction = this.evaluate(this.timeUs, dt, rate);
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
        pointNodes[r.id] = { utilisation: q.utilisation, backlog: q.backlog, arrivalsPerSec: r.rate, completionsPerSec: q.completions / seconds, dropsPerSec: q.drops / seconds };
        const cache = this.caches.get(r.id), cf = this.cacheFlow.get(r.id);
        if (cache && cf) {
          const hit = cf.gets > 0 ? cf.hits / cf.gets : 0;
          pointNodes[r.id].cacheHitRate = hit; pointNodes[r.id].occupancy = cache.occupancy;
          if (!r.down) cache.schedule(this.timeUs, seconds, cf.sets, cf.gets, cf.originUs);
          if (!r.down) cache.advance(this.timeUs + dt, seconds);
        }
        if (r.spec?.kind === 'rateLimiter') r.tokens = Math.max(0, Math.min(r.spec.params.burst, r.tokens + (r.spec.params.ratePerSec - r.rate * r.gate) * seconds));
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
      const step: ScalePoint = { tUs: this.timeUs, dtUs: dt, offeredPerSec: rate, succeededPerSec: rate * within, estimatedTimelySuccessRatio: rate > 0 ? within : null, retryAmplification: rate > 0 ? 1 + this.extraAttempts / rate : null, nodes: pointNodes };
      if (steps % this.seriesStride === 0) series.push(step);
      if (series.length > 600) { series = series.filter((_, i) => i % 2 === 0); this.seriesStride *= 2; }
      options.onStep?.(step, conservation);
      this.timeUs += dt; steps++;
      if (stableSteps >= 4) { this.dtUs = Math.min(maxDt, dt * 2); stableSteps = 0; }
    }
    const fidelity = checkFidelity(this.design, this.scenario);
    const dynamicUnavailable = [...this.resources.values()].some(r => r.unavailable);
    const latencyEnabled = fidelity.predictions.latency.enabled && !dynamicUnavailable;
    const nodes: ScaleNode[] = [...this.resources.values()].map(r => {
      const c = this.caches.get(r.id), enabled = !c || fidelity.predictions.hitRate.enabled;
      return { nodeId: r.id, utilisation: measuredUs > 0 ? r.utilArea / measuredUs : 0, backlog: r.backlog, avgQueue: measuredUs > 0 ? r.queueArea / measuredUs : 0, maxQueue: r.maxQueue, arrivals: r.arrivals, completions: r.completions, drops: r.drops, errors: r.errors, capacityPerSec: r.q.capacity,
        latency: !r.unavailable && latencyEnabled ? percentiles(r.latency, r.completions) : emptyPercentiles(), ...(r.unavailable ? { unavailableReason: r.unavailable } : {}),
        ...(c ? { cache: { occupancy: c.occupancy, hitRate: enabled ? c.hitRate : null, steadyHitRate: c.steadyHitRate, timeTo90Us: c.timeTo90Us, originPerSec: c.originPerSec } } : {}) };
    });
    const monthly = this.design.nodes.reduce((sum, n) => sum + (n.kind === 'client' ? 0 : n.params.costPerHour * (n.kind === 'database' ? n.params.replicas : 1)), 0) * 24 * 30;
    const seconds = measuredUs / 1e6;
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
    return { mode: 'scale', correctness: 'unknown', confidence: this.warnings.size ? 'low-confidence' : 'validated-envelope', assumptions: ['Independent hops, branches and retry attempts.', 'P1 replicas multiply capacity and cost; no replication correctness.', 'Fluid outcomes are quasi-stationary arrival-cohort estimates; drain transients are low-confidence.'], warnings: [...this.warnings].sort(), fidelity, outcome, metrics, nodes, series, steps, simEndUs: this.timeUs, bottleneck: saturated[0]?.nodeId ?? null };
  }
}

export function runScale(design: Design, scenario: Scenario, options: ScaleOptions = {}): ScaleResult {
  return new ScaleSession(structuredClone(design), structuredClone(scenario), options).run();
}
