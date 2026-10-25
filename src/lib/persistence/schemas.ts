import { z } from "zod";
import type { Design, Step, RunKey } from "../../engine/types";

export const SCHEMA_VERSION = 1;
export const DESIGN_IMPORT_LIMIT = 2 * 1024 * 1024;
export const BACKUP_IMPORT_LIMIT = 50 * 1024 * 1024;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().positive();
const fraction = z.number().min(0).max(1);
const id = z.string().min(1).max(512);
// Mirrors Annotation in components/sandbox/design-store.ts. Shared links and sync payloads are untrusted, and the board and SVG export assume this shape.
const annotation = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("stroke"), color: z.string().max(64), points: z.array(z.tuple([z.number(), z.number(), z.number()])).max(5000) }),
  z.object({ id, type: z.enum(["text", "note"]), x: z.number(), y: z.number(), text: z.string().max(2000) }),
]);
const dist = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("constant"), us: positive }),
  z.object({ kind: z.literal("exponential"), meanUs: positive }),
  z.object({ kind: z.literal("lognormal"), medianUs: positive, sigma: z.number().nonnegative() }),
  z.object({ kind: z.literal("empirical"), buckets: z.array(z.object({ us: positive, weight: z.number().nonnegative() })).min(1).refine(buckets => buckets.some(bucket => bucket.weight > 0), "At least one bucket must have positive weight") }),
]);
const retry = z.object({ max: count, backoffUs: count, multiplier: positive, jitter: z.enum(["none", "full"]), retryOn: z.array(z.enum(["timeout", "5xx", "429"])) });
const condition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cacheHit") }),
  z.object({ kind: z.literal("found") }),
  z.object({ kind: z.literal("dedupHit") }),
  z.object({ kind: z.literal("prob"), p: fraction }),
  z.object({ kind: z.literal("leaderAlive"), store: id }),
  z.object({ kind: z.literal("breakerClosed"), breaker: id }),
]);
const dataOp = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("get") }),
  ...(["insert", "put", "delete"] as const).map(kind => z.object({ kind: z.literal(kind) })),
  z.object({ kind: z.literal("conditionalPut"), expectedVersion: count.optional() }),
  z.object({ kind: z.literal("query"), index: id.optional(), limit: count }),
  z.object({ kind: z.literal("update"), field: id, op: z.enum(["set", "increment", "append"]), value: z.union([z.number(), z.string()]).optional() }),
  z.object({ kind: z.literal("decrementIfPositive"), field: id }),
]);
const inputGen = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("zipf"), min: z.number().int(), max: z.number().int(), s: positive }).refine(g => g.max >= g.min),
  z.object({ kind: z.literal("uniform"), min: z.number().int(), max: z.number().int() }).refine(g => g.max >= g.min),
  z.object({ kind: z.literal("sequence"), start: z.number().int() }),
  z.object({ kind: z.literal("size"), meanBytes: z.number().nonnegative(), sdBytes: z.number().nonnegative() }),
]);
const keyDist = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uniform"), n: count.min(1).max(1_000_000) }),
  z.object({ kind: z.literal("sequential"), n: count.min(1).max(1_000_000) }),
  z.object({ kind: z.literal("zipf"), n: count.min(1).max(1_000_000), s: positive }),
  z.object({ kind: z.literal("hotspot"), n: count.min(1).max(1_000_000), hotFraction: fraction }),
]);
const step: z.ZodType<Step> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("call"), target: id, timeoutUs: positive, retry: retry.optional(), cancelOnTimeout: z.boolean().optional(), propagateDeadline: z.boolean().optional() }),
  ...(["cacheGet", "cacheSet", "cacheDelete"] as const).map(type => z.object({ type: z.literal(type), cache: id, timeoutUs: positive })),
  z.object({ type: z.literal("branch"), cond: condition, then: z.array(step), else: z.array(step) }),
  z.object({ type: z.literal("respond"), status: z.union([z.literal(200), z.literal(201), z.literal(404), z.literal(409), z.literal(429), z.literal(503), z.literal(504)]) }),
  z.object({ type: z.literal("parallel"), branches: z.array(z.array(step)), join: z.discriminatedUnion("kind", [z.object({ kind: z.literal("all") }), z.object({ kind: z.literal("any") }), z.object({ kind: z.literal("quorum"), k: count.min(1) }), z.object({ kind: z.literal("firstN"), n: count.min(1) })]), cancelLosers: z.boolean() }),
  z.object({ type: z.literal("publish"), queue: id, timeoutUs: positive, orderedByKey: z.boolean() }),
  z.object({ type: z.literal("data"), target: id, entity: id, op: dataOp, timeoutUs: positive, retry: retry.optional() }),
  z.object({ type: z.literal("dedup"), store: id, timeoutUs: positive }),
]));
const queue = { concurrency: count.min(1), queueCapacity: count, queueDiscipline: z.enum(["fifo", "lifo"]), costPerHour: z.number().nonnegative(), region: z.string(), zone: z.string(), restartWarmupUs: count.optional() };
const node = { id, label: z.string(), position: z.object({ x: z.number(), y: z.number() }), handlers: z.record(id, z.array(step)).optional() };

