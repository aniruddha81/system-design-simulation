import type { CaseStudy } from "./types";
import { alter, backoff, client, data, entity, find, link, loadBalancer, lognormal, node, pool, respond, scenario, service, variant, window } from "./kit";

const items = entity("items", "kv", { key: ["string", 16], value: ["string", 1000] }, 10_000);
const retry = backoff(2, 5);
const handlers = {
  get: [data("kv", "items", { kind: "get" }, 30, retry), respond(200)],
  put: [data("kv", "items", { kind: "put" }, 30, retry), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "key-value-store",
  name: "Dynamo-style key-value store",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("coord1", "Coordinator 1", [2, 0], handlers, 128, 0.3),
    service("coord2", "Coordinator 2", [2, 2], handlers, 128, 0.3),
    node("kv", "kvStore", "Storage ring (6 nodes)", [3, 1], {
      ...pool(48, 1.2, 2000), readTime: lognormal(1), writeTime: lognormal(1.5),
      members: 6, vnodes: 64, replicationFactor: 3, readQuorum: 2, writeQuorum: 2,
      hintedHandoff: true, readRepair: true, tombstoneGcUs: 864_000_000_000,
    }),
  ],
  edges: [link("client", "lb"), link("lb", "coord1"), link("lb", "coord2"), link("coord1", "kv"), link("coord2", "kv")],
  endpoints: [
    { id: "get", name: "GET /kv/:key", op: "read" as const, keyTemplate: "item:{key}", requestBytes: 100, responseBytes: 1100, idempotent: true },
    { id: "put", name: "PUT /kv/:key", op: "write" as const, keyTemplate: "item:{key}", requestBytes: 1100, responseBytes: 100, idempotent: true },
  ],
  entities: [items],
};

const baseline = scenario("kv-day", { arrival: { kind: "poisson", rps: 2000 }, mix: { get: 0.7, put: 0.3 }, keys: { kind: "zipf", n: 10_000, s: 0.99 }, deadlineMs: 200 });

