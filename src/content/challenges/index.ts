import {
  cachingChallenge,
  kvQuorumDesign,
  kvQuorumScenario,
  noCacheDesign,
  paymentsScenario,
  paymentsWithoutDedupDesign,
  queueDlqDesign,
  queueDlqScenario,
  replicationFailoverDesign,
  replicationFailoverScenario,
  unsafeTicketBookingDesign,
} from "@/engine/fixtures";
import type { ChallengeSpec, Design, NodeSpec } from "@/engine/types";

export type Challenge = {
  id: string;
  title: string;
  /** Short paragraphs shown above the editor. */
  brief: string[];
  spec: ChallengeSpec;
  start: Design;
  /** Fallback hint ladder; the grader's own hints win when present. */
  hints: [string, string, string];
};

// ---------- 2. flash sale: no oversell (P2, built on E1's ticket-booking fixture) ----------

const SEATS = 100;
const lognormal = (ms: number) => ({ kind: "lognormal" as const, medianUs: ms * 1000, sigma: 0.4 });
const POS: Record<string, { x: number; y: number; label: string }> = {
  client: { x: 0, y: 160, label: "Buyers" },
  svc: { x: 256, y: 160, label: "Booking service" },
  db: { x: 512, y: 160, label: "Tickets DB" },
};

/** The fixture's read-then-decrement booking, laid out and given realistic DB latency so concurrent buyers race. */
export const flashSaleStart: Design = (() => {
  const d = structuredClone(unsafeTicketBookingDesign);
  d.id = "flash-sale";
  d.name = "Flash sale";
  d.nodes = d.nodes.map((n): NodeSpec => {
    const p = POS[n.id];
    const placed = { ...n, label: p?.label ?? n.label, position: p ? { x: p.x, y: p.y } : n.position } as NodeSpec;
    if (placed.kind === "database")
      return { ...placed, params: { ...placed.params, concurrency: 32, readTime: lognormal(0.5), writeTime: lognormal(0.5), costPerHour: 0.2 } };
    if (placed.kind === "service") return { ...placed, params: { ...placed.params, concurrency: 64, serviceTime: lognormal(1), costPerHour: 0.05 } };
    return placed;
  });
  d.entities = (d.entities ?? []).map((e) => ({ ...e, dataset: { ...e.dataset, initial: { remaining: SEATS } } }));
  d.endpoints = d.endpoints.map((e) => (e.id === "put" ? { ...e, name: "POST /book" } : { ...e, name: "GET /seats" }));
  return d;
})();

const flashSaleChallenge: ChallengeSpec = {
  id: "flash-sale-no-oversell",
  title: "Sell 100 seats without overselling",
  scenario: {
    id: "flash-sale",
    version: 1,
    warmupUs: 0,
    measureUs: 1_000_000,
    drainUs: 300_000,
    chaos: [],
    workload: { arrival: { kind: "constant", rps: 1000 }, mix: { put: 1 }, keys: { kind: "uniform", n: 1 }, deadlineUs: 250_000 },
  },
  variantChaos: [[{ id: "slow-db", kind: "degrade", target: "db", atUs: 200_000, endUs: 600_000, slowFactor: 4 }]],
  // 100 seats for ~1,000 buyers: at most ~10% can succeed, so the goodput bar is the seat count, not 99%.
  slos: [{ kind: "goodput", min: 0.095 }], // 100 successes are too few for a p99 estimate
  invariants: ["oversell"],
  budgetPerMonth: 400,
  allowedKinds: ["client", "loadBalancer", "service", "database", "dedupStore", "rateLimiter", "queue", "worker", "cache"],
  seeds: [1, 2, 3, 4, 5],
};

// ---------- 3. idempotent payment retry: no duplicateEffect on lost acks ----------

const PAY_POS: Record<string, { x: number; y: number; label: string }> = {
  client: { x: 0, y: 180, label: "Checkout clients" },
  svc: { x: 220, y: 180, label: "Checkout gateway" },
  payments: { x: 460, y: 180, label: "Payment service" },
  dedup: { x: 700, y: 80, label: "Idempotency store" },
  db: { x: 700, y: 280, label: "Ledger DB" },
};

