# Quorum replication

`createQuorumModel({ n?, r?, w?, sloppy?, spares?, gcGrace? })` returns
`Model<QuorumState, QuorumAction>`. Defaults: N=3, R=W=2, strict quorum,
two optional sloppy spares, GC grace ten ticks. N0..N(N-1) are the fixed home
preference list; extra nodes are spare holders. This focused model uses one key
preference list, not a hash ring or Merkle-tree implementation.

`write` accepts a key, string value (`null` is a tombstone), and optional replica
IDs. Writes reach every selected live replica and are acknowledged at W distinct
responses. Incomplete writes persist without advancing `latestAcked`. `read`
requires at least R distinct live responses and selects the highest modeled
version. Default operations choose the first available preference-list entries;
explicit replica IDs let the learner construct adversarial quorum intersections.
Sequential writes use a monotonic version sequencer, separate from physical time.

`read` with `repair: true` repairs the responding replicas; `repair` performs
anti-entropy over its selected live set. Sloppy writes to spares create hints for
missing home replicas; `handoff` delivers hints only while holder and target are
live. Sloppy read and write sets can fail to overlap even when R+W>N.

`advance` and `gc` remove tombstones old enough for the configured grace period.
GC deliberately does not check that all replicas were repaired: a recovering
replica's old value may then win repair and resurrect deleted data. Repair before
GC prevents this in the supplied safe counterexample. Missing data and an actual
tombstone both represent absence to a read.

`quorumInvariants` reports historical `staleRead` witnesses. Freshness means at
least the latest acknowledged version (a newer incomplete write may be visible).
The R+W>N argument assumes fixed home quorums, sequential writes, successful
acknowledgements and retained versions/tombstones. R+W<=N permits a stale read,
but does not force every possible read set to be stale. Sloppy quorum and early
GC invalidate those assumptions. The scripts show overlap, read repair, unsafe
GC and (when enabled) hinted handoff. An unacknowledged delete has no durability
guarantee, including configurations with W=N and one unavailable home replica.

`generateQuorumVariant` / `solveQuorumVariant` in `variants.ts` produce explicit
read/write schedules and solve whether any read is stale by replaying the model.
