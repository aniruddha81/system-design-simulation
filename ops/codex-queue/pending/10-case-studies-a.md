<!-- title: Add case studies 1-13 with runnable designs and failure scenarios -->
<!-- paths: content/en/case-studies src/content/case-studies -->
First read ops/codex-queue/PREAMBLE.md and follow it. Then read PLAN.md §3 (Track 5 list and the case-study template paragraph), §5.3, §5.6, §8A, §10 (interview mode uses these), src/engine/types.ts, src/engine/fixtures.ts (examples of designs and scenarios, including the P2 fixtures), src/engine/index.ts, and content/en/building-blocks/caching.mdx plus src/lib/content/schema.ts (lesson format and widgets).

Task: create case studies 1–13 from §3 Track 5, in order: URL shortener, pastebin, rate limiter, key-value store, distributed cache, news feed, chat, notification system, Twitter timeline, Instagram, YouTube/video streaming, Uber/ride matching, proximity service.
1. src/content/case-studies/index.ts exports `caseStudies: CaseStudy[]` and `getCaseStudy(id)`. The CaseStudy type covers:
   - id, title, summary;
   - requirements { functional[], nonFunctional[] };
   - estimates (worked numbers with formulas);
   - api[]; dataModel (EntitySpec-compatible);
   - design: Design (a runnable reference design built from real engine components, with endpoints, routes and entities);
   - alternatives[] { title, tradeoffs, design?: Design };
   - failureScenarios[] { id, title, explanation, scenario: Scenario, expect: string } — each one is runnable;
   - deepDives[] { title, body };
   - rubric[] { stage, descriptors: [1..4] }, where the stages are requirements, estimates, api, data model, high level, deep dive, wrap-up;
   - clarifyingQuestions[]; commonMistakes[].
   If the file is shared with a later case-studies-b task, export the type and an array that is easy to extend.
2. Each design must pass validateDesign with each of its scenarios. Write a vitest that, for every case study, validates every scenario and runs a short runToCompletion (≤ 3 s sim, small rps) without throwing. Keep the runtime of the whole test file under about 60 s.
3. content/en/case-studies/<id>.mdx: the narrative case-study page per the §3 template (requirements, estimates, API, data model, high-level design, deep dives, alternatives, failure scenarios, rubric). Use the lesson frontmatter schema with track "case-studies", and only the widgets that exist in widgetSchemas. Cite real sources (engineering blogs or papers you are certain of).
The /case-studies route and interview mode come from a later task, so do not build routes.
