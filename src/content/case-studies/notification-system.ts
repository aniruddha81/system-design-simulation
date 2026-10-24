import type { CaseStudy } from "./types";
import { backoff, client, dedup, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

const api = { notify: [dedup("dedup"), { type: "branch" as const, cond: { kind: "dedupHit" as const }, then: [respond(200)], else: [publish("outbox"), respond(201)] }] };
// Workers call the provider through a circuit breaker; a failed attempt leaves the message
// unacknowledged, so the queue redelivers it later and dead-letters it after 5 tries.
const send = { notify: [{ type: "call" as const, target: "breaker", timeoutUs: 300_000, retry: backoff(1, 50) }, respond(200)] };

const design = {
  schemaVersion: 1 as const,
  id: "notification-system",
  name: "Notification system",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1]),
    service("api1", "Notify API 1", [2, 0], api),
    service("api2", "Notify API 2", [2, 2], api),
    node("dedup", "dedupStore", "Idempotency keys", [3, 0], { ...pool(256, 0.2), serviceTime: lognormal(0.3), ttlUs: 86_400_000_000, atomic: true, durable: true }),
    node("outbox", "queue", "Notification queue", [3, 2], { partitions: 128, capacityMessages: 1000, visibilityTimeoutUs: 400_000, maxDeliveries: 5, retentionUs: 86_400_000_000, publishTime: lognormal(1), costPerHour: 0.2, region: "us-east", zone: "a" }),
    node("sender", "worker", "Sender workers", [4, 2], { ...pool(128, 0.68), serviceTime: lognormal(1), source: "outbox", batchSize: 32 }, send),
    node("breaker", "circuitBreaker", "Breaker (per provider)", [5, 2], { failureRateThreshold: 0.5, windowUs: 200_000, minRequests: 20, openUs: 300_000, halfOpenProbes: 5, bulkheadMax: 128 }),
    // APNs/FCM: an external HTTP/2 API, ~40 ms away.
    node("provider", "service", "Push provider (APNs/FCM)", [6, 2], { ...pool(10_000, 0), serviceTime: lognormal(40, 0.5) }),
  ],
  edges: [link("client", "lb"), link("lb", "api1"), link("lb", "api2"), link("api1", "dedup"), link("api2", "dedup"), link("api1", "outbox"), link("api2", "outbox"), link("sender", "breaker"), link("breaker", "provider")],
  endpoints: [{ id: "notify", name: "POST /v1/notifications", op: "write" as const, keyTemplate: "user:{userId}", requestBytes: 600, responseBytes: 120, idempotent: false }],
};

const baseline = scenario("notify-day", { arrival: { kind: "poisson", rps: 1000 }, mix: { notify: 1 }, keys: { kind: "uniform", n: 100_000 }, deadlineMs: 300 });

