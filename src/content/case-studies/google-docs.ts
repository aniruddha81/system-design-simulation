import type { CaseStudy } from "./types";
import { alter, backoff, cache, cacheAside, cacheDelete, client, data, dedup, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// Append-only operation log per document + periodic materialised snapshots in object storage.
const oplog = entity("oplog", "opstore", { docId: ["int", 8], rev: ["int", 8], opBytes: ["string", 200] }, 10_000);
const snapshots = entity("snapshots", "snapstore", { docId: ["int", 8], snapshotBlob: ["string", 16_000] }, 10_000);

// Session gateway maintains WebSockets and routes all collaborators on docId to the same collab server via consistent hashing.
const gwHandlers = {
  edit: [{ type: "call" as const, target: "collab", timeoutUs: 50_000, retry: backoff(2, 10, ["timeout"]) }],
  load: [{ type: "call" as const, target: "collab", timeoutUs: 150_000 }],
};

const collabHandlers = {
  // Deduplicate client opId, append transformed/CRDT op to the durable op log, and enqueue snapshot compaction.
  edit: [
    dedup("opdedup"),
    {
      type: "branch" as const,
      cond: { kind: "dedupHit" as const },
      then: [respond(200)],
      else: [
        data("opstore", "oplog", { kind: "update", field: "opBytes", op: "append", value: "op" }, 40),
        publish("compaction", true),
        respond(200),
      ],
    },
  ],
  // Opening a doc fetches tail ops from the op log and reads the compacted snapshot through the active snapshot cache.
  load: [
    data("opstore", "oplog", { kind: "get" }, 40),
    ...cacheAside("doccache", [data("snapstore", "snapshots", { kind: "get" }, 80)]),
  ],
};

const compactorHandlers = {
  edit: [data("opstore", "oplog", { kind: "get" }, 50), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "google-docs",
  name: "Collaborative document editor",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1], "consistentHash"),
    service("gw1", "WebSocket gateway 1", [2, 0], gwHandlers, 256, 0.2),
    service("gw2", "WebSocket gateway 2", [2, 2], gwHandlers, 256, 0.2),
    service("collab", "Document session service", [3, 1], collabHandlers, 128, 0.6),
    node("opdedup", "dedupStore", "Client opId dedup", [4, 0], { ...pool(256, 0.2), serviceTime: lognormal(0.25), ttlUs: 86_400_000_000, atomic: true, durable: true }),
    cache("doccache", "Active document cache", [4, 1], 25_000_000, 120_000),
    node("opstore", "kvStore", "Operation log store", [4, 2], { ...pool(128, 1.2), readTime: lognormal(1.2), writeTime: lognormal(1.8), members: 6, vnodes: 64, replicationFactor: 3, readQuorum: 2, writeQuorum: 2, hintedHandoff: true, readRepair: true, tombstoneGcUs: 864_000_000_000 }),
    node("compaction", "queue", "Snapshot compaction queue", [5, 1], { partitions: 64, capacityMessages: 25_000, visibilityTimeoutUs: 500_000, maxDeliveries: 5, retentionUs: 86_400_000_000, publishTime: lognormal(0.8), costPerHour: 0.15, region: "us-east", zone: "a" }),
    node("compactor", "worker", "Snapshot compactors", [6, 1], { ...pool(32, 0.5), serviceTime: lognormal(15), source: "compaction", batchSize: 32 }, compactorHandlers),
    node("snapstore", "objectStore", "Document snapshots", [6, 2], { readTime: lognormal(15, 0.4), writeTime: lognormal(30, 0.4), costPerGBMonth: 0.02, costPerMillionRequests: 0.4, region: "us-east", zone: "a" }),
  ],
  edges: [
    link("client", "lb"), link("lb", "gw1"), link("lb", "gw2"),
    link("gw1", "collab"), link("gw2", "collab"),
    link("collab", "opdedup"), link("collab", "doccache"), link("collab", "opstore"), link("collab", "compaction"), link("collab", "snapstore"),
    link("compactor", "opstore"),
  ],
  endpoints: [
    { id: "edit", name: "WS op { docId, opId, baseRev, delta }", op: "write" as const, keyTemplate: "doc:{docId}", requestBytes: 250, responseBytes: 100, idempotent: false },
    { id: "load", name: "GET /v1/documents/:docId", op: "read" as const, keyTemplate: "doc:{docId}", requestBytes: 150, responseBytes: 16_000, idempotent: true },
  ],
  entities: [oplog, snapshots],
};

const baseline = scenario("docs-day", { arrival: { kind: "poisson", rps: 2000 }, mix: { edit: 0.75, load: 0.25 }, keys: { kind: "zipf", n: 10_000, s: 1.0 }, deadlineMs: 400 });
const lostOpAcks = variant(baseline, "docs-lost-acks", [{ id: "lost-acks", kind: "partition", target: "", links: [{ from: "collab", to: "gw1" }], ...window(1500, 1580) }]);

