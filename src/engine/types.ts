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
  | "rateLimiter"
  // P2 (§5.3)
  | "dns"
  | "cdn"
  | "apiGateway"
  | "kvStore"
  | "queue"
  | "worker"
  | "objectStore"
  | "searchIndex"
  | "dedupStore"
  | "autoscaler"
  | "circuitBreaker";

export type QueueParams = {
  concurrency: number; // workers
  queueCapacity: number; // waiting slots; full => reject (503)
  queueDiscipline: "fifo" | "lifo";
  costPerHour: number; // USD
  region: string;
  zone: string;
  restartWarmupUs?: Us; // P2: time spent `restarting` after a kill ends (default 1 µs)
};

// P2 failover settings for leader-based stores (§5.6).
export type FailoverParams = {
  heartbeatUs: Us;
  missedHeartbeats: number; // detection delay = heartbeatUs × missedHeartbeats
  electionUs: Us;
  fencing: boolean; // without fencing an old leader that comes back can accept writes (split brain)
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
    // P2 (all optional; absent = P1 behaviour)
    replication?: "sync" | "semiSync" | "async";
    replicationLag?: Dist; // async/semi-sync shipping delay per write
    readFromReplicas?: boolean; // read/write split
    walDurable?: boolean; // committed WAL survives a kill (default true)
    connectionPool?: number; // max concurrent connections; excess waits
    failover?: FailoverParams;
  };
  rateLimiter: QueueParams & {
    serviceTime: Dist;
    algorithm: "tokenBucket" | "leakyBucket" | "fixedWindow" | "slidingWindow";
    ratePerSec: number;
    burst: number;
    centralised?: boolean; // P2: shared state adds a round trip (simplified)
  };
  // ---------- P2 ----------
  dns: { resolutionTime: Dist; ttlUs: Us; records: NodeId[] }; // records[0] primary, rest failover
  cdn: QueueParams & {
    serviceTime: Dist;
    capacityBytes: number; // per region
    eviction: "lru" | "lfu";
    ttlUs?: Us;
    originShield: boolean;
    costPerGB: number; // egress
  }; // miss => forwards to its single outgoing edge (origin)
  apiGateway: QueueParams & { serviceTime: Dist; maxRequestBytes: number }; // serviceTime = auth latency; oversize => 413 counted as 409-class reject
  kvStore: QueueParams & {
    readTime: Dist;
    writeTime: Dist;
    members: number; // nodes on the consistent-hash ring (live-editable => rebalancing)
    vnodes: number;
    replicationFactor: number; // N
    readQuorum: number; // R
    writeQuorum: number; // W
    hintedHandoff: boolean;
    readRepair: boolean;
    tombstoneGcUs: Us;
  };
  queue: {
    partitions: number;
    capacityMessages: number; // back-pressure: publish rejected (503) when full
    visibilityTimeoutUs: Us;
    maxDeliveries: number; // then DLQ
    retentionUs: Us;
    publishTime: Dist;
    costPerHour: number;
    region: string;
    zone: string;
  };
  worker: QueueParams & { serviceTime: Dist; source: NodeId; batchSize: number }; // consumer group of `concurrency` consumers; handlers keyed by endpoint
  objectStore: { readTime: Dist; writeTime: Dist; costPerGBMonth: number; costPerMillionRequests: number; region: string; zone: string };
  searchIndex: QueueParams & { serviceTime: Dist; indexLag: Dist; source: NodeId }; // eventually consistent copy of `source`
  dedupStore: QueueParams & { serviceTime: Dist; ttlUs: Us; atomic: boolean; durable: boolean };
  autoscaler: {
    targets: NodeId[];
    metric: "utilisation" | "queueLength";
    targetValue: number;
    min: number;
    max: number;
    cooldownUs: Us;
    provisionUs: Us;
    warmupUs: Us;
    evaluateEveryUs: Us;
  }; // not in the request path; changes targets' concurrency
  circuitBreaker: {
    failureRateThreshold: number; // [0,1]
    windowUs: Us;
    minRequests: number;
    openUs: Us;
    halfOpenProbes: number;
    bulkheadMax?: number; // max concurrent pass-through calls
  }; // pass-through to its single outgoing edge; open => fast 503
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