export const idempotentPaymentStart: Design = (() => {
  const d = structuredClone(paymentsWithoutDedupDesign);
  d.id = "idempotent-payment-retry";
  d.name = "Payment retry without deduplication";
  d.nodes = d.nodes.map((n): NodeSpec => {
    const p = PAY_POS[n.id];
    return { ...n, label: p?.label ?? n.label, position: p ? { x: p.x, y: p.y } : n.position } as NodeSpec;
  });
  return d;
})();

const idempotentPaymentChallenge: ChallengeSpec = {
  id: "idempotent-payment-retry",
  title: "Charge once when payment acknowledgements drop",
  scenario: structuredClone(paymentsScenario),
  variantChaos: [
    [{ id: "lost-ack-variant", kind: "partition", target: "", atUs: 8_600, endUs: 9_200, links: [{ from: "payments", to: "svc" }] }],
  ],
  slos: [{ kind: "goodput", min: 0.99 }],
  invariants: ["duplicateEffect"],
  budgetPerMonth: 400,
  allowedKinds: ["client", "loadBalancer", "service", "database", "dedupStore", "queue", "worker", "cache"],
  seeds: [1, 2, 3, 4, 5],
};

// ---------- 4. fenced leader failover: no ackedWriteLost or splitBrainWrite ----------

const FAILOVER_POS: Record<string, { x: number; y: number; label: string }> = {
  client: { x: 0, y: 160, label: "Writers" },
  svc: { x: 256, y: 160, label: "Account service" },
  db: { x: 512, y: 160, label: "Primary + replicas" },
};

export const fencedFailoverStart: Design = (() => {
  const d = structuredClone(replicationFailoverDesign);
  d.id = "fenced-leader-failover";
  d.name = "Async unfenced failover";
  d.nodes = d.nodes.map((n): NodeSpec => {
    const p = FAILOVER_POS[n.id];
    const placed = { ...n, label: p?.label ?? n.label, position: p ? { x: p.x, y: p.y } : n.position } as NodeSpec;
    if (placed.kind === "database") {
      return {
        ...placed,
        params: { ...placed.params, replicationLag: { kind: "constant", us: 2_000 } },
      };
    }
    return placed;
  });
  return d;
})();

const fencedFailoverScenario = (() => {
  const s = structuredClone(replicationFailoverScenario);
  s.id = "fenced-leader-failover";
  s.measureUs = 200_000;
  s.workload.arrival = { kind: "constant", rps: 100 };
  s.chaos = [{ id: "leader-down", kind: "kill", target: "db", atUs: 11_000, endUs: 15_000 }];
  return s;
})();

const fencedFailoverChallenge: ChallengeSpec = {
  id: "fenced-leader-failover",
  title: "Survive primary failover without lost writes or split-brain",
  scenario: fencedFailoverScenario,
  variantChaos: [[{ id: "leader-down-variant", kind: "kill", target: "db", atUs: 21_000, endUs: 25_000 }]],
  slos: [{ kind: "goodput", min: 0.94 }],
  invariants: ["ackedWriteLost", "splitBrainWrite"],
  budgetPerMonth: 500,
  allowedKinds: ["client", "loadBalancer", "service", "database", "dedupStore", "cache"],
  seeds: [1, 2, 3, 4, 5],
};

// ---------- 5. quorum fresh reads: no staleRead on replicated KV ----------

const QUORUM_POS: Record<string, { x: number; y: number; label: string }> = {
  client: { x: 0, y: 160, label: "Clients" },
  svc: { x: 256, y: 160, label: "Storage proxy" },
  kv: { x: 512, y: 160, label: "KV ring (N=3)" },
};

export const quorumFreshReadsStart: Design = (() => {
  const d = structuredClone(kvQuorumDesign);
  d.id = "quorum-fresh-reads";
  d.name = "Weak quorum KV (R=1, W=1)";
  d.nodes = d.nodes.map((n): NodeSpec => {
    const p = QUORUM_POS[n.id];
    return { ...n, label: p?.label ?? n.label, position: p ? { x: p.x, y: p.y } : n.position } as NodeSpec;
  });
  return d;
})();

