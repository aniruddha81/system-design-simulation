import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, cacheDelete, client, data, dedup, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// Content-addressed 4 MB blocks in object storage; file metadata + chunk manifest list in transactional DB.
const fileMeta = entity("fileMeta", "metadb", { fileId: ["int", 8], version: ["int", 4], blockHashes: ["string", 256], updatedAt: ["timestamp", 8] }, 15_000);
const blocks = entity("blocks", "blockstore", { blockId: ["int", 8], payload: ["string", 64_000] }, 15_000);

const handlers = {
  // Commit a new file version: upload only unseen blocks (content-addressed dedup), update metadata, invalidate cache, notify devices.
  commit: [
    dedup("blockdedup"),
    {
      type: "branch" as const,
      cond: { kind: "dedupHit" as const },
      then: [
        data("metadb", "fileMeta", { kind: "update", field: "version", op: "increment", value: 1 }, 60),
        cacheDelete("metacache"),
        publish("syncbus", true),
        respond(200),
      ],
      else: [
        data("blockstore", "blocks", { kind: "put" }, 400),
        data("metadb", "fileMeta", { kind: "update", field: "version", op: "increment", value: 1 }, 60),
        cacheDelete("metacache"),
        publish("syncbus", true),
        respond(201),
      ],
    },
  ],
  // Syncing devices fetch the file's chunk manifest from cached metadata, then pull missing blocks directly from object storage/CDN.
  sync: cacheAside("metacache", [data("metadb", "fileMeta", { kind: "get" }, 50)]),
};

const notifierHandlers = {
  commit: [data("metadb", "fileMeta", { kind: "get" }, 50), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "dropbox",
  name: "Cloud file sync (Dropbox)",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "Sync + Block API 1", [2, 0], handlers, 128, 0.6),
    service("api2", "Sync + Block API 2", [2, 2], handlers, 128, 0.6),
    node("blockdedup", "dedupStore", "Block SHA-256 index", [3, 0], { ...pool(256, 0.25), serviceTime: lognormal(0.3), ttlUs: 86_400_000_000, atomic: true, durable: true }),
    cache("metacache", "Metadata cache", [3, 1], 15_000_000, 120_000),
    node("metadb", "database", "Metadata DB (files + versions)", [4, 1], { ...pool(20, 0.8, 500), readTime: lognormal(1.5), writeTime: lognormal(3.0), replicas: 3, replication: "semiSync", replicationLag: lognormal(1), walDurable: true, failover: { heartbeatUs: 100_000, missedHeartbeats: 3, electionUs: 200_000, fencing: true } }),
    node("blockstore", "objectStore", "Content-addressed block store", [4, 0], { readTime: lognormal(15, 0.4), writeTime: lognormal(25, 0.4), costPerGBMonth: 0.02, costPerMillionRequests: 0.4, region: "us-east", zone: "a" }),
    node("syncbus", "queue", "Device notification stream", [3, 2], { partitions: 64, capacityMessages: 25_000, visibilityTimeoutUs: 400_000, maxDeliveries: 5, retentionUs: 86_400_000_000, publishTime: lognormal(0.8), costPerHour: 0.15, region: "us-east", zone: "a" }),
    node("notifier", "worker", "Long-poll / push notifiers", [4, 2], { ...pool(32, 0.4), serviceTime: lognormal(2), source: "syncbus", batchSize: 32 }, notifierHandlers),
  ],
  edges: [
    link("client", "lb"), link("lb", "api1"), link("lb", "api2"),
    ...["api1", "api2"].flatMap((a) => [link(a, "blockdedup"), link(a, "metacache"), link(a, "metadb"), link(a, "blockstore"), link(a, "syncbus")]),
    link("notifier", "metadb"),
  ],
  endpoints: [
    { id: "commit", name: "POST /v1/files/:fileId/commit (chunk + manifest)", op: "write" as const, keyTemplate: "file:{fileId}", requestBytes: 64_000, responseBytes: 150, idempotent: false },
    { id: "sync", name: "GET /v1/files/:fileId/manifest", op: "read" as const, keyTemplate: "file:{fileId}", requestBytes: 150, responseBytes: 800, idempotent: true },
  ],
  entities: [fileMeta, blocks],
};

const baseline = scenario("dropbox-day", { arrival: { kind: "poisson", rps: 2000 }, mix: { sync: 0.85, commit: 0.15 }, keys: { kind: "zipf", n: 15_000, s: 1.1 }, deadlineMs: 600 });

