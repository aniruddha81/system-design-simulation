<!-- title: Embed focused-model players in Track 2 lessons -->
<!-- paths: content/en/distributed-systems content/matrix.json -->
First read ops/codex-queue/PREAMBLE.md and follow it.

Task: the Track 2 lessons in content/en/distributed-systems were written before the focused-model player widgets were registered. They are now registered in src/lib/content/schema.ts (`widgetSchemas`); read those entries and their zod props first. Embed the players at these steps:
- **Raft**: consensus.mdx steps `election`, `commit`, `partition`; leader-election.mdx step `leader-reads`. Add a model variant question on the commit index.
- **Clocks**: clocks.mdx steps `lww` (scenario "last-writer-wins loses an update under skew"), `lamport`, `vector`, `hlc`.
- **Two-phase**: sagas.mdx steps `blocking` and `in-doubt` (coordinator crash after prepare), `compensate` (saga failure with reverse compensation), `outbox`.
- **Gossip**: gossip.mdx step `epidemic`; steps `phi` and `threshold` (phi false positive / failure detection).
- **CRDT**: crdts.mdx steps `counter` (reordered and duplicated counter messages), `sets` (OR-Set add wins), `sequence-crdt` (concurrent RGA edits), and `ot` (the OT model).
- **Quorum**: consistency-models.mdx step `eventual`; cap-pacelc.mdx step `classify` (quorum overlap, sloppy quorum and hinted handoff).
Pick the scenario names that actually exist in each model's `scenarios`. Then add "M" to those lessons' `activities` and to their matrix.json rows. Keep every existing step and question. The content tests must pass.
