import type { CaseStudy } from "./types";
import { alter, cache, cacheAside, cacheDelete, client, data, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// Authoritative seat inventory per event/section; `remaining = 1` means the seat can be held once.
const seats = entity("seats", "bookingdb", { seatId: ["int", 8], eventId: ["int", 8], remaining: ["int", 4], holdToken: ["string", 24] }, 10_000, {
  indexes: [{ name: "byEvent", fields: ["eventId"], unique: false }],
  dataset: { count: 10_000, keys: { kind: "uniform", n: 10_000 }, initial: { remaining: 1 } },
});

const handlers = {
  // Browse seat map: served from edge/memory cache; invalidated on seat state changes.
  seatmap: cacheAside("seatcache", [data("bookingdb", "seats", { kind: "query", index: "byEvent", limit: 40 }, 60)]),
  // Hold a seat with a 5-minute TTL: MUST use atomic conditional decrement (`decrementIfPositive`) so two fans never get the same seat.
  reserve: [
    data("bookingdb", "seats", { kind: "decrementIfPositive", field: "remaining" }, 50),
    cacheDelete("seatcache"),
    publish("holdexpirer", true),
    respond(200),
  ],
  // Release an expired or cancelled hold so the seat returns to inventory.
  release: [
    data("bookingdb", "seats", { kind: "update", field: "remaining", op: "set", value: 1 }, 50),
    cacheDelete("seatcache"),
    respond(200),
  ],
};

const expirerHandlers = {
  reserve: [data("bookingdb", "seats", { kind: "get" }, 50), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "ticket-booking",
  name: "Ticket booking (Ticketmaster)",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "Booking API 1", [2, 0], handlers, 128, 0.5),
    service("api2", "Booking API 2", [2, 2], handlers, 128, 0.5),
    cache("seatcache", "Seat-map cache", [3, 0], 15_000_000, 5_000),
    node("bookingdb", "database", "Seat inventory DB", [3, 1], { ...pool(64, 1.0, 1000), readTime: lognormal(1.2), writeTime: lognormal(2.2), replicas: 3, replication: "semiSync", replicationLag: lognormal(1), walDurable: true, failover: { heartbeatUs: 100_000, missedHeartbeats: 3, electionUs: 200_000, fencing: true } }),
    node("holdexpirer", "queue", "Hold TTL expiry queue", [3, 2], { partitions: 64, capacityMessages: 25_000, visibilityTimeoutUs: 400_000, maxDeliveries: 5, retentionUs: 86_400_000_000, publishTime: lognormal(0.8), costPerHour: 0.15, region: "us-east", zone: "a" }),
    node("reaper", "worker", "Hold expiry workers", [4, 2], { ...pool(32, 0.4), serviceTime: lognormal(2), source: "holdexpirer", batchSize: 32 }, expirerHandlers),
  ],
  edges: [
    link("client", "lb"), link("lb", "api1"), link("lb", "api2"),
    ...["api1", "api2"].flatMap((a) => [link(a, "seatcache"), link(a, "bookingdb"), link(a, "holdexpirer")]),
    link("reaper", "bookingdb"),
  ],
  endpoints: [
    { id: "seatmap", name: "GET /v1/events/:id/seats", op: "read" as const, keyTemplate: "seat:{seatId}", requestBytes: 150, responseBytes: 3000, idempotent: true },
    { id: "reserve", name: "POST /v1/seats/:seatId/hold", op: "write" as const, keyTemplate: "seat:{seatId}", requestBytes: 250, responseBytes: 200, idempotent: false },
    { id: "release", name: "POST /v1/seats/:seatId/release", op: "write" as const, keyTemplate: "seat:{seatId}", requestBytes: 180, responseBytes: 100, idempotent: true },
  ],
  entities: [seats],
};

const baseline = scenario("tickets-day", { arrival: { kind: "poisson", rps: 2500 }, mix: { seatmap: 0.88, reserve: 0.06, release: 0.06 }, keys: { kind: "uniform", n: 10_000 }, deadlineMs: 400 });
const hotEvent = variant(baseline, "tickets-hot-event", [], { keys: { kind: "hotspot", n: 10_000, hotFraction: 0.25 } });

