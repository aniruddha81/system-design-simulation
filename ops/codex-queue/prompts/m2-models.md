You are worker M2 (Focused models: data structures and streams) in a parallel build of this repo. Claude (the lead) and you agreed on docs/PLAN.md together. A previous Codex worker built src/models (hash ring, isolation) with a shared Model<S, A> interface.
First read docs/WORKSTREAMS.md (the rules, plus the "P2 wave 2" section), src/models/README.md, src/models/types.ts and one existing model end to end (src/models/hash-ring), then PLAN.md §6, §19 ("Focused models"), §2 (variants) and Appendix A.

You own ONLY src/models/crdt/**, src/models/matching/**, src/models/spatial/**, src/models/sketches/**, src/models/windowing/**. Do not edit src/models/types.ts or src/models/index.ts. If an index needs your exports, list the lines to add in your final summary. Do not npm install, do not git commit. Other workers are active in other paths, including M1 in other src/models subfolders.

Build each model on the shared Model<S, A> interface: pure, deterministic and seeded, with scenarios as Scripts, invariants, and a seeded variant generator whose answers come from a solver over the model itself.
1. crdt:
   - CRDTs: G-Counter, PN-Counter, OR-Set and an RGA text sequence across replicas, with user-controlled message delivery (reorder, duplicate, delay). The invariant is convergence once all messages are delivered.
   - Operational Transformation for plain-text insert/delete with a central server: the transform functions, and a scenario showing why naive application diverges and transformation converges.
2. matching: a limit order book with price-time priority, market/limit/cancel orders, partial fills, a sequencer assigning sequence numbers, and a trade tape.
   - Invariants: no crossed book after matching; price-time priority respected; quantity conservation.
   - Scenarios: a simple cross, partial fills across levels, a cancel race resolved by sequence order.
3. spatial: geohash encode/decode with precision and neighbours, and a point quadtree with a capacity split. Answer radius / k-nearest queries and show the cells visited. Include the classic geohash edge-boundary case (nearby points with different prefixes) and the fix of searching the neighbours.
4. sketches: a Bloom filter (m, k, false-positive rate measured vs the theoretical (1-e^{-kn/m})^k), a count-min sketch (overestimate bounds), and HyperLogLog (registers, estimate, relative error ≈ 1.04/√m). Use deterministic seeded hashing.
5. windowing: an event-time stream with tumbling, sliding and session windows, watermarks (bounded out-of-orderness), allowed lateness, late-event handling (drop / side output / update), and deduplication by event id.
   - Invariants: window results are emitted only after the watermark passes the window end (plus lateness); dedup never double-counts.

Tests (vitest, *.test.ts next to each model):
- determinism;
- fast-check property tests: CRDT convergence under random delivery orders and duplicates; OT convergence for random concurrent edit pairs; order-book invariants under random order streams; quadtree queries equal brute force;
- Bloom filter has no false negatives;
- count-min never underestimates;
- the HLL error is within 3 standard errors on seeded streams;
- windowing totals equal brute-force aggregation for on-time events;
- every variant solver agrees with the model.
Vitest on this machine needs: `npx vitest run src/models/<your dirs> --configLoader native --pool threads --maxWorkers 1`.
Done = `npx tsc --noEmit` clean for your paths, tests green, `npx eslint` clean for your paths. Finish with a short summary: the exported API per model, the index lines to add, design choices, and test results.
