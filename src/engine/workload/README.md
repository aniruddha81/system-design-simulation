`arrivalRate(arrival, tUs, durationUs = 300_000_000)` returns instantaneous rps.
Pass warmup + measure as the third argument for scenario-length ramps. Replay
interpolates linearly and holds the endpoint rates outside the supplied points.
The engine owns arrival scheduling and Poisson interarrival sampling.

`sampleInput(gen, rng)` supports uniform/Zipf inclusive integers, sequence counters
scoped to generator identity and RNG, and non-negative normally distributed byte
sizes. Fresh run RNGs reset sequences. `sampleKey(dist, rng, sequence)` supports
the shared key distributions. `renderKey(template, inputs)` throws on a missing
placeholder instead of generating an ambiguous key.

`parseReplayCsv(text)` accepts an optional `atUs,rps` header and two numeric
columns. Times are integer microseconds and strictly increasing; maximum input is
1 MiB and 10,000 points. It never executes cells. `toPeakRps(perDay, peakFactor)`
requires a finite daily volume ≥ 0 and peak factor ≥ 1.

Fresh workload presets: `launchDaySpike`, `diurnal`, `viralKey`, `ddos`,
`batchBackfill`. Each optionally accepts the endpoint id.