export const googleDocs: CaseStudy = {
  id: "google-docs",
  title: "Collaborative editor (Google Docs)",
  summary: "Let dozens of people edit the same document concurrently in real time, offline or online, and converge to the exact same state. The core design combines Operational Transformation (OT) or sequence CRDTs with an append-only operation log, background snapshot compaction, and ephemeral cursor/presence fan-out.",
  requirements: {
    functional: [
      "Multiple users edit the same rich-text document simultaneously and see each other's changes and cursors in real time.",
      "Strong eventual convergence: any two collaborators who have received the same set of operations display the exact same document.",
      "Offline editing and reconnect without losing or duplicating operations; version history and point-in-time restore.",
    ],
    nonFunctional: [
      "Local typing is zero-latency (optimistic local apply); remote collaborators see edits within ~100–200 ms.",
      "Zero data loss once an operation is acknowledged; idempotent operation replay across reconnects.",
      "Cap active editors per document (~100 concurrent writers) while supporting thousands of read-only viewers.",
    ],
  },
  estimates: [
    { label: "Operation rate", formula: "5M concurrent active editors × 1 batched op every 2 s", result: "≈ 2.5M ops/s globally (each ~100–200 B)" },
    { label: "Operation log growth", formula: "2.5M ops/s × 150 B × 86,400 s", result: "≈ 32 TB/day of raw ops before compaction into checkpoints" },
    { label: "Document load bandwidth", formula: "opening a doc fetches 1 compacted snapshot (~50 KB) + < 100 tail ops", result: "fast O(1) open time instead of replaying millions of historical keystrokes" },
    { label: "Cursor / presence traffic", formula: "20 editors/doc × 5 cursor moves/s × 20 recipients", result: "ephemeral UDP/WebSocket broadcast — never persisted to the database" },
  ],
  api: [
    { signature: "WS op { docId, opId, baseRev, ops[] }", request: "client-generated opId; baseRev is last server revision applied locally", response: "ack { opId, serverRev }; transformed op broadcast to peers", endpointId: "edit" },
    { signature: "GET /v1/documents/{docId}", request: "optional atRev for history", response: "200 { snapshotRev, content, tailOps[] }", endpointId: "load" },
    { signature: "WS presence { docId, cursorRange, selection }", request: "ephemeral, best-effort", response: "broadcast to active session peers without persistence" },
  ],
  dataModel: {
    entities: [oplog, snapshots],
    notes: [
      "oplog: partitioned by `docId`, ordered by monotonically increasing `rev`. Each entry stores the client `opId`, author, timestamp, and operation delta.",
      "snapshots: periodic compacted document state at `rev = k × 100` in object storage so loading a document only replays the tail (`rev > snapshotRev`).",
      "opdedup: tracks `(docId, opId)` so a client reconnecting and resending unacknowledged edits never applies an insert or delete twice.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "No operation deduplication on reconnect",
      tradeoffs: "When a WebSocket drops after the server appends an operation to the log but before the client receives the `ack`, the client resends its unacknowledged buffer. Without `opId` deduplication (or idempotent CRDT item IDs), the character insertion is applied twice.",
      design: alter(design, "docs-no-dedup", "Collaborative editor without opId dedup", (d) => {
        find<"service">(d, "collab").handlers!.edit = [
          data("opstore", "oplog", { kind: "update", field: "opBytes", op: "append", value: "op" }, 40),
          cacheDelete("doccache"),
          publish("compaction", true),
          respond(200),
        ];
      }),
      check: { scenario: "lost-acks", violations: ["duplicateEffect"] },
    },
    {
      title: "Write full document snapshot to object storage on every edit",
      tradeoffs: "Rewriting a 100 KB document blob on every keystroke instead of appending a 150 B operation to a log amplifies write bandwidth by ~700× and pushes p99 latency above 80 ms.",
      design: alter(design, "docs-sync-snapshot", "Collaborative editor writing full snapshots on every edit", (d) => {
        find<"service">(d, "collab").handlers!.edit = [
          data("snapstore", "snapshots", { kind: "put" }, 350),
          cacheDelete("doccache"),
          respond(200),
        ];
      }),
      check: { scenario: "baseline", minP99Ms: 75 },
    },
    {
      title: "Pessimistic locking (check-out / check-in)",
      tradeoffs: "Locking the document or paragraph while one user types avoids OT/CRDT complexity entirely, but blocks real-time collaboration and leaves stale locks whenever a browser tab disconnects.",
    },
  ],
  failureScenarios: [
    {
      id: "lost-acks",
      title: "WebSocket acknowledgements are dropped during reconnect",
      explanation: "From t = 1.5 s to 1.58 s responses from the collaboration service to gateway 1 are lost; the gateway retries the buffered operations with the same `opId`.",
      scenario: lostOpAcks,
      expect: "The dedup store catches the retried `opId`s and returns the original revision ack without appending duplicate text to the document log. Compare the no-dedup alternative.",
      check: { minGoodput: 0.97, clean: true },
    },
    {
      id: "compactor-down",
      title: "Snapshot compaction workers crash",
      explanation: "The background snapshot compactors are down from t = 1.3 s to 2.0 s.",
      scenario: variant(baseline, "docs-compactor-down", [{ id: "compactor-kill", kind: "kill", target: "compactor", ...window(1300, 2000) }]),
      expect: "Live editing and document loading keep working at 100% goodput: edits only need the operation log, and loads read the last snapshot plus a slightly longer tail of operations until compactors catch up.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "all-hands-doc",
      title: "Everyone opens and edits the company all-hands doc",
      explanation: "One hot document receives 30% of all load and edit traffic.",
      scenario: variant(baseline, "docs-hot-doc", [], { keys: { kind: "hotspot", n: 10_000, hotFraction: 0.3 } }),
      expect: "The active document cache serves document loads, and routing the document's session to one collaboration server serialises its revision log cleanly in memory.",
      check: { minGoodput: 0.99, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Operational Transformation (OT) vs Sequence CRDTs",
      body: "In Google Jupiter-style OT, a single authoritative server per active document assigns a total order of revisions (`rev = 1, 2, 3...`). Each client holds at most one unacknowledged in-flight operation batch; when an operation referencing `baseRev = 5` arrives at `rev = 7`, the server transforms its character indices against ops 6 and 7 before appending it as `rev = 8`. Sequence CRDTs (RGA, Yjs, Automerge) instead give every character a globally unique immutable ID `(clientId, clock)` and insert relative to left/right neighbour IDs, so operations commute without a central server — ideal for peer-to-peer or long offline edits, at the cost of tombstone metadata.",
    },
    {
      title: "Single-writer document session routing",
      body: "For server-ordered OT, routing all editors of `docId` to the same stateful collaboration server (via consistent hashing with leases in etcd/ZooKeeper) lets that server sequence revisions in memory and append to the durable op log without cross-node coordination on every keystroke. When a document exceeds ~100 active writers, additional joiners are placed in a read-only follower fan-out tree fed by the session server.",
    },
    {
      title: "Operation log compaction and version history",
      body: "Replaying 500,000 operations from `rev = 0` on every page load is too slow. Every N operations (or when a session becomes idle), a background worker folds the tail operations into a new snapshot at `snapshotRev`. Named versions and history scrubbers read the nearest preceding snapshot and replay forward to the target revision.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Edit a shared document.", "Real-time sync + cursors.", "Convergence guarantee, optimistic local edits, offline reconnect, and writer caps.", "Distinguishes persistent op log from ephemeral presence and read-only viewer fan-out."] },
    { stage: "estimates", descriptors: ["None.", "Active users.", "Op rate, op log growth, and snapshot compaction intervals.", "Separates persistent edit bandwidth from quadratic cursor broadcast traffic."] },
    { stage: "api", descriptors: ["Save document.", "WebSocket ops.", "Client `opId`, `baseRev`, server `ack` with `serverRev`, and snapshot+tail load.", "Single in-flight batch protocol (Jupiter) and reconnect catch-up."] },
    { stage: "data model", descriptors: ["Documents table.", "Document blob + history.", "Partitioned append-only op log + periodic snapshots in object storage.", "Tombstone/compaction metadata and client opId deduplication."] },
    { stage: "high level", descriptors: ["Clients write DB.", "WebSocket server + DB.", "Session routing per docId, op log, snapshot compactor, presence channel.", "Read-only fan-out tier for viral docs and lease-based session failover."] },
    { stage: "deep dive", descriptors: ["None.", "Names OT or CRDT.", "Explains index shift in OT vs unique character IDs in RGA/Yjs CRDTs.", "Jupiter single-in-flight state machine, tombstone GC, and rich-text formatting spans."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions latency.", "Session server crash and divergence bugs as top risks.", "Automated fuzz/convergence testing, op-log lag alerts, and session failover drills."] },
  ],
  clarifyingQuestions: [
    "How many concurrent editors vs read-only viewers must a single document support?",
    "Do we need long-lived offline editing with automatic merge, or primarily online collaboration?",
    "Is the document plain text, rich text (spans), or block-structured (Notion/Figma)?",
    "What granularity of version history must be retained?",
  ],
  commonMistakes: [
    "Sending the entire document text on every keystroke instead of compact operations.",
    "Applying `insert(pos, char)` from concurrent editors without OT index transformation or CRDT IDs.",
    "Persisting every cursor movement to the database.",
    "Replaying the entire operation log from revision 0 on document open without periodic snapshots.",
    "Omitting client operation IDs, causing duplicate insertions when a client reconnects.",
  ],
};
