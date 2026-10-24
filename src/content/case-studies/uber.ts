import type { CaseStudy } from "./types";
import { alter, client, data, entity, find, link, loadBalancer, lognormal, node, pool, respond, scenario, service, variant, window } from "./kit";

// Latest location per driver, indexed by geo cell (H3 at Uber). Loss-tolerant: a newer ping arrives in 4 s.
const locations = entity("locations", "geo", { driverId: ["int", 8], cell: ["int", 8], lat: ["float", 8], lng: ["float", 8], updatedAt: ["timestamp", 8] }, 10_000, {
  indexes: [{ name: "byCell", fields: ["cell"], unique: false }],
});
locations.dataset.keys = { kind: "uniform", n: 10_000 };
// Dispatch state per driver: available = 1 means free. Claiming must be atomic.
const drivers = entity("drivers", "dispatchdb", { driverId: ["int", 8], available: ["int", 4], tripId: ["string", 16] }, 10_000, { dataset: { count: 10_000, keys: { kind: "uniform", n: 10_000 }, initial: { available: 1 } } });

const handlers = {
  location: [data("geo", "locations", { kind: "put" }, 30), respond(200)],
  // Find nearby candidates by cell, then claim the best one atomically; a 409 means another rider got them first.
  ride: [
    data("geo", "locations", { kind: "query", index: "byCell", limit: 30 }, 50),
    data("dispatchdb", "drivers", { kind: "decrementIfPositive", field: "available" }, 50),
    respond(200),
  ],
  complete: [data("dispatchdb", "drivers", { kind: "update", field: "available", op: "set", value: 1 }, 50), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "uber",
  name: "Ride matching",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "Dispatch API 1", [2, 0], handlers, 128),
    service("api2", "Dispatch API 2", [2, 2], handlers, 128),
    // Supply index: in-memory, sharded by cell, replicated twice; written on every ping.
    node("geo", "kvStore", "Location index (by cell)", [3, 0], { ...pool(128, 1.2), readTime: lognormal(0.8), writeTime: lognormal(0.5), members: 6, vnodes: 64, replicationFactor: 2, readQuorum: 1, writeQuorum: 1, hintedHandoff: true, readRepair: false, tombstoneGcUs: 60_000_000 }),
    node("dispatchdb", "database", "Dispatch state", [3, 2], { ...pool(32, 0.6, 600), readTime: lognormal(1.5), writeTime: lognormal(3), replicas: 3, replication: "semiSync", replicationLag: lognormal(1), walDurable: true, failover: { heartbeatUs: 100_000, missedHeartbeats: 3, electionUs: 200_000, fencing: true } }),
  ],
  edges: [link("client", "lb"), link("lb", "api1"), link("lb", "api2"), link("api1", "geo"), link("api2", "geo"), link("api1", "dispatchdb"), link("api2", "dispatchdb")],
  endpoints: [
    { id: "location", name: "POST /v1/drivers/:id/location", op: "write" as const, keyTemplate: "driver:{id}", requestBytes: 120, responseBytes: 50, idempotent: true },
    { id: "ride", name: "POST /v1/rides (claim candidate :id)", op: "write" as const, keyTemplate: "claim:{id}", requestBytes: 300, responseBytes: 400, idempotent: false },
    { id: "complete", name: "POST /v1/trips/:id/complete", op: "write" as const, keyTemplate: "trip:{id}", requestBytes: 200, responseBytes: 100, idempotent: true },
  ],
  entities: [locations, drivers],
};

const baseline = scenario("rides-day", { arrival: { kind: "poisson", rps: 3000 }, mix: { location: 0.9, ride: 0.05, complete: 0.05 }, keys: { kind: "uniform", n: 10_000 }, deadlineMs: 500 });
const surge = variant(baseline, "rides-downtown-surge", [], { keys: { kind: "hotspot", n: 10_000, hotFraction: 0.2 } });

