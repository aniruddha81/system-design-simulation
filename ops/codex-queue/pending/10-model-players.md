<!-- title: Add interactive players and lesson widgets for all focused models -->
<!-- paths: src/components/models src/lib/content/schema.ts mdx-components.tsx src/app/dev src/models/index.ts -->
First read ops/codex-queue/PREAMBLE.md and follow it.

Task: PLAN §6 says every focused model gets an interactive player. src/models contains these models:
- hash-ring and isolation, which already have players in src/components/models (built by a Claude worker);
- raft, clocks, two-phase, gossip and quorum (worker M1);
- crdt, matching, spatial, sketches and windowing (worker M2).
Read src/models/README.md, each model's exports, and the existing players and their widget registration (src/lib/content/schema.ts `widgetSchemas`, mdx-components.tsx `implementations`) before you write anything.

1. If src/models/index.ts does not export the M1/M2 models yet, add the exports (the M1/M2 summaries listed them; read each folder's index).
2. Build one player per model in src/components/models, reusing the existing shared player controls (play/pause/step/scrub over Script actions, user-injected actions, violated-invariant list) and their visual style exactly.
   - raft: nodes in a ring with role/term badges, in-flight messages you can click to deliver/drop, partitions drawn as cut lines, and per-node logs with the commit index.
   - clocks: a space-time message diagram with Lamport/vector/HLC stamps and a happens-before highlight.
   - 2PC/saga: a coordinator/participant swimlane with the compensation path.
   - gossip: an infection grid over rounds plus a phi-accrual chart.
   - quorum: replicas with versions, R/W sets highlighted, hinted handoff.
   - CRDT/OT: replicas side by side converging as messages deliver.
   - matching: a live order book ladder with the trade tape.
   - spatial: geohash grid / quadtree cells with the query radius and visited cells.
   - sketches: a bit array / counter matrix / HLL registers with the measured vs theoretical error.
   - windowing: an event-time vs processing-time plot with the watermark line and windows.
   Every player needs a text alternative and keyboard operation.
3. Register each player, plus one seeded variant question per model, as lesson widgets with zod props, matching the existing entries' pattern exactly.
4. Add them all to the /dev/preview author preview.
Tests: vitest for any non-trivial pure view logic (layout maths), and `npm run build`.
