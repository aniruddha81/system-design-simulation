# Illustrative planet-scale references

`index.ts` exports `referenceDesigns: ReferenceDesign[]`. Each contains an editable `Design`, an `illustrative` label, assumptions with optional public sources, and six `{ id, title, mode: 'scale', description, scenario }` entries. Source-free values are explicitly illustrative. Public figures are dated context, not evidence for the invented topology, capacities or API rates. No production configuration is claimed.

Use `checkFidelity` before displaying predictions; correctness is always unknown. In particular, the five write-heavy celebrity scenarios intentionally use hotspot keys, so contention disables affected flow/latency/timely-success predictions. Google search is read-only. Video celebrity scenarios use a stationary, more concentrated Zipf distribution from the start; they do not simulate a popularity shift. DDoS means an application traffic multiplier, without distinguishing attack traffic from legitimate traffic.

The paired regional clients split load equally. Regional membership and the directional `Design.regions` matrix affect real request paths. There is no automatic evacuation to another entry when a region fails; shared dependencies can take both cells down. Queue acknowledgement does not imply delivery. Group/follower amplification, payment correctness, index freshness and real video bitrate adaptation are outside these sketches.

## Reproduce the observed ladders

The lessons report the first three rungs from an **independent normal-day sweep**, at 1x, 4x and 16x, with 2 s warm-up and 8 s measurement per level, fixed 250 ms steps, and no sweep drain. These short runs cannot satisfy the engine's 30 s steady-state detector: levels report `unstable — no steady state`. These are diagnostic windows, not precise breaking-point estimates. Tests snapshot those three rungs to keep the narratives tied to observations. Longer runs, finer steps and what-if runs are learner experiments, not verified remedies.

An engine edge holds at least 1 microsecond per exchange, so its effective capacity is at most about 1 million exchanges/s even when configured bandwidth would allow more. Several ladders therefore show `edge:*` saturation at that numerical ceiling. Do not interpret that as a measured network bandwidth limit. Also, endpoints reuse fixed response bytes on internal calls; they do not model separate metadata and media payloads. Both restrictions matter when extrapolating these aggregates.

## Integration for the lead (outside this task's paths)

- Register `reference-designs` in `src/lib/content/schema.ts`'s `TRACKS` and add all eight lessons to `content/matrix.json`. Until then, the standard loader does not discover this directory. The local MDX test checks the lesson contract with only the new track literal extended; it does not register the track globally.
- Resolve `/sandbox?ref=<id>` against `referenceDesigns`, clone its design and default `normal-day` scenario, and select the Scale tab. Optional `/sandbox?ref=<id>&scenario=<scenario-id>` selects a pack entry by its short ID. Reject unknown IDs through the existing empty/error flow. No query handling or routes are implemented here.
- IDs: `youtube`, `whatsapp`, `uber`, `twitter-timeline`, `netflix-cdn`, `stripe-payments`, `discord`, `google-search`.
- Scenario IDs: `normal-day`, `peak-event`, `region-outage`, `hot-key-celebrity`, `dependency-brownout`, `ddos`. Engine scenario IDs are prefixed with the reference ID.
- Show assumptions, source links, the illustrative label and disabled-prediction reasons alongside results. Clone before modifications so module-level templates remain unchanged.
- After registration, check lesson rendering and sandbox selection visually. Build/browser checks are delegated to the lead by the queue preamble.