// P2 (§8A.2): input field generators. keyTemplate placeholders refer to these names.
export type InputGen =
  | { kind: "zipf"; min: number; max: number; s: number }
  | { kind: "uniform"; min: number; max: number }
  | { kind: "sequence"; start: number }
  | { kind: "size"; meanBytes: number; sdBytes: number };

export type EndpointSpec = {
  id: EndpointId;
  name: string; // e.g. "GET /user/:id"
  op: "read" | "write";
  keyTemplate: string; // e.g. "user:{userId}"
  requestBytes: number;
  responseBytes: number;
  idempotent: boolean;
  inputs?: Record<string, InputGen>; // P2; absent => scenario.workload.keys drives the key
  responseFields?: string[]; // P2; response size = sum of these entity field sizes (else responseBytes)
};

// ---------- P2 data model (§8A.1) ----------
export type FieldSpec = {
  name: string;
  type: "string" | "int" | "float" | "bool" | "timestamp";
  bytes: { meanBytes: number; sdBytes: number };
};
export type IndexSpec = { name: string; fields: string[]; unique: boolean };
export type EntitySpec = {
  name: string;
  store: NodeId; // database / kvStore / cache / searchIndex / objectStore
  fields: FieldSpec[];
  primaryKey: string;
  indexes: IndexSpec[];
  shardKey?: string;
  dataset: { count: number; keys: KeyDist; initial?: Record<string, number> }; // generated from the run seed, reset every run; count ≤ 1M (Exact)
};

// P2: visual frames (§8). Membership comes from node params region/zone; latency from Design.regions.
export type GroupSpec = { id: string; kind: "region" | "zone"; name: string; position: { x: number; y: number }; size: { w: number; h: number } };
export type RegionMatrix = { names: string[]; latencyUs: Us[][]; egressCostPerGB: number[][] }; // added to edges crossing regions

export type Design = {
  schemaVersion: 1;
  id: string;
  name: string;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  endpoints: EndpointSpec[];
  // P2 (optional; absent = P1). designHash excludes groups, annotations and every position/label.
  entities?: EntitySpec[];
  regions?: RegionMatrix;
  groups?: GroupSpec[];
  annotations?: unknown[]; // whiteboard ink/text/stickies; never simulated (§8A.5)
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
  | { kind: "prob"; p: number } // explicitly probabilistic
  // P2: state-based (§5.2)
  | { kind: "found" } // most recent data read returned a record
  | { kind: "dedupHit" } // most recent dedup step saw a known idempotency key
  | { kind: "leaderAlive"; store: NodeId }
  | { kind: "breakerClosed"; breaker: NodeId };

export type DataOp =
  | { kind: "get" }
  | { kind: "query"; index?: string; limit: number } // no index => full scan ∝ entity count
  | { kind: "insert"; values?: Record<string, number | string | boolean> } // unique conflict => 409
  | { kind: "put"; values?: Record<string, number | string | boolean> }
  | { kind: "update"; field: string; op: "set" | "increment" | "append"; value?: number | string | boolean }
  | { kind: "delete" }
  | { kind: "conditionalPut"; expectedVersion?: number; values?: Record<string, number | string | boolean> } // absent uses the preceding read's version
  | { kind: "decrementIfPositive"; field: string }; // inventory/tickets; would go < 0 => 409

export type Join = { kind: "all" } | { kind: "any" } | { kind: "quorum"; k: number } | { kind: "firstN"; n: number };

export type Step =
  | { type: "call"; target: NodeId; timeoutUs: Us; retry?: RetryPolicy; cancelOnTimeout?: boolean; propagateDeadline?: boolean }
  | { type: "cacheGet"; cache: NodeId; timeoutUs: Us }
  | { type: "cacheSet"; cache: NodeId; timeoutUs: Us }
  | { type: "cacheDelete"; cache: NodeId; timeoutUs: Us }
  | { type: "branch"; cond: Condition; then: Step[]; else: Step[] }
  | { type: "respond"; status: Status }
  // P2
  | { type: "parallel"; branches: Step[][]; join: Join; cancelLosers: boolean }
  | { type: "publish"; queue: NodeId; timeoutUs: Us; orderedByKey: boolean } // ack when the queue accepts
  | { type: "data"; target: NodeId; entity: string; op: DataOp; timeoutUs: Us; retry?: RetryPolicy }
  | { type: "dedup"; store: NodeId; timeoutUs: Us }; // check-and-record idempotency key (atomic per store params)

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
    | { kind: "spike"; rps: number; spikeAtUs: Us; spikeDurUs: Us; spikeRps: number }
    // P2 (§5.5)
    | { kind: "ramp"; fromRps: number; toRps: number }
    | { kind: "diurnal"; meanRps: number; amplitude: number; periodUs: Us } // amplitude in [0,1]
    | { kind: "replay"; points: { atUs: Us; rps: number }[] }; // validated user curve (CSV), linear between points
  mix: Record<EndpointId, number>; // weights
  keys: KeyDist;
  deadlineUs: Us; // per logical request, inclusive (§5.1)
  sessions?: { count: number }; // P2: requests carry a session id for read-your-writes / monotonic reads / sticky LB
};

