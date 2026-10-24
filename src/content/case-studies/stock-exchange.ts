import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, client, data, dedup, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// Authoritative order book state and execution fills persisted from the deterministic sequencer log.
const orders = entity("orders", "bookstore", { symbolKey: ["string", 16], orderId: ["string", 16], priceTicks: ["int", 8], qty: ["int", 4], status: ["string", 12] }, 5000);
const trades = entity("trades", "bookstore", { tradeId: ["string", 16], symbolKey: ["string", 16], execPrice: ["int", 8], execQty: ["int", 4] }, 5000);

const gatewayHandlers = {
  // Order gateway checks client idempotency + pre-trade risk, then appends to the symbol-partitioned sequencer log in strict order.
  order: [
    dedup("dedup"),
    {
      type: "branch" as const,
      cond: { kind: "dedupHit" as const },
      then: [respond(200)],
      else: [publish("sequencer", true), respond(200)],
    },
  ],
  // Market data (L1/L2 book snapshot) is fanned out from the matching engine and served from low-latency memory cache.
  book: cacheAside("mdcache", [data("bookstore", "orders", { kind: "get" }, 20)]),
};

const matcherHandlers = {
  // Deterministic matching engine processes the partitioned sequencer stream in-memory and writes executions & book updates.
  order: [
    data("bookstore", "orders", { kind: "put" }, 30),
    data("bookstore", "trades", { kind: "put" }, 30),
    respond(200),
  ],
};

const design = {
  schemaVersion: 1 as const,
  id: "stock-exchange",
  name: "Electronic stock exchange",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1], "consistentHash"),
    service("gw1", "Order gateway 1 (risk & FIX)", [2, 0], gatewayHandlers, 128, 0.2),
    service("gw2", "Order gateway 2 (risk & FIX)", [2, 2], gatewayHandlers, 128, 0.2),
    node("dedup", "dedupStore", "ClientOrderID dedup", [3, 0], { ...pool(256, 0.25), serviceTime: lognormal(0.2), ttlUs: 86_400_000_000, atomic: true, durable: true }),
    node("sequencer", "queue", "Deterministic sequencer log (by symbol)", [3, 1], {
      partitions: 16,
      capacityMessages: 30_000,
      visibilityTimeoutUs: 500_000,
      maxDeliveries: 5,
      retentionUs: 86_400_000_000,
      publishTime: lognormal(0.3),
      costPerHour: 0.4,
      region: "us-east",
      zone: "a",
    }),
    node("matcher", "worker", "Matching engine (price-time priority)", [4, 1], { ...pool(16, 0.8), serviceTime: lognormal(0.4, 0.2), source: "sequencer", batchSize: 16 }, matcherHandlers),
    cache("mdcache", "L1/L2 market data cache", [3, 3], 10_000_000, 1000),
    node("bookstore", "kvStore", "Order & execution store", [5, 2], {
      ...pool(128, 1.5),
      readTime: lognormal(0.5),
      writeTime: lognormal(0.6),
      members: 6,
      vnodes: 64,
      replicationFactor: 3,
      readQuorum: 2,
      writeQuorum: 2,
      hintedHandoff: true,
      readRepair: true,
      tombstoneGcUs: 864_000_000_000,
    }),
  ],
  edges: [
    link("client", "lb"),
    link("lb", "gw1"),
    link("lb", "gw2"),
    ...["gw1", "gw2"].flatMap((a) => [link(a, "dedup"), link(a, "sequencer"), link(a, "mdcache"), link(a, "bookstore")]),
    link("matcher", "bookstore"),
  ],
  endpoints: [
    { id: "order", name: "POST /v1/orders { symbol, side, price, qty, clOrdId }", op: "write" as const, keyTemplate: "sym:{id}", requestBytes: 160, responseBytes: 120, idempotent: false },
    { id: "book", name: "GET /v1/marketdata/:symbol/book", op: "read" as const, keyTemplate: "md:{id}", requestBytes: 100, responseBytes: 1200, idempotent: true },
  ],
  entities: [orders, trades],
};

