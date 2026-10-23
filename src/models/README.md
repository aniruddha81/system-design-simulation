# P3 focused models

Pure deterministic TypeScript, independent of the DOM and operational engine.
The public entry point is `src/models/index.ts`. No clock, random global, storage,
or UI state enters a model. Seeds are safe integers; placement uses a seeded
32-bit non-cryptographic hash.

## Shared contract and replay

`Model<S, A>`, `Violation`, and `Script<A>` live in `types.ts`.
A script has a name, description, and ordered actions. Factories capture their
configuration; `step` returns a new state without modifying the previous state.
Scrub to cursor `i` with:

```ts
const model = createHashRingModel();
const script = model.scenarios[0];
const state = script.actions.slice(0, i).reduce(model.step, model.init(seed));
```

## Hash ring

`createHashRingModel({ nodes?, vnodes?, keys? })` defaults to A/B/C, 32 virtual
nodes per physical node and 1,000 keys. Actions are `addNode`, `removeNode`,
`setVnodes`, and `addKeys`. `actions(state)` supplies executable examples; callers
can construct actions with their own node names and keys.

State exposes sorted `ring` positions (unsigned 32-bit integers), sorted unique
`nodes`/`keys`, `ownership`, `load`, and `movedKeys`. Collisions break ties by node
name and vnode index; key ownership is the first clockwise position, wrapping
around zero. New keys are assignments, not movements. Removing a missing node or
adding an existing node is idempotent; removing the last node throws. Limits are
128 physical nodes, 1,024 virtual nodes per node, and 10,000 keys.

`hashRingScenarios` demonstrates add/remove and one versus 128 virtual nodes on
the default topology. `loadStandardDeviation(state)` measures load skew.
Virtual nodes improve balance statistically, not for every seed/key sample.
The property test compares aggregate standard deviations over seeded batches.
`compareModuloHashing(keys, beforeNodes, afterNodes, seed)` returns both owner
maps and movement counts using sorted physical-node indices and `hash(key) % N`.

`generateHashRingVariant(seed)` creates a removal question, including all inputs.
`solveHashRingVariant(variant)` obtains the movement count by stepping the model.

## Isolation scheduler

`createIsolationModel(level, definition?)` accepts `readCommitted`, `snapshot`,
or `serializable`, plus initial numeric values and transaction programs. The
default definition is the non-repeatable-read scenario. `isolationScenarios`
exports all five canonical scripts with their required initial state/programs;
construct a model for each scenario to obtain its replayable `scenarios` list.

Each transaction contains `read`, `rangeRead`, `write`, `commit`, or `abort` ops.
A range is an inclusive lexicographic `[from, to]` key predicate. A write uses a
number, `null` (delete), or `{ read: key, delta: number }` evaluated from the most
recent observation of that key. Reading a missing key yields `null`; a missing
numeric operand is an error. Every program ends with one commit/abort. An
`{ type: "execute", transaction: "T1" }` action attempts the next operation.

- Transaction start is implicit on its first scheduled action, including a
  blocked attempt. This is the snapshot timestamp.
- Read Committed reads the latest committed version per operation plus its own
  writes. Exclusive write locks last until termination, preventing dirty writes.
- Snapshot reads its start-time MVCC versions plus its own writes. Writers stage
  privately; first-committer-wins aborts a transaction if any written key was
  committed by another transaction after its start.
- Serializable uses strict two-phase locking: shared point/range locks and
  exclusive point-write locks, all held until commit/abort. Range locks include
  absent keys, so inserts/deletes cannot evade a predicate lock. A wait-for cycle
  aborts the transaction whose request creates the deadlock; locks then release.
  There are no implicit retries.

Blocked attempts do not advance the program counter. `waitFor`, `locks`,
transaction status/reason, versioned `database`, `reads`, and `history` expose why
an action executed, waited, or aborted. Selecting a terminated transaction is a
new-state no-op; selecting an unknown transaction throws. A write-expression
error also leaves the caller's state untouched.

`detectAnomalies(state)`, `state.anomalies`, and `model.invariants(state)` report
the same observed anomaly violations, with transaction IDs and affected keys.
Detection uses read versions and committed writes, never scenario labels:

- dirty read: another transaction's uncommitted version was observed;
- non-repeatable read: repeated point reads returned different committed values,
  excluding the reader's own intervening writes;
- phantom: a repeated identical range changed membership, excluding own writes;
- lost update: a committed write overwrote an intervening update after reading an
  older version of that key; a refreshed read before writing updates that basis;
- write skew: committed transactions form a cycle of read/write anti-dependencies
  across disjoint write sets (including predicates and missing keys).

`runIsolationScenario(level, scenario, seed?)` performs the scripted interleaving
and then finishes delayed operations, choosing the first runnable transaction in
definition order. The extra attempts are recorded in history. To scrub the exact
attempted interleaving without this completion phase, replay `scenario.actions`
directly with the model. Live UI stepping can continue with `model.actions`.

### Expected outcomes for these canonical schedules

| Anomaly | Read Committed | Snapshot | Serializable |
|---|---|---|---|
| Dirty read | prevented | prevented | prevented |
| Non-repeatable read | allowed | prevented | prevented |
| Repeated-range phantom | allowed | prevented | prevented |
| Lost update | allowed | prevented | prevented |
| Write skew | allowed | allowed | prevented |

`expectedOutcomes` exports this table. These are schedule-specific outcomes for
the algorithms above, not promises about every vendor's named isolation level.
The definitions follow [Berenson et al. (1995), *A Critique of ANSI SQL Isolation
Levels*](https://arxiv.org/abs/cs/0701157) and the snapshot/first-committer-wins
definition and write-skew analysis in [Fekete et al. (2005), *Making Snapshot
Isolation Serializable*, §1.1](https://www.cse.iitb.ac.in/infolab/Data/Courses/CS632/2009/Papers/p492-fekete.pdf).
Berenson's broader P3 can sometimes occur under snapshot isolation; this table's
phantom means a changed result on an actual repeated predicate (A3-style), which
a fixed snapshot prevents. It does not claim snapshot isolation is serializable.

`generateIsolationVariant(seed)` selects a level, schedule and numeric parameters;
`solveIsolationVariant(variant)` returns sorted observed anomaly codes, or `[]` if
prevented, by executing the model. Assessment UIs should show the operations and
initial values, not scenario names/labels, which identify the teaching example.

### Scope and checks

This is an educational numeric key/value scheduler, not SQL execution. Predicates
cover key ranges, with conservative locks; there are no indexes, constraints,
timeouts, automatic retries, or a database vendor emulator. Transaction programs
are straight-line; anomaly detection reports observed read changes and committed
write conflicts/cycles, not every possible integrity constraint violation.

Tests check every table cell, deterministic immutable replay/scrub prefixes,
MVCC start/own-write/conflict behavior, dirty-read guards, range-lock blocking,
deadlock recovery, and solver consistency. Random serializable interleavings are
also compared against an independent enumeration of serial transaction orders,
checking both committed read observations and the final database.