export const uber: CaseStudy = {
  id: "uber",
  title: "Uber (ride matching)",
  summary: "Track a million moving drivers and match each ride request to a nearby free driver in about a second. The write path is a firehose of location pings; the correctness problem is never assigning one driver to two riders.",
  requirements: {
    functional: ["Drivers send their location every few seconds.", "A rider requests a ride; the system finds nearby available drivers, offers the trip, and assigns exactly one driver.", "Track trip state (requested, assigned, in progress, completed)."],
    nonFunctional: [
      "Matching decision within ~1 s of the request.",
      "Location updates are loss-tolerant: a newer one arrives seconds later.",
      "A driver is never assigned two concurrent trips.",
      "Survive the loss of a data centre: dispatch for a city must fail over.",
    ],
  },
  estimates: [
    { label: "Location writes", formula: "1M online drivers ÷ 4 s ping interval", result: "≈ 250k writes/s, each ~100 B" },
    { label: "Location memory", formula: "1M drivers × ~200 B (position, cell, state, timestamp) × 2 replicas", result: "≈ 400 MB — the supply index fits in memory" },
    { label: "Ride requests", formula: "20M trips/day ÷ 86,400 × ~3 peak factor", result: "≈ 700 requests/s at peak, each a geo query plus a claim" },
    { label: "Geo query size", formula: "drivers within ~2 km in a dense city", result: "tens to a few hundred candidates — query the rider's cell and its neighbours, not a radius over everything" },
    { label: "Ingress bandwidth", formula: "250k/s × ~300 B with headers", result: "≈ 75 MB/s — fine; the per-request overhead is what you optimise (batching, persistent connections)" },
  ],
  api: [
    { signature: "POST /v1/drivers/{id}/location", request: "{ lat, lng, heading, ts }", response: "200", notes: "Last-write-wins by timestamp; stale pings are dropped.", endpointId: "location" },
    { signature: "POST /v1/rides", request: "{ pickup, dropoff, product } + Idempotency-Key", response: "200 { tripId, driver } · 409 candidate taken (retry with next)", endpointId: "ride" },
    { signature: "POST /v1/trips/{id}/complete", request: "—", response: "200", notes: "Frees the driver.", endpointId: "complete" },
  ],
  dataModel: {
    entities: [locations, drivers],
    notes: [
      "locations: latest position per driver plus its geo cell (H3 hexagon at resolution ~8–9), held in memory and indexed by cell. Not a durable history — that goes to a log for analytics.",
      "drivers: authoritative dispatch state (available / on trip), changed only by atomic conditional updates.",
      "Trips are a separate durable entity with a state machine; payment and receipts hang off it.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Read the driver's state, then write it",
      tradeoffs: "The obvious code: read available, if 1 then set 0. Two dispatchers matching two riders to the same nearby driver both read 1 and both assign. Run the downtown surge against it and the engine reports the driver 'oversold'. Use an atomic conditional update (compare-and-set, or decrement-if-positive) instead.",
      design: alter(design, "uber-unsafe-claim", "Ride matching with read-then-write claims", (d) => {
        for (const id of ["api1", "api2"]) find<"service">(d, id).handlers!.ride = [
          data("geo", "locations", { kind: "query", index: "byCell", limit: 30 }, 50),
          data("dispatchdb", "drivers", { kind: "get" }, 50),
          data("dispatchdb", "drivers", { kind: "update", field: "available", op: "increment", value: -1 }, 50),
          respond(200),
        ];
      }),
      check: { scenario: "downtown-surge", violations: ["oversell"] },
    },
    {
      title: "Store locations in the relational database",
      tradeoffs: "Durable and queryable with a spatial index, but 250k updates/s of data that is obsolete in 4 seconds is the worst workload for a WAL-based, disk-backed store. Keep the hot supply index in memory and send pings to a log for history.",
    },
    {
      title: "Geohash or quadtree instead of H3",
      tradeoffs: "Geohash cells are rectangles whose neighbours have different shapes and whose size varies with latitude; a quadtree adapts to density but must be rebalanced as drivers move. Uber built H3 because hexagons have uniform neighbour distances, which makes 'cells within k rings' a good approximation of a radius.",
    },
  ],
  failureScenarios: [
    {
      id: "downtown-surge",
      title: "Everyone wants the same driver downtown",
      explanation: "After a concert, 20% of all traffic targets one driver ID — many riders' nearest candidate is the same car. Pings and claims for that driver race.",
      scenario: surge,
      expect: "Exactly one rider gets the driver; every other claim gets 409 and would retry with the next candidate. Goodput drops because a 409 counts as a failed request, but the invariant holds: no double assignment. Compare the read-then-write alternative.",
      check: { maxGoodput: 0.997, clean: true },
    },
    {
      id: "ping-storm",
      title: "Location pings triple",
      explanation: "From t = 1.2 s to 2.2 s traffic triples — a mobile client release that pings every second instead of every 4.",
      scenario: variant(baseline, "rides-ping-storm", [{ id: "storm", kind: "trafficSpike", target: "", multiplier: 3, ...window(1200, 2200) }]),
      expect: "The in-memory index absorbs it: writes are sub-millisecond and the ring has spare workers. Matching latency barely moves. If pings went to the dispatch database instead, it would be the first thing to fall over.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "dispatch-failover",
      title: "The dispatch database leader dies",
      explanation: "The dispatch database leader is killed at t = 1.5 s; a replica is promoted after about 0.5 s.",
      scenario: variant(baseline, "rides-dispatch-failover", [{ id: "leader-down", kind: "kill", target: "dispatchdb", ...window(1500, 2200) }]),
      expect: "Location updates continue (they never touch the dispatch database). Ride claims and completions fail for the half second of detection and election, then resume on the new leader. With semi-synchronous replication and fencing, no acknowledged assignment is lost and the old leader cannot assign anyone after it returns.",
      check: { minGoodput: 0.95, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Indexing moving points",
      body: "Map each location to a cell (H3 resolution 8 cells are about 0.7 km² each) and keep, per cell, the set of drivers in it. A ping that changes cell moves the driver between two sets. A query takes the rider's cell plus one or two rings of neighbours, filters by state and ranks by estimated time of arrival from a routing engine, not straight-line distance. Shard the index by cell (or city) so one city's load stays on its shards.",
    },
    {
      title: "Assigning exactly one driver",
      body: "Matching proposes; the dispatch state decides. Claim a driver with an atomic conditional write (available 1 → 0, or compare-and-set on a version) in the store that owns the driver. A rejected claim moves on to the next candidate. The offer to the driver has a timeout, after which the claim is released — a lease. Batch matching (collect requests for a second, solve an assignment problem per area) gives better global ETAs than greedy nearest-driver.",
    },
    {
      title: "Ping ingestion",
      body: "Pings arrive over persistent connections, are validated (clock, speed sanity checks), written to the in-memory index and appended to a log (Kafka) for ETA models, fraud detection and trip reconstruction. Last-write-wins by device timestamp drops out-of-order pings. Losing a few pings is harmless; losing the index means rebuilding it from the next 4 s of pings.",
    },
    {
      title: "Regional failover",
      body: "Dispatch state is per city, so cities are the unit of failover. Uber has described keeping enough trip state on the driver's phone to rebuild a trip in another data centre after failover; the general lesson is that the partition key (city) should also be the failure domain.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Request a ride.", "Locations and matching.", "Latency, loss tolerance, no double assignment.", "Failover unit and trip state machine."] },
    { stage: "estimates", descriptors: ["None.", "Ping rate.", "Ping rate, index memory, ride rate.", "Shows the index fits in memory and the database must not take pings."] },
    { stage: "api", descriptors: ["Endpoints.", "Ping and request.", "Claim conflicts and idempotent ride requests.", "Offer/accept with timeouts (leases)."] },
    { stage: "data model", descriptors: ["Drivers table with lat/lng.", "Geo index named.", "Cell-based in-memory index + authoritative dispatch state.", "Separates hot location state, durable trips and the ping log."] },
    { stage: "high level", descriptors: ["One service and DB.", "Location service + dispatch.", "Sharded index, atomic claims, log for history.", "City-scoped sharding and failover."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions geohash.", "Cell queries with neighbour rings and ETA ranking.", "Race-free assignment, batch matching and index rebuild."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Metrics.", "Hot cells and dispatch store as risks.", "Matching latency SLO, conflict rate and failover drills."] },
  ],
  clarifyingQuestions: ["How many drivers online, and how often do they ping?", "Matching radius and time target?", "Can a driver have pooled trips?", "Is the system global or per city?"],
  commonMistakes: [
    "Writing every ping to a relational database.",
    "Radius queries over all drivers instead of cell lookups.",
    "Read-then-write driver assignment.",
    "Treating location data as precious and replicating it synchronously.",
    "Ignoring which unit fails over.",
  ],
};
