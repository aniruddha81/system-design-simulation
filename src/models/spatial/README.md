# Geohash and point quadtree

`geohashEncode(latitude, longitude, precision = 6)` accepts latitude -90..90,
longitude -180..180 and precision 1..12. `geohashDecode(hash)` returns the cell's
`minX/maxX/minY/maxY` bounds and center `latitude/longitude`.
`geohashNeighbours(hash)` returns unique adjacent cell hashes, wraps longitude
at the dateline and omits cells beyond the poles.

`geohashCandidates(points, center, precision, neighbours = true)` selects points
in the center cell and optionally its immediate neighbours. Points use
`{ id, x, y }`, with x=longitude and y=latitude for geohash functions. The edge
scenario demonstrates that ±0.0001 longitude can have different first prefixes;
searching adjacent cells recovers the nearby point. This helper is a candidate
cover, not a general radius query: radii beyond the adjacent cells need a larger
cover and exact distance filtering.

`createSpatialModel({ capacity?, bounds?, points? })` returns a
`Model<SpatialState, SpatialAction>`. Defaults are capacity four and world bounds.
`insert` requires a unique ID within bounds; `radius` and `nearest` save their
result in `state.result`. `radiusQuery(tree, center, radius)` and
`nearestQuery(tree, center, k)` are directly usable and return `{ points, visited }`.
Visited entries contain cell IDs and bounds. Results sort by distance, then ID;
ties at the kth distance are resolved by ID. Queries prune cells by minimum
possible distance to their bounding rectangle.

Cells split at capacity; duplicate-coordinate leaves and depth-24 leaves can
exceed capacity to keep splitting finite. Insertion rebuilds the teaching tree.
All query distances use Euclidean **coordinate units**, not kilometres or
spherical distances. Tree queries do not wrap at the dateline.

`spatialInvariants` checks unique point placement in containing leaves;
`spatialScenarios` supplies boundary and split/query examples.
`generateSpatialVariant` / `solveSpatialVariant` generate seeded inputs and solve
point-ID answers through the model. The folder exports these functions and all
associated point, bounds, tree, action, state and options types.
