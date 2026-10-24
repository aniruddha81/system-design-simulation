<!-- title: Add CI workflow, Playwright e2e with axe, and bundle budgets -->
<!-- paths: .github e2e playwright.config.ts scripts/check-bundle.mjs docs/a11y-checklist.md -->
First read ops/codex-queue/PREAMBLE.md and follow it. Then read PLAN.md §13 (manual a11y checklist), §18 (budgets), §19 (UI tests) and §20 (CI gates), and look at package.json scripts.

Task:
1. .github/workflows/ci.yml (GitHub Actions, Node 24, npm ci, with caching). Jobs: typecheck, lint, unit tests (vitest), content checks, golden runs, build, then Playwright e2e plus axe on the production build (`next start`), and the bundle budget check. Engine benchmarks (`npm run bench`) go in a separate job that is allowed to be informational, because CI runners differ from the baseline machine; document why.
2. playwright.config.ts plus e2e/*.spec.ts against `next start` on a fixed port, chromium only. Cover:
   - complete steps of the caching lesson;
   - open the cache-aside challenge, insert a cache on both service→DB edges (dispatch a real DataTransfer drop event, as the board uses HTML5 drag-and-drop), submit, and expect a pass;
   - reload: the progress page shows the challenge stars;
   - the share-link round trip;
   - a hostile import is rejected;
   - storage blocked → in-memory banner;
   - navigating away and back 10 times leaves no extra workers (use any debug hook the run manager exposes; if there is none, assert via performance/memory heuristics or skip with a note).
   Run axe on every route template, in both themes if the theme toggle exists.
   Prefer accessible selectors (roles and labels). If a flow cannot be automated reliably, mark it test.fixme with the reason.
3. scripts/check-bundle.mjs: read the Next build output (.next) and fail if the initial JS for content pages exceeds 170 KB gzip or the sandbox route exceeds 350 KB gzip (PLAN §18). Print a table.
4. docs/a11y-checklist.md: the manual release checklist from §13 (keyboard only, NVDA + Firefox, VoiceOver + Safari macOS/iOS), with the flows listed and pass/fail columns.
In your summary, list the exact package.json script lines to add (e.g. "e2e", "check:bundle"); you must not edit package.json.
Run the e2e suite locally once and report the results. Failures caused by real app bugs are findings: report them, and don't weaken the tests.