export const designSchema: z.ZodType<Design> = z.object({
  schemaVersion: z.literal(1), id, name: z.string().max(10000),
  nodes: z.array(z.discriminatedUnion("kind", [
    z.object({ ...node, kind: z.literal("client"), params: z.object({ entry: id }) }),
    z.object({ ...node, kind: z.literal("loadBalancer"), params: z.object({ ...queue, algorithm: z.enum(["roundRobin", "leastConnections", "p2c", "consistentHash"]), serviceTime: dist, healthCheck: z.object({ intervalUs: positive, unhealthyThreshold: count.min(1), healthyThreshold: count.min(1) }) }) }),
    z.object({ ...node, kind: z.literal("service"), params: z.object({ ...queue, serviceTime: dist }) }),
    z.object({ ...node, kind: z.literal("cache"), params: z.object({ ...queue, serviceTime: dist, capacityBytes: count, eviction: z.enum(["lru", "lfu"]), ttlUs: count.optional(), coalesce: z.boolean() }) }),
    z.object({ ...node, kind: z.literal("database"), params: z.object({ ...queue, readTime: dist, writeTime: dist, replicas: count.min(1), replication: z.enum(["sync", "semiSync", "async"]).optional(), replicationLag: dist.optional(), readFromReplicas: z.boolean().optional(), walDurable: z.boolean().optional(), connectionPool: count.min(1).optional(), failover: z.object({ heartbeatUs: positive, missedHeartbeats: count.min(1), electionUs: count, fencing: z.boolean() }).optional() }) }),
    z.object({ ...node, kind: z.literal("rateLimiter"), params: z.object({ ...queue, serviceTime: dist, algorithm: z.enum(["tokenBucket", "leakyBucket", "fixedWindow", "slidingWindow"]), ratePerSec: positive, burst: positive, centralised: z.boolean().optional() }) }),
    z.object({ ...node, kind: z.literal("dns"), params: z.object({ resolutionTime: dist, ttlUs: count, records: z.array(id) }) }),
    z.object({ ...node, kind: z.literal("cdn"), params: z.object({ ...queue, serviceTime: dist, capacityBytes: count, eviction: z.enum(["lru", "lfu"]), ttlUs: count.optional(), originShield: z.boolean(), costPerGB: z.number().nonnegative() }) }),
    z.object({ ...node, kind: z.literal("apiGateway"), params: z.object({ ...queue, serviceTime: dist, maxRequestBytes: count }) }),
    z.object({ ...node, kind: z.literal("kvStore"), params: z.object({ ...queue, readTime: dist, writeTime: dist, members: count.min(1), vnodes: count.min(1), replicationFactor: count.min(1), readQuorum: count.min(1), writeQuorum: count.min(1), hintedHandoff: z.boolean(), readRepair: z.boolean(), tombstoneGcUs: count }) }),
    z.object({ ...node, kind: z.literal("queue"), params: z.object({ partitions: count.min(1), capacityMessages: count, visibilityTimeoutUs: positive, maxDeliveries: count.min(1), retentionUs: positive, publishTime: dist, costPerHour: z.number().nonnegative(), region: z.string(), zone: z.string() }) }),
    z.object({ ...node, kind: z.literal("worker"), params: z.object({ ...queue, serviceTime: dist, source: id, batchSize: count.min(1) }) }),
    z.object({ ...node, kind: z.literal("objectStore"), params: z.object({ readTime: dist, writeTime: dist, costPerGBMonth: z.number().nonnegative(), costPerMillionRequests: z.number().nonnegative(), region: z.string(), zone: z.string() }) }),
    z.object({ ...node, kind: z.literal("searchIndex"), params: z.object({ ...queue, serviceTime: dist, indexLag: dist, source: id }) }),
    z.object({ ...node, kind: z.literal("dedupStore"), params: z.object({ ...queue, serviceTime: dist, ttlUs: count, atomic: z.boolean(), durable: z.boolean() }) }),
    z.object({ ...node, kind: z.literal("autoscaler"), params: z.object({ targets: z.array(id), metric: z.enum(["utilisation", "queueLength"]), targetValue: positive, min: count.min(1), max: count.min(1), cooldownUs: count, provisionUs: count, warmupUs: count, evaluateEveryUs: positive }) }),
    z.object({ ...node, kind: z.literal("circuitBreaker"), params: z.object({ failureRateThreshold: fraction, windowUs: positive, minRequests: count.min(1), openUs: positive, halfOpenProbes: count.min(1), bulkheadMax: count.min(1).optional() }) }),
  ])).max(200),
  edges: z.array(z.object({ id, from: id, to: id, latency: dist, bandwidthBytesPerSec: positive, lossRate: fraction })).max(600),
  endpoints: z.array(z.object({ id, name: z.string(), op: z.enum(["read", "write"]), keyTemplate: z.string(), requestBytes: count, responseBytes: count, idempotent: z.boolean(), inputs: z.record(id, inputGen).optional(), responseFields: z.array(id).optional() })),
  entities: z.array(z.object({ name: id, store: id, fields: z.array(z.object({ name: id, type: z.enum(["string", "int", "float", "bool", "timestamp"]), bytes: z.object({ meanBytes: z.number().nonnegative(), sdBytes: z.number().nonnegative() }) })), primaryKey: id, indexes: z.array(z.object({ name: id, fields: z.array(id), unique: z.boolean() })), shardKey: id.optional(), dataset: z.object({ count: count.max(1_000_000), keys: keyDist, initial: z.record(id, z.number()).optional() }) })).optional(),
  regions: z.object({ names: z.array(id), latencyUs: z.array(z.array(count)), egressCostPerGB: z.array(z.array(z.number().nonnegative())) }).optional(),
  groups: z.array(z.object({ id, kind: z.enum(["region", "zone"]), name: z.string(), position: z.object({ x: z.number(), y: z.number() }), size: z.object({ w: positive, h: positive }) })).optional(),
  annotations: z.array(annotation).max(500).optional(),
});