export const dropbox: CaseStudy = {
  id: "dropbox",
  title: "File sync & storage (Dropbox)",
  summary: "Keep files synchronised across a user's devices without re-uploading an entire 1 GB file when one paragraph changes. Files are split into content-addressed chunks (~4 MB or Rabin-fingerprinted variable chunks) stored in an immutable object store, while a transactional metadata database tracks versioned chunk lists and notifies linked devices.",
  requirements: {
    functional: [
      "Upload, download, and automatically synchronise files and folders across multiple devices per user.",
      "Delta sync and deduplication: upload and download only modified chunks, and skip chunks whose SHA-256 hash already exists.",
      "Maintain file version history and handle concurrent offline edits without silently losing work (conflict copies).",
    ],
    nonFunctional: [
      "Zero silent data loss or corruption; 99.999999999% (11 nines) block durability via replication / Reed-Solomon erasure coding.",
      "Low-latency change propagation: linked online devices learn of a file change within a couple of seconds.",
      "Strict separation between small transactional metadata and multi-exabyte immutable block payloads.",
    ],
  },
  estimates: [
    { label: "Active clients", formula: "100M DAU × ~2.5 connected devices", result: "≈ 250M connected sync clients holding long-poll / WebSocket channels" },
    { label: "Block uploads", formula: "500M file edits/day × ~1.5 changed chunks (4 MB max, ~400 KB mean compressed) ÷ 86,400", result: "≈ 8,700 chunk writes/s average, ~3.5 GB/s ingress before deduplication" },
    { label: "Storage footprint", formula: "700M users × ~3 GB average raw ÷ ~1.4 dedup & compression ratio", result: "≈ 1.5 EB logical, stored across erasure-coded warm/cold storage tiers" },
    { label: "Metadata QPS", formula: "file commits + manifest fetches + cursor checks", result: "≈ 50k–100k metadata reads/s, 10k writes/s — served by sharded SQL + cache" },
  ],
  api: [
    { signature: "POST /v1/blocks/check → PUT /v1/blocks/{sha256}", request: "list of chunk SHA-256 hashes; upload only the missing ones", response: "200 { missingHashes[] } then 201 per uploaded block" },
    { signature: "POST /v1/files/{fileId}/commit", request: "{ baseVersion, blockHashes: [sha256, ...] }", response: "200 { newVersion } · 409 version conflict (create conflicted copy)", endpointId: "commit" },
    { signature: "GET /v1/files/{fileId}/manifest", request: "sinceVersion cursor", response: "200 { version, blockHashes[], downloadUrls[] }", endpointId: "sync" },
  ],
  dataModel: {
    entities: [fileMeta, blocks],
    notes: [
      "blocks: immutable, content-addressed by `sha256(chunk)`. Because the key is the cryptographic hash of the content, blocks never change in place and can be cached forever.",
      "fileMeta: maps `(workspaceId, fileId) → currentVersion, [sha256_0, sha256_1, ...]`. Updating a file is an atomic CAS (`WHERE version = baseVersion`) on the chunk list.",
      "Device sync cursors: each workspace is a sequenced log (`seq = 1, 2, ...`); devices long-poll `/changes?cursor=lastSeq` so reconnects simply replay missed metadata entries.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Re-upload the entire file on every edit (no chunking or dedup)",
      tradeoffs: "Uploading a whole file on every save instead of only unseen chunks hammers object storage and saturates upload links. In the simulator, skipping block deduplication and metadata caching pushes write latency and load much higher.",
      design: alter(design, "dropbox-whole-file", "File sync without chunk dedup or metadata cache", (d) => {
        for (const id of ["api1", "api2"]) {
          find<"service">(d, id).handlers!.commit = [
            data("blockstore", "blocks", { kind: "put" }, 400),
            data("metadb", "fileMeta", { kind: "query", limit: 200 }, 150),
            respond(201),
          ];
          find<"service">(d, id).handlers!.sync = [
            data("metadb", "fileMeta", { kind: "query", limit: 200 }, 150),
            respond(200),
          ];
        }
      }),
      check: { scenario: "baseline", maxGoodput: 0.85 },
    },
    {
      title: "Fixed-size 4 MB chunks vs Content-Defined Chunking (Rabin fingerprinting)",
      tradeoffs: "Fixed 4 MB chunks are simple, but inserting 1 byte at the beginning of a 100 MB file shifts every boundary and invalidates all 25 chunks. Content-Defined Chunking (rolling Rabin hash that cuts a chunk boundary when `hash & mask == 0`) re-synchronises boundaries immediately after the insertion so only one chunk changes.",
    },
    {
      title: "Pass block bytes through metadata API servers",
      tradeoffs: "Routing gigabytes of file bytes through transactional metadata servers wastes CPU and NIC capacity. Instead, clients upload/download blocks directly against the block store (or via pre-signed S3/storage URLs) and send only the 32-byte SHA-256 hashes to the metadata service.",
    },
  ],
  failureScenarios: [
    {
      id: "shared-folder-storm",
      title: "Shared team folder receives a burst of syncs",
      explanation: "A shared project file is synced and edited heavily, driving 35% of requests to one hot key.",
      scenario: variant(baseline, "dropbox-hot-folder", [], { keys: { kind: "hotspot", n: 15_000, hotFraction: 0.35 } }),
      expect: "The metadata cache absorbs repeated manifest reads, and content-addressed block deduplication avoids re-writing identical chunks to the object store.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "metadb-failover",
      title: "Metadata database leader fails over",
      explanation: "The metadata DB leader crashes from t = 1.5 s to 2.0 s while semi-sync replicas elect a new leader.",
      scenario: variant(baseline, "dropbox-metadb-failover", [{ id: "db-kill", kind: "kill", target: "metadb", ...window(1500, 2000) }]),
      expect: "Cached manifest reads continue unaffected. File version commits pause during the ~500 ms failover window and then resume on the promoted replica with zero lost versions thanks to semi-synchronous replication and fencing.",
      check: { minGoodput: 0.8, clean: true },
    },
    {
      id: "notifier-lag",
      title: "Notification workers crash briefly",
      explanation: "The push/long-poll notifier workers crash from t = 1.3 s to 1.9 s.",
      scenario: variant(baseline, "dropbox-notifier-down", [{ id: "notifier-kill", kind: "kill", target: "notifier", ...window(1300, 1900) }]),
      expect: "File commits and manifest fetches succeed without interruption; change events wait in the durable `syncbus` queue and notify connected devices as soon as workers recover.",
      check: { minGoodput: 0.99, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Chunking, content addressing, and write-before-commit ordering",
      body: "A client splits a file into chunks (4 MB fixed or Rabin content-defined), hashes each chunk with SHA-256, and asks the server which hashes are missing. The client uploads only the missing blocks to the block store, verifies their hashes, and **only after all blocks are durably stored** calls `commit(fileId, baseVersion, [sha256...])` on the metadata DB. This ordering guarantees a committed file version never points to a dangling block.",
    },
    {
      title: "Optimistic concurrency and conflict files",
      body: "Unlike Google Docs, arbitrary binary files (.psd, .zip, .docx) cannot always be auto-merged character-by-character. Each commit supplies `baseVersion`. If Alice and Bob both edit `v3` offline, Alice's commit advances the file to `v4`; Bob's commit with `baseVersion = 3` gets `409 Conflict`. Rather than overwriting Alice's work, the client saves Bob's blocks as `report (Bob's conflicted copy).docx` so both versions are preserved.",
    },
    {
      title: "Cold storage tiering and erasure coding",
      body: "Most uploaded blocks are rarely read after the initial sync across a user's devices. Keeping 3 full copies of an exabyte is prohibitively expensive (`3×` overhead). Dropbox's Magic Pocket groups immutable blocks into large extents and applies Reed-Solomon erasure coding (e.g. 6 data + 3 parity shards across failure domains = `1.5×` overhead) with cold archival tiers for old versions.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Upload and download files.", "Sync across devices + history.", "Chunk delta sync, deduplication, 11-nines durability, conflict preservation.", "Separates metadata ACID requirements from immutable block storage."] },
    { stage: "estimates", descriptors: ["None.", "Total storage.", "Chunk write rate, dedup savings, metadata QPS, and connected long-poll clients.", "Shows why metadata traffic and block bandwidth must be scaled on separate paths."] },
    { stage: "api", descriptors: ["PUT/GET file.", "Chunk upload + metadata.", "Pre-check missing hashes → upload blocks → CAS commit manifest.", "Cursor-based `/changes` long-polling and pre-signed block URLs."] },
    { stage: "data model", descriptors: ["Files table.", "Files + chunks.", "Content-addressed immutable blocks (`sha256`) + versioned manifest rows.", "Workspace change sequence log and reference counting / GC for orphaned blocks."] },
    { stage: "high level", descriptors: ["App server + S3.", "Metadata DB + block store.", "Separate block plane and metadata plane + async notification bus.", "CDN/direct block transfer, cache invalidation, and multi-zone erasure coding."] },
    { stage: "deep dive", descriptors: ["None.", "Explains 4 MB chunks.", "Rabin content-defined chunking and write-blocks-before-commit invariant.", "CAS conflict copies, long-poll cursor recovery, and Reed-Solomon cold storage."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions durability.", "Dangling blocks, silent corruption, and reconnect storms as top risks.", "End-to-end checksum scrubbing, orphan block GC watermarks, and failover drills."] },
  ],
  clarifyingQuestions: [
    "Maximum file size and typical file size distribution?",
    "How should concurrent offline edits to the same file be resolved?",
    "Do we deduplicate blocks within a single user's account or globally across accounts?",
    "How long do we retain deleted files and old versions?",
  ],
  commonMistakes: [
    "Uploading and downloading whole files instead of content-addressed chunks.",
    "Committing the metadata row before all referenced blocks are durably written.",
    "Streaming multi-gigabyte file uploads through the metadata database servers.",
    "Using fixed-size chunks when middle-of-file insertions are common, without discussing content-defined chunking.",
    "Having 250M clients poll the metadata database every second instead of using cursor-based long polling.",
  ],
};
