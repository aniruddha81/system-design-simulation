`createDataStore(entity, rng)` creates a new deterministic dataset. Use a fresh
`Random(seed, componentId)` per entity/run. Dataset keys are numeric strings from
`dataset.keys`; sampling is without replacement. `count` must fit the keyspace.
Seeded keys also accept endpoint prefixes such as `user:42`. Field sizes are
stored as byte counts, so large fields do not allocate large strings.

`apply(op, key, nowUs)` returns status, version, found, rowsScanned and costUnits.
`DataOperation` accepts optional `values`, update `value`, and `expectedVersion`;
the shared `DataOp` remains accepted. Pass the preceding read's version for a
conditional put. Initial versions are 1; successful writes increment per key,
including reinserts after deletion. Rejections leave data/indexes unchanged.

`read(key)` returns a detached record including values and fieldBytes.
`snapshotVersion(key)` returns undefined when missing. `shardFor(key, shardCount)`
hashes the shard field, falling back to the primary key. Shard count belongs to
the engine's node configuration, not EntitySpec.

Secondary queries accept a scalar string for single-field indexes or a canonical
JSON tuple for composite indexes. Unindexed queries scan the entire live entity.
`dataCostUs(op, entity, sampledBaseUs)` uses one microsecond per scanned/returned
row and per B-tree level; E1 owns queues, sampling, elapsed time and replication.
