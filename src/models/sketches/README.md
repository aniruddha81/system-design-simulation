# Bloom, count-min and HyperLogLog

`createSketchModel(options?)` returns `Model<SketchState, SketchAction>`. Each
`add { key, count? }` updates all three structures; count defaults to one and
must be a positive safe integer. Duplicates affect frequency, not distinctness.
`probe { keys }` records unique test keys for measured Bloom false positives.
Hashing uses the shared deterministic seeded 32-bit hash; it is not cryptographic.

Options default to `bloomBits: 1024`, `bloomHashes: 4`, `width: 128`, `depth: 4`,
`hllPrecision: 8`. State exposes Bloom `bits`, count-min `table`, HLL `registers`
and exact `counts`/`total` as a teaching oracle for error measurement.

- `bloomContains(state, key)` tests membership. `bloomStatistics` returns
  `theoretical = (1 - exp(-k*n/m))^k`, `measured` and absent probe count.
  Here n is distinct inserted keys; an empty probe set reports measured zero
  and probe count zero rather than implying a statistical measurement.
- `countMinEstimate(state, key)` returns the minimum row count.
  `countMinBounds` exposes epsilon=e/width, delta=exp(-depth), and additive error
  epsilon*total: under independent uniform hashing, a fixed key's estimate is
  between its actual count and actual+epsilon*total with probability ≥1-delta.
  No underestimate is deterministic for these positive-only updates; the upper
  error bound is probabilistic, not an invariant of every key/seed.
- `hllEstimate` uses m=2^precision registers, leading-zero ranks, standard alpha
  constants, small-range linear counting and the 32-bit large-range correction.
  `hllStatistics` returns estimate, exact cardinality, signed relative error,
  and standardError=1.04/sqrt(m). Precision is 4..16. Three standard errors is a
  seeded statistical test, not a universal per-stream guarantee.

`sketchInvariants` checks Bloom false negatives, count-min underestimates/row
totals and HLL register bounds. `sketchScenarios` demonstrates duplicate updates
and seeded measurement. `generateSketchVariant` / `solveSketchVariant` expose
seeded replay inputs and return membership, frequency estimate and cardinality.
The folder exports these APIs and config/state/action/variant types.

Exact counts and probe history deliberately consume linear memory for teaching;
this state wrapper is not a production sublinear-memory stream processor.
