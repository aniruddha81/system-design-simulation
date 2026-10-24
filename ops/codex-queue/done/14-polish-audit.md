<!-- title: Integration audit and polish across the app -->
<!-- paths: src docs/AUDIT.md -->
First read ops/codex-queue/PREAMBLE.md and follow it. You run last, after every other task in this queue, so you may edit anything under src/ to fix integration problems. Keep each fix minimal and do not redesign.

Task:
1. Run the full checks: `npx tsc --noEmit`, `npx eslint .`, the full vitest suite (with the flags from the preamble), `npm run build`, and if e2e exists, `npx playwright test`. Fix every failure.
2. Wire up the loose ends earlier tasks reported in their summaries, which are in ops/codex-queue/logs/*.result.md. For example:
   - mount the CommandPalette in the layout;
   - add nav entries for Case studies and Interview;
   - support opening reference designs in the sandbox via `?ref=`;
   - add any missing package.json scripts (you may edit package.json scripts only; never install).
3. Check that every route in the PLAN §4 IA exists, links resolve, unknown slugs give the branded 404, and no page hard-codes colours (grep for hex/rgb/oklch in src/components and src/app outside globals.css and the OG images; replace them with tokens).
4. Write docs/AUDIT.md: what you checked, what you fixed, and the remaining known gaps against PLAN.md, phase by phase.
