import type { CaseStudy } from "./types";
import { alter, backoff, cache, cacheAside, client, data, entity, find, link, loadBalancer, lognormal, node, pool, respond, scenario, service, variant, window } from "./kit";

const pastes = entity("pastes", "db", { id: ["string", 8], userId: ["int", 8], title: ["string", 60], syntax: ["string", 12], blobKey: ["string", 24], createdAt: ["timestamp", 8], expiresAt: ["timestamp", 8] }, 5_000, {
  indexes: [{ name: "byUser", fields: ["userId"], unique: false }, { name: "byExpiry", fields: ["expiresAt"], unique: false }],
  shardKey: "id",
});
const blobs = entity("blobs", "objects", { blobKey: ["string", 24], content: ["string", 10_000] }, 5_000);

const blobRead = data("objects", "blobs", { kind: "get" }, 100, backoff(2, 10));
const handlers = {
  read: cacheAside("cache", [data("db", "pastes", { kind: "get" }, 50), blobRead]),
  // Blob first, metadata second: a crash in between leaves an unreferenced blob (swept later), never a dangling paste.
  create: [data("objects", "blobs", { kind: "put" }, 300), data("db", "pastes", { kind: "insert" }, 100), respond(201)],
};

const design = {
  schemaVersion: 1 as const,
  id: "pastebin",
  name: "Pastebin",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "API 1", [2, 0], handlers),
    service("api2", "API 2", [2, 2], handlers),
    cache("cache", "Paste cache", [3, 0], 10_500_000, 3_600_000),
    node("db", "database", "Metadata DB", [3, 1], {
      ...pool(16, 0.5, 400), readTime: lognormal(2), writeTime: lognormal(4), replicas: 2,
      replication: "semiSync", replicationLag: lognormal(1), walDurable: true,
      failover: { heartbeatUs: 100_000, missedHeartbeats: 3, electionUs: 200_000, fencing: true },
    }),
    node("objects", "objectStore", "Object store", [3, 2], { readTime: lognormal(15, 0.5), writeTime: lognormal(30, 0.5), costPerGBMonth: 0.023, costPerMillionRequests: 0.4, region: "us-east", zone: "a" }),
  ],
  edges: [link("client", "lb"), link("lb", "api1"), link("lb", "api2"), ...["api1", "api2"].flatMap((a) => [link(a, "cache"), link(a, "db"), link(a, "objects")])],
  endpoints: [
    { id: "read", name: "GET /p/:id", op: "read" as const, keyTemplate: "paste:{id}", requestBytes: 200, responseBytes: 10_240, idempotent: true },
    { id: "create", name: "POST /v1/pastes", op: "write" as const, keyTemplate: "paste:{id}", requestBytes: 10_240, responseBytes: 200, idempotent: false, inputs: { id: { kind: "sequence" as const, start: 1_000_000 } } },
  ],
  entities: [pastes, blobs],
};

const baseline = scenario("pastebin-day", { arrival: { kind: "poisson", rps: 2000 }, mix: { read: 0.9, create: 0.1 }, keys: { kind: "zipf", n: 5_000, s: 0.9 }, deadlineMs: 1000 });
const lossy = variant(baseline, "pastebin-lossy-link", [{ id: "lossy-objects", kind: "linkLoss", target: "api1-objects", lossRate: 0.1, ...window(1200, 2400) }]);

