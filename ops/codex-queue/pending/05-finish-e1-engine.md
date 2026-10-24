<!-- title: Complete P2 Exact engine breadth (E1) -->
<!-- paths: src/engine/simulation.ts src/engine/validation.ts src/engine/grading.ts src/engine/engine.worker.ts src/engine/core.ts src/engine/fixtures.ts src/engine/index.ts src/engine/types.ts src/engine/CHANGES.md src/engine/engine.test.ts src/engine/p2.test.ts src/engine/components.test.ts src/engine/worker.test.ts src/engine/bench -->
First read ops/codex-queue/PREAMBLE.md and follow it.

Recovery task: an earlier worker may have been interrupted when the lead's session ended. The original task is ops/codex-queue/prompts/e1-engine.md, and its continuation note says: E2 landed src/engine/data and src/engine/workload, so use them; bump REPLAY_COMPAT_ID and regenerate goldens with UPDATE_GOLDEN=1 at the end; keep src/engine/scale tests green without editing scale.

Inspect the current state of your paths (git diff / git status). If the work is already complete and its checks pass, just run the checks and report. Otherwise finish it, keeping everything already done. Never discard existing work.
