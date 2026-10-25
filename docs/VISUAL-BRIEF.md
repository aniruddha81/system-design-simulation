# Visual-first pass — brief for every worker

Goal: the product teaches by **showing**. Cut prose hard, replace it with diagrams, motion, numbers and interaction. A learner should get the idea from the picture first and read only a caption.

## Rules

- **Prose budget**: at most ~60 words of body text per lesson step / page section (cut ≥ 50% of the current words). One idea per step, then a visual, then the question. Never delete a step, question, objective or `id` (progress is keyed by stable ids). Keep frontmatter, sources and limitations intact (limitations must stay visible — they are a plan requirement).
- **Every step gets a visual**, in this order of preference: an existing interactive widget (`HitRateCalculator`, model players), then the visual kit below, then a new small component in your own namespaced file.
- **Kit** (`src/components/visual/kit.tsx`, already registered as MDX widgets and in `src/lib/content/schema.ts`):
  - `<Flow title nodes edges failed hot height caption />` architecture diagram with animated packets, `x`/`y` are 0–100 grid positions, `kind` picks the icon/colour (`client|loadBalancer|service|cache|database|rateLimiter|dns|cdn|apiGateway|kvStore|queue|worker|objectStore|searchIndex|dedupStore|autoscaler|circuitBreaker`).
  - `<Bars title items log caption />` magnitudes (use `log` for latency numbers).
  - `<Stats title items />` big-number tiles. `<Sequence title actors messages />` message flow (`lost: true` for dropped messages). `<Timeline title events />` incidents/phases. `<Compare title sides />` 2–4 options, ≤ 4 short points each.
  - Props are zod-validated at build; MDX props with arrays/objects use JSX expression syntax, e.g. `nodes={[{ id: "a", label: "Client", kind: "client", x: 0, y: 50 }]}`.
  - If you need a new generic primitive, add it in a **new file** `src/components/visual/<yourarea>-*.tsx` and register it only if you own the registry (you don't: put it in your own widget file and tell the lead in your summary). Do not edit `kit.tsx`, `schema.ts` or `mdx-components.tsx`.
- Style: follow `docs/DESIGN.md` (field-notebook identity), CSS tokens only, no hard-coded colours, WCAG 2.2 AA, meaning never by colour alone, `prefers-reduced-motion` respected, mobile-first (16 px gutters, no horizontal page scroll).
- Diagrams in Markdown files are Mermaid only. Any prose you keep: plain, short sentences.
- Next.js here is 16.4 with breaking changes: read the relevant guide in `node_modules/next/dist/docs/` before touching Next-specific code.

## Process rules

- Edit **only** the paths you own; other workers are editing other paths at the same time in the same working tree.
- Do **not** run `npm install`, `git commit`, `git push`, `next build`, or start a dev server (the lead does). Verify with `npx tsc --noEmit` (report only errors in your paths), `npx eslint <paths>`, and `npx vitest run <your test paths> --pool threads --maxWorkers 1`.
- Content tests (`src/lib/content/content.test.ts`, `src/content/**/*.test.ts`) check: widgets valid, each step interactive, every objective assessed, DAG valid. Keep them green.
- Finish with a short summary: what changed, words before → after, what to check visually. Last line exactly `RESULT: PASS` or `RESULT: FAIL <reason>`.
