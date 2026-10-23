// Shared engine contract (PLAN.md §5, §7, §8A). Owned by the engine workstream;
// UI, grading and persistence code depend on these shapes. Change only by agreement.

export type Us = number; // integer microseconds (§5.1)
export type NodeId = string;
export type EndpointId = string;

// ---------- distributions ----------
export type Dist =
  | { kind: "constant"; us: Us }
  | { kind: "exponential"; meanUs: Us }
  | { kind: "lognormal"; medianUs: Us; sigma: number }
  | { kind: "empirical"; buckets: { us: Us; weight: number }[] };

// ---------- design (what the learner builds; hashed into RunKey) ----------
export type ComponentKind =
  | "client"
  | "loadBalancer"
  | "service"
  | "cache"
  | "database"
  | "rateLimiter";

export type QueueParams = {
  concurrency: number; // workers
  queueCapacity: number; // waiting slots; full => reject (503)
  queueDiscipline: "fifo" | "lifo";
  costPerHour: number; // USD
  region: string;
  zone: string;
};

export type NodeParams = {
  client: { entry: NodeId }; // where generated requests are sent
  loadBalancer: QueueParams & {
    algorithm: "roundRobin" | "leastConnections" | "p2c" | "consistentHash";
    serviceTime: Dist;
    healthCheck: { intervalUs: Us; unhealthyThreshold: number; healthyThreshold: number };
  };
  service: QueueParams & { serviceTime: Dist };
  cache: QueueParams & {
    serviceTime: Dist;
    capacityBytes: number;
    eviction: "lru" | "lfu";
    ttlUs?: Us; // undefined = no TTL
    coalesce: boolean; // request coalescing for concurrent misses
  };
  database: QueueParams & {
    readTime: Dist;
    writeTime: Dist;
    replicas: number; // P1: capacity only; replication semantics arrive in P2
  };
  rateLimiter: QueueParams & {
    serviceTime: Dist;
    algorithm: "tokenBucket" | "leakyBucket" | "fixedWindow" | "slidingWindow";
    ratePerSec: number;
    burst: number;
  };
};

export type NodeSpec<K extends ComponentKind = ComponentKind> = K extends ComponentKind
  ? {
      id: NodeId;
      kind: K;
      label: string;
      position: { x: number; y: number }; // excluded from designHash
      params: NodeParams[K];
      // Route program per endpoint, run when a request for that endpoint arrives here.
      // loadBalancer/cache/database/rateLimiter have built-in behaviour and ignore handlers,
      // except rateLimiter which forwards to its single outgoing edge.
      handlers?: Partial<Record<EndpointId, Step[]>>;
    }
  : never;

export type EdgeSpec = {
  id: string;
  from: NodeId; // edge means "from may call to" (§8A.5)
  to: NodeId;
  latency: Dist; // one-way propagation
  bandwidthBytesPerSec: number; // contended FIFO per direction (§5.4)
  lossRate: number; // [0,1]
};

export type EndpointSpec = {
  id: EndpointId;
  name: string; // e.g. "GET /user/:id"
  op: "read" | "write";
  keyTemplate: string; // e.g. "user:{userId}"
  requestBytes: number;
  responseBytes: number;
  idempotent: boolean;
};

export type Design = {
  schemaVersion: 1;
  id: string;
  name: string;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  endpoints: EndpointSpec[];
};

// ---------- route program (§5.2) — P1 subset ----------
export type RetryPolicy = {
  max: number;
  backoffUs: Us;
  multiplier: number;
  jitter: "none" | "full";
  retryOn: ("timeout" | "5xx" | "429")[];
};

export type Condition =
  | { kind: "cacheHit" } // result of the most recent cacheGet in this route
  | { kind: "prob"; p: number }; // explicitly probabilistic

export type Step =
  | { type: "call"; target: NodeId; timeoutUs: Us; retry?: RetryPolicy; cancelOnTimeout?: boolean }
  | { type: "cacheGet"; cache: NodeId; timeoutUs: Us }
  | { type: "cacheSet"; cache: NodeId; timeoutUs: Us }
  | { type: "cacheDelete"; cache: NodeId; timeoutUs: Us }
  | { type: "branch"; cond: Condition; then: Step[]; else: Step[] }
  | { type: "respond"; status: Status };

