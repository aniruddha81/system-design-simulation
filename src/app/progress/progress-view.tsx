"use client";

import Link from "next/link";
import { useState } from "react";
import { ids, isCompleted, saveTrackPlacement, useProgress, useReviews } from "@/components/lesson/progress";
import { formatPercent } from "@/lib/format";

export type LessonSummary = {
  id: string;
  track?: string;
  title: string;
  href: string;
  steps: string[];
  objectives: { id: string; text: string; step?: string }[];
};

type PlacementQuestion = {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  correctId: string;
  explanation: string;
};

type PlacementTrack = {
  track: string;
  label: string;
  summary: string;
  questions: [PlacementQuestion, PlacementQuestion, PlacementQuestion];
};

const PLACEMENT_TRACKS: PlacementTrack[] = [
  {
    track: "foundations",
    label: "Track 0 — Foundations",
    summary: "Little's Law, M/M/1 queueing, tail latency amplification, and back-of-the-envelope capacity math.",
    questions: [
      {
        id: "f-1",
        prompt: "By Little's Law (L = λW), a service handling 1,200 RPS with a mean residence time of 25 ms holds how many concurrent requests in flight on average?",
        options: [
          { id: "12", label: "12 requests" },
          { id: "30", label: "30 requests" },
          { id: "48", label: "48 requests" },
        ],
        correctId: "30",
        explanation: "L = λ × W = 1,200 req/s × 0.025 s = 30 concurrent requests.",
      },
      {
        id: "f-2",
        prompt: "An aggregator fans out each user request in parallel to 10 independent shards, each with a 1% chance of exceeding 80 ms (p99 = 80 ms). What is the probability that the aggregator waits longer than 80 ms?",
        options: [
          { id: "1pct", label: "1.0%" },
          { id: "9.6pct", label: "≈ 9.6% (1 − 0.99¹⁰)" },
          { id: "50pct", label: "50.0%" },
        ],
        correctId: "9.6pct",
        explanation: "All 10 shards must finish within 80 ms for the aggregator to beat 80 ms: 1 − 0.99¹⁰ ≈ 9.56%.",
      },
      {
        id: "f-3",
        prompt: "In an M/M/1 queue with arrival rate λ and service rate μ (utilisation ρ = λ/μ), how does mean queueing delay scale as ρ approaches 1?",
        options: [
          { id: "linear", label: "Linearly with ρ" },
          { id: "hyperbolic", label: "Nonlinearly as ρ / (1 − ρ), diverging toward infinity as ρ → 1" },
          { id: "constant", label: "Remains constant until ρ > 1" },
        ],
        correctId: "hyperbolic",
        explanation: "Mean residence time is 1 / (μ − λ) = (1/μ) / (1 − ρ); small load increases near saturation explode queue wait.",
      },
    ],
  },
  {
    track: "building-blocks",
    label: "Track 1 — Building Blocks",
    summary: "Load balancing, cache-aside & stampede coalescing, rate limiting, partitioned queues, and indexing.",
    questions: [
      {
        id: "bb-1",
        prompt: "A service receives 2,500 RPS and fronts its database with a cache that achieves a 92% hit rate. What read rate still reaches the database?",
        options: [
          { id: "200", label: "200 RPS" },
          { id: "500", label: "500 RPS" },
          { id: "2300", label: "2,300 RPS" },
        ],
        correctId: "200",
        explanation: "Miss rate = 1 − 0.92 = 0.08; 2,500 × 0.08 = 200 RPS hit the origin database.",
      },
      {
        id: "bb-2",
        prompt: "In a partitioned queue with orderedByKey enabled, workers take up to 4 ms on slow jobs, but visibilityTimeoutUs is set to 1 ms. What failure mode occurs?",
        options: [
          { id: "ordering", label: "Premature redelivery causes concurrent execution and per-key ordering violations" },
          { id: "dlq-instant", label: "Messages are deleted before any worker reads them" },
          { id: "none", label: "No failure; visibility timeout only affects dead-letter retention" },
        ],
        correctId: "ordering",
        explanation: "When visibilityTimeoutUs < worker service time, the queue hands the in-flight message to a second worker, violating per-key order.",
      },
      {
        id: "bb-3",
        prompt: "When a hot cache key expires under 1,000 RPS, which mechanism prevents 1,000 simultaneous cache misses from stampeding the database?",
        options: [
          { id: "lru", label: "Switching eviction from LRU to FIFO" },
          { id: "coalesce", label: "Request coalescing (singleflight) so one miss fills the cache while concurrent readers wait" },
          { id: "short-ttl", label: "Reducing the TTL to 100 ms" },
        ],
        correctId: "coalesce",
        explanation: "Request coalescing collapses concurrent misses for the same key into a single origin read.",
      },
    ],
  },
  {
    track: "distributed-systems",
    label: "Track 2 — Distributed Systems",
    summary: "Leader–follower replication, fencing tokens, Dynamo quorums, Raft consensus, and sagas.",
    questions: [
      {
        id: "ds-1",
        prompt: "On a leaderless KV ring with replication factor N = 3, which quorum settings guarantee strict read/write overlap (R + W > N)?",
        options: [
          { id: "r1w1", label: "R = 1, W = 1" },
          { id: "r2w2", label: "R = 2, W = 2" },
          { id: "r1w2", label: "R = 1, W = 2" },
        ],
        correctId: "r2w2",
        explanation: "Strict quorum intersection requires R + W > N. With N = 3, R = 2 and W = 2 give 2 + 2 = 4 > 3.",
      },
      {
        id: "ds-2",
        prompt: "A primary database pauses during a GC stall while a new leader is elected in term 2. When the old primary resumes, how does the storage layer prevent splitBrainWrite?",
        options: [
          { id: "fencing", label: "Rejecting writes whose monotonic fencing token (term/epoch) is lower than the highest seen token" },
          { id: "async", label: "Switching replication from sync to async" },
          { id: "heartbeat", label: "Increasing the client timeout" },
        ],
        correctId: "fencing",
        explanation: "Fencing tokens allow storage or replicas to reject zombie writes from a deposed leader in an older term.",
      },
      {
        id: "ds-3",
        prompt: "Why does a checkout gateway that retries on timeout cause duplicateEffect when the payment response packet is dropped, and how is it fixed?",
        options: [
          { id: "dedup", label: "The ledger already committed before the ack dropped; fix by checking an atomic, durable idempotency store before mutating" },
          { id: "exponential", label: "Backoff was too short; increasing backoff alone prevents duplicate effects" },
          { id: "lb", label: "Load balancer round-robin caused the duplicate; sticky sessions prevent it" },
        ],
        correctId: "dedup",
        explanation: "Retrying after a lost ack re-sends a committed request; only an atomic idempotency key check deduplicates the side effect.",
      },
    ],
  },
  {
    track: "reliability",
    label: "Track 3 — Reliability & Operations",
    summary: "Timeout budgets, retry storms, circuit breakers, load shedding, and error-budget burn alerts.",
    questions: [
      {
        id: "rel-1",
        prompt: "Three tiers each retry failed calls up to 3 times (4 total attempts per tier). In the worst case, how many leaf attempts can a single user request trigger?",
        options: [
          { id: "12", label: "12 attempts" },
          { id: "64", label: "64 attempts (4³)" },
          { id: "4", label: "4 attempts" },
        ],
        correctId: "64",
        explanation: "Multiplicative retries across k tiers amplify load as (1 + retries)^k = 4³ = 64 leaf attempts.",
      },
      {
        id: "rel-2",
        prompt: "When a downstream service is overloaded and failing 80% of requests, what is the primary effect of tripping an upstream circuit breaker?",
        options: [
          { id: "shed", label: "Fails fast (503) to stop wasting downstream work and allow recovery, without fabricating 200 responses" },
          { id: "heal", label: "Automatically increases downstream CPU concurrency" },
          { id: "goodput", label: "Turns 503 errors into 200 successes immediately" },
        ],
        correctId: "shed",
        explanation: "A circuit breaker sheds load and stops retry amplification so the dependency can recover.",
      },
      {
        id: "rel-3",
        prompt: "During overload, why does LIFO (last-in, first-out) or CoDel queue discipline improve goodput compared to an unbounded FIFO queue?",
        options: [
          { id: "fresh", label: "It serves fresh requests that still have deadline budget instead of making every request wait behind already-expired work" },
          { id: "cpu", label: "It reduces the service time of individual database queries" },
          { id: "memory", label: "It doubles network bandwidth" },
        ],
        correctId: "fresh",
        explanation: "Under saturation, FIFO makes every request pay the full queue wait (often exceeding caller deadlines), whereas LIFO + deadline propagation serves fresh requests before their deadline expires.",
      },
    ],
  },
  {
    track: "security",
    label: "Track 4 — Security, Cost & Governance",
    summary: "Edge DDoS & WAF defense, FinOps unit economics, and multi-region data residency.",
    questions: [
      {
        id: "sec-1",
        prompt: "Where should volumetric L7 traffic scrubbing and strict request-size limits (maxRequestBytes) sit to protect stateful databases and compute?",
        options: [
          { id: "edge", label: "At the CDN / API gateway and edge rate limiter before requests allocate application workers" },
          { id: "db", label: "Inside database stored procedures" },
          { id: "worker", label: "In the background queue consumer" },
        ],
        correctId: "edge",
        explanation: "Rejecting oversized or abusive traffic at the edge avoids exhausting scarce service threads and database connection pools.",
      },
      {
        id: "sec-2",
        prompt: "In cloud FinOps, why can cross-AZ and cross-region egress dominate monthly cost on media-heavy or chatty microservice architectures?",
        options: [
          { id: "egress", label: "Per-GB transfer charges multiply by payload size and fan-out hop count on every request" },
          { id: "dns", label: "DNS queries are billed per byte of origin storage" },
          { id: "idle", label: "Egress is only charged when servers are idle" },
        ],
        correctId: "egress",
        explanation: "Cross-region and CDN egress scale with RPS × responseBytes; caching at the edge and co-locating chatty services within one zone cuts transfer spend.",
      },
      {
        id: "sec-3",
        prompt: "To comply with strict regional data residency (e.g. EU user PII must remain in eu-west), how should a multi-region architecture route writes?",
        options: [
          { id: "cell", label: "Pin each tenant's primary storage cell to their home region and avoid replicating raw PII across non-compliant regions" },
          { id: "global-async", label: "Replicate every table asynchronously to all regions and filter on read" },
          { id: "client-cache", label: "Store all records only in the CDN" },
        ],
        correctId: "cell",
        explanation: "Data residency requires regional storage partitioning (cell/home-region pinning) so regulated records are never persisted outside the permitted jurisdiction.",
      },
    ],
  },
];