export const ticketBooking: CaseStudy = {
  id: "ticket-booking",
  title: "Ticket booking (Ticketmaster)",
  summary: "Sell 50,000 concert seats to 2 million fans waiting at 10:00:00 AM without ever selling the same seat twice. The design pairs a virtual waiting room at the edge with two-phase seat reservation (an atomic bounded-TTL hold followed by payment capture) and conditional atomic updates (`decrementIfPositive` / CAS) on seat rows.",
  requirements: {
    functional: [
      "View an event's available seats by section and price tier.",
      "Two-phase booking: place a temporary hold (e.g. 5–10 minutes) on specific seats while the user enters payment details, then confirm the ticket or automatically release the hold on expiry.",
      "Fair admission during massive on-sale drops via a virtual waiting room.",
    ],
    nonFunctional: [
      "Hard correctness invariant: never sell or hold the same seat for two users (`oversell` must be zero).",
      "Seat-map browsing must stay fast (< 100 ms) even at 100:1 read-to-write ratio; stale availability by a couple of seconds on the map is acceptable because the hold step is authoritative.",
      "Survive 100× flash-crowd traffic at the exact second tickets go on sale without cascading failure.",
    ],
  },
  estimates: [
    { label: "Flash-crowd arrival", formula: "2M fans in waiting room admitted at controlled rate of ~10k checkout sessions/s", result: "virtual waiting room shapes an unbounded spike into the exact TPS the booking DB can sustain" },
    { label: "Seat-map reads", formula: "500k active browsers refreshing/selecting sections ÷ 5 s", result: "≈ 100k reads/s — absorbed by a short-TTL (2–5 s) seat-map cache + push diffs" },
    { label: "Hold / reserve writes", formula: "50,000 seats × ~3 hold attempts per seat (contention + expiries) over 5 minutes", result: "≈ 500–2,000 atomic seat updates/s per hot event" },
    { label: "Inventory dataset", formula: "50,000 seats × ~128 B per seat row", result: "≈ 6.4 MB per stadium event — an entire stadium's inventory fits inside CPU L3 cache!" },
  ],
  api: [
    { signature: "GET /v1/events/{eventId}/seats", request: "section filter", response: "200 { seats: [{ seatId, status, priceCents }] } (cached 2–5 s)", endpointId: "seatmap" },
    { signature: "POST /v1/seats/{seatId}/hold", request: "{ userId, idempotencyKey }", response: "200 { holdId, holdToken, expiresAt } · 409 seat already held/sold", endpointId: "reserve" },
    { signature: "POST /v1/holds/{holdId}/confirm", request: "{ holdToken, paymentToken }", response: "200 { ticketId } · 410 hold expired (fencing check on holdToken)" },
    { signature: "POST /v1/seats/{seatId}/release", request: "{ holdToken }", response: "200", notes: "Called on user cancel or by the hold-expiry reaper.", endpointId: "release" },
  ],
  dataModel: {
    entities: [seats],
    notes: [
      "seats: `(seatId, eventId, status: AVAILABLE|HELD|SOLD, remaining: 1|0, holdToken, holdExpiresAt)`. Partitioned by `eventId` (or `(eventId, sectionId)` for stadium-scale events).",
      "Atomic hold transition: `UPDATE seats SET status='HELD', remaining=0, holdToken=:tok, holdExpiresAt=:exp WHERE seatId=:id AND (status='AVAILABLE' OR (status='HELD' AND holdExpiresAt < NOW()))`.",
      "holdToken acts as a fencing token: if a user's 5-minute hold expires and Seat A is re-held by User 2 (`holdToken = 2`), User 1's late payment callback carrying `holdToken = 1` is rejected and refunded.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Read seat availability, then write (`SELECT` then `UPDATE`)",
      tradeoffs: "If the API reads `remaining == 1` in one query and then sends `UPDATE seats SET remaining = remaining - 1`, two concurrent requests for the same front-row seat both read `1` and both succeed — double-selling the seat (`oversell`). Run the `hot-event` scenario against this alternative to see the violation.",
      design: alter(design, "ticket-booking-unsafe", "Ticket booking with read-then-write holds", (d) => {
        for (const id of ["api1", "api2"]) {
          find<"service">(d, id).handlers!.reserve = [
            data("bookingdb", "seats", { kind: "get" }, 50),
            data("bookingdb", "seats", { kind: "update", field: "remaining", op: "increment", value: -1 }, 50),
            cacheDelete("seatcache"),
            publish("holdexpirer", true),
            respond(200),
          ];
        }
      }),
      check: { scenario: "hot-event", violations: ["oversell"] },
    },
    {
      title: "Hold seats until payment completes without a TTL",
      tradeoffs: "Without a strict 5-minute lease/TTL on `HELD` seats, users who close their browser tab or scalper bots that open thousands of checkouts lock up the entire stadium inventory indefinitely without paying.",
    },
    {
      title: "Single-thread actor per event in memory (with WAL)",
      tradeoffs: "Because one stadium is only ~50,000 seats (~6 MB), a single-threaded in-memory state machine per event (backed by a replicated write-ahead log) can process 50,000 seat holds per second with zero lock contention. More custom operational tooling than SQL `UPDATE ... WHERE`, but eliminates row-lock queuing on ultra-hot events.",
    },
  ],
  failureScenarios: [
    {
      id: "hot-event",
      title: "Everyone clicks the same front-row seat on a Taylor Swift drop",
      explanation: "During an on-sale drop, 25% of all traffic targets the same hot seat ID.",
      scenario: hotEvent,
      expect: "The atomic `decrementIfPositive` grants the hold to exactly one request and returns `409 Conflict` to every concurrent contender. Goodput dips slightly because 409 rejections count as unsuccessful attempts, while the `oversell` invariant stays completely clean (`clean: true`). Compare the read-then-write alternative.",
      check: { maxGoodput: 0.997, clean: true },
    },
    {
      id: "map-refresh-storm",
      title: "Fans hammer F5 on the seat map (2× traffic spike)",
      explanation: "From t = 1.2 s to 2.2 s traffic doubles as waiting fans repeatedly refresh the seat map.",
      scenario: variant(baseline, "tickets-refresh-storm", [{ id: "storm", kind: "trafficSpike", target: "", multiplier: 2, ...window(1200, 2200) }]),
      expect: "The short-TTL seat-map cache with request coalescing absorbs the read storm so the booking database remains dedicated to atomic hold and release transactions.",
      check: { minGoodput: 0.98, clean: true },
    },
    {
      id: "bookingdb-failover",
      title: "Booking database primary crashes mid-sale",
      explanation: "The primary seat inventory database fails at t = 1.5 s and promotes a semi-sync replica by t = 2.0 s.",
      scenario: variant(baseline, "tickets-db-failover", [{ id: "db-kill", kind: "kill", target: "bookingdb", ...window(1500, 2000) }]),
      expect: "Cached seat maps keep rendering during the failover. Seat holds fail closed for ~500 ms until the new leader takes over with fencing; no confirmed hold is lost and no seat is double-sold.",
      check: { minGoodput: 0.72, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Two-phase reservation and the late-payment race (fencing tokens)",
      body: "Charging a credit card takes seconds; you cannot hold a database transaction open across it. Phase 1 atomically flips the seat from `AVAILABLE` to `HELD` with `holdExpiresAt = now + 5m` and increments a monotonic `holdToken`. Phase 2 charges the card and then commits `HELD → SOLD WHERE seatId = :id AND holdToken = :tok`. If User 1's payment finishes at 5m02s after the hold expired and Seat A was given to User 2 (`holdToken` incremented), the `WHERE holdToken = :tok` check fails and triggers an automatic refund for User 1 instead of double-selling the seat.",
    },
    {
      title: "Expiring holds reliably",
      body: "Two mechanisms work together so a seat is never stuck in `HELD`: (1) a delayed message in the `holdexpirer` queue (or timing wheel) fires at `t = +5m` to flip `HELD → AVAILABLE` and invalidate the seat-map cache, and (2) lazy expiry in the hold SQL predicate itself (`WHERE status = 'AVAILABLE' OR (status = 'HELD' AND holdExpiresAt < NOW())`), which lets a new buyer claim an expired seat immediately even if the background reaper is lagging.",
    },
    {
      title: "Virtual waiting room and bot protection",
      body: "When 2 million fans arrive for 50,000 seats, letting all 2 million hit the seat map and hold API causes 97.5% wasted work and lock thrashing. A virtual waiting room at the CDN/edge assigns each authenticated fan a queue position at on-sale time and issues signed, short-lived admission tokens at the exact rate checkout can drain (~5,000 users/min), turning a thundering herd into steady flow.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Book a ticket.", "Seat map + hold + pay.", "Two-phase hold with TTL, zero oversell invariant, and flash-crowd handling.", "Addresses late-payment races after hold expiry and fair queuing."] },
    { stage: "estimates", descriptors: ["None.", "QPS.", "Read vs write ratio, stadium dataset size in RAM, and on-sale spike factor.", "Proves one stadium's seats are only a few megabytes — contention, not data size, is the bottleneck."] },
    { stage: "api", descriptors: ["POST /book.", "Hold and confirm endpoints.", "Returns `409` on contention, `holdToken` + `expiresAt`, and idempotent confirm.", "Includes virtual waiting room admission token and explicit release."] },
    { stage: "data model", descriptors: ["Seats table.", "Seat status column.", "Seat state machine (`AVAILABLE/HELD/SOLD`) with `holdToken` and `holdExpiresAt`.", "Lazy expiry predicate + sharding by `(eventId, sectionId)`."] },
    { stage: "high level", descriptors: ["API + DB.", "Adds cache.", "Edge waiting room, coalesced seat-map cache, atomic DB holds, hold-expiry queue.", "Explains failover with fencing and why payment stays outside DB locks."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions row locks.", "Atomic CAS/`decrementIfPositive` vs read-then-write overselling.", "Fencing tokens (`holdToken`) for late payments, lazy+active expiry, and single-writer event actors."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions latency.", "Overselling, stuck holds, and bot floods as top risks.", "Zero-oversell audit checks, hold-expiry lag alerts, and waiting-room admission pacing."] },
  ],
  clarifyingQuestions: [
    "Do users pick exact individual seats on a map, or 'best available' in a section/tier?",
    "How long is a seat held during checkout before it expires?",
    "What is the peak concurrent user count for a major stadium on-sale drop?",
    "How should we handle adjacent multi-seat requests (e.g. 4 seats together)?",
  ],
  commonMistakes: [
    "Reading seat availability with `SELECT` and then writing `UPDATE` in a separate statement (`oversell`).",
    "Holding a database lock while waiting for the user to type credit card details or for the PSP to respond.",
    "Forgetting the race condition where a payment succeeds 1 second after the 5-minute hold expired (missing fencing token).",
    "Relying only on a background cron job to expire holds without lazy expiry on the `holdExpiresAt` timestamp.",
    "Not caching the seat map or omitting a virtual waiting room for 100× flash sales.",
  ],
};
