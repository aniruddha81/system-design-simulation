<!-- title: Add case studies 14-26 with runnable designs and failure scenarios -->
<!-- paths: content/en/case-studies src/content/case-studies -->
First read ops/codex-queue/PREAMBLE.md and follow it. A previous task created src/content/case-studies (the CaseStudy type, the registry and tests) and content/en/case-studies with case studies 1–13. Read them fully, plus PLAN.md §3 (Track 5), and follow the exact same format, quality and test pattern.

Task: add case studies 14–26:
- web crawler, typeahead, search engine;
- Google Docs (OT/CRDT), Dropbox/file sync;
- payment system, ticket booking, hotel booking;
- leaderboard, ad-click aggregation, metrics/monitoring system, job scheduler;
- stock exchange (matching engine).

Each one has a runnable reference design, alternatives, runnable failure scenarios with expectations, deep dives, a rubric, clarifying questions and common mistakes.
- Payment system and ticket booking must showcase the correctness invariants: duplicateEffect with/without the dedup store, and oversell with read-then-write vs decrementIfPositive.
- Stock exchange must showcase orderingViolated.
Link each case study to the relevant focused-model widgets where they exist (matching engine, CRDT/OT).
Extend the registry test so every case study's scenarios validate and run briefly. For the invariant showcases, assert that the "bad" variant triggers its violation and the fixed design does not.
