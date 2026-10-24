# Handoff: keeping the build loop running

The lead (Claude) plans, verifies and commits. Codex executes the queued work in `ops/codex-queue/` (see its README). If Claude's session ends or hits its limit, the work continues like this:

1. **Start the Codex runner** in your own PowerShell window. Leave it open; it survives Claude's session.

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File E:\system-design-simulation\ops\codex-queue\run.ps1
   ```

2. **Lift the gate** if `opsdex-queueHOLD` exists (Claude lifted it on 2026-10-24; it only reappears if Claude adds it again):

   ```powershell
   Remove-Item E:\system-design-simulation\ops\codex-queue\HOLD
   ```

   The queue then runs wave by wave:
   - 05–06 finishes any interrupted P2 work (engine, models, content, sandbox, Scale panel, visual identity);
   - 10–14 builds P3–P6 (model players, case studies, CI/e2e, Track 2–4 content, interview mode, planet-scale designs, search/SEO, the landing page, and the final audit).

   Each task that reports `RESULT: PASS` is committed automatically, one single-line commit per task.

3. **When Claude is back**: Claude reads `ops/codex-queue/logs/*.result.md` and `failed/`, verifies and fixes, deletes any queued recovery task it already handled, and enqueues the next work.

Progress at a glance: `ops/codex-queue/logs/runner.log`.