const base = { schemaVersion: z.literal(1), revision: count };
export const designRecordSchema = z.object({ ...base, id, design: designSchema, createdAt: count, updatedAt: count, restoreGeneration: count.optional() }).refine(r => r.id === r.design.id, "Design IDs must match");
const chaosBase = { id, target: id, atUs: count, endUs: count.optional() };
export const runKeySchema: z.ZodType<RunKey> = z.object({
  engineVersion: z.string(), scenarioVersion: count, designHash: z.string(), seed: z.number().int(),
  settings: z.object({ traceSampleRate: fraction }),
  chaosTimeline: z.array(z.discriminatedUnion("kind", [z.object({ ...chaosBase, kind: z.literal("kill") }), z.object({ ...chaosBase, kind: z.literal("degrade"), slowFactor: positive }), z.object({ ...chaosBase, kind: z.literal("gray"), errorRate: fraction })])),
  liveEditLog: z.array(z.object({ cursor: z.object({ timeUs: count, seq: count }), nodeId: id, path: z.string(), value: z.json() })),
});
const percentiles = z.object({ p50: z.number().nonnegative().nullable(), p90: z.number().nonnegative().nullable(), p99: z.number().nonnegative().nullable(), p999: z.number().nonnegative().nullable() });
export const metricsSchema = z.object({
  offered: count, admitted: count, succeeded: count, failed: count, attempts: count, unfinished: count,
  retryAmplification: z.number().nonnegative().nullable(), goodput: fraction.nullable(), availability: fraction.nullable(), successLatency: percentiles, allLatency: percentiles,
  throughput: z.object({ offeredPerSec: z.number().nonnegative(), admittedPerSec: z.number().nonnegative(), completedPerSec: z.number().nonnegative() }),
  costPerMonth: z.number().nonnegative(), statusCounts: z.record(z.string().regex(/^(200|201|404|409|429|503|504)$/), count),
});
export const runRecordSchema = z.object({ ...base, id, designId: id, createdAt: count, runKey: runKeySchema, replayCompatId: z.string(), summary: z.object({ metrics: metricsSchema, outcome: z.enum(["finished", "inconclusive"]), verdict: z.enum(["pass", "fail", "inconclusive"]).optional(), invariantCounts: z.record(z.string(), count).default({}), inconclusiveReason: z.string().optional() }) });
export const progressRecordSchema = z.object({ ...base, itemId: id, kind: z.enum(["lesson", "step", "objective", "challenge"]), completedAt: count.optional(), mastery: fraction.optional(), stars: count.max(3).optional(), contentRevision: count.optional() });
export const reviewRecordSchema = z.object({ ...base, itemId: id, dueAt: count, updatedAt: count, intervalDays: count, repetitions: count, ease: z.number().min(1.3) });
export const settingsRecordSchema = z.object({ ...base, id: z.literal("settings"), theme: z.enum(["system", "dark", "light"]).optional(), reducedMotion: z.boolean().optional() }).catchall(z.json());
export const metaRecordSchema = z.object({ ...base, id: z.literal("state"), restoreGeneration: count, designRevisions: z.record(z.string(), count).default({}) });
export const quarantineRecordSchema = z.object({ ...base, id, store: z.string(), key: z.union([z.string(), z.number()]), value: z.unknown(), reason: z.string(), quarantinedAt: count });

