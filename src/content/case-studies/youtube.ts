import type { CaseStudy } from "./types";
import { client, data, entity, link, loadBalancer, lognormal, node, pool, publish, respond, scenario, service, variant, window } from "./kit";

// A video is stored as ~4 s segments per rendition; players fetch segments over HTTP (HLS/DASH).
const segments = entity("segments", "objects", { segmentKey: ["string", 48], bytes: ["string", 256_000] }, 20_000);
const videos = entity("videos", "db", { videoId: ["string", 11], ownerId: ["int", 8], title: ["string", 100], status: ["string", 12], manifestKey: ["string", 48] }, 5_000);

const handlers = {
  segment: [data("objects", "segments", { kind: "get" }, 500), respond(200)],
  // Upload a raw chunk, record it, enqueue transcoding. Chunks of one video transcode in parallel.
  upload: [data("objects", "segments", { kind: "put" }, 2000), data("db", "videos", { kind: "put" }, 100), publish("transcode"), respond(201)],
};

const ORIGIN_UPLINK = 312_500_000; // 2.5 Gbit/s from the origin data centre
const EDGE = 12_500_000_000; // 100 Gbit/s of edge capacity

const design = {
  schemaVersion: 1 as const,
  id: "youtube",
  name: "Video streaming",
  nodes: [
    client("dns"),
    node("dns", "dns", "DNS steering", [1, 1], { resolutionTime: lognormal(20), ttlUs: 300_000, records: ["cdn", "lb"] }),
    node("cdn", "cdn", "CDN edge + origin shield", [2, 0], { ...pool(8192, 2), serviceTime: lognormal(0.5), capacityBytes: 1_030_000_000, eviction: "lru", ttlUs: 86_400_000_000, originShield: true, costPerGB: 0.01 }),
    loadBalancer("lb", [3, 1]),
    service("origin1", "Origin 1", [4, 0], handlers, 256),
    service("origin2", "Origin 2", [4, 2], handlers, 256),
    node("objects", "objectStore", "Segment store", [5, 0], { readTime: lognormal(20, 0.5), writeTime: lognormal(50, 0.5), costPerGBMonth: 0.02, costPerMillionRequests: 0.4, region: "us-east", zone: "a" }),
    node("db", "database", "Video metadata", [5, 1], { ...pool(32, 0.6, 600), readTime: lognormal(2), writeTime: lognormal(4), replicas: 1 }),
    node("transcode", "queue", "Transcode jobs", [5, 2], { partitions: 64, capacityMessages: 50_000, visibilityTimeoutUs: 3_000_000, maxDeliveries: 3, retentionUs: 86_400_000_000, publishTime: lognormal(1), costPerHour: 0.1, region: "us-east", zone: "a" }),
    // One 4 s chunk into ~6 renditions: ~300 ms on a GPU/ASIC-backed worker.
    node("transcoder", "worker", "Transcoders", [6, 2], { ...pool(12, 2.5), serviceTime: lognormal(300, 0.3), source: "transcode", batchSize: 12 }, { upload: [data("objects", "segments", { kind: "put" }, 2000), respond(200)] }),
  ],
  edges: [
    link("client", "dns", 0.25, EDGE), link("dns", "cdn", 0.25, EDGE), link("cdn", "lb", 0.25, ORIGIN_UPLINK), link("dns", "lb", 0.25, ORIGIN_UPLINK),
    link("lb", "origin1"), link("lb", "origin2"), ...["origin1", "origin2"].flatMap((o) => [link(o, "objects"), link(o, "db"), link(o, "transcode")]), link("transcoder", "objects"),
  ],
  endpoints: [
    { id: "segment", name: "GET /v/:videoId/:rendition/:n.m4s", op: "read" as const, keyTemplate: "seg:{n}", requestBytes: 400, responseBytes: 256_000, idempotent: true },
    { id: "upload", name: "PUT /upload/:videoId/chunk/:n", op: "write" as const, keyTemplate: "seg:{n}", requestBytes: 1_000_000, responseBytes: 200, idempotent: true, inputs: { n: { kind: "sequence" as const, start: 1_000_000 } } },
  ],
  entities: [segments, videos],
};

const baseline = scenario("video-day", { arrival: { kind: "poisson", rps: 2000 }, mix: { segment: 0.99, upload: 0.01 }, keys: { kind: "zipf", n: 20_000, s: 1.2 }, deadlineMs: 2000 });

