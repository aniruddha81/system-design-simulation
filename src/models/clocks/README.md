# Clocks

`createClocksModel({ nodes?, clock? })` returns `Model<ClocksState, ClocksAction>`.
Each node has a physical skew in milliseconds and drift in parts per million.
All four timestamp types are retained on every event: physical, Lamport, vector
and HLC. `setClock` selects the teaching view and physical-order anomaly notice.

`local`, `write`, `send`, `receive`, `advance` and `configure` build a message
diagram. Events expose local and message `parents`; messages reference their send
event and are explicitly delivered by ID. Send IDs are m1, m2, ...; event IDs are
e1, e2, ... in execution order. `advance` moves simulated physical time;
`configure` can jump a node's physical clock backwards without rewinding HLC.

`compareVectors` returns `before`, `after`, `equal` or `concurrent`.
`causalRelation` independently traverses graph edges; `compareHLC` orders HLC
pairs and `physicalTime` evaluates a node's drift/skew at simulated time.
Lamport/HLC order preserves causal edges but cannot establish that unrelated
events are causal. The vector dimension order is the configured node order.

`write` also updates a physical-timestamp LWW register. Sends carry that register;
receives merge it. Equal timestamps break ties by event ID. A local write may be
discarded after observing a causally earlier write from a fast clock. The
`lwwLostUpdate` notice records this independently of the selected clock view.
`clocksInvariants` checks vector order against the graph, Lamport/HLC causal
order, physical timestamp inversions/ties and discarded LWW writes.

The five scripts cover physical, Lamport, vector, HLC and LWW under skew.
`generateClocksVariant` and `solveClocksVariant` (in `variants.ts`) ask for the
causal relation of two events; the solver traverses the replayed diagram.
This is a fixed-node message diagram, not clock synchronization or an NTP model.
