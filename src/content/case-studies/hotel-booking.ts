import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, client, data, dedup, entity, find, link, loadBalancer, lognormal, node, pool, respond, scenario, service, variant, window } from "./kit";

// Inventory row per (hotel, roomType, date) with remaining room count; claiming a room decrements atomically.
const inventory = entity("inventory", "bookingdb", { roomDateKey: ["string", 20], hotelId: ["int", 8], roomTypeId: ["int", 4], available: ["int", 4], priceCents: ["int", 4] }, 10_000, {
  indexes: [{ name: "byHotel", fields: ["hotelId"], unique: false }],
  dataset: { count: 10_000, keys: { kind: "uniform", n: 10_000 }, initial: { available: 8 } },
});
const reservations = entity("reservations", "bookingdb", { reservationId: ["string", 16], roomDateKey: ["string", 20], guestId: ["int", 8], status: ["string", 12], expiresAt: ["timestamp", 8] }, 10_000);

const handlers = {
  // Search and availability pages are read-heavy and cached briefly; the final booking checks the authoritative row.
  search: cacheAside("availcache", [data("bookingdb", "inventory", { kind: "query", index: "byHotel", limit: 20 }, 60)]),
  // Idempotency key prevents double-booking on retry; atomic decrementIfPositive prevents overselling the last rooms.
  book: [
    dedup("dedup"),
    {
      type: "branch" as const,
      cond: { kind: "dedupHit" as const },
      then: [respond(200)],
      else: [
        data("bookingdb", "inventory", { kind: "decrementIfPositive", field: "available" }, 80),
        data("bookingdb", "reservations", { kind: "put" }, 80),
        respond(201),
      ],
    },
  ],
};

const design = {
  schemaVersion: 1 as const,
  id: "hotel-booking",
  name: "Hotel reservation system",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "Booking API 1", [2, 0], handlers, 128),
    service("api2", "Booking API 2", [2, 2], handlers, 128),
    cache("availcache", "Availability cache", [3, 0], 12_000_000, 15_000),
    node("dedup", "dedupStore", "Idempotency store", [3, 1], { ...pool(256, 0.2), serviceTime: lognormal(0.3), ttlUs: 86_400_000_000, atomic: true, durable: true }),
    node("bookingdb", "database", "Inventory & reservations DB", [3, 2], {
      ...pool(32, 0.8, 800),
      readTime: lognormal(2),
      writeTime: lognormal(3.5),
      replicas: 3,
      replication: "semiSync",
      replicationLag: lognormal(1),
      walDurable: true,
      failover: { heartbeatUs: 100_000, missedHeartbeats: 3, electionUs: 200_000, fencing: true },
    }),
  ],
  edges: [
    link("client", "lb"),
    link("lb", "api1"),
    link("lb", "api2"),
    ...["api1", "api2"].flatMap((a) => [link(a, "availcache"), link(a, "dedup"), link(a, "bookingdb")]),
  ],
  endpoints: [
    { id: "search", name: "GET /v1/hotels/:id/availability", op: "read" as const, keyTemplate: "hotel:{id}", requestBytes: 180, responseBytes: 2400, idempotent: true },
    { id: "book", name: "POST /v1/reservations", op: "write" as const, keyTemplate: "room:{id}", requestBytes: 450, responseBytes: 250, idempotent: false },
  ],
  entities: [inventory, reservations],
};

const baseline = scenario("hotel-day", { arrival: { kind: "poisson", rps: 2500 }, mix: { search: 0.96, book: 0.04 }, keys: { kind: "zipf", n: 10_000, s: 0.85 }, deadlineMs: 500 });
const hotHotel = variant(baseline, "hotel-hot-surge", [], { keys: { kind: "hotspot", n: 10_000, hotFraction: 0.25 } });

