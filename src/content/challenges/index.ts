import { cachingChallenge, noCacheDesign, unsafeTicketBookingDesign } from "@/engine/fixtures";
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

// ---------- flash sale: no oversell (P2, built on E1's ticket-booking fixture) ----------

const SEATS = 100;
const lognormal = (ms: number) => ({ kind: "lognormal" as const, medianUs: ms * 1000, sigma: 0.4 });
const POS: Record<string, { x: number; y: number; label: string }> = {
  client: { x: 0, y: 160, label: "Buyers" }, svc: { x: 256, y: 160, label: "Booking service" }, db: { x: 512, y: 160, label: "Tickets DB" },
};

/** The fixture's read-then-decrement booking, laid out and given realistic DB latency so concurrent buyers race. */
export const flashSaleStart: Design = (() => {
  const d = structuredClone(unsafeTicketBookingDesign);
  d.id = "flash-sale";
  d.name = "Flash sale";
  d.nodes = d.nodes.map((n): NodeSpec => {
    const p = POS[n.id];
    const placed = { ...n, label: p?.label ?? n.label, position: p ? { x: p.x, y: p.y } : n.position } as NodeSpec;
    if (placed.kind === "database") return { ...placed, params: { ...placed.params, concurrency: 32, readTime: lognormal(0.5), writeTime: lognormal(0.5), costPerHour: 0.2 } };
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
    id: "flash-sale", version: 1, warmupUs: 0, measureUs: 1_000_000, drainUs: 300_000, chaos: [],
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

export const challenges: Challenge[] = [
  {
    id: cachingChallenge.id,
    title: cachingChallenge.title,
    brief: [
      "Users read their profiles far more often than they update them, and a few profiles are very hot. The database has only a handful of workers, so every read hitting it queues behind the others.",
      "Seven seconds in, the cache node restarts empty. Your design has to keep reads fast and successful through that cold start — without blowing the budget.",
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
      "Tickets for a concert go on sale: 100 seats, and about a thousand buyers in the first second. The booking service reads the remaining count, then writes it back one lower.",
      "When two buyers read the same count at once, both succeed and the venue sells a seat it doesn't have. Make every booking safe under concurrency — buyers who miss out should get a clean 409, not a phantom seat.",
    ],
    spec: flashSaleChallenge,
    start: flashSaleStart,
    hints: [
      "Run it and open the Results tab: the invariants list shows an oversell, with the request IDs that took a seat that wasn't there.",
      "The read and the write are two separate data steps, so another buyer can slip in between them. Look for a single data operation that checks and decrements together.",
      "On the booking service, replace get + update with one data step: decrementIfPositive on tickets.remaining. It returns 409 once the seats are gone.",
    ],
  },
];

export function getChallenge(id: string): Challenge | undefined {
  return challenges.find((c) => c.id === id);
}