export const notificationSystem: CaseStudy = {
  id: "notification-system",
  title: "Notification system",
  summary: "Accept notification requests from many internal services and deliver them through push, SMS and email providers. The design is a durable queue between fast producers and slow, flaky third parties, with retries, rate limits and user preferences in between.",
  requirements: {
    functional: [
      "Internal services send a notification for a user and a template; the system picks channels (push, SMS, email) from the user's preferences.",
      "Respect opt-outs, quiet hours and per-user frequency caps.",
      "Track status (queued, sent, delivered, failed) and retry transient failures.",
    ],
    nonFunctional: [
      "Accepting a request takes under 50 ms and never depends on provider health.",
      "At-least-once delivery to the provider, with duplicates suppressed where the channel allows (collapse IDs, idempotency keys).",
      "Time-sensitive notifications (2FA codes) delivered within seconds; marketing can wait.",
    ],
  },
  estimates: [
    { label: "Volume", formula: "1B notifications/day ÷ 86,400", result: "≈ 11.6k/s average; campaigns spike to 10× for minutes" },
    { label: "Queue backlog during a provider outage", formula: "11.6k/s × 10 min", result: "≈ 7M messages ≈ 7 GB at 1 KB — a durable log handles it; an in-memory queue does not" },
    { label: "Sender concurrency", formula: "Little's law: 11.6k/s × 40 ms provider latency", result: "≈ 460 requests in flight; HTTP/2 multiplexing keeps that to a few hundred connections" },
    { label: "Queue partitions", formula: "a partition is consumed one message at a time, in order → partitions ≥ in-flight messages", result: "≥ 460 partitions, or unordered consumption; the simulated cell needs 1,000/s × ~45 ms ≈ 45 and has 128" },
    { label: "Status records", formula: "1B/day × 200 B × 30 days retention", result: "≈ 6 TB — a wide-column or time-partitioned store" },
  ],
  api: [
    { signature: "POST /v1/notifications", request: "{ userId, template, params, priority } + Idempotency-Key", response: "201 { notificationId } queued · 200 duplicate · 429", endpointId: "notify" },
    { signature: "GET /v1/notifications/{id}", request: "—", response: "200 { status, attempts }" },
    { signature: "PUT /v1/users/{id}/preferences", request: "{ channels, quietHours, optOuts }", response: "200" },
  ],
  dataModel: {
    entities: [],
    notes: [
      "notifications(notificationId, userId, template, channel, status, attempts, createdAt): written on accept, updated by senders.",
      "preferences(userId → channels, opt-outs, quiet hours): read on every send, so it is cached aggressively.",
      "devices(userId → push tokens): tokens rotate; providers report invalid tokens, which must be deleted.",
      "The idempotency store maps the caller's key to a notificationId for a day.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "Call the provider synchronously from the API",
      tradeoffs: "One less moving part and immediate status. But the caller's latency and availability now equal the provider's: when APNs slows down, every internal service that sends notifications slows down with it. The queue is what decouples them.",
    },
    {
      title: "Separate queues per channel and priority",
      tradeoffs: "One queue per (channel, priority) lets 2FA codes bypass a marketing campaign backlog and lets each provider's senders scale and rate-limit independently. More queues to operate, but a slow email provider can no longer delay push.",
    },
  ],
  failureScenarios: [
    {
      id: "provider-gray",
      title: "The push provider fails half of all requests",
      explanation: "From t = 1.3 s to 1.9 s the provider returns errors for 50% of requests while still answering health checks.",
      scenario: variant(baseline, "notify-provider-gray", [{ id: "gray", kind: "gray", target: "provider", errorRate: 0.5, ...window(1300, 1900) }]),
      expect: "The API keeps accepting at full speed — it only writes to the queue. Senders see failures, retry once, then leave messages for redelivery; the breaker opens and fails fast instead of piling load onto the provider. After the incident the redelivered messages go through. Watch the queue's redelivery count rather than the API's goodput.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "provider-outage",
      title: "The provider is down long enough to fill the queue",
      explanation: "The provider is unreachable from t = 1.1 s to the end of the run. The queue holds 1,000 messages — about one second of traffic.",
      scenario: variant(baseline, "notify-provider-outage", [{ id: "down", kind: "kill", target: "provider", atUs: 1_100_000 }]),
      expect: "For a while nothing changes for callers. Then the queue reaches capacity and publishes are rejected with 503: back-pressure reaches the API. That is the right failure — loud and bounded — but the capacity must cover the longest provider outage you plan for, which is why production systems use a disk-backed log sized in hours.",
      check: { maxGoodput: 0.95 },
    },
    {
      id: "provider-slow",
      title: "The provider's latency jumps by 250 ms",
      explanation: "From t = 1.3 s to 2.3 s every call from the breaker to the provider takes 250 ms longer.",
      scenario: variant(baseline, "notify-provider-slow", [{ id: "slow", kind: "linkLatency", target: "breaker-provider", addUs: 250_000, ...window(1300, 2300) }]),
      expect: "Each sender now waits ~290 ms per notification, so 128 senders deliver only ~440/s against 1,000/s arriving (Little's law). The queue backs up, and well before the slowdown ends it reaches its 1,000-message capacity: new requests get 503. Latency alone produced the same back-pressure as an outage. The bulkhead keeps the slowdown from consuming unbounded resources; autoscaling senders on queue depth and a deeper, disk-backed queue are the fixes.",
      check: { maxGoodput: 0.95, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Delivery semantics end to end",
      body: "The API records an idempotency key and enqueues; the caller's retry is a no-op. Senders acknowledge a message only after the provider accepts it, so a crash means redelivery: at-least-once. Duplicates reaching the user are suppressed per channel — APNs collapse IDs and FCM collapse keys replace an undelivered earlier notification, email providers accept idempotency keys. After N attempts a message goes to a dead-letter queue for inspection instead of retrying forever.",
    },
    {
      title: "Retries, breakers and provider limits",
      body: "Retry transient errors (timeouts, 5xx, 429) with exponential backoff and jitter; never retry permanent ones (invalid token — delete it). Providers enforce rate limits, so senders pace themselves with a token bucket per provider and per app. A circuit breaker per provider stops hammering a provider that is failing, and a bulkhead caps concurrent calls so one slow provider cannot starve the others.",
    },
    {
      title: "Priorities, preferences and campaigns",
      body: "A marketing campaign of 50M notifications must not delay a 2FA code: separate queues by priority, or at least separate consumer pools. Preferences and frequency caps are evaluated at send time (not enqueue time), because users change them and quiet hours depend on when delivery actually happens. Campaigns are rate-shaped at the source so they do not hit the queue as a single burst.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Send notifications.", "Multiple channels.", "Preferences, priorities and delivery guarantees.", "Separates acceptance latency from delivery latency and defines duplicate handling per channel."] },
    { stage: "estimates", descriptors: ["None.", "Throughput.", "Throughput, backlog during an outage, status storage.", "Sender concurrency from Little's law and provider limits."] },
    { stage: "api", descriptors: ["Send endpoint.", "Adds status.", "Idempotency key and priority.", "Preferences API and provider callbacks for delivery receipts."] },
    { stage: "data model", descriptors: ["None.", "Notifications table.", "Notifications, preferences, devices.", "Token lifecycle and status retention."] },
    { stage: "high level", descriptors: ["API calls provider.", "Queue between API and senders.", "Per-channel senders with retries.", "Priorities, breakers, bulkheads and DLQ with clear failure behaviour."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions retries.", "At-least-once with idempotency and DLQ.", "Provider rate limits, collapse keys and preference evaluation timing."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions metrics.", "Queue depth and provider errors as signals.", "Per-priority delivery SLOs with alerts on lag and DLQ growth."] },
  ],
  clarifyingQuestions: [
    "Which channels, and which providers?",
    "Which notifications are time-critical?",
    "Is delivery confirmation required, or is 'handed to the provider' enough?",
    "Expected campaign sizes and how fast they must go out?",
  ],
  commonMistakes: [
    "Calling providers synchronously in the request path.",
    "Retrying without backoff or a cap, so an outage becomes a retry storm.",
    "One queue for all priorities.",
    "Ignoring provider rate limits and invalid-token feedback.",
    "No idempotency key, so caller retries send duplicates.",
  ],
};