const baseline = scenario("exchange-day", {
  arrival: { kind: "poisson", rps: 3000 },
  mix: { order: 0.65, book: 0.35 },
  keys: { kind: "zipf", n: 5000, s: 1.0 },
  deadlineMs: 200,
});
const hotSymbol = variant(baseline, "exchange-hot-symbol", [], { keys: { kind: "hotspot", n: 100, hotFraction: 0.8 } });

export const stockExchange: CaseStudy = {
  id: "stock-exchange",
  title: "Stock exchange (order matching engine)",
  summary: "Accept limit and market orders, enforce pre-trade risk limits, and match buys against sells by strict price-time priority. Traditional database locks are orders of magnitude too slow and non-deterministic; a real exchange sequences commands into a total order per symbol and runs a single-threaded, in-memory deterministic state machine.",
  requirements: {
    functional: [
      "Place new limit and market orders (`BUY` / `SELL`, `symbol`, `priceTicks`, `quantity`, `clientOrderId`) and cancel open orders.",
      "Match orders strictly by price-time priority (best price first; ties broken FIFO by sequencer timestamp/sequence).",
      "Publish execution reports to the trading parties and stream L1/L2 market data (top-of-book and depth) to subscribers.",
    ],
    nonFunctional: [
      "Deterministic total ordering per symbol: replaying the input command log must produce the exact same trades and order book state.",
      "Sub-millisecond to single-digit-millisecond matching latency; hundreds of thousands of orders/s across symbols.",
      "Zero lost or reordered executions, and zero duplicate orders when a gateway retries.",
    ],
  },
  estimates: [
    { label: "Order rate", formula: "5B orders & cancels per 6.5-hour trading day ÷ 23,400 s", result: "≈ 210k messages/s average, ≈ 1M/s at market open/close" },
    { label: "Order book memory", formula: "10M resting orders across 8,000 symbols × ~64 B per order node", result: "≈ 640 MB total — every symbol's entire order book fits in L3 cache / RAM!" },
    { label: "Single-thread matching speed", formula: "in-memory price map + doubly-linked FIFO queue (~200–500 ns per match)", result: "one pinned CPU core matches ~1M–2M orders/s for a symbol partition" },
    { label: "Sequencer log size", formula: "5B messages/day × 64 B binary frame", result: "≈ 320 GB/day — easily replicated in memory (Raft/Aeron) and archived to disk" },
    { label: "Market data fan-out", formula: "500k book updates/s × 100 B to multicast/gateway subscribers", result: "≈ 50 MB/s per feed before subscriber fan-out" },
  ],
  api: [
    { signature: "NewOrderSingle (FIX / binary) / POST /v1/orders", request: "{ clOrdId, symbol, side, ordType, priceTicks, qty }", response: "ExecutionReport { ordId, seqNum, status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED', fills[] }", endpointId: "order" },
    { signature: "OrderCancelRequest / DELETE /v1/orders/{ordId}", request: "{ clOrdId, origClOrdId, symbol }", response: "ExecutionReport { status: 'CANCELED' }", notes: "O(1) removal via `orderId → node*` hash map into the price level's doubly-linked list." },
    { signature: "GET /v1/marketdata/{symbol}/book", request: "depth = 10 | 50", response: "200 { seqNum, bids[{ price, qty }], asks[{ price, qty }] }", endpointId: "book" },
  ],
  dataModel: {
    entities: [orders, trades],
    notes: [
      "The authoritative order book for each symbol partition lives in RAM inside its single-threaded matching engine: a hash map `orderId → OrderNode*` (for O(1) cancel) plus two price trees/arrays (`bids` descending, `asks` ascending) of doubly-linked FIFO `OrderNode` queues.",
      "The sequencer log is the source of truth: every order/cancel gets a monotonic sequence number before touching the matching engine. Hot standby matching replicas consume the exact same log to stay in lockstep.",
      "orders and trades in `bookstore` are written asynchronously down the outbound execution pipeline for client drop-copy, clearing, and historical queries.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Multi-threaded concurrent workers with variable latency and short visibility timeouts",
      tradeoffs: "If multiple concurrent workers pull from a symbol's queue with variable execution times (e.g., lock contention or GC pauses) and a short visibility timeout (1 ms), a slow order's lease expires or is overtaken by a fast order on the same symbol. A later sequence number commits before an earlier one becomes visible and completes, violating price-time priority (`orderingViolated`). Run the hot-symbol scenario against this alternative to see `orderingViolated`.",
      design: alter(design, "exchange-unordered-workers", "Exchange with concurrent variable-latency workers", (d) => {
        find<"queue">(d, "sequencer").params.visibilityTimeoutUs = 1000;
        const matcher = find<"worker">(d, "matcher");
        matcher.params.concurrency = 8;
        matcher.params.batchSize = 1;
        matcher.params.serviceTime = {
          kind: "empirical",
          buckets: [
            { us: 100, weight: 1 },
            { us: 4000, weight: 1 },
          ],
        };
      }),
      check: { scenario: "hot-symbol", violations: ["orderingViolated"] },
    },
    {
      title: "Match orders by scanning the store synchronously without a sequencer",
      tradeoffs: "Storing resting orders in a database and matching with `SELECT ... WHERE side='SELL' AND price <= :buyPrice ORDER BY price ASC, created_at ASC FOR UPDATE` serialises every order on disk/store scans (~2–10 ms per order, or ~200 orders/s per symbol). In the simulator, scanning the store synchronously on the order path more than doubles p99 latency compared to the sequenced in-memory matcher.",
      design: alter(design, "exchange-sql-matching", "Matching via synchronous store scans", (d) => {
        for (const id of ["gw1", "gw2"]) {
          find<"service">(d, id).handlers!.order = [
            data("bookstore", "orders", { kind: "query", limit: 50 }, 80),
            data("bookstore", "orders", { kind: "put" }, 80),
            respond(200),
          ];
        }
      }),
      check: { scenario: "baseline", minP99Ms: 8 },
    },
    {
      title: "Active-passive vs deterministic active-active (replicated state machine)",
      tradeoffs: "Shipping order book mutations to a standby replica after matching adds latency to the critical path. Instead, replicate the compact *input command log* at the sequencer (via Raft or Aeron UDP multicast) and run two or more identical deterministic matching engines in parallel; if the primary engine dies, the secondary already has the exact same in-memory book at the exact same sequence number.",
    },
  ],
  failureScenarios: [
    {
      id: "hot-symbol",
      title: "Earnings release: 80% of all orders hit one ticker symbol",
      explanation: "A major tech stock reports earnings and 80% of order and book traffic targets a single symbol partition.",
      scenario: hotSymbol,
      expect: "The reference design routes all orders for the symbol through its ordered sequencer partition and deterministic matching engine with a 500 ms visibility lease, preserving strict sequence order (`clean: true`) with zero `orderingViolated` anomalies.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "market-open-burst",
      title: "9:30 AM market open: order and quote rate doubles",
      explanation: "From t = 1.2 s to 2.2 s traffic doubles as opening cross and algorithmic orders flood the gateways.",
      scenario: variant(baseline, "exchange-market-open", [{ id: "open-bell", kind: "trafficSpike", target: "", multiplier: 2, ...window(1200, 2200) }]),
      expect: "Pre-trade risk checks at the gateway and the in-memory sequencer/matcher absorb the burst well inside the 200 ms deadline.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "md-cache-flush",
      title: "Market data cache restarts",
      explanation: "At t = 1.5 s the L1/L2 market data cache restarts.",
      scenario: variant(baseline, "exchange-md-flush", [{ id: "md-down", kind: "kill", target: "mdcache", ...window(1500, 1550) }]),
      expect: "Order entry and matching continue without interruption; book snapshot reads repopulate the cache from the execution/book store in milliseconds.",
      check: { minGoodput: 0.99, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Order book data structure for O(1) cancel and match",
      body: "Cancels and modifications are 80–90% of exchange messages, so cancelling an order cannot scan a price level linearly. Represent each side of a symbol's book with: (1) a price index mapping `integerPriceTicks → PriceLevel*` (either a balanced tree, or a flat array indexed by tick offset around the current midpoint for O(1) lookup), (2) a doubly-linked list of `OrderNode`s inside each `PriceLevel` in FIFO arrival order, and (3) a hash map `orderId → OrderNode*`. Matching inspects only the head of the best opposite `PriceLevel`; cancelling looks up `OrderNode*` by `orderId` and unlinks its `prev`/`next` pointers in O(1) time.",
    },
    {
      title: "The LMAX Disruptor / deterministic state-machine pattern",
      body: "Why is a single thread faster than 32 threads for matching one symbol? Multi-threaded access to the top of the order book causes CPU cache-line bouncing, lock contention, and context switches (~1–5 µs), whereas a single thread pinned to a CPU core with no locks, no heap allocations (pre-allocated ring buffer of order structs), and no I/O executes a match in ~200–500 ns (>1M orders/s). Scale horizontally by partitioning symbols across independent single-threaded matching engines.",
    },
    {
      title: "Sequencer replication and pre-trade risk at the gateway",
      body: "Gateways terminate client sessions (FIX or binary SBE/OUCH), deduplicate `clientOrderId`, and check pre-trade risk limits (fat-finger max order size, price collar, buying power) using cached position state. Validated commands are sent to the sequencer, which assigns a gapless sequence number and replicates the command to a quorum of log nodes before the matching engines consume it. Because matching is a pure function of the sequenced command log (no `now()` calls, no random numbers, integer tick arithmetic only), any replica engine produces byte-for-byte identical fills.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Buy and sell stocks.", "Limit/market orders and cancels.", "Price-time priority (FIFO), deterministic ordering, and low-latency market data.", "Includes pre-trade risk checks, `clientOrderId` idempotency, and deterministic replay."] },
    { stage: "estimates", descriptors: ["None.", "Orders/s only.", "Calculates peak message rate (~200k–1M/s) and shows the entire resting book fits in <1 GB RAM.", "Contrasts ~300 ns in-memory single-thread matching with millisecond disk/DB locking."] },
    { stage: "api", descriptors: ["POST order.", "Order, cancel, and order book.", "Includes `clOrdId`, integer `priceTicks`, and sequenced `ExecutionReport` events.", "Distinguishes low-latency binary order entry (OUCH/SBE/FIX) from multicast market data feeds."] },
    { stage: "data model", descriptors: ["Orders table.", "Orders and trades tables.", "In-memory price levels + doubly-linked FIFO queues + `orderId → node*` map, backed by a sequenced command log.", "Uses integer price ticks (never floating point) and monotonic sequence numbers."] },
    { stage: "high level", descriptors: ["API + DB.", "Gateway + matching engine + DB.", "Gateways (dedup + risk) → partitioned sequencer log → single-threaded matching engines → execution & market data fan-out.", "Explains hot-standby state-machine replication fed by the same sequencer log."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions in-memory book.", "Explains O(1) cancel via hash map + doubly-linked list and why single-threaded beats locks.", "Details how concurrent workers or out-of-order retries break price-time priority (`orderingViolated`)."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions latency.", "Identifies hot symbols, gateway reconnects, and runaway algorithms as key risks.", "Includes kill-switch / cancel-on-disconnect and regulatory audit trail replay."] },
  ],
  clarifyingQuestions: [
    "Which order types are in scope (limit, market, cancel, IOC/FOK)?",
    "What is the latency target at the matching engine (sub-millisecond vs tens of milliseconds) and peak message rate?",
    "How many symbols are traded, and can one hot symbol receive a large fraction of the volume?",
    "Are pre-trade risk checks (buying power, fat-finger limits) part of the gateway path?",
  ],
  commonMistakes: [
    "Matching orders with SQL transactions and `SELECT ... FOR UPDATE` row locks.",
    "Using multi-threaded workers on the same symbol's order book, causing lock contention and out-of-order execution.",
    "Representing prices as IEEE 754 floating-point numbers instead of integer ticks (`priceTicks`), causing rounding bugs.",
    "Using a heap or array for price levels where cancelling an arbitrary `orderId` requires an O(N) scan.",
    "Calling `System.currentTimeMillis()` inside the matching engine instead of using the sequencer's timestamp, breaking deterministic replay.",
  ],
};