export type Status = 200 | 201 | 404 | 409 | 429 | 503 | 504;

// ---------- scenario (workload + chaos) ----------
export type KeyDist =
  | { kind: "uniform"; n: number }
  | { kind: "zipf"; n: number; s: number }
  | { kind: "hotspot"; n: number; hotFraction: number } // one key gets hotFraction of traffic
  | { kind: "sequential"; n: number };

export type Workload = {
  arrival:
    | { kind: "poisson"; rps: number }
    | { kind: "constant"; rps: number }
    | { kind: "step"; rps: number; stepAtUs: Us; stepRps: number }
    | { kind: "spike"; rps: number; spikeAtUs: Us; spikeDurUs: Us; spikeRps: number };
  mix: Record<EndpointId, number>; // weights
  keys: KeyDist;
  deadlineUs: Us; // per logical request, inclusive (§5.1)
};

export type ChaosEvent = {
  id: string;
  target: NodeId;
  atUs: Us;
  endUs?: Us;
} & (
  | { kind: "kill" }
  | { kind: "degrade"; slowFactor: number }
  | { kind: "gray"; errorRate: number }
);

export type Scenario = {
  id: string;
  version: number;
  workload: Workload;
  chaos: ChaosEvent[];
  warmupUs: Us;
  measureUs: Us;
  drainUs: Us;
};

export type RunSettings = {
  traceSampleRate: number; // fraction of requests sent for packet animation (visual only, not in results)
  limits?: Partial<{ events: number; liveRequests: number; heap: number; queued: number; memoryBytes: number }>;
};

// §5.1 — same RunKey => byte-identical results.
export type RunKey = {
  engineVersion: string;
  scenarioVersion: number;
  designHash: string;
  seed: number;
  settings: RunSettings;
  chaosTimeline: ChaosEvent[];
  liveEditLog: LiveEdit[]; // P1: always []
};

export type Cursor = { timeUs: Us; seq: number };
export type LiveEdit = { cursor: Cursor; nodeId: NodeId; path: string; value: unknown };

// ---------- validation (§5.9) ----------
export type ValidationIssue = {
  code: string; // e.g. "NO_TRAFFIC_SOURCE", "UNREACHABLE_NODE", "MISSING_TARGET", "NO_EDGE_FOR_CALL"
  message: string;
  nodeId?: NodeId;
  edgeId?: string;
  endpointId?: EndpointId;
};

// ---------- results (§5.8) ----------
export type Percentiles = { p50: number | null; p90: number | null; p99: number | null; p999: number | null }; // µs; null = insufficient data

export type InvariantKind =
  | "ackedWriteLost"
  | "duplicateEffect"
  | "staleRead"
  | "oversell"
  | "uniquenessViolated"
  | "splitBrainWrite"
  | "orderingViolated";

export type Violation = { kind: InvariantKind; timeUs: Us; requestIds: string[]; detail: string };

export type NodeStats = {
  nodeId: NodeId;
  utilisation: number; // busy worker-time / (concurrency * window)
  avgQueue: number; // time-averaged
  maxQueue: number;
  drops: number;
  errors: number;
  served: number;
  latency: Percentiles; // sojourn at this node
  meanQueueWaitUs?: number | null;
  inFlight?: number;
  wastedWork?: number;
  cache?: { hits: number; misses: number; evictions: number; hitRate: number | null };
};

export type SeriesPoint = {
  tUs: Us; // bucket start
  offeredPerSec: number;
  succeededPerSec: number;
  failedPerSec: number;
  p99Us: number | null;
  nodeUtil: Record<NodeId, number>;
  cacheHitRate: Record<NodeId, number | null>;
};

export type RunMetrics = {
  offered: number;
  admitted: number;
  succeeded: number;
  failed: number;
  attempts: number;
  unfinished: number;
  retryAmplification: number | null; // attempts / offered
  goodput: number | null; // §5.8 primary SLI; null = no traffic (N/A)
  availability: number | null;
  successLatency: Percentiles;
  allLatency: Percentiles;
  throughput: { offeredPerSec: number; admittedPerSec: number; completedPerSec: number };
  costPerMonth: number;
  statusCounts: Partial<Record<Status, number>>;
};

