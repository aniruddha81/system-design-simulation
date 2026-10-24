<!-- title: Complete P2 sandbox breadth (C1) -->
<!-- paths: src/app/sandbox src/app/challenges src/components/sandbox src/lib/run-manager src/content/challenges -->
First read ops/codex-queue/PREAMBLE.md and follow it.

Recovery task: an earlier worker may have been interrupted when the lead's session ended. The original task (worker C1, a Claude agent) was the P2 sandbox breadth in docs/WORKSTREAMS.md: library/inspector for all new component kinds, route step editor for parallel/publish/data/dedup and new conditions, a data model designer, endpoint input generators, a scenario editor (all arrival kinds, CSV replay, presets, 1B/day entry, chaos timeline for every chaos kind), live edits via liveEdit/editAck, region/zone group frames and a region matrix editor, annotations stored in Design.annotations, insertion rules for LB/queue/rate limiter/gateway, export .sds.json/PNG/SVG, elkjs auto-layout, Ctrl+K component search, align/duplicate/copy-paste, results for the new NodeStats fields and all invariants, and a Scale tab mounting ScalePanel from @/components/scale with onHeat painting node heat. Use only design tokens (--kind-*, --heat-*), per docs/DESIGN.md.

Inspect the current state of your paths (git diff / git status). If the work is already complete and its checks pass, just run the checks and report. Otherwise finish it, keeping everything already done. Never discard existing work.

Last known state when the Claude worker stopped: it was debugging React Flow silently not rendering some edges (handle bounds across controlled-node updates). Make sure every edge renders, including after node edits and on reload.
