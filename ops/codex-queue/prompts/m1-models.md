You are worker M1 (Focused models: consensus and time) in a parallel build of this repo. Claude (the lead) and you agreed on docs/PLAN.md together. A previous Codex worker built src/models (hash ring, isolation) with a shared Model<S, A> interface.
First read docs/WORKSTREAMS.md (the rules, plus the "P2 wave 2" section), src/models/README.md, src/models/types.ts and one existing model end to end (src/models/hash-ring), then PLAN.md §6, §19 ("Focused models"), §2 (variants) and Appendix A.

You own ONLY src/models/raft/**, src/models/clocks/**, src/models/two-phase/**, src/models/gossip/**, src/models/quorum/**. Do not edit src/models/types.ts or src/models/index.ts. If an index needs your exports, list the lines to add in your final summary. Do not npm install, do not git commit. Other workers are active in other paths, including M2 in other src/models subfolders.

Build each model on the shared Model<S, A> interface: pure, deterministic and seeded, with scenarios as Scripts, invariants, and a seeded variant generator whose answers come from a solver over the model itself.
1. raft:
   - terms, randomized election timeouts from the seed, RequestVote and AppendEntries as explicit in-flight messages that the user can deliver, drop or delay, partitions and heal, client proposals, commit index, leader stickiness;
   - invariants: Election Safety, Log Matching, Leader Completeness, State Machine Safety;
   - scenarios: normal election, leader crash, split vote, minority partition (stale leader cannot commit), and partition heal with log repair;
   - no membership changes (this limitation is listed in Appendix A).
2. clocks: physical clocks with drift and skew, Lamport, vector clocks and HLC over a message diagram. Detect happens-before vs concurrent, and show a physical-timestamp ordering anomaly. Scenarios: one per clock type plus a "last-writer-wins loses an update under skew" case.
3. two-phase:
   - 2PC: coordinator and participants, prepare/vote/commit/abort, coordinator crash after prepare (blocking shown as an invariant/notice), participant timeout;
   - Saga: steps with compensations, a failure mid-way, compensation order (reverse), and a non-compensatable step;
   - transactional outbox: as a scenario variant.
4. gossip: push/pull/push-pull rounds with fanout, infection curve vs rounds; and a phi-accrual failure detector over heartbeat inter-arrival history with a threshold, showing false positives vs detection time trade-off.
5. quorum: N replicas, R/W quorums, sloppy quorum + hinted handoff, read repair, and tombstones with GC (tombstone resurrection when GC runs before repair). The invariant is "a read returns the latest acked write" when R+W > N, and it is shown to fail otherwise.

Tests (vitest, *.test.ts next to each model):
- determinism;
- fast-check property tests for Raft safety (election safety and log matching under random partitions, drops and delays);
- vector-clock happens-before matches a brute-force causal graph;
- 2PC never has a participant commit while another aborts;
- the saga compensates in reverse;
- gossip reaches all nodes in O(log n) rounds in expectation, statistically and with seeded runs;
- quorum staleness appears iff R+W ≤ N, or sloppy-quorum cases, as specified;
- every variant solver agrees with the model.
Vitest on this machine needs: `npx vitest run src/models/<your dirs> --configLoader native --pool threads --maxWorkers 1`.
Done = `npx tsc --noEmit` clean for your paths, tests green, `npx eslint` clean for your paths. Finish with a short summary: the exported API per model, the index lines to add, design choices, and test results.
