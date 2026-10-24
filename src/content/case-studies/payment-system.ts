import type { CaseStudy } from "./types";
import { alter, backoff, client, data, dedup, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// Double-entry ledger entries (debit + credit) and payment state machine rows in an ACID database.
const payments = entity("payments", "ledgerdb", { paymentId: ["int", 8], status: ["string", 16], amountCents: ["int", 8], entries: ["string", 256] }, 10_000);

// API gateway retries the payment service on timeout using the caller's Idempotency-Key.
const gwHandlers = {
  charge: [{ type: "call" as const, target: "pay", timeoutUs: 50_000, retry: backoff(2, 10, ["timeout"]) }],
  status: [{ type: "call" as const, target: "pay", timeoutUs: 80_000 }],
};

const payHandlers = {
  // Check-and-record Idempotency-Key first; only on a new key do we append double-entry ledger rows and enqueue PSP capture/settlement.
  charge: [
    dedup("idemp"),
    {
      type: "branch" as const,
      cond: { kind: "dedupHit" as const },
      then: [respond(200)],
      else: [
        data("ledgerdb", "payments", { kind: "update", field: "entries", op: "append", value: "dr/cr" }, 40),
        publish("outbox", true),
        respond(200),
      ],
    },
  ],
  status: [data("ledgerdb", "payments", { kind: "get" }, 40), respond(200)],
};

const settlementHandlers = {
  charge: [data("ledgerdb", "payments", { kind: "put" }, 60), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "payment-system",
  name: "Payment system & ledger",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("gw1", "Payment gateway 1", [2, 0], gwHandlers, 256, 0.3),
    service("gw2", "Payment gateway 2", [2, 2], gwHandlers, 256, 0.3),
    service("pay", "Payment orchestrator", [3, 1], payHandlers, 128, 0.6),
    node("idemp", "dedupStore", "Idempotency key store", [4, 0], { ...pool(256, 0.25), serviceTime: lognormal(0.3), ttlUs: 86_400_000_000, atomic: true, durable: true }),
    node("ledgerdb", "database", "Double-entry ledger DB", [4, 1], { ...pool(64, 1.2, 1000), readTime: lognormal(1.2), writeTime: lognormal(2.5), replicas: 3, replication: "semiSync", replicationLag: lognormal(1), walDurable: true, failover: { heartbeatUs: 100_000, missedHeartbeats: 3, electionUs: 200_000, fencing: true } }),
    node("outbox", "queue", "Transactional outbox / settlement queue", [4, 2], { partitions: 64, capacityMessages: 25_000, visibilityTimeoutUs: 400_000, maxDeliveries: 8, retentionUs: 86_400_000_000, publishTime: lognormal(0.8), costPerHour: 0.2, region: "us-east", zone: "a" }),
    node("settler", "worker", "PSP capture + reconciliation workers", [5, 2], { ...pool(32, 0.5), serviceTime: lognormal(5), source: "outbox", batchSize: 16 }, settlementHandlers),
  ],
  edges: [
    link("client", "lb"), link("lb", "gw1"), link("lb", "gw2"),
    link("gw1", "pay"), link("gw2", "pay"),
    link("pay", "idemp"), link("pay", "ledgerdb"), link("pay", "outbox"),
    link("settler", "ledgerdb"),
  ],
  endpoints: [
    { id: "charge", name: "POST /v1/payments (Idempotency-Key)", op: "write" as const, keyTemplate: "pay:{paymentId}", requestBytes: 450, responseBytes: 200, idempotent: false },
    { id: "status", name: "GET /v1/payments/:paymentId", op: "read" as const, keyTemplate: "pay:{paymentId}", requestBytes: 150, responseBytes: 350, idempotent: true },
  ],
  entities: [payments],
};

const baseline = scenario("payments-day", { arrival: { kind: "poisson", rps: 1800 }, mix: { charge: 0.6, status: 0.4 }, keys: { kind: "zipf", n: 10_000, s: 0.9 }, deadlineMs: 500 });
const lostAcks = variant(baseline, "payments-lost-acks", [{ id: "lost-acks", kind: "partition", target: "", links: [{ from: "pay", to: "gw1" }], ...window(1500, 1580) }]);

export const paymentSystem: CaseStudy = {
  id: "payment-system",
  title: "Payment system (Stripe-like ledger)",
  summary: "Move money without ever charging a customer twice or losing a cent when networks time out. Every mutation carries an end-to-end Idempotency-Key, records immutable double-entry ledger postings (sum of debits = sum of credits) in an ACID transaction with an outbox, and reconciles daily against external card networks.",
  requirements: {
    functional: [
      "Authorize, capture, and refund payments via external Payment Service Providers (PSPs / card networks) and settle balances to merchants.",
      "Record every balance movement in an immutable double-entry ledger where every transaction's debits equal its credits.",
      "End-to-end idempotency: retrying a timed-out charge with the same Idempotency-Key returns the original result without double-charging.",
      "Daily automated reconciliation between internal ledger entries and external PSP settlement files.",
    ],
    nonFunctional: [
      "Zero double charges (`duplicateEffect`) and zero lost acknowledged transactions (`ackedWriteLost`).",
      "Strict monetary precision: integer minor units (cents) plus currency code — never IEEE-754 floats.",
      "Auditability: ledger entries are append-only; corrections are compensating reversal entries, never `UPDATE` or `DELETE`.",
    ],
  },
  estimates: [
    { label: "Transaction volume", formula: "500M payments/day ÷ 86,400", result: "≈ 5,800 charges/s average, ≈ 20,000/s peak (Black Friday / flash sales)" },
    { label: "Ledger rows", formula: "500M payments/day × ~4 ledger postings (buyer, merchant, fee, settlement) × 200 B", result: "≈ 400 GB/day ≈ 150 TB/year of immutable audit rows" },
    { label: "Idempotency key store", formula: "500M keys/day × 128 B × 24–48 h active TTL", result: "≈ 64–128 GB — fits in memory + durable transactional table" },
    { label: "External PSP call latency", formula: "card network rails take 200–1,000 ms p99", result: "never hold a database row lock across an external PSP network call" },
  ],
  api: [
    { signature: "POST /v1/payments", request: "Header: Idempotency-Key (UUID) · Body: { amountCents, currency, source, merchantId }", response: "200 { paymentId, status, ledgerTxId } (replayed on duplicate key)", endpointId: "charge" },
    { signature: "POST /v1/payments/{id}/refunds", request: "Header: Idempotency-Key · Body: { amountCents, reason }", response: "200 { refundId, compensatingEntries[] }" },
    { signature: "GET /v1/payments/{id}", request: "—", response: "200 { paymentId, status, amountCents, entries[] }", endpointId: "status" },
  ],
  dataModel: {
    entities: [payments],
    notes: [
      "payments: state machine (`CREATED → AUTH_IN_PROGRESS → AUTHORIZED → CAPTURED → SETTLED` or `FAILED`).",
      "ledger_entries: immutable `(entryId, txId, accountId, direction: DEBIT|CREDIT, amountCents, currency, createdAt)`. Account balance is the sum of entries (materialised into a versioned checkpoint for fast reads).",
      "idempotency_keys: `(merchantId, idempotencyKey) → { requestHash, status, responsePayload }`, committed atomically with the payment state transition.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "No idempotency store: retry timeouts blindly",
      tradeoffs: "When the payment orchestrator commits the charge and the response packet is dropped, the gateway times out and retries. Without atomic `Idempotency-Key` deduplication, the customer's card and ledger are debited twice (`duplicateEffect`). Run the `lost-acks` scenario to see the violation.",
      design: alter(design, "payment-no-dedup", "Payment system without idempotency store", (d) => {
        find<"service">(d, "pay").handlers!.charge = [
          data("ledgerdb", "payments", { kind: "update", field: "entries", op: "append", value: "dr/cr" }, 40),
          publish("outbox", true),
          respond(200),
        ];
      }),
      check: { scenario: "lost-acks", violations: ["duplicateEffect"] },
    },
    {
      title: "Mutable `balance` column instead of an append-only double-entry ledger",
      tradeoffs: "Doing `UPDATE accounts SET balance = balance - 1000` overwrites history. When a bug, partial retry, or settlement mismatch occurs, there is no audit trail proving where money came from or went, and no self-checking invariant (`SUM(debits) == SUM(credits)`).",
    },
    {
      title: "Distributed 2PC across internal DB and external PSP",
      tradeoffs: "External card networks do not speak XA two-phase commit, and holding database locks across a 500 ms HTTP call to Visa/Mastercard exhausts connection pools. Instead, persist a `PENDING` payment + idempotency key locally, call the PSP outside the DB transaction forwarding the idempotency key, and record the outcome via a state-machine transition / saga.",
    },
  ],
  failureScenarios: [
    {
      id: "lost-acks",
      title: "Acknowledgements from the payment service are lost",
      explanation: "From t = 1.5 s to 1.58 s every response from the payment orchestrator to gateway 1 is dropped after the ledger write has already committed. Gateway 1 times out after 50 ms and retries with the same `Idempotency-Key`.",
      scenario: lostAcks,
      expect: "The idempotency store intercepts every retry and replays the committed response without appending a second debit/credit pair. Zero duplicate charges (`clean: true`). Compare the no-dedup alternative.",
      check: { minGoodput: 0.97, clean: true },
    },
    {
      id: "settler-crash",
      title: "Settlement / outbox workers crash",
      explanation: "The PSP capture & settlement workers crash from t = 1.3 s to 1.9 s.",
      scenario: variant(baseline, "payments-settler-crash", [{ id: "settler-down", kind: "kill", target: "settler", ...window(1300, 1900) }]),
      expect: "Because payment intents and ledger entries are durably committed with an outbox queue, synchronous charge acceptance stays at > 99% goodput while settlement catches up once workers restart.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "ledger-failover",
      title: "Ledger database leader fails over",
      explanation: "The primary ledger database node crashes at t = 1.5 s and promotes a semi-sync replica by t = 2.0 s.",
      scenario: variant(baseline, "payments-ledger-failover", [{ id: "db-down", kind: "kill", target: "ledgerdb", ...window(1500, 2000) }]),
      expect: "Charges pause during the ~500 ms leader election and fail closed rather than risking split-brain or unrecorded writes. Semi-sync replication and fencing ensure every acknowledged payment survives on the new primary.",
      check: { minGoodput: 0.6, clean: true },
    },
  ],
  deepDives: [
    {
      title: "End-to-end idempotency keys and state machines",
      body: "An idempotency key flows across three hops: `Client → Payment API → External PSP`. On arrival, the orchestrator atomically inserts `(merchantId, idempotencyKey, status = IN_PROGRESS)` before touching the PSP. If a concurrent retry arrives while the first call is still in flight, it sees `IN_PROGRESS` and either waits or returns `409 Conflict (retry shortly)`. If the first call completed, the stored response is returned verbatim. If the client accidentally reuses the same key with different parameters (`amountCents`), compare the stored request hash and reject with `422`.",
    },
    {
      title: "Double-entry bookkeeping and avoiding hot merchant accounts",
      body: "Every financial event writes at least two immutable rows in one ACID transaction: e.g. a \\$10.00 charge debits `buyer_clearing` by `1000` cents and credits `merchant_payable` by `970` cents and `platform_fee` by `30` cents. If every charge to a huge merchant (e.g. Amazon) locked a single merchant balance row to update a running total, that row would bottleneck at a few hundred TPS. Instead, append ledger entries without updating a single hot counter, or shard the merchant's sub-accounts across N buckets (`merchant_payable#0..N-1`) and sum them on read.",
    },
    {
      title: "Sagas, transactional outbox, and T+1 reconciliation",
      body: "Updating the ledger DB and publishing an event to a queue cannot be done with a naive dual write (if the process crashes in between, the ledger and downstream systems diverge). Commit the outbox message in the same local DB transaction as the ledger entries, and let a relay worker publish it at-least-once. Finally, every night a reconciliation job diffs the internal ledger against the PSP's settlement file (T+1), automatically flagging any orphan authorizations, missing captures, or fee discrepancies for finance review.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Charge a card.", "Charge, refund, and store status.", "Idempotency, double-entry ledger, integer cents, and daily reconciliation.", "Defines exact failure semantics across client retries, DB crashes, and PSP timeouts."] },
    { stage: "estimates", descriptors: ["None.", "TPS.", "Average/peak TPS, ledger storage growth, and idempotency key footprint.", "Identifies external PSP latency (~500 ms) vs internal DB lock duration (< 5 ms)."] },
    { stage: "api", descriptors: ["POST /pay.", "Includes amount and currency.", "Mandatory `Idempotency-Key` header, integer minor units, and status/refund endpoints.", "Specifies behaviour for concurrent in-flight duplicates and mismatched payload hashes."] },
    { stage: "data model", descriptors: ["Payments table.", "Payments + balances.", "Payment state machine + immutable double-entry postings + idempotency table.", "Transactional outbox and sharded sub-accounts for high-throughput merchants."] },
    { stage: "high level", descriptors: ["API calls Stripe.", "API + DB + PSP.", "Gateway, orchestrator, idempotency store, ledger DB, outbox queue, settlement workers.", "Separates synchronous DB state transitions from external PSP network calls."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions idempotency.", "Atomic idempotency locking, double-entry zero-sum invariant, and outbox pattern.", "Saga compensation (refund/void), hot-account sharding, and T+1 settlement reconciliation."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions monitoring.", "Duplicate charges, ledger imbalance, and PSP drift as top risks.", "Continuous `SUM(debits) == SUM(credits)` invariant checks and reconciliation alerts."] },
  ],
  clarifyingQuestions: [
    "Are we building the merchant-facing payment gateway/ledger, or card-issuing rails?",
    "Do we support multi-currency transactions and foreign-exchange conversion?",
    "How are payouts to merchants scheduled (instant vs T+2 rolling settlement)?",
    "What happens when an external PSP times out and neither confirms nor denies a charge?",
  ],
  commonMistakes: [
    "Storing money as `FLOAT` or `DOUBLE` instead of integer minor units (`amountCents`) + currency.",
    "Checking the idempotency key with a non-atomic `SELECT` before `INSERT` (check-then-act race).",
    "Holding a database transaction open while waiting on a 500 ms HTTP call to an external PSP.",
    "Mutating account balance columns in place without an immutable double-entry audit log.",
    "Having no reconciliation loop to detect drift between internal state and external bank/PSP settlement files.",
  ],
};
