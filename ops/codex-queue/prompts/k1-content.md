You are worker K1 (Lesson content, Tracks 0–1, phase P3) in a parallel build of this repo, a system-design learning platform. Claude (the lead) and you agreed on docs/PLAN.md together.
First read:
- docs/WORKSTREAMS.md (the rules, plus the "P2 wave 2" section);
- PLAN.md §2 (pedagogy), §3 (curriculum, Tracks 0 and 1), §9 (content pipeline) and Appendix A;
- content/en/building-blocks/caching.mdx, the reference lesson: copy its structure, frontmatter shape, tone and quality bar exactly;
- src/lib/content/schema.ts (frontmatter schema and the widgetSchemas registry: only these widgets exist);
- src/lib/content/variants.ts (question templates with solvers);
- src/lib/content/content.test.ts (the CI content checks your lessons must pass);
- content/matrix.json.

You own ONLY:
- content/en/foundations/**
- content/en/building-blocks/** (do not rewrite caching.mdx; you may only add links to it)
- content/matrix.json
- src/lib/content/variants.ts (append new templates to `templates`; do not change existing ones or the helper functions)
Do not npm install, do not git commit. Other workers are active, including a Claude designer restyling the lesson UI and a Claude worker adding model widgets to the registry. Use only widgets that exist in widgetSchemas when you start. If a registry entry appears later for hash-ring / isolation players, you may use it.

Write every Track 0 (foundations) and Track 1 (building-blocks) lesson listed in content/matrix.json `lessons` with status "planned", and flip each to "live". Each lesson must:
- have 2–5 measurable objectives;
- have 6–10 steps, each with an interactive element (a calculator, choice, ordering or variant question);
- have parameterised VariantQuestion templates with solvers for its numeric objectives (Little's law, nines → downtime, QPS/storage/bandwidth estimation, replication quorum arithmetic, consistent-hashing key movement, B-tree vs LSM write amplification, rate-limiter token maths, etc.), each with per-mistake feedback;
- give choice questions per-distractor feedback;
- end with a MasteryCheck;
- cite primary sources (papers or official docs, with real titles, authors, years and URLs; do not invent sources: if unsure, cite the well-known paper or spec you are certain of);
- state its limitations, set lastReviewed to today (2026-10-24), and keep prerequisites consistent with the DAG (no cycles);
- where a runnable sandbox demo fits, link to /sandbox?template=cache-aside or /sandbox (only those templates exist).
Teach for real: clear explanations, concrete numbers, the classic failure modes and the trade-offs, written for an engineer preparing for system design interviews and real work. Keep each lesson around the length of caching.mdx.
Also update content/matrix.json rows so that every Appendix A row for Tracks 0–1 points at the right lesson.

Verify with:
- `npx vitest run src/lib/content --configLoader native --pool threads --maxWorkers 1` (the content checks must pass: schema, prerequisites, no cycles, every objective assessed, every step interactive, 300 seeds per template never producing wrong-answer values equal to the answer);
- `npx tsc --noEmit` for your paths;
- `npx eslint src/lib/content`.
Finish with a short summary: the lessons written, the templates added, and test results.