// `target` meaning depends on kind: node id, edge id ("link*"), zone or region name.
export type ChaosEvent = {
  id: string;
  target: NodeId;
  atUs: Us;
  endUs?: Us;
} & (
  | { kind: "kill" }
  | { kind: "degrade"; slowFactor: number }
  | { kind: "gray"; errorRate: number }
  // P2 (§5.6)
  | { kind: "partition"; links: { from: NodeId; to: NodeId }[] } // directional; target unused ("")
  | { kind: "linkLoss"; lossRate: number } // target = edge id
  | { kind: "linkLatency"; addUs: Us } // target = edge id (dependency latency injection)
  | { kind: "clockSkew"; skewUs: Us } // target = node id (lease demos)
  | { kind: "zoneOutage" } // target = zone name
  | { kind: "regionOutage" } // target = region name
  | { kind: "trafficSpike"; multiplier: number } // target unused ("")
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
// §5.7. nodeId "@workload" edits scenario.workload (path e.g. "arrival.rps"); "@chaos" adds/edits future chaos events.
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
  dropsOnEdit?: number;
  cache?: { hits: number; misses: number; evictions: number; hitRate: number | null };
  // P2 (present only for the relevant kinds)
  replicationLagUs?: { mean: number; max: number };
  queue?: { depthMax: number; redelivered: number; deadLettered: number; consumerLagMax: number };
  breaker?: { opens: number; shortCircuited: number };
  autoscale?: { minConcurrency: number; maxConcurrency: number; scaleEvents: number };
  failovers?: number;
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
  costBreakdown?: { compute: number; egress: number; requests: number; storage: number }; // P2, per month
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
  liveEdit(nodeId: NodeId, path: string, value: unknown, acknowledge?: (edit: LiveEdit) => void): string | undefined;
  replayEdits(edits: LiveEdit[]): void;
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
  | { type: "start"; design: Design; scenario: Scenario; seed: number; settings: RunSettings; speed: Speed; liveEditLog?: LiveEdit[] }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "setSpeed"; speed: Speed }
  | { type: "step"; by: "event" | "1ms" }
  | { type: "replayTo"; cursor: Cursor }
  | { type: "ping" }
  | { type: "liveEdit"; nodeId: NodeId; path: string; value: unknown }; // P2 §5.7; applied at next event boundary

export type FromWorker =
  | { type: "invalid"; issues: ValidationIssue[] }
  | { type: "started"; runKey: RunKey }
  | { type: "snapshot"; snapshot: LiveSnapshot }
  | { type: "heartbeat" }
  | { type: "pong" }
  | { type: "done"; result: RunResult }
  | { type: "error"; message: string }
  | { type: "editAck"; edit: LiveEdit } // only acked edits enter liveEditLog
  | { type: "editRejected"; nodeId: NodeId; path: string; reason: string }; // structural or past-cursor edits

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
