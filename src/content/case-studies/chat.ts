import type { CaseStudy } from "./types";
import { alter, backoff, client, data, dedup, entity, find, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// Messages are stored per conversation (partition key = conversationId); history reads one partition.
const messages = entity("messages", "msgstore", { conversationId: ["int", 8], log: ["string", 2000] }, 10_000);
const inbox = entity("inbox", "msgstore", { userId: ["string", 8], pending: ["string", 500] }, 10_000);
const kv = (id: string, label: string, at: [number, number]) => node(id, "kvStore", label, at, {
  ...pool(64, 1.2), readTime: lognormal(1.5), writeTime: lognormal(2), members: 6, vnodes: 64, replicationFactor: 3, readQuorum: 2, writeQuorum: 2, hintedHandoff: true, readRepair: true, tombstoneGcUs: 864_000_000_000,
});

// The connection gateway holds the client's WebSocket; it retries the chat service if a send times out.
const gateway = { send: [{ type: "call" as const, target: "chat", timeoutUs: 40_000, retry: backoff(2, 10, ["timeout"]) }], history: [{ type: "call" as const, target: "chat", timeoutUs: 100_000 }] };
const chatHandlers = {
  // The client-generated message ID is the idempotency key: a retried send is recorded once.
  send: [dedup("dedup"), { type: "branch" as const, cond: { kind: "dedupHit" as const }, then: [respond(200)], else: [
    data("msgstore", "messages", { kind: "update", field: "log", op: "append", value: "m" }, 50),
    publish("deliveries", true),
    respond(200),
  ] }],
  history: [data("msgstore", "messages", { kind: "get" }, 50), respond(200)],
};

const design = {
  schemaVersion: 1 as const,
  id: "chat",
  name: "Chat",
  nodes: [
    client("lb"),
    loadBalancer("lb", [1, 1], "consistentHash"),
    service("gw1", "Connection gateway 1", [2, 0], gateway, 256, 0.2),
    service("gw2", "Connection gateway 2", [2, 2], gateway, 256, 0.2),
    service("chat", "Chat service", [3, 1], chatHandlers, 128, 0.5),
    node("dedup", "dedupStore", "Message-ID dedup", [4, 0], { ...pool(256, 0.2), serviceTime: lognormal(0.3), ttlUs: 86_400_000_000, atomic: true, durable: true }),
    kv("msgstore", "Message store", [4, 1]),
    node("deliveries", "queue", "Delivery log (per conversation)", [4, 2], { partitions: 16, capacityMessages: 20_000, visibilityTimeoutUs: 300_000, maxDeliveries: 10, retentionUs: 86_400_000_000, publishTime: lognormal(1), costPerHour: 0.2, region: "us-east", zone: "a" }),
    // Delivery pushes to the recipient's gateway if online; offline recipients get an inbox entry and a push notification.
    node("delivery", "worker", "Delivery workers", [5, 2], { ...pool(16, 0.34), serviceTime: lognormal(3), source: "deliveries", batchSize: 16 }, { send: [data("msgstore", "inbox", { kind: "put" }, 50), respond(200)] }),
  ],
  edges: [link("client", "lb"), link("lb", "gw1"), link("lb", "gw2"), link("gw1", "chat"), link("gw2", "chat"), link("chat", "dedup"), link("chat", "msgstore"), link("chat", "deliveries"), link("delivery", "msgstore")],
  endpoints: [
    { id: "send", name: "WS send { conversationId, messageId, body }", op: "write" as const, keyTemplate: "conv:{conversationId}", requestBytes: 400, responseBytes: 100, idempotent: false },
    { id: "history", name: "GET /v1/conversations/:id/messages", op: "read" as const, keyTemplate: "conv:{conversationId}", requestBytes: 150, responseBytes: 4000, idempotent: true },
  ],
  entities: [messages, inbox],
};

const baseline = scenario("chat-day", { arrival: { kind: "poisson", rps: 2000 }, mix: { send: 0.6, history: 0.4 }, keys: { kind: "zipf", n: 10_000, s: 0.9 }, deadlineMs: 500 });
const lostAcks = variant(baseline, "chat-lost-acks", [{ id: "lost-acks", kind: "partition", target: "", links: [{ from: "chat", to: "gw1" }], ...window(1500, 1580) }]);

export const chat: CaseStudy = {
  id: "chat",
  title: "Chat (WhatsApp / Messenger)",
  summary: "One-to-one and group messaging with delivery receipts. The core problems are keeping millions of connections open, storing messages once even when clients retry, and delivering them in order to devices that come and go.",
  requirements: {
    functional: [
      "Send a message to a user or a group (up to a few hundred members).",
      "Deliver in real time to online devices; store and deliver later to offline ones (with a push notification).",
      "Per-conversation message order; sent / delivered / read receipts.",
      "Fetch conversation history, paginated.",
    ],
    nonFunctional: [
      "End-to-end delivery latency under ~200 ms p99 between online users in a region.",
      "No message lost once the sender sees 'sent'; no message shown twice.",
      "Hundreds of millions of concurrent connections.",
    ],
  },
  estimates: [
    { label: "Messages", formula: "500M DAU × 40 messages/day ÷ 86,400", result: "≈ 230k messages/s average, ≈ 500k/s peak" },
    { label: "Storage", formula: "20B messages/day × ~200 B (body, IDs, timestamps)", result: "≈ 4 TB/day, ≈ 1.5 PB/year before replication (if the server keeps history)" },
    { label: "Connections", formula: "200M concurrent devices ÷ ~1M connections per tuned gateway host", result: "≈ 200–400 gateway hosts; memory per idle connection (tens of KB) is the limit" },
    { label: "Group fan-out", formula: "average group 20 members × group share of traffic", result: "delivery work is several times the send rate" },
    { label: "Bandwidth", formula: "500k/s × 400 B including headers", result: "≈ 200 MB/s ingress; small, connection count dominates" },
  ],
  api: [
    { signature: "WS send { conversationId, messageId, body }", request: "messageId is generated by the client (UUID) and reused on retry", response: "ack { messageId, serverSeq } once durably stored", endpointId: "send" },
    { signature: "WS ← message { conversationId, serverSeq, ... }", request: "pushed by the server", response: "client acks delivery; server emits a 'delivered' receipt" },
    { signature: "GET /v1/conversations/{id}/messages?before=seq", request: "cursor by sequence number", response: "200 { messages[] }", endpointId: "history" },
  ],
  dataModel: {
    entities: [messages, inbox],
    notes: [
      "messages: partition key conversationId, clustering key serverSeq (or a time-ordered ID), so history is one partition range read — the layout Discord describes for Cassandra.",
      "inbox: per-user pending deliveries for offline devices, deleted once acknowledged.",
      "A dedup record per (sender, messageId) with a TTL of a day turns client retries into no-ops.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "No idempotency key",
      tradeoffs: "Simpler, but a send whose acknowledgement is lost is retried and stored twice — the recipient sees the message twice. Run the lost-acknowledgement scenario against it.",
      design: alter(design, "chat-no-dedup", "Chat without dedup", (d) => {
        find<"service">(d, "chat").handlers!.send = [data("msgstore", "messages", { kind: "update", field: "log", op: "append", value: "m" }, 50), publish("deliveries", true), respond(200)];
      }),
      check: { scenario: "lost-acks", violations: ["duplicateEffect"] },
    },
    {
      title: "Polling instead of persistent connections",
      tradeoffs: "Plain HTTP and trivial load balancing, but latency equals the poll interval and most polls return nothing: 200M devices polling every 5 s is 40M requests/s of mostly empty responses. Long polling or WebSockets push only when there is something to say.",
    },
    {
      title: "Relational store for messages",
      tradeoffs: "Fine for millions of messages a day, and transactions make sequence assignment easy. At billions per day the write volume and the append-only, partition-local access pattern suit a wide-column store better; Discord moved from MongoDB to Cassandra (and later ScyllaDB) for this reason.",
    },
  ],
  failureScenarios: [
    {
      id: "lost-acks",
      title: "Acknowledgements from the chat service are lost",
      explanation: "From t = 1.5 s to 1.58 s every response from the chat service to gateway 1 is dropped. The messages were stored, but the gateway times out after 40 ms and retries.",
      scenario: lostAcks,
      expect: "The retries carry the same message ID, the dedup store recognises them and the chat service answers 'sent' without storing again. No duplicates. Most senders see a short delay; the few whose three attempts all fell inside the cut get an error, and the device retries later with the same ID — still safe.",
      check: { minGoodput: 0.97, clean: true },
    },
    {
      id: "delivery-crash",
      title: "Delivery workers crash",
      explanation: "All delivery workers die from t = 1.3 s to 1.8 s. Messages they had taken are unacknowledged and reappear after the 300 ms visibility timeout.",
      scenario: variant(baseline, "chat-delivery-crash", [{ id: "workers-down", kind: "kill", target: "delivery", ...window(1300, 1800) }]),
      expect: "Sending keeps working because it ends at the durable log. Delivery pauses, then catches up; redelivered messages stay in order because the log is partitioned by conversation and a partition is consumed in order. Nothing is lost, nothing is reordered, recipients just see a delay.",
      check: { minGoodput: 0.99, clean: true },
    },
    {
      id: "slow-store",
      title: "The message store slows down",
      explanation: "From t = 1.5 s to 2.2 s the message store runs 8× slower (a compaction storm).",
      scenario: variant(baseline, "chat-slow-store", [{ id: "slow", kind: "degrade", target: "msgstore", slowFactor: 8, ...window(1500, 2200) }]),
      expect: "Stores take 12–16 ms and some exceed the gateway's 40 ms timeout, so the gateway retries. Dedup keeps the retries harmless, but they add load to a store that is already slow — retries need a budget, or they turn a slowdown into an outage.",
      check: { minGoodput: 0.95, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Connections and routing",
      body: "Each device holds a WebSocket (or MQTT, in Facebook Messenger's case) to a gateway. A presence/session service maps userId → gateway, so a delivery worker knows where to push. Gateways are stateful, so deploys must drain connections gradually and clients reconnect with jittered backoff; a gateway crash otherwise turns into a reconnect storm.",
    },
    {
      title: "Exactly-once from the user's point of view",
      body: "Networks give at-least-once at best. The client assigns a message ID and retries until acknowledged; the server stores (sender, messageId) in a dedup table and treats a repeat as success without re-storing. Delivery to recipients is also at-least-once; the recipient's client dedups by message ID. Together that looks like exactly-once to people.",
    },
    {
      title: "Ordering",
      body: "Global order is unnecessary and expensive. Order within a conversation is required: the chat service assigns a per-conversation sequence number when it stores the message (a counter in the conversation's partition), and the delivery log is partitioned by conversation so consumers see messages in that order. Clients display by sequence number and fill gaps by fetching history.",
    },
    {
      title: "Groups and end-to-end encryption",
      body: "Small groups fan out on send (one delivery per member device). With end-to-end encryption (the Signal protocol, used by WhatsApp) the server never sees plaintext: clients encrypt per recipient device or with a group sender key, and the server only routes and stores ciphertext — which also means server-side search is impossible.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Send and receive.", "Adds groups or offline delivery.", "Ordering, delivery guarantees, latency and scale.", "Defines 'sent/delivered/read' precisely and what 'no duplicates' means."] },
    { stage: "estimates", descriptors: ["None.", "Message rate.", "Message rate, storage and connection count.", "Gateway sizing by memory per connection and group fan-out cost."] },
    { stage: "api", descriptors: ["REST send.", "WebSocket messages.", "Client message IDs and acks.", "Receipts, history cursors and reconnect/resume semantics."] },
    { stage: "data model", descriptors: ["Messages table.", "Keyed by conversation.", "Partitioned by conversation, ordered by sequence; inbox for offline.", "Dedup table with TTL; hot-partition handling for huge groups."] },
    { stage: "high level", descriptors: ["Server relays messages.", "Gateways + chat service + store.", "Adds delivery log/queue and presence routing.", "Explains each failure: gateway crash, store slowdown, worker crash."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions WebSockets.", "Idempotent sends and per-conversation order.", "Group fan-out, E2E encryption constraints and reconnect storms."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Mentions monitoring.", "Delivery lag and connection churn as risks.", "SLOs on delivery latency with alerting on consumer lag and reconnect rate."] },
  ],
  clarifyingQuestions: [
    "1:1 only, or groups — how large?",
    "Do we store history on the server, or only until delivered?",
    "Multiple devices per user?",
    "End-to-end encrypted?",
    "Which receipts are needed?",
  ],
  commonMistakes: [
    "No client-generated message ID, so retries duplicate messages.",
    "Promising global ordering.",
    "Polling for new messages at scale.",
    "Storing messages keyed by user instead of by conversation, so history needs a fan-in.",
    "Ignoring the reconnect storm after a gateway failure.",
  ],
};
