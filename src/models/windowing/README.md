# Event-time windows

`createWindowingModel(options?)` returns `Model<WindowState, WindowAction>`.
Options default to `kind: "tumbling"`, `size: 10`, `slide: 5`, `gap: 10`,
`outOfOrderness: 10`, `allowedLateness: 5`, `latePolicy: "update"`.
Durations/timestamps use caller-chosen integer units, independent of wall time.
Events have `{ id, time, value, key? }`; missing keys use the empty string.

`event` actions deduplicate globally by ID before aggregation. Duplicate IDs
are ignored even if their payload changes or the first event was rejected.
Tumbling/sliding windows use half-open `[start, end)` ranges anchored at zero
(including negative times); sliding windows may overlap or have gaps.
Session windows group by key, extend through last-event-time+gap and merge on
overlap. Events exactly gap apart start distinct sessions. A delayed bridge can
merge open sessions; a bridge touching any finalized session is rejected whole.

Watermarks start at -Infinity. After a unique event they advance monotonically
to `max(previous, maxEventTime - outOfOrderness)`. Explicit `watermark` actions
must also be monotonic. Classification uses the prior watermark so an event
does not make itself late. For each target window:

- Before the watermark passes its end, the event is accepted.
- Once the watermark passes its end, `drop` records the event in `dropped`,
  `sideOutput` records it in `sideOutput`, and `update` revises the buffered
  aggregate while the watermark is at most end+allowedLateness.
- After watermark > end+allowedLateness, all policies reject updates; sideOutput
  keeps them separately, and the other policies record them as dropped.

These are **final emissions only**: `emissions` receives one immutable result
per window strictly after watermark > end+allowedLateness. There are no early
results or retractions. A sliding event can be accepted by an open target and
also appear once in the rejection output for another target. Empty windows are
not emitted. The input stream is not implicitly completed; advance the watermark
far enough to finalize the remaining results.

`windows` exposes buffered events, count, sum and `emittedAt`; `seen` and
`duplicates` expose deduplication. `windowingInvariants` checks final emission
timing, exact totals, per-window unique event IDs and frozen final results.
`windowingScenarios` supplies disorder/dedup, late updates and session bridging;
the bridge example is intended for session mode. `generateWindowingVariant` /
`solveWindowingVariant` replay seeded inputs to return final window aggregates.
All APIs and action/options/config/state/window/emission types are exported.

History and dedup IDs are retained indefinitely for replay/inspection; there is
no state eviction, external sink, partition-idleness protocol or crash recovery.