const quorumFreshReadsChallenge: ChallengeSpec = {
  id: "quorum-fresh-reads",
  title: "Eliminate stale reads on a 3-replica key-value ring",
  scenario: structuredClone(kvQuorumScenario),
  variantChaos: [[{ id: "proxy-degrade", kind: "degrade", target: "svc", atUs: 10_000, endUs: 20_000, slowFactor: 2 }]],
  slos: [{ kind: "goodput", min: 0.99 }],
  invariants: ["staleRead"],
  budgetPerMonth: 500,
  allowedKinds: ["client", "loadBalancer", "service", "kvStore", "cache"],
  seeds: [1, 2, 3, 4, 5],
};

// ---------- 6. ordered queue visibility: no orderingViolated under slow workers ----------

const QUEUE_POS: Record<string, { x: number; y: number; label: string }> = {
  client: { x: 0, y: 160, label: "Producers" },
  svc: { x: 220, y: 160, label: "Ingest service" },
  jobs: { x: 440, y: 160, label: "Partitioned queue" },
  consumer: { x: 660, y: 160, label: "Worker pool" },
  db: { x: 880, y: 160, label: "State DB" },
};

export const orderedQueueStart: Design = (() => {
  const d = structuredClone(queueDlqDesign);
  d.id = "ordered-queue-visibility";
  d.name = "Short visibility timeout queue";
  d.nodes = d.nodes.map((n): NodeSpec => {
    const p = QUEUE_POS[n.id];
    const placed = { ...n, label: p?.label ?? n.label, position: p ? { x: p.x, y: p.y } : n.position } as NodeSpec;
    if (placed.kind === "worker") {
      return {
        ...placed,
        params: { ...placed.params, serviceTime: { kind: "empirical", buckets: [{ us: 1, weight: 1 }, { us: 4_000, weight: 1 }] } },
        handlers: { put: [{ type: "respond", status: 200 }] },
      };
    }
    return placed;
  });
  return d;
})();

const orderedQueueScenario = (() => {
  const s = structuredClone(queueDlqScenario);
  s.id = "ordered-queue-visibility";
  s.measureUs = 5_001;
  return s;
})();

const orderedQueueChallenge: ChallengeSpec = {
  id: "ordered-queue-visibility",
  title: "Preserve per-key queue order when workers hit slow tail spikes",
  scenario: orderedQueueScenario,
  variantChaos: [[{ id: "svc-slow", kind: "degrade", target: "svc", atUs: 1_000, endUs: 2_500, slowFactor: 2 }]],
  slos: [{ kind: "goodput", min: 0.99 }],
  invariants: ["orderingViolated"],
  budgetPerMonth: 500,
  allowedKinds: ["client", "service", "queue", "worker", "database", "dedupStore"],
  seeds: [1, 2, 3, 4, 5],
};

