# Production e2e

Use the already installed dependencies and Chromium:

```sh
npm run build
npx --no-install playwright test
node scripts/check-bundle.mjs --self-test
node scripts/check-bundle.mjs
```

Playwright owns `next start` on `127.0.0.1:3100`. It refuses to reuse an existing
server so a dev server cannot accidentally satisfy the production test gate.
Each test gets clean browser storage. Sharing opens a separate browser context.
The suite has 32 Chromium tests: eight functional cases and 24 axe scans across
12 route representatives in Paper and Slate. Axe includes WCAG 2.2 AA tags,
including colour contrast; no rules or elements are excluded.

Cache insertion dispatches HTML5 dragstart/dragover/drop/dragend with a browser
`DataTransfer`, using the library's kind MIME and coordinates between the service
and database handles. It exercises both service paths and the real worker grader.
The navigation test counts live workers using Playwright's worker lifecycle API
over ten Next client navigations; it also rejects document reloads, which could
otherwise conceal a leak. There is no run-manager browser debug hook to use.

## Local verification, 2026-10-24

These results are a snapshot of a shared working tree with concurrent app/content
changes. Only this task's workflow, configuration, e2e, bundle script and manual
checklist paths were edited. `package.json` was not edited.

| Check | Result |
| --- | --- |
| `npx --no-install tsc --noEmit` | PASS |
| ESLint on `playwright.config.ts`, `e2e/*.spec.ts`, `scripts/check-bundle.mjs` | PASS |
| CI YAML parse and job dependency assertions | PASS |
| `node scripts/check-bundle.mjs --self-test` | PASS: manifest parsing, invalid-format/path rejection, chunk deduplication, on-demand chunks and route budgets |
| `npx --no-install playwright test --list` | PASS: 32 tests discovered |
| `npx --no-install playwright test` | BLOCKED: `Error: spawn EPERM` before any tests executed; no browser/axe result is claimed |
| `npm run build` | BLOCKED: compilation succeeds, then TypeScript child process startup fails with `spawn EPERM` |
| Production build using process-local Next worker-thread/API-typechecker settings | FAIL: TypeScript passes, then prerendering `/learn/building-blocks/caching` and `/_not-found` fails on the content matrix mismatch below; no project configuration was edited |
| `node scripts/check-bundle.mjs` | BLOCKED: no completed `.next/BUILD_ID`; checker refuses to measure an incomplete build |
| Vitest content and golden checks | 137 passed, 1 failed across 138 tests; golden replay test passes |
| Remaining `src` Vitest tests, excluding content and golden checks | 464 passed, 9 failed, 1 skipped across 474 tests |

Verified findings outside this task's editable paths:

- Content validation and production prerendering both report that lesson
  `retries` has an MDX file but is marked planned in `content/matrix.json`.
- The distributed-cache cold-restart case-study fixture produces goodput
  `0.4299427416638599`, below its expected minimum `0.97`.
- News-feed baseline and alternative fixtures fail validation: the database
  dataset keyspace must be an integer in `[10000, 1000000]`.
- Six expected case-study MDX files are missing: `url-shortener`, `pastebin`,
  `rate-limiter`, `key-value-store`, `distributed-cache`, and `news-feed`.

The functional/axe assertions remain enabled. Re-run the production suite and
bundle measurement once process startup is available and the app/content build
blockers are fixed. No flow was marked fixme merely to turn these failures green.
Manual assistive-technology checks and Lighthouse gates were not run; use
`docs/a11y-checklist.md` for release sign-off. The CI workflow itself has not run
on GitHub here. Engine timing benchmarks remain an informational CI job for the
machine-variance reasons documented in the workflow and checklist.

Package scripts for the integrating owner to add:

```json
"e2e": "playwright test",
"check:bundle": "node scripts/check-bundle.mjs"
```