export const recordSchemas = { designs: designRecordSchema, runs: runRecordSchema, progress: progressRecordSchema, reviews: reviewRecordSchema, settings: settingsRecordSchema, meta: metaRecordSchema, quarantine: quarantineRecordSchema };
export type StoreName = keyof typeof recordSchemas;
export const STORE_NAMES = Object.keys(recordSchemas) as StoreName[];
export const keyPaths: Record<StoreName, string> = { designs: "id", runs: "id", progress: "itemId", reviews: "itemId", settings: "id", meta: "id", quarantine: "id" };
export type DesignRecord = z.infer<typeof designRecordSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type ProgressRecord = z.infer<typeof progressRecordSchema>;
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;
export type SettingsRecord = z.infer<typeof settingsRecordSchema>;
export type MetaRecord = z.infer<typeof metaRecordSchema>;
export type QuarantineRecord = z.infer<typeof quarantineRecordSchema>;
export type Records = { [K in StoreName]: z.infer<(typeof recordSchemas)[K]> };

export class RevisionConflict extends Error { constructor() { super("Data changed in another tab. Reload or save as a copy."); this.name = "RevisionConflict"; } }
export class StorageQuotaError extends Error { constructor() { super("Storage is full. Export or delete designs and run histories."); this.name = "StorageQuotaError"; } }
export class ImportError extends Error { constructor(message: string) { super(message); this.name = "ImportError"; } }
export class BackupTooLargeError extends Error { readonly offerWithoutRuns = true; constructor() { super("Backup exceeds 50 MB. Export again without run history."); this.name = "BackupTooLargeError"; } }
export class ReadOnlyStoreError extends Error { constructor() { super("This database is newer than the app. Update the app; this copy is read-only."); this.name = "ReadOnlyStoreError"; } }

export function newId(): string { return globalThis.crypto.randomUUID(); }
export function mergeProgress(a: ProgressRecord | undefined, b: ProgressRecord): ProgressRecord {
  const result = { ...a, ...b };
  for (const key of ["mastery", "completedAt", "stars", "contentRevision"] as const) {
    if (a?.[key] !== undefined || b[key] !== undefined) result[key] = Math.max(a?.[key] ?? 0, b[key] ?? 0);
  }
  return result;
}

export function scheduleReview(previous: ReviewRecord | undefined, itemId: string, quality: number, now = Date.now()): ReviewRecord {
  z.number().int().min(0).max(5).parse(quality);
  const ease = Math.max(1.3, (previous?.ease ?? 2.5) + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  const repetitions = quality < 3 ? 0 : (previous?.repetitions ?? 0) + 1;
  const intervalDays = repetitions === 0 ? 1 : repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.round((previous?.intervalDays ?? 1) * ease);
  return { schemaVersion: 1, revision: previous?.revision ?? 0, itemId, ease, repetitions, intervalDays, updatedAt: now, dueAt: now + intervalDays * 86400000 };
}
