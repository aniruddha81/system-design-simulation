# CRDTs and central text OT

`createCrdtModel({ replicas? })` returns `Model<CrdtState, CrdtAction>` with A/B/C
by default. `crdtView(replica)` exposes G-counter components/value, PN positive
and negative components/value, the sorted OR-set, RGA elements/tombstones and text.
All four structures coexist so one replay can compare their behavior.

Local actions are `increment` (`counter: "g" | "pn"`), `add`, `remove`, `insert`
and `delete`. Text indices/counts use Unicode code points. Each local operation
broadcasts its replica's known operation set to the others. Operation IDs are
unique per origin and sequence; delivery merges by ID. This implements counters
as unique per-origin increments, observed-remove add tags, and RGA parent links
with deterministic descending Lamport/replica ordering for concurrent siblings.
Deleted RGA parents remain as tombstones so their children stay reachable.

`deliver` selects any message ID, `duplicate` creates another envelope, and
`delay` keeps an envelope pending and increments its visible delay count. There
is no automatic clock or delivery: simply leaving an envelope pending also
delays it. `deliverAll` drains the queue. `crdtInvariants` checks unique operation
application and convergence after the queue drains. `crdtScenarios` supplies
counter duplicates, observed-remove concurrency, and concurrent RGA edits.

`createOtModel({ text?, clients?, mode? })` is a separate central-server model;
defaults are text `ab`, clients A/B and mode `transform`. `edit` creates one
outstanding local insert/range-delete per client, `server` receives that client's
submission, and `receive` delivers its next server revision in order. The server
rebases submissions from their acknowledged revision; clients transform remote
edits against their outstanding edit. `flush` receives all submissions and then
all client revisions. An acknowledgement frees the client to edit again.

`textOperation(text, edit, id)` builds retain/insert/delete components;
`applyTextOperation`, `transformPair` (returns `[a after b, b after a]`) and
`transformOperation` are independently usable. Operations require identical base
lengths and distinct stable IDs; insertion ties sort by ID. OT positions use
JavaScript UTF-16 code units. Empty transformed operations are valid no-ops.
The `naive` mode applies original positions unchanged, exposing convergence
violations in `otScenarios[0]`; transform mode converges on the same script.

`generateCrdtVariant` / `solveCrdtVariant` and `generateOtVariant` /
`solveOtVariant` expose seeded inputs and obtain answers by stepping the models.
All APIs and their action/state/config types are exported from this folder.

These are teaching models: operation logs, messages and RGA tombstones are kept
for inspection, with no compaction or causal-stability garbage collection. OT
uses one outstanding edit per client and reliable ordered server revisions;
it does not model an offline editor, reconnect protocol or grapheme selection.
