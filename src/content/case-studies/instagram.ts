import type { CaseStudy } from "./types";
import { client, data, entity, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

const media = entity("media", "db", { mediaId: ["int", 8], userId: ["int", 8], caption: ["string", 200], photoKey: ["string", 40], createdAt: ["timestamp", 8] }, 10_000, {
  indexes: [{ name: "byUser", fields: ["userId"], unique: false }],
  shardKey: "userId",
});
const photos = entity("photos", "objects", { photoKey: ["string", 40], bytes: ["string", 150_000] }, 10_000);

const EDGE = 12_500_000_000; // 100 Gbit/s: the CDN's edge capacity is not the constraint in this cell

const handlers = {
  view: [data("objects", "photos", { kind: "get" }, 200), respond(200)],
  // Store the original, record metadata, then hand resizing to workers; the client gets 201 before thumbnails exist.
  upload: [data("objects", "photos", { kind: "put" }, 1000), data("db", "media", { kind: "insert" }, 100), publish("resize"), respond(201)],
};

const design = {
  schemaVersion: 1 as const,
  id: "instagram",
  name: "Instagram photo sharing",
  nodes: [
    client("dns"),
    node("dns", "dns", "DNS (CDN, origin fallback)", [1, 1], { resolutionTime: lognormal(20), ttlUs: 300_000, records: ["cdn", "lb"] }),
    node("cdn", "cdn", "CDN edge", [2, 0], { ...pool(4096, 0.5), serviceTime: lognormal(0.5), capacityBytes: 310_000_000, eviction: "lru", ttlUs: 86_400_000_000, originShield: true, costPerGB: 0.02 }),
    loadBalancer("lb", [3, 1]),
    service("api1", "Media API 1", [4, 0], handlers),
    service("api2", "Media API 2", [4, 2], handlers),
    node("db", "database", "Media metadata (sharded Postgres)", [5, 0], { ...pool(32, 0.6, 600), readTime: lognormal(2), writeTime: lognormal(4), replicas: 2, replication: "semiSync", replicationLag: lognormal(1), walDurable: true }),
    node("objects", "objectStore", "Photo store", [5, 1], { readTime: lognormal(25, 0.5), writeTime: lognormal(60, 0.5), costPerGBMonth: 0.023, costPerMillionRequests: 0.4, region: "us-east", zone: "a" }),
    node("resize", "queue", "Resize jobs", [5, 2], { partitions: 32, capacityMessages: 20_000, visibilityTimeoutUs: 2_000_000, maxDeliveries: 5, retentionUs: 86_400_000_000, publishTime: lognormal(1), costPerHour: 0.1, region: "us-east", zone: "a" }),
    // Decode, resize to ~5 sizes, re-encode: ~120 ms of CPU per photo.
    node("resizer", "worker", "Resize workers", [6, 2], { ...pool(12, 0.68), serviceTime: lognormal(120), source: "resize", batchSize: 12 }, { upload: [data("objects", "photos", { kind: "put" }, 1000), respond(200)] }),
  ],
  edges: [link("client", "dns", 0.25, EDGE), link("dns", "cdn", 0.25, EDGE), link("dns", "lb", 0.25, EDGE), link("cdn", "lb"), link("lb", "api1"), link("lb", "api2"), ...["api1", "api2"].flatMap((a) => [link(a, "db"), link(a, "objects"), link(a, "resize")]), link("resizer", "objects")],
  endpoints: [
    { id: "view", name: "GET /p/:photoKey (image)", op: "read" as const, keyTemplate: "photo:{id}", requestBytes: 300, responseBytes: 150_000, idempotent: true },
    { id: "upload", name: "POST /v1/media", op: "write" as const, keyTemplate: "photo:{id}", requestBytes: 2_000_000, responseBytes: 300, idempotent: false, inputs: { id: { kind: "sequence" as const, start: 1_000_000 } } },
  ],
  entities: [media, photos],
};

const baseline = scenario("instagram-day", { arrival: { kind: "poisson", rps: 2000 }, mix: { view: 0.98, upload: 0.02 }, keys: { kind: "zipf", n: 10_000, s: 1.1 }, deadlineMs: 1000 });

export const instagram: CaseStudy = {
  id: "instagram",
  title: "Instagram (photo sharing)",
  summary: "Upload photos, store them durably and serve them to a global audience. Most bytes never touch your servers: the CDN serves views, an object store keeps the originals, and asynchronous workers produce the sizes clients ask for.",
  requirements: {
    functional: ["Upload a photo with a caption.", "View photos (several sizes for different screens).", "List a user's photos; a feed (see the news feed case study).", "Like and comment (out of scope here)."],
    nonFunctional: [
      "Image views p99 under ~200 ms worldwide — mostly a CDN problem.",
      "Uploaded photos are never lost (11 nines of durability in the object store).",
      "Upload acknowledged in a few seconds; thumbnails can appear a moment later.",
      "Very read-heavy: hundreds of views per upload.",
    ],
  },
  estimates: [
    { label: "Uploads", formula: "100M photos/day ÷ 86,400", result: "≈ 1,160 uploads/s average, ≈ 3k/s peak" },
    { label: "Storage", formula: "100M × (2 MB original + ~0.5 MB of resized versions) × 365", result: "≈ 90 PB/year — object storage with tiering for old photos" },
    { label: "Views", formula: "500M DAU × 100 image views/day ÷ 86,400", result: "≈ 580k image requests/s" },
    { label: "Egress", formula: "580k/s × ~150 KB average served size", result: "≈ 87 GB/s ≈ 700 Gbit/s — only a CDN serves this economically" },
    { label: "Origin traffic", formula: "580k/s × (1 − 95% CDN hit rate)", result: "≈ 29k/s to the origin; the hit rate decides origin size" },
    { label: "Resize workers", formula: "Little's law: 1,160 uploads/s × 120 ms CPU", result: "≈ 140 cores busy on average; ≈ 400 at peak" },
  ],
  api: [
    { signature: "POST /v1/media", request: "multipart image + { caption }; resumable for large files", response: "201 { mediaId, urls{} } (sizes may be pending)", endpointId: "upload" },
    { signature: "GET /p/{photoKey}_{size}.jpg", request: "served by the CDN", response: "200 image · 404", notes: "Keys are immutable: an edit creates a new key, so CDN caching never needs invalidation.", endpointId: "view" },
    { signature: "GET /v1/users/{id}/media?cursor=", request: "cursor = last mediaId", response: "200 { media[] }" },
  ],
  dataModel: {
    entities: [media, photos],
    notes: [
      "media rows are sharded by userId (Instagram used thousands of logical shards on PostgreSQL), so a profile grid is one shard.",
      "mediaId embeds a timestamp and the shard ID (41 bits ms + 13 bits shard + 10 bits sequence), so IDs sort by time and locate their shard without a lookup.",
      "Image bytes live in the object store under immutable keys; the database only stores the key.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Serve images from your own servers",
      tradeoffs: "Full control and no CDN bill, but 700 Gbit/s of egress from a few regions means high latency far from them and enormous origin capacity. A CDN (or your own edge network, as Facebook and Netflix built) is the only practical option at this scale.",
    },
    {
      title: "Resize synchronously during upload",
      tradeoffs: "The client gets every size immediately, but uploads now take hundreds of milliseconds of CPU each and a spike of uploads saturates the API tier. Asynchronous workers let uploads stay fast and absorb spikes as queue depth.",
    },
    {
      title: "Store photos in a filesystem-like blob store you run",
      tradeoffs: "Facebook's Haystack packed many photos into large files to avoid per-file metadata reads, then f4 moved older 'warm' photos to erasure-coded storage at lower cost. Worth it at Facebook's scale; most teams should use a managed object store and lifecycle tiers.",
    },
  ],
  failureScenarios: [
    {
      id: "cdn-outage",
      title: "The CDN edge goes down",
      explanation: "The CDN fails from t = 1.5 s on. DNS still points clients at it until the cached record expires (TTL 300 ms here, scaled down from the usual 30–300 s), then fails over to the origin.",
      scenario: variant(baseline, "instagram-cdn-outage", [{ id: "edge-down", kind: "kill", target: "cdn", atUs: 1_500_000 }]),
      expect: "Requests fail until the DNS record expires; after that, the origin takes every image view. It survives here because the cell's origin was sized generously, but note what changed: object-store reads jump from the miss rate to the full rate, and egress now leaves your origin. DNS TTL is your failover time — and real resolvers often hold records longer than the TTL.",
      check: { maxGoodput: 0.95 },
    },
    {
      id: "upload-spike",
      title: "Uploads spike 3× (New Year's Eve)",
      explanation: "From t = 1.2 s to 2.2 s all traffic is 3× higher; uploads go from 40/s to 120/s, above the resize workers' ~60/s (each job is ~120 ms of CPU plus ~60 ms to store the results).",
      scenario: variant(baseline, "instagram-upload-spike", [{ id: "nye", kind: "trafficSpike", target: "", multiplier: 3, ...window(1200, 2200) }]),
      expect: "Uploads are acknowledged as fast as before because resizing is asynchronous; the resize queue grows and thumbnails lag behind. Views keep hitting the CDN. Scale workers on queue depth.",
      check: { minGoodput: 0.98, clean: true },
    },
    {
      id: "slow-object-store",
      title: "The object store slows down 6×",
      explanation: "From t = 1.5 s to 2.3 s object-store reads take ~150 ms instead of ~25 ms.",
      scenario: variant(baseline, "instagram-slow-objects", [{ id: "slow", kind: "degrade", target: "objects", slowFactor: 6, ...window(1500, 2300) }]),
      expect: "Most views are CDN hits and do not notice. CDN misses and uploads slow down, and the slowest misses exceed the API's 200 ms storage timeout and fail. The CDN is shielding the storage tier — the hit rate is a reliability feature, not just a cost one.",
      check: { minGoodput: 0.95, clean: true },
    },
  ],
  deepDives: [
    {
      title: "The upload path",
      body: "Clients upload directly to the object store with a pre-signed URL (or through an upload service for small files), resumable in chunks so a dropped mobile connection does not restart a 10 MB upload. The API then writes the metadata row and enqueues processing: resizing, content moderation, and feature extraction. The response returns before processing finishes; clients show a local preview meanwhile.",
    },
    {
      title: "Serving images",
      body: "Image URLs are immutable (content-addressed or versioned), so CDN entries never need invalidation and can be cached for a year. Popularity is heavily skewed, so the CDN's hit rate is high for recent popular photos and low for the long tail of old ones; an origin shield (a regional mid-tier cache) collapses misses from many edges into one origin read. Choose image sizes per device and use modern formats to cut egress.",
    },
    {
      title: "IDs and sharding",
      body: "Instagram generated 64-bit IDs inside PostgreSQL: 41 bits of milliseconds since a custom epoch, 13 bits of logical shard ID, 10 bits of per-shard sequence. Thousands of logical shards were mapped onto fewer physical servers, so rebalancing moves whole logical shards. IDs sort by time, which makes 'newest first' queries and cursors cheap.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Upload and view.", "Sizes and durability.", "Read-heavy ratio, latency targets, async processing.", "Defines what 'uploaded' means (acknowledged vs processed)."] },
    { stage: "estimates", descriptors: ["None.", "QPS.", "Storage, egress and origin traffic from hit rate.", "Worker sizing for processing via Little's law."] },
    { stage: "api", descriptors: ["Endpoints.", "Upload/view.", "Resumable upload and immutable image URLs.", "Pre-signed direct upload and cursor pagination by time-ordered ID."] },
    { stage: "data model", descriptors: ["Photos in DB.", "Metadata + blob store.", "Metadata sharded by user, blobs keyed immutably.", "ID scheme that encodes time and shard."] },
    { stage: "high level", descriptors: ["Servers serve images.", "CDN + object store.", "Async processing pipeline.", "Origin shield, DNS failover and how each tier fails."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions CDN.", "Upload path and serving path in detail.", "Storage tiering, ID generation and rebalancing."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Metrics.", "CDN hit rate and processing lag as signals.", "Cost model (egress and storage) and failure drills."] },
  ],
  clarifyingQuestions: ["Photo sizes and how many renditions?", "Global audience?", "Is video in scope?", "How long are photos kept, and can they be deleted (privacy law)?"],
  commonMistakes: [
    "Storing images in the database.",
    "Serving images from the application servers.",
    "Synchronous resizing in the upload request.",
    "Mutable image URLs that need CDN purges.",
    "Ignoring egress cost.",
  ],
};