export const keyValueStore: CaseStudy = {
  id: "key-value-store",
  title: "Key-value store",
  summary: "Design a Dynamo-style store: partition keys over a consistent-hash ring, replicate each key N times and let R and W quorums trade consistency for latency and availability.",
  requirements: {
    functional: ["put(key, value) and get(key) for values up to ~1 MB (typically ~1 KB).", "delete(key).", "Optional: conditional put on a version for read-modify-write."],
    nonFunctional: [
      "Single-digit-millisecond p99 for get and put inside a region.",
      "Writes always accepted while a quorum of replicas is reachable (high write availability).",
      "Tunable consistency per request; read-your-writes when R + W > N.",
      "Scale horizontally to tens of TB and ~1M ops/s by adding nodes, with minimal data movement.",
    ],
  },
  estimates: [
    { label: "Data", formula: "10B keys × ~1 KB", result: "≈ 10 TB, ≈ 30 TB with N = 3" },
    { label: "Nodes for storage", formula: "30 TB ÷ ~2 TB usable per node (leave room for compaction)", result: "≈ 15 nodes" },
    { label: "Nodes for throughput", formula: "1M ops/s × (70% reads × R=2 + 30% writes × N=3 replicas written) ÷ ~100k replica ops/s per node", result: "≈ 23 nodes → plan ~30 for headroom and node loss" },
    { label: "Data moved when a node joins", formula: "≈ 1/(nodes) of the keys with consistent hashing", result: "≈ 1 TB of 30 TB for the 31st node, vs nearly all of it with hash mod N" },
    { label: "Quorum latency", formula: "W = 2 of 3 waits for the 2nd-fastest replica", result: "p99 is set by the 2nd replica, not the slowest — a reason not to pick W = N" },
  ],
  api: [
    { signature: "GET /kv/{key}?consistency=quorum|one", request: "—", response: "200 { value, version } · 404", endpointId: "get" },
    { signature: "PUT /kv/{key}", request: "{ value } + If-Match: version (optional)", response: "200 { version } · 409 version mismatch", notes: "A plain put is idempotent, so the coordinator can retry it safely.", endpointId: "put" },
    { signature: "DELETE /kv/{key}", request: "—", response: "200", notes: "Writes a tombstone, garbage-collected after gc_grace (here 10 days) so a lagging replica cannot resurrect the value." },
  ],
  dataModel: {
    entities: [items],
    notes: [
      "Each key hashes to a token on the ring; its N = 3 replicas are the next 3 distinct nodes clockwise (the preference list).",
      "Each node owns many virtual nodes (64 here, 256 in Cassandra's default), which spreads load evenly and spreads a failed node's load across all survivors.",
      "Values carry a version (vector clock in Dynamo, timestamp in Cassandra) used to pick a winner and to repair replicas.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Weak quorums: R = 1, W = 1",
      tradeoffs: "Lowest latency and highest availability — any single replica answers. But R + W = 2 ≤ N = 3, so a read can land on a replica the write never reached: acknowledged writes become invisible to later reads. Run the baseline against it and the engine reports stale reads.",
      design: alter(design, "kv-weak-quorum", "KV store with R=W=1", (d) => {
        const kv = find<"kvStore">(d, "kv");
        kv.params = { ...kv.params, readQuorum: 1, writeQuorum: 1, hintedHandoff: false, readRepair: false };
      }),
      check: { scenario: "baseline", violations: ["staleRead"] },
    },
    {
      title: "Round-robin load balancing in front of the coordinators",
      tradeoffs: "Round robin ignores how busy each coordinator is. When one coordinator silently loses its path to the ring, round robin keeps giving it half the requests until a health check notices — and a shallow health check never does.",
      design: alter(design, "kv-round-robin", "KV store behind round robin", (d) => {
        find<"loadBalancer">(d, "lb").params.algorithm = "roundRobin";
      }),
      check: { scenario: "coordinator-partition", maxGoodput: 0.9 },
    },
    {
      title: "Leader per shard with consensus (Raft/Paxos)",
      tradeoffs: "Each key range has one leader replicated by Raft (etcd, TiKV, CockroachDB, Spanner). Reads and writes are linearizable and there are no conflicting versions to merge. The cost: writes wait for a majority and stall during leader election, and a partitioned minority cannot accept writes — the CP side of the trade-off Dynamo deliberately avoided for the shopping cart.",
    },
    {
      title: "Hash mod N instead of a ring",
      tradeoffs: "Trivial to implement, but changing N remaps almost every key, so every resize is a full reshuffle. Consistent hashing (or a directory of ranges) moves only about 1/N of the keys.",
    },
  ],
  failureScenarios: [
    {
      id: "lossy-link",
      title: "Packet loss between a coordinator and the ring",
      explanation: "From t = 1.2 s to 2.4 s, 5% of packets from coordinator 1 to the storage nodes are lost.",
      scenario: variant(baseline, "kv-lossy", [{ id: "lossy", kind: "linkLoss", target: "coord1-kv", lossRate: 0.05, ...window(1200, 2400) }]),
      expect: "Lost requests time out after 30 ms and the coordinator retries with backoff. Because put is an idempotent overwrite and get has no side effects, retries are safe and nearly every request succeeds; the retries show up as a fatter tail.",
      check: { minGoodput: 0.98, clean: true },
    },
    {
      id: "slow-ring",
      title: "The storage nodes slow down 6×",
      explanation: "From t = 1.5 s to 2.3 s every storage operation takes 6× longer — compaction or a noisy neighbour on shared disks.",
      scenario: variant(baseline, "kv-slow", [{ id: "slow", kind: "degrade", target: "kv", slowFactor: 6, ...window(1500, 2300) }]),
      expect: "Quorum operations take 6–9 ms instead of 1–2 ms, and the p99 roughly quadruples. Everything still finishes inside the 200 ms deadline, so availability holds — the ring has spare workers. With less headroom the same slowdown would queue requests; ring utilisation is the signal to add nodes before the next compaction storm.",
      check: { minGoodput: 0.97, minP99Ms: 12, clean: true },
    },
    {
      id: "coordinator-partition",
      title: "Coordinator 2 loses its network path to the ring",
      explanation: "From t = 1.5 s to 2.0 s, coordinator 2 cannot reach any storage node, but it still answers the load balancer's health checks.",
      scenario: variant(baseline, "kv-partition", [{ id: "cut", kind: "partition", target: "", links: [{ from: "coord2", to: "kv" }, { from: "kv", to: "coord2" }], ...window(1500, 2000) }]),
      expect: "The health check only asks 'is the process up?', so coordinator 2 stays in the pool — a gray failure. What saves most requests is the least-connections policy: requests stuck on coordinator 2 keep its connection count high, so new requests flow to coordinator 1. Only the requests caught on coordinator 2 time out three times and fail. Compare round robin, which keeps sending half the traffic into the hole.",
      check: { minGoodput: 0.95, maxGoodput: 0.998 },
    },
  ],
  deepDives: [
    {
      title: "Quorums: why R + W > N",
      body: "With N replicas, a write waits for W acknowledgements and a read for R replies. If R + W > N the read set and the last write set must overlap in at least one replica, so the read sees the latest acknowledged version (after picking the highest version among the replies). N = 3, R = W = 2 tolerates one slow or dead replica on both paths. R = 1, W = 3 makes reads fast and writes fragile; R = W = 1 is fastest but only eventually consistent. Note that quorum overlap is not linearizability: concurrent writes and sloppy quorums still need versions and conflict resolution.",
    },
    {
      title: "Sloppy quorums, hinted handoff, read repair, anti-entropy",
      body: "When a preference-list replica is down, Dynamo writes to the next healthy node with a hint and hands the data back when the owner recovers — writes stay available. Read repair updates stale replicas that a read happened to contact. Hints and read repair only fix keys that are touched, so a background anti-entropy process compares Merkle trees of key ranges between replicas and streams the differences.",
    },
    {
      title: "Conflicts and deletes",
      body: "Concurrent writes to the same key on different replicas produce siblings. Dynamo returns them with vector clocks for the application to merge (the shopping cart unions them); Cassandra uses last-write-wins timestamps, which silently drops one write if clocks skew. Deletes write tombstones that must outlive every replica's chance to sync; garbage-collecting them too early lets an old replica resurrect the deleted value.",
    },
    {
      title: "Storage engine",
      body: "Each node appends writes to a commit log and an in-memory memtable, flushed to immutable sorted files (an LSM tree) and compacted in the background. Writes are sequential and fast; reads may check several files, so bloom filters skip files that cannot contain the key. Compaction is the main source of latency spikes, as in the slow-ring scenario.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["get/put only.", "Adds value size and scale.", "States latency, availability and consistency requirements.", "Makes consistency tunable and explains which side of CAP the use case needs."] },
    { stage: "estimates", descriptors: ["None.", "Total data size.", "Node count from storage and from throughput, including replication.", "Data moved on resize and quorum latency effects."] },
    { stage: "api", descriptors: ["get/put.", "Adds delete and status codes.", "Versions and conditional put.", "Per-request consistency levels and idempotent retries."] },
    { stage: "data model", descriptors: ["A hash map.", "Hash partitioning.", "Consistent-hash ring with replicas.", "Virtual nodes, preference lists and versioning."] },
    { stage: "high level", descriptors: ["One server.", "Sharded servers.", "Coordinators + ring + replication.", "Explains read and write paths with quorums and failure handling."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions replication.", "Quorum math and hinted handoff.", "Read repair, anti-entropy, conflict resolution and tombstones."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions monitoring.", "Names compaction and hot keys as risks.", "Proposes deep health checks, capacity signals and rebalancing procedure."] },
  ],
  clarifyingQuestions: [
    "Value size distribution and total data size?",
    "Read/write ratio and peak throughput?",
    "Is eventual consistency acceptable, or do some operations need read-your-writes or compare-and-set?",
    "Single region or multi-region?",
  ],
  commonMistakes: [
    "hash(key) mod N partitioning.",
    "Claiming 'strong consistency' with R + W ≤ N.",
    "Ignoring tombstones and resurrection.",
    "Sizing for storage only and forgetting replication's effect on throughput.",
    "Shallow health checks that miss gray failures.",
  ],
};
