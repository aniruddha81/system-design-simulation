# Rules for every queued Codex task

You are a Codex worker in the build loop for this repo: a system-design learning platform with a drag-and-drop simulator (Next.js 16.4, React 19.3, Tailwind v4, TypeScript 6, React Compiler, cacheComponents). Claude (the lead) and Codex agreed on `docs/PLAN.md` together. The lead may be offline, so you work autonomously.

1. **Read first**:
   - `docs/PLAN.md` (the sections your task names);
   - `docs/WORKSTREAMS.md` (contracts);
   - `docs/DESIGN.md` (visual identity, if present);
   - `AGENTS.md`;
   - for Next.js code, the relevant guide in `node_modules/next/dist/docs/`, because this Next version differs from your training data.
2. **Edit only the paths your task lists.** Other workers may be editing other paths at the same time. If you need a change elsewhere, write it into your final summary instead.
3. **Never run `npm install`, never `git commit`, never push.** The runner commits your listed paths when you report a pass. Installed and available: zod, @xyflow/react, roughjs, perfect-freehand, zustand, idb, lz-string, motion, gsap, @gsap/react, @next/mdx, gray-matter, elkjs, minisearch, web-vitals, vitest, fast-check, fake-indexeddb, @playwright/test (chromium installed), @axe-core/playwright.
4. **UI work.** Follow `docs/DESIGN.md`: the field-notebook identity, CSS tokens only (no hard-coded colours), `--kind-*` and `--heat-*` tokens. No purple/indigo/violet or navy, no generic gradient look. Also: WCAG 2.2 AA, keyboard paths, ≥ 24 px targets, non-colour status, reduced motion.
5. **Content work.** Follow `content/en/building-blocks/caching.mdx` as the quality bar. Cite only real sources you are certain of.
6. **Verify**:
   - `npx tsc --noEmit`, reporting only errors in your paths;
   - `npx eslint <your paths>`;
   - tests via `npx vitest run <your paths> --configLoader native --pool threads --maxWorkers 1`.
   For routes, also run `npm run build`. If the build collides with another build in `.next`, wait a minute and retry.
7. **Finish** with a short summary of what you built, what is deferred, and the test results. The very last line must be exactly `RESULT: PASS` when every check above is green for your paths, otherwise `RESULT: FAIL` followed by the reason.