export const hotelBooking: CaseStudy = {
  id: "hotel-booking",
  title: "Hotel booking (Booking.com / Airbnb)",
  summary: "Browse availability across millions of rooms and book a stay for a date range. Browsing is 95%+ of traffic and tolerates a few seconds of staleness; booking is a small transactional core where two guests must never claim the same last room and a retried checkout must never book twice.",
  requirements: {
    functional: [
      "Search hotel room types and view nightly availability and rates for a check-in / check-out range.",
      "Place a reservation hold on a room type for every night in the stay, complete payment, and confirm or release the hold.",
      "View or cancel an existing reservation (returning inventory to the pool).",
    ],
    nonFunctional: [
      "Zero overselling beyond configured overbooking margin: concurrent checkouts for the last room must grant at most one reservation.",
      "Exactly-once booking semantics on client retries via an idempotency key.",
      "Availability search p99 under ~150 ms; booking checkout p99 under ~500 ms.",
      "Browse path stays highly available even if the transactional booking store is failing over.",
    ],
  },
  estimates: [
    { label: "Inventory rows", formula: "5M hotels × 5 room types × 365 bookable days", result: "≈ 9.1B rows × ~64 B ≈ 580 GB — fits comfortably in a sharded relational store" },
    { label: "Bookings", formula: "4M bookings/day ÷ 86,400", result: "≈ 46 bookings/s average, ≈ 250/s peak — small enough for ACID transactions" },
    { label: "Searches & page views", formula: "100:1 browse-to-book ratio × 250/s peak", result: "≈ 25k availability reads/s at peak, absorbed by a short-TTL cache" },
    { label: "Lock contention", formula: "popular convention hotel: 50 users clicking 'Book' in the same second", result: "serialised on one (hotelId, roomTypeId, date) row for ~3 ms each — atomic conditional update rejects extras immediately" },
    { label: "Hold expiry", formula: "250 holds/s × 600 s (10-minute checkout window)", result: "≈ 150k active holds at peak — tiny state for a background reaper" },
  ],
  api: [
    { signature: "GET /v1/hotels/{id}/availability?checkIn&checkOut", request: "ISO dates, guests", response: "200 { roomTypes[{ roomTypeId, available, priceCents }] }", notes: "Served from a short-TTL cache; slightly stale counts are fine until checkout.", endpointId: "search" },
    { signature: "POST /v1/reservations", request: "{ hotelId, roomTypeId, checkIn, checkOut, guest } + Idempotency-Key", response: "201 { reservationId, status: 'CONFIRMED' } · 409 sold out", endpointId: "book" },
    { signature: "DELETE /v1/reservations/{id}", request: "—", response: "200 { status: 'CANCELLED' }", notes: "Atomically transitions status and increments inventory for each night." },
  ],
  dataModel: {
    entities: [inventory, reservations],
    notes: [
      "inventory stores one row per (hotelId, roomTypeId, date) rather than interval ranges: a 3-night stay updates 3 rows in primary-key order (to avoid deadlocks) with `available = available - 1 WHERE available > 0`.",
      "reservations is keyed by client-supplied or server-generated reservationId and tracks the state machine (PENDING → CONFIRMED → CANCELLED / EXPIRED).",
      "Sharding by hotelId keeps all nights and room types for a booking inside a single shard transaction.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Read-then-write room inventory without atomic bounds check",
      tradeoffs: "Reading `available`, checking `> 0` in application code, and then decrementing works under light traffic, but when a conference hotel goes on sale, concurrent checkouts all read `available = 1` and all decrement it below zero. Run the hot-hotel scenario against this alternative to see `oversell` violations.",
      design: alter(design, "hotel-read-then-write", "Hotel booking with read-then-write inventory", (d) => {
        for (const id of ["api1", "api2"]) {
          find<"service">(d, id).handlers!.book = [
            data("bookingdb", "inventory", { kind: "get" }, 80),
            data("bookingdb", "inventory", { kind: "update", field: "available", op: "increment", value: -1 }, 80),
            data("bookingdb", "reservations", { kind: "put" }, 80),
            respond(201),
          ];
        }
      }),
      check: { scenario: "hot-hotel", violations: ["oversell"] },
    },
    {
      title: "Unindexed availability scan without cache",
      tradeoffs: "Always shows exact live room counts on the search page, but sends the 96% browse workload straight to the transactional database without a cache or hotel index. In the simulated cell, scanning the inventory table on every search saturates the database worker pool and pushes p99 latency above 25 ms (more than double the cached design).",
      design: alter(design, "hotel-no-cache", "Hotel booking without availability cache or index", (d) => {
        for (const id of ["api1", "api2"]) {
          find<"service">(d, id).handlers!.search = [data("bookingdb", "inventory", { kind: "query", limit: 20 }, 60), respond(200)];
        }
      }),
      check: { scenario: "baseline", minP99Ms: 25 },
    },
    {
      title: "Store bookings as date intervals with exclusion constraints instead of per-night rows",
      tradeoffs: "Necesary when individual physical rooms are assigned at booking time (Airbnb listings, specific seats), using PostgreSQL range types (`daterange`) or per-day bitmaps. For hotels selling interchangeable rooms of a category, per-night counter rows are much simpler and faster to update.",
    },
  ],
  failureScenarios: [
    {
      id: "hot-hotel",
      title: "Conference hotel flash sale: 25% of traffic targets one room type",
      explanation: "A major conference announces its venue and a quarter of all searches and bookings target the same hotel room key, which only has 2 rooms left.",
      scenario: hotHotel,
      expect: "The availability cache absorbs the search flood. On the booking path, the first 2 reservations decrement `available` to 0 and succeed; every subsequent checkout gets 409 Sold Out from `decrementIfPositive`. Zero overselling occurs (compare the read-then-write alternative).",
      check: { maxGoodput: 0.995, clean: true },
    },
    {
      id: "cache-flush",
      title: "The availability cache restarts empty",
      explanation: "At t = 1.5 s the availability cache restarts, dropping all cached hotel availability pages.",
      scenario: variant(baseline, "hotel-cache-flush", [{ id: "flush", kind: "kill", target: "availcache", ...window(1500, 1550) }]),
      expect: "Popular hotels refill within tens of milliseconds thanks to request coalescing on the cache and spare database capacity. Bookings are unaffected.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "db-failover",
      title: "The booking database leader crashes mid-day",
      explanation: "The primary booking database crashes at t = 1.5 s; missed heartbeats and promotion take ~0.5 s.",
      scenario: variant(baseline, "hotel-db-failover", [{ id: "db-down", kind: "kill", target: "bookingdb", ...window(1500, 2100) }]),
      expect: "Cached availability pages continue serving 96% of users without interruption. Checkouts and uncached searches fail briefly during leader election, then resume on the promoted replica with fencing and semi-synchronous replication preserving every confirmed booking.",
      check: { minGoodput: 0.85, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Per-night inventory counters vs interval locking",
      body: "Hotels sell room categories ('Deluxe King'), not physical room numbers, at booking time; room numbers are assigned at check-in. That lets you model inventory as one row per `(hotelId, roomTypeId, date)` with an `available` integer. Booking a 3-night stay runs a single transaction updating the 3 rows in ascending date order (ordering prevents deadlocks when two guests book overlapping ranges) with `UPDATE inventory SET available = available - 1 WHERE hotel_id = ? AND room_type_id = ? AND date = ? AND available > 0`. If fewer than 3 rows match, the transaction rolls back and returns 409.",
    },
    {
      title: "Two-step holds and payment sagas",
      body: "Never hold a database transaction open while calling an external payment gateway. Instead, step 1 atomically decrements `available` and inserts a `reservations` row with `status = 'HOLD'` and `expiresAt = now + 10 min`. Step 2 charges the card outside the DB lock using `reservationId` as the payment idempotency key. Step 3 marks the reservation `CONFIRMED`. A background reaper scans expired `HOLD` rows every minute, marks them `EXPIRED` with `WHERE status = 'HOLD'`, and increments `available` back.",
    },
    {
      title: "Overbooking as a data problem, not a race condition",
      body: "Hotels intentionally overbook by 5–10% to account for no-shows. Model this explicitly by storing `totalCapacity`, `overbookingAllowance`, and `available = totalCapacity + overbookingAllowance - booked`, rather than relaxing transaction isolation. Correctness still requires atomic updates so the controlled cap is never exceeded by concurrent requests.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Search and book rooms.", "Mentions no double-booking.", "Separates read-heavy browse SLOs from strict transactional checkout and idempotency.", "Clarifies room-type vs specific-room inventory, hold expiry, and intentional overbooking."] },
    { stage: "estimates", descriptors: ["None.", "Booking QPS only.", "Computes ~9B inventory rows (~600 GB) and ~100:1 browse-to-book ratio.", "Shows booking QPS (~50–250/s) easily fits sharded SQL while browse needs caching."] },
    { stage: "api", descriptors: ["GET and POST endpoints.", "Includes dates and room type.", "Idempotency-Key on POST and 409 on sold-out conflict.", "Models hold creation, confirmation, and cancellation state transitions."] },
    { stage: "data model", descriptors: ["Rooms table.", "Bookings table with start/end dates.", "Per-(hotel, roomType, date) inventory counter rows + reservations table.", "Shards by hotelId and sorts multi-night updates by date to prevent deadlocks."] },
    { stage: "high level", descriptors: ["API + DB.", "Adds cache for search.", "Cache-aside for availability, dedup store, and replicated DB with atomic updates.", "Decouples payment gateway calls from DB locks using time-bounded reservation holds."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions locking.", "Compares pessimistic `SELECT FOR UPDATE`, atomic conditional decrement, and optimistic CAS.", "Explains hold reaper races, cache invalidation vs TTL, and deadlock prevention."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions monitoring.", "Identifies hot-hotel flash sales and abandoned holds as key risks.", "Defines metrics on hold conversion, 409 conflict rate, and inventory reconciliation audits."] },
  ],
  clarifyingQuestions: [
    "Do guests book a room category (Deluxe King) or a specific physical unit (like Airbnb)?",
    "What is the browse-to-book ratio, and can search results be a few seconds stale?",
    "Do we need a temporary hold window while the user enters payment details?",
    "Should the system support controlled overbooking margins per hotel?",
  ],
  commonMistakes: [
    "Reading `available` into application memory and writing `available - 1` without an atomic conditional check or row lock.",
    "Holding a database transaction open across a slow third-party payment gateway call.",
    "Using `SERIALIZABLE` isolation across the entire database instead of row-level conditional updates.",
    "Skipping the availability cache because 'inventory must be strongly consistent', overloading the DB with browse traffic.",
    "Retrying timed-out booking requests without an `Idempotency-Key`, booking and charging the guest twice.",
  ],
};