export const youtube: CaseStudy = {
  id: "youtube",
  title: "YouTube (video streaming)",
  summary: "Accept uploads, transcode them into an adaptive bitrate ladder and stream segments to millions of concurrent viewers. Bandwidth, not requests, is the constraint: the CDN carries the bytes, and transcoding is a large batch pipeline.",
  requirements: {
    functional: ["Upload a video (up to hours long).", "Transcode into multiple resolutions and bitrates.", "Stream with adaptive bitrate on any device; seek anywhere.", "Video metadata, view counts (eventually consistent)."],
    nonFunctional: [
      "Playback starts in under ~2 s and does not rebuffer on a stable connection.",
      "Uploaded videos are never lost; processing can take minutes.",
      "Serve on the order of 100 Tbit/s of egress at peak.",
    ],
  },
  estimates: [
    { label: "Upload volume", formula: "500 hours of video uploaded per minute (YouTube's public figure)", result: "≈ 30,000 hours of video per hour of wall clock" },
    { label: "Raw ingest", formula: "500 h/min × 60 × ~1 GB/hour (1080p upload)", result: "≈ 30 TB/hour of originals ≈ 0.7 PB/day" },
    { label: "Stored renditions", formula: "~6 renditions totalling ~1.5× the upload size", result: "≈ 1 PB/day added before replication or erasure coding" },
    { label: "Transcode compute", formula: "30,000 video-hours/hour × ~1 transcoder-hour per video-hour per rendition ladder", result: "tens of thousands of transcoders busy continuously — parallelised per 4 s chunk" },
    { label: "Concurrent viewers", formula: "1B hours watched/day ÷ 24 h", result: "≈ 42M concurrent streams on average" },
    { label: "Egress", formula: "42M streams × ~2.5 Mbit/s average bitrate", result: "≈ 100 Tbit/s — served from ISP-embedded caches, not data centres" },
  ],
  api: [
    { signature: "POST /upload → PUT /upload/{videoId}/chunk/{n}", request: "resumable chunked upload", response: "201 per chunk; processing status via GET /videos/{id}", endpointId: "upload" },
    { signature: "GET /v/{id}/master.m3u8", request: "—", response: "manifest listing renditions and segment URLs" },
    { signature: "GET /v/{id}/{rendition}/{n}.m4s", request: "byte ranges optional", response: "200 segment (~4 s of media)", notes: "Immutable, so cached at the edge for a long time.", endpointId: "segment" },
  ],
  dataModel: {
    entities: [segments, videos],
    notes: [
      "videos: metadata and processing status, keyed by video ID; view counts are aggregated asynchronously, not updated per view.",
      "segments: immutable objects keyed by (video, rendition, index); the manifest lists them.",
      "Originals are kept (for re-encoding with better codecs later) in colder, cheaper storage.",
    ],
  },
  design,
  scenario: baseline,
  alternatives: [
    {
      title: "No origin shield",
      tradeoffs: "Without a shield, each edge that misses a segment fetches it from the origin independently, so a newly popular video causes as many origin fetches as there are edges, plus concurrent misses within each. The simulated cell has a single edge, so it cannot show this; the shield's value grows with the number of edge locations.",
    },
    {
      title: "Progressive download of one file",
      tradeoffs: "Simplest to serve, but one bitrate for everyone: rebuffering on slow networks, wasted bandwidth on fast ones, and seeking needs byte ranges into a huge file. Segmented adaptive streaming (HLS, DASH) lets the player switch bitrate every few seconds.",
    },
    {
      title: "Per-title or per-shot encoding",
      tradeoffs: "A fixed bitrate ladder wastes bits on simple content and starves complex content. Netflix's per-title encoding chooses the ladder per video from its complexity; it costs more compute up front and saves bandwidth on every view, which wins for content watched many times.",
    },
  ],
  failureScenarios: [
    {
      id: "viral-video",
      title: "A video goes viral",
      explanation: "One video's segments take 40% of all requests — a new music video premiere.",
      scenario: variant(baseline, "video-viral", [], { keys: { kind: "hotspot", n: 20_000, hotFraction: 0.4 } }),
      expect: "The viral segments are cached at the edge after the first fetch; the origin barely notices them. The rest of this scenario's traffic is spread uniformly over the catalogue, so the edge hit rate falls overall and the origin uplink carries more long-tail misses.",
      check: { minGoodput: 0.98, clean: true },
    },
    {
      id: "cdn-outage",
      title: "The CDN edge fails and traffic falls back to the origin",
      explanation: "The edge dies at t = 1.5 s. After the DNS TTL (300 ms, scaled down) clients go straight to the origin, whose uplink is 2.5 Gbit/s.",
      scenario: variant(baseline, "video-cdn-outage", [{ id: "edge-down", kind: "kill", target: "cdn", atUs: 1_500_000 }]),
      expect: "First requests time out until DNS fails over, then the origin uplink saturates: 2,000 segments/s × 256 KB is about 4 Gbit/s against 2.5 Gbit/s of capacity. The link becomes a queue that grows by ~200 MB every second; within a second of failover segment latency is up from milliseconds to over half a second and climbing, and a longer outage ends in timeouts and rebuffering. For video the CDN is not an optimisation: the origin cannot carry the bytes.",
      check: { maxGoodput: 0.95, minP99Ms: 300 },
    },
    {
      id: "upload-surge",
      title: "Uploads triple",
      explanation: "From t = 1.2 s to 2.2 s all traffic triples, including uploads.",
      scenario: variant(baseline, "video-upload-surge", [{ id: "surge", kind: "trafficSpike", target: "", multiplier: 3, ...window(1200, 2200) }]),
      expect: "Chunk uploads are acknowledged as soon as they are stored; transcoding work queues up and videos take longer to become playable. Viewing is unaffected — the CDN is serving it. The transcode queue depth is the capacity signal.",
      check: { minGoodput: 0.98, clean: true },
    },
  ],
  deepDives: [
    {
      title: "Adaptive bitrate streaming",
      body: "Each video is encoded into a ladder (e.g. 240p to 4K at increasing bitrates) and cut into segments of a few seconds aligned at keyframes. A manifest (HLS .m3u8, DASH .mpd) lists them. The player measures throughput and buffer level and picks the next segment's rendition, so it can step down instead of rebuffering. Segments are plain HTTP objects, which is what makes CDNs effective.",
    },
    {
      title: "The transcoding pipeline",
      body: "Split the upload into chunks at keyframes, transcode chunks in parallel across many workers, then stitch and publish the manifest. A job DAG (split → encode per rendition → package → thumbnail → publish) with retries per task and idempotent outputs (deterministic object keys) tolerates worker loss. Prioritise short videos and popular creators; batch the long tail.",
    },
    {
      title: "Delivering 100 Tbit/s",
      body: "Data-centre egress cannot reach most viewers cheaply. Large platforms place cache appliances inside ISP networks (Google Global Cache, Netflix Open Connect) and steer clients by DNS or by the manifest to a nearby cache that has the content. Popular content is pre-positioned off-peak; the long tail is fetched through regional shields on demand.",
    },
  ],
  rubric: [
    { stage: "requirements", descriptors: ["Upload and watch.", "Multiple resolutions.", "Start-up time, rebuffering, durability and scale.", "Separates upload, processing and playback latency targets."] },
    { stage: "estimates", descriptors: ["None.", "Upload volume.", "Storage growth and egress bandwidth.", "Transcode compute and concurrent streams from watch time."] },
    { stage: "api", descriptors: ["Upload/watch.", "Chunked upload.", "Manifests and segments.", "Resumable uploads and immutable segment URLs."] },
    { stage: "data model", descriptors: ["Videos table.", "Metadata + blobs.", "Segments per rendition with manifests.", "Original retention and async view counting."] },
    { stage: "high level", descriptors: ["Server streams files.", "CDN + object store.", "Async transcoding pipeline.", "Origin shield, ISP caches and steering."] },
    { stage: "deep dive", descriptors: ["None.", "Mentions bitrates.", "ABR and the transcoding DAG.", "Per-title encoding, pre-positioning and failure behaviour."] },
    { stage: "wrap-up", descriptors: ["Stops.", "Metrics.", "Rebuffer rate and processing lag.", "Cost model of egress vs compute and capacity plans for premieres."] },
  ],
  clarifyingQuestions: ["Upload sizes and lengths?", "Live streaming in scope?", "Which devices — do we need DRM?", "Global audience?", "How fast must an upload become playable?"],
  commonMistakes: [
    "Serving video from application servers.",
    "One rendition per video.",
    "Transcoding a long video as one job on one machine.",
    "Counting views with a synchronous database update per view.",
    "Sizing by requests per second instead of bits per second.",
  ],
};