export const challenges: Challenge[] = [
  {
    id: cachingChallenge.id,
    title: cachingChallenge.title,
    brief: [
      "Profiles are read far more than written, and a few are very hot. The database has few workers, so reads queue.",
      "At 7 s the cache restarts empty. Keep reads fast and successful through the cold start, within budget.",
    ],
    spec: cachingChallenge,
    start: noCacheDesign,
    hints: [
      "Look at which component is busiest in the results. Is every read paying for a database round trip?",
      "The services can already call the cache. Change the GET route to check the cache first and only call the database on a miss — then store what you read.",
      "GET: cacheGet → if hit respond 200, else call DB → cacheSet → respond 200. PUT: call DB → cacheDelete → respond 200. Turn on request coalescing so the cold start doesn't stampede the database.",
    ],
  },
  {
    id: flashSaleChallenge.id,
    title: flashSaleChallenge.title,
    brief: [
      "100 seats, about a thousand buyers in the first second. The service reads the count, then writes it back one lower.",
      "Two buyers reading the same count both succeed, so a seat is oversold. Make bookings concurrency-safe; losers get a clean 409.",
    ],
    spec: flashSaleChallenge,
    start: flashSaleStart,
    hints: [
      "Run it and open the Results tab: the invariants list shows an oversell, with the request IDs that took a seat that wasn't there.",
      "The read and the write are two separate data steps, so another buyer can slip in between them. Look for a single data operation that checks and decrements together.",
      "On the booking service, replace get + update with one data step: decrementIfPositive on tickets.remaining. It returns 409 once the seats are gone.",
    ],
  },
  {
    id: idempotentPaymentChallenge.id,
    title: idempotentPaymentChallenge.title,
    brief: [
      "The gateway retries payments. A network glitch drops the response after the ledger write already succeeded.",
      "The retry charges twice. Wire the idempotency store so retries return the original result.",
    ],
    spec: idempotentPaymentChallenge,
    start: idempotentPaymentStart,
    hints: [
      "Run the starter design and inspect the duplicateEffect violation: the retry arrives with the same logical request ID after the response was dropped.",
      "An idempotency store (dedup) is already on the board and connected to the payment service, but the payment service's PUT handler goes straight to the ledger DB.",
      "In the payment service's PUT handler, run dedup on 'dedup' first, then branch on dedupHit: if hit, respond 200 immediately; else update ledger.total in 'db'. Also reduce the payment service's constant serviceTime so it finishes well before the 1 ms caller timeout.",
    ],
  },
  {
    id: fencedFailoverChallenge.id,
    title: fencedFailoverChallenge.title,
    brief: [
      "An account service writes to a replicated database with async replication and unfenced failover.",
      "The primary crashes at 4.5 ms: unshipped writes are lost (ackedWriteLost) and the old leader briefly accepts writes (splitBrainWrite). Fix both.",
    ],
    spec: fencedFailoverChallenge,
    start: fencedFailoverStart,
    hints: [
      "Inspect the two violations after running: ackedWriteLost happens when the primary dies before async replication ships committed writes to replicas.",
      "splitBrainWrite happens when the old leader comes back and accepts writes without checking a fencing token.",
      "Select the Primary + replicas database node: switch replication from 'async' to 'sync' and enable failover fencing (fencing: true).",
    ],
  },
  {
    id: quorumFreshReadsChallenge.id,
    title: quorumFreshReadsChallenge.title,
    brief: [
      "A 3-replica store (N = 3) runs sloppy quorums, R = 1 and W = 1.",
      "Reads often hit a replica without the latest acknowledged write (staleRead). Make read and write quorums overlap.",
    ],
    spec: quorumFreshReadsChallenge,
    start: quorumFreshReadsStart,
    hints: [
      "With N = 3 replicas, W = 1 and R = 1 satisfy R + W = 2 ≤ N, so the read replica set and write replica set can be disjoint.",
      "Strict quorum intersection requires R + W > N (for example, R = 2 and W = 2 when N = 3) or hinted handoff.",
      "Select the KV ring node and raise readQuorum to 2 and writeQuorum to 2 (so 2 + 2 > 3).",
    ],
  },
  {
    id: orderedQueueChallenge.id,
    title: orderedQueueChallenge.title,
    brief: [
      "Producers publish per-key ordered jobs. Half take 1 µs, half take 4 ms.",
      "A 1 ms visibility timeout redelivers slow jobs while still running, breaking per-key order (orderingViolated). Tune the queue.",
    ],
    spec: orderedQueueChallenge,
    start: orderedQueueStart,
    hints: [
      "Check the worker service time distribution (up to 4,000 µs) versus the queue's visibilityTimeoutUs (1,000 µs).",
      "When visibilityTimeoutUs expires before a worker finishes, the queue assumes the worker died and hands the message to another worker.",
      "Select the Partitioned queue node ('jobs') and increase visibilityTimeoutUs to at least 10,000 µs (10 ms).",
    ],
  },
];

export function getChallenge(id: string): Challenge | undefined {
  return challenges.find((c) => c.id === id);
}