export type Bottleneck = { nodeId: NodeId; utilisation: number; queueGrowth: number; retryAmplification: number | null };

export type RunResult = {
  runKey: RunKey;
  replayCompatId: string;
  outcome: "finished" | "inconclusive";
  inconclusiveReason?: string; // "resource limit X reached at t=…" + guidance
  metrics: RunMetrics;
  nodes: NodeStats[];
  series: SeriesPoint[]; // 1 s sim buckets, downsampled to <= 600 points
  violations: Violation[];
  bottleneck: Bottleneck | null;
  eventsProcessed: number;
  simEndUs: Us;
};

// ---------- trace (§8A.3) ----------
export type Span = {
  nodeId: NodeId;
  kind: "network" | "queue" | "service" | "retryBackoff" | "timeout";
  startUs: Us;
  endUs: Us;
  note?: string; // e.g. "cache MISS user:42", "DB read v17"
};
export type TraceResult = { status: Status; totalUs: Us; spans: Span[]; dataOps: string[] };
export type TraceInput = { endpointId: EndpointId; key: string };
export type AdvanceOptions = { maxWallMs?: number; untilUs?: Us; maxEvents?: number };
export interface Simulation {
  advance(options?: AdvanceOptions): 'running' | 'done';
  snapshot(): LiveSnapshot;
  result(): RunResult;
}

// ---------- live animation feed (visual only, never part of results) ----------
export type Packet = { requestId: string; from: NodeId; to: NodeId; departUs: Us; arriveUs: Us; ok: boolean };

export type LiveSnapshot = {
  cursor: Cursor;
  simTimeUs: Us;
  metrics: RunMetrics; // so far
  nodeUtil: Record<NodeId, number>;
  nodeState: Record<NodeId, "up" | "degraded" | "gray" | "down" | "restarting">;
  packets: Packet[]; // sampled since the previous snapshot
};

// ---------- worker protocol (§5.1, §5.10) ----------
export type Speed = 0.1 | 1 | 10 | "max";

export type ToWorker =
  | { type: "start"; design: Design; scenario: Scenario; seed: number; settings: RunSettings; speed: Speed }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "setSpeed"; speed: Speed }
  | { type: "step"; by: "event" | "1ms" }
  | { type: "replayTo"; cursor: Cursor }
  | { type: "ping" };

export type FromWorker =
  | { type: "invalid"; issues: ValidationIssue[] }
  | { type: "started"; runKey: RunKey }
  | { type: "snapshot"; snapshot: LiveSnapshot }
  | { type: "heartbeat" }
  | { type: "pong" }
  | { type: "done"; result: RunResult }
  | { type: "error"; message: string };

// ---------- grading (§7) ----------
export type SLO =
  | { kind: "goodput"; min: number } // mandatory
  | { kind: "successLatency"; percentile: "p50" | "p90" | "p99"; maxUs: Us };

export type ChallengeSpec = {
  id: string;
  title: string;
  scenario: Scenario;
  variantChaos: ChaosEvent[][]; // ★★★ set
  slos: SLO[];
  invariants: InvariantKind[];
  budgetPerMonth: number;
  allowedKinds: ComponentKind[];
  seeds: number[]; // K = 5
};

export type GradeReport = {
  verdict: "pass" | "fail" | "inconclusive";
  stars: 0 | 1 | 2 | 3;
  perSeed: { seed: number; result: RunResult; failures: string[] }[];
  costPerMonth: number;
  hints: [string, string, string];
};

// ---------- public engine API (implemented in src/engine/index.ts) ----------
// validateDesign(design, scenario): ValidationIssue[]
// designHash(design): string                       // canonical JSON (sorted keys, positions/labels excluded), sync
// runToCompletion(design, scenario, seed, settings?): RunResult   // Node + worker
// createSimulation(design, scenario, seed, settings): Simulation  // incremental, for the worker
//   Simulation.advance({ maxWallMs?, untilUs?, maxEvents? }): "running" | "done"
//   Simulation.snapshot(): LiveSnapshot ; Simulation.result(): RunResult
// traceRequest(design, endpointId, key, seed, priorInputs): TraceResult
// gradeChallenge(design, challenge): GradeReport
// ENGINE_VERSION, REPLAY_COMPAT_ID
