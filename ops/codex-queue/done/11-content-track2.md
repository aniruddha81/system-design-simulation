<!-- title: Add Track 2 distributed-systems lessons -->
<!-- paths: content/en/distributed-systems content/matrix.json src/lib/content/variants.ts -->
First read ops/codex-queue/PREAMBLE.md and follow it. Then read PLAN.md §2, §3 (Track 2), §9 and Appendix A; content/en/building-blocks/caching.mdx (the quality bar and format); src/lib/content/schema.ts (frontmatter and registered widgets, which now include the focused-model players and their variant questions); src/lib/content/variants.ts; src/lib/content/content.test.ts; and content/matrix.json.

Task: write every Track 2 (distributed-systems) lesson from §3:
- CAP and PACELC;
- consistency models;
- consensus (Raft);
- leader election with leases and fencing tokens;
- clocks;
- idempotency;
- retries/backoff/jitter;
- timeouts and deadlines;
- circuit breakers;
- bulkheads;
- load shedding;
- distributed transactions (2PC, sagas, outbox);
- CRDTs and OT;
- gossip and failure detectors.
Merge closely related topics into one lesson where the plan's matrix does (check content/matrix.json `lessons`), add missing lesson entries to `lessons`, and set the live ones to status "live".

Each lesson follows the caching.mdx structure:
- 2–5 objectives;
- 6–10 steps, each interactive;
- the matching focused-model player widget wherever a model exists (raft, clocks, two-phase, gossip, quorum, crdt);
- seeded VariantQuestion templates with solvers and per-mistake feedback (appended to variants.ts);
- choice questions with per-distractor feedback;
- a MasteryCheck;
- real cited sources (for example Ongaro & Ousterhout 2014 for Raft, Lamport 1978, Brewer, Abadi 2012 PACELC, Garcia-Molina & Salem 1987 for sagas, Shapiro et al. 2011 for CRDTs, Hayashibara et al. 2004 for phi accrual);
- limitations;
- lastReviewed 2026-10-24.
Where a runnable sandbox fixture exists (retry storm + circuit breaker, idempotent payments, split brain), link to /sandbox. Update the Appendix A rows in matrix.json. The content tests must pass.