const MASTERED = 0.8;

export function ProgressView({ lessons, challenges }: { lessons: LessonSummary[]; challenges: { id: string; title: string }[] }) {
  const progress = useProgress();
  const reviews = useReviews();
  const [activeTrack, setActiveTrack] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submittedTrack, setSubmittedTrack] = useState<string | null>(null);

  if (!progress) return <p className="mt-10 text-muted" role="status">Loading progress…</p>;

  const rows = lessons.map((l) => {
    const rec = progress.get(ids.lesson(l.id));
    const stepsDone = l.steps.filter((s) => isCompleted(progress, ids.step(l.id, s))).length;
    const testedOut = rec?.contentRevision === 0 && rec?.completedAt !== undefined;
    return {
      ...l,
      rec,
      stepsDone,
      testedOut,
      mastered: (rec?.mastery ?? 0) >= MASTERED,
      completed: rec?.completedAt !== undefined,
    };
  });

  const due = lessons.flatMap((l) =>
    l.objectives
      .map((o) => {
        const itemId = ids.objective(l.id, o.id);
        const rec = progress.get(itemId);
        const rev = reviews?.items.get(itemId);
        return { lesson: l, objective: o, rec, rev };
      })
      .filter((x) => {
        const lowMastery = x.rec?.mastery !== undefined && x.rec.mastery < MASTERED;
        const reviewDue = x.rev !== undefined && reviews !== null && x.rev.dueAt <= reviews.now;
        return lowMastery || reviewDue;
      }),
  );

  const testedOutCount = rows.filter((r) => r.testedOut).length;

  const stats = [
    { label: "Completed", value: rows.filter((r) => r.completed).length, icon: "✓" },
    { label: "Mastered", value: rows.filter((r) => r.mastered).length, icon: "★" },
    {
      label: "Tested out",
      value: testedOutCount,
      icon: "⇥",
      note: testedOutCount > 0 ? "Via track placement checks" : "Use placement checks below to test out",
    },
    { label: "Due for review", value: due.length, icon: "↻" },
  ];

  const selectedPlacement = PLACEMENT_TRACKS.find((t) => t.track === activeTrack) ?? null;

  async function handleSubmitPlacement(pt: PlacementTrack) {
    setSubmittedTrack(pt.track);
    const allCorrect = pt.questions.every((q) => answers[q.id] === q.correctId);
    if (allCorrect) {
      const trackLessonIds = lessons.filter((l) => l.track === pt.track).map((l) => l.id);
      await saveTrackPlacement(trackLessonIds);
    }
  }

  return (
    <div className="mt-10 grid gap-12">
      <dl className="grid grid-cols-2 gap-6 border-y border-rule py-6 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="min-w-0">
            <dt className="flex items-center gap-2 text-sm text-muted">
              <span aria-hidden>{s.icon}</span>
              {s.label}
            </dt>
            <dd className="num mt-2 text-3xl">{s.value}</dd>
            {s.note && <dd className="mt-1 text-xs text-muted">{s.note}</dd>}
          </div>
        ))}
      </dl>

      <section aria-labelledby="review">
        <h2 id="review" className="mb-4 font-display text-2xl">
          Review queue
        </h2>
        {due.length === 0 ? (
          <p className="text-muted">Nothing due. Objectives you miss in a mastery check or that reach their SM-2 spaced-repetition interval land here.</p>
        ) : (
          <ul className="grid">
            {due.map(({ lesson, objective, rec, rev }) => (
              <li key={`${lesson.id}/${objective.id}`} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
                <div>
                  <p className="font-medium">{objective.text}</p>
                  <p className="text-sm text-muted">
                    {lesson.title}
                    {rec?.mastery !== undefined && (
                      <>
                        , last score <span className="num">{formatPercent(rec.mastery, 0)}</span>
                      </>
                    )}
                    {rev && (
                      <>
                        {" "}· SM-2 interval <span className="num">{rev.intervalDays}d</span> (ease <span className="num">{rev.ease.toFixed(2)}</span>)
                      </>
                    )}
                  </p>
                </div>
                <Link href={`${lesson.href}${objective.step ? `#step-${objective.step}` : ""}`} className="btn">
                  Review
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="placement">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="placement" className="font-display text-2xl">
              Track placement checks (test out)
            </h2>
            <p className="mt-1 text-sm text-muted">
              Already know a track? Answer 3 verification questions (3/3 required) to mark that track&apos;s lessons as tested out.
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {PLACEMENT_TRACKS.map((pt) => {
            const trackLessons = rows.filter((r) => r.track === pt.track);
            const allDone = trackLessons.length > 0 && trackLessons.every((r) => r.completed);
            const isOpen = activeTrack === pt.track;
            return (
              <div key={pt.track} className="flex flex-col justify-between rounded-md border border-border bg-surface p-4">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-medium text-fg">{pt.label}</h3>
                    <span className="font-mono text-xs text-muted num">
                      {trackLessons.filter((r) => r.completed).length}/{trackLessons.length} lessons
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{pt.summary}</p>
                </div>
                <div className="mt-4 flex items-center justify-between gap-2">
                  <span className={`text-xs font-medium ${allDone ? "text-success" : "text-muted"}`}>
                    {allDone ? "✓ Track complete" : "3 questions · 100% to test out"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveTrack(isOpen ? null : pt.track);
                      setSubmittedTrack(null);
                    }}
                    className="btn text-xs"
                  >
                    {isOpen ? "Close check" : allDone ? "Retake check" : "Test out"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {selectedPlacement && (
          <div className="mt-4 rounded-md border border-rule bg-surface p-5">
            <h3 className="font-display text-xl text-fg">{selectedPlacement.label} — Placement Check</h3>
            <p className="mt-1 text-xs text-muted">Select the best answer for all three questions, then check your placement.</p>
            <div className="mt-4 grid gap-5">
              {selectedPlacement.questions.map((q, idx) => {
                const chosen = answers[q.id];
                const isSubmitted = submittedTrack === selectedPlacement.track;
                const isRight = chosen === q.correctId;
                return (
                  <fieldset key={q.id} className="border-t border-border pt-4">
                    <legend className="text-sm font-medium text-fg">
                      <span className="font-mono text-xs text-muted mr-2">{idx + 1}.</span>
                      {q.prompt}
                    </legend>
                    <div className="mt-2.5 grid gap-2">
                      {q.options.map((opt) => (
                        <label
                          key={opt.id}
                          className={`flex cursor-pointer items-start gap-2.5 rounded border px-3 py-2 text-sm ${
                            chosen === opt.id ? "border-accent bg-surface-2 text-fg" : "border-border text-ink-2"
                          }`}
                        >
                          <input
                            type="radio"
                            name={q.id}
                            value={opt.id}
                            checked={chosen === opt.id}
                            onChange={() => {
                              setAnswers((prev) => ({ ...prev, [q.id]: opt.id }));
                              setSubmittedTrack(null);
                            }}
                            className="mt-1"
                          />
                          <span>{opt.label}</span>
                        </label>
                      ))}
                    </div>
                    {isSubmitted && (
                      <p className={`mt-2 text-xs ${isRight ? "text-success" : "text-danger"}`}>
                        {isRight ? "✓ Correct — " : "✗ Not quite — "}
                        {q.explanation}
                      </p>
                    )}
                  </fieldset>
                );
              })}
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <button
                type="button"
                onClick={() => void handleSubmitPlacement(selectedPlacement)}
                disabled={selectedPlacement.questions.some((q) => !answers[q.id])}
                className="btn"
              >
                Grade placement check
              </button>
              {submittedTrack === selectedPlacement.track && (
                <p
                  role="status"
                  className={`text-sm font-medium ${
                    selectedPlacement.questions.every((q) => answers[q.id] === q.correctId) ? "text-success" : "text-warning"
                  }`}
                >
                  {selectedPlacement.questions.every((q) => answers[q.id] === q.correctId)
                    ? `⇥ Passed 3/3! All lessons in ${selectedPlacement.label} are now marked Tested out and Mastered.`
                    : "Score below 3/3. Review the explanations above or adjust your answers and try again."}
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="lessons">
        <h2 id="lessons" className="mb-4 font-display text-2xl">
          Lessons
        </h2>
        <ul className="grid">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
              <div>
                <Link href={r.href} className="font-medium underline-offset-4 hover:underline">
                  {r.title}
                </Link>
                <p className="text-sm text-muted">
                  <span className="num">{r.stepsDone}</span> of <span className="num">{r.steps.length}</span> steps
                  {r.rec?.mastery !== undefined && (
                    <>
                      , best mastery check <span className="num">{formatPercent(r.rec.mastery, 0)}</span>
                    </>
                  )}
                  {r.testedOut && r.stepsDone < r.steps.length && <> · ⇥ Tested out via placement check</>}
                </p>
              </div>
              <span className={`text-sm font-medium ${r.mastered ? "text-success" : r.completed ? "text-accent-2" : "text-muted"}`}>
                {r.mastered ? "★ Mastered" : r.completed ? "✓ Completed" : r.stepsDone > 0 ? "◐ In progress" : "○ Not started"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="challenges">
        <h2 id="challenges" className="mb-4 font-display text-2xl">
          Challenges
        </h2>
        <ul className="grid">
          {challenges.map((c) => {
            const stars = progress.get(`challenge:${c.id}`)?.stars ?? 0;
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4">
                <Link href={`/challenges/${c.id}`} className="font-medium underline-offset-4 hover:underline">
                  {c.title}
                </Link>
                <span className={`text-sm font-medium ${stars ? "text-success" : "text-muted"}`}>
                  {stars ? `${"★".repeat(stars)} Passed` : "○ Not passed"}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