export const pastebin: CaseStudy = {
  id: "pastebin",
  title: "Pastebin",
  summary: "Store text snippets and serve them by ID. It looks like the URL shortener, but the payload is 20× bigger, so the real design question is where the bytes live: metadata in a database, content in an object store, hot pastes in a cache.",
  requirements: {
    functional: [
      "Create a paste (text up to 10 MB, typically ~10 KB) and get back an unguessable ID.",
      "Read a paste by ID; optional syntax highlighting and raw view.",
      "Pastes can expire (10 minutes to never) or be burn-after-read.",
      "Signed-in users can list and delete their pastes.",
    ],
    nonFunctional: [
      "Reads p99 under 200 ms for typical pastes.",
      "99.9% availability for reads; a paste, once acknowledged, is never lost.",
      "Storage cost dominates, so cold content must sit in cheap storage.",
    ],
  },
  estimates: [
    { label: "Write rate", formula: "10M new pastes/day ÷ 86,400 s", result: "≈ 116 writes/s average, ≈ 230/s peak" },
    { label: "Read rate", formula: "10 reads per write", result: "≈ 1,160 reads/s average, ≈ 2,300/s peak" },
    { label: "Content storage", formula: "10M × 10 KB/day × 365 × 5 years", result: "≈ 183 TB — object store territory (≈ $4k/month at $0.023/GB)" },
    { label: "Metadata storage", formula: "18B rows × ~300 B", result: "≈ 5.5 TB — a sharded relational or KV store" },
    { label: "Read bandwidth", formula: "2,300/s × 10 KB", result: "≈ 23 MB/s (≈ 190 Mbit/s) of egress at peak" },
    { label: "Cache", formula: "hottest 20% of a day's reads: 0.2 × 100M × 10 KB", result: "≈ 200 GB; fewer entries than the URL shortener, but 20× the bytes each" },
  ],
  api: [
    { signature: "POST /v1/pastes", request: "{ content, syntax?, expiresIn?, burnAfterRead? } + Idempotency-Key", response: "201 { id, url } · 413 too large · 429", endpointId: "create" },
    { signature: "GET /p/{id}", request: "—", response: "200 text · 404 · 410 expired", endpointId: "read" },
    { signature: "DELETE /v1/pastes/{id}", request: "auth: owner", response: "204", notes: "Deletes metadata, schedules the blob for deletion and invalidates the cache." },
  ],
  dataModel: {
    entities: [pastes, blobs],
    notes: [
      "pastes holds small metadata rows and a pointer (blobKey) to the content.",
      "Content lives in an object store keyed by blobKey: cheap per GB, very durable, but tens of milliseconds per read.",
      "byExpiry lets the cleanup job find expired pastes without a full scan.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Keep the content in the database",
      tradeoffs: "One system, one transaction, no orphaned blobs. But 183 TB of text in a relational store means many more shards, slower backups and replicas that copy every byte. Below a few TB it is a reasonable choice; at this scale the object store wins on cost and operational load.",
    },
    {
      title: "No retries on blob reads",
      tradeoffs: "Object-store reads are idempotent, so retrying with backoff is safe and cheap. Without retries, every lost packet between the API and the store becomes a failed read.",
      design: alter(design, "pastebin-no-retry", "Pastebin without blob retries", (d) => {
        for (const id of ["api1", "api2"]) find<"service">(d, id).handlers!.read = cacheAside("cache", [data("db", "pastes", { kind: "get" }, 50), data("objects", "blobs", { kind: "get" }, 100)]);
      }),
      check: { scenario: "lossy-link", maxGoodput: 0.99 },
    },
    {
      title: "A CDN in front of public pastes",
      tradeoffs: "Public pastes are immutable, so they cache perfectly at the edge and the origin sees only first reads. Private and burn-after-read pastes must bypass the CDN, and deletes need a purge call.",
    },
  ],
  failureScenarios: [
    {
      id: "slow-object-store",
      title: "The object store slows down 8×",
      explanation: "From t = 1.5 s to 2.3 s object-store reads take about 120 ms instead of 15 ms — a degraded storage tier.",
      scenario: variant(baseline, "pastebin-slow-objects", [{ id: "slow-objects", kind: "degrade", target: "objects", slowFactor: 8, ...window(1500, 2300) }]),
      expect: "Cache hits are untouched, while misses and new pastes slow down. API workers spend longer waiting on the store, so their utilisation rises: a slow dependency consumes your concurrency even though it is not your CPU.",
      check: { minGoodput: 0.95, clean: true },
    },
    {
      id: "lossy-link",
      title: "Packet loss between one API server and the object store",
      explanation: "From t = 1.2 s to 2.4 s, 10% of packets on the API 1 → object store link are dropped. A lost packet looks like a timeout to the caller.",
      scenario: lossy,
      expect: "Blob reads retry with exponential backoff and jitter, so almost every read still succeeds; the cost is a longer tail. Paste creation does not retry (the blob write is not behind an idempotency key here), so a few creates fail.",
      check: { minGoodput: 0.97, clean: true },
    },
    {
      id: "viral-paste",
      title: "A paste goes viral",
      explanation: "One paste receives 40% of all reads — a leaked config file linked from a popular forum.",
      scenario: variant(baseline, "pastebin-viral", [], { keys: { kind: "hotspot", n: 5_000, hotFraction: 0.4 } }),
      expect: "The viral paste is served from the cache after its first read. The remaining traffic is spread over the long tail, so the object store sees more misses — the hot key is the cheap part.",
      check: { minGoodput: 0.99, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Metadata and content in different stores",
      body: "Small, frequently queried fields (owner, expiry, syntax) go in a database that supports indexes. Large immutable content goes in an object store, which is far cheaper per GB and designed for 11 nines of durability, but slower per request. Write the blob first and the metadata second: a crash between the two leaves an unreferenced blob that a sweeper deletes, whereas the opposite order leaves a paste that 404s. Because pastes are immutable, the cache never needs invalidating except on delete or expiry.",
    },
    {
      title: "Expiry, burn-after-read and cleanup",
      body: "Check expiresAt on read so expired pastes return 410 immediately. A background job walks the byExpiry index in small batches, deletes metadata and then blobs. Burn-after-read needs an atomic read-and-delete — a conditional delete on the metadata row — or two concurrent readers can both see it. Object stores also offer lifecycle rules that delete by age, which removes most of the sweeper's work for fixed TTLs.",
    },
    {
      title: "IDs and abuse",
      body: "Use random 8-character base-62 IDs (2 × 10¹⁴ values), not a counter: pastes are often secrets, so IDs must not be enumerable. Rate-limit creation per IP and account, cap size at the gateway (413 before the body is read), and scan for leaked credentials — services such as GitHub's secret scanning partner programme exist because pastes leak keys.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Create and read only.", "Adds expiry or size limits.", "States size distribution, read/write ratio and durability.", "Also covers burn-after-read semantics, privacy of IDs and deletion."] },
    { stage: "estimates", descriptors: ["No numbers.", "QPS only.", "QPS, content vs metadata storage and bandwidth.", "Uses storage numbers to justify the object store and sizes the cache in bytes, not entries."] },
    { stage: "api", descriptors: ["Vague endpoints.", "Create/read with status codes.", "Adds 413/410/429 and idempotency.", "Explains how delete propagates to blob, cache and CDN."] },
    { stage: "data model", descriptors: ["Content and metadata undifferentiated.", "One table holding content.", "Metadata table with a blob pointer and owner index.", "Adds the expiry index and justifies write ordering between stores."] },
    { stage: "high level", descriptors: ["Single box.", "LB, API, database.", "Adds object store and cache on the read path.", "Explains which tier fails how, and that cache hits shield the slow store."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions TTLs.", "Designs expiry cleanup and ID generation.", "Handles burn-after-read atomically and analyses retries vs idempotency for each step."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions monitoring.", "Lists bottlenecks and mitigations.", "Prioritises cost, abuse and the slow-dependency risk with concrete signals."] },
  ],
  clarifyingQuestions: [
    "What are the typical and maximum paste sizes?",
    "Are pastes public, unlisted or private? Do IDs need to be unguessable?",
    "What expiry options exist, and is burn-after-read required?",
    "How long must pastes be kept if they never expire?",
  ],
  commonMistakes: [
    "Putting multi-terabyte content in the relational database by default.",
    "Sizing the cache by entry count instead of bytes.",
    "Writing metadata before the blob, which can leave pastes that 404.",
    "Sequential IDs for content that is often secret.",
    "Retrying non-idempotent writes without an idempotency key.",
  ],
};
