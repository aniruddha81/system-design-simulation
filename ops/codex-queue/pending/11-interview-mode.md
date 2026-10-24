<!-- title: Add case-study pages and interview mode -->
<!-- paths: src/app/case-studies src/app/interview src/components/interview src/components/sandbox/TemplatePicker.tsx src/app/sandbox -->
First read ops/codex-queue/PREAMBLE.md and follow it. Then read:
- PLAN.md §4 (IA), §10 (interview mode, in full), §13 and §14;
- docs/DESIGN.md (visual identity: this UI must look crafted and distinctive, not generic);
- src/content/case-studies (the registry built by the case-studies tasks);
- src/components/sandbox (the editor: how templates are opened via `?template=`, and how the editor is embedded on the challenge page src/app/challenges/[id]);
- src/lib/persistence (progress API).

Task:
1. /case-studies (index) and /case-studies/[id]:
   - Server Components with generateStaticParams, await params, notFound() for unknown ids, and generateMetadata.
   - Render the MDX narrative, the requirements, worked estimates, API, data model, alternatives with trade-offs, deep dives and the rubric.
   - Each failure scenario gets a "Run this scenario" button that opens the sandbox with the reference design and that scenario.
   - "Open in sandbox" for the reference design and for each alternative.
   Add `?case=<id>&scenario=<id>&alt=<n>` support to the sandbox's template opening (TemplatePicker / the sandbox page), reading params client-side inside Suspense like the existing `?template=` support.
2. /interview and /interview/[caseId] (§10):
   - stages requirements → estimates → API → data model → high level → deep dive → wrap-up, each with a suggested time;
   - timer 45/60 min or untimed, pausable and extendable, with no penalty;
   - tools: requirements checklist, an estimation calculator, the embedded sandbox editor (reuse the challenge page's embedding pattern) and a notes panel;
   - deep-dive cards drawn from the case study's failure scenarios, each runnable against the learner's design;
   - at the end: a self-assessment rubric (1–4 per stage), then a reveal of the reference solution with trade-off notes and a side-by-side component diff (learner vs reference kinds and counts);
   - the session saves locally (persistence store or localStorage, with the reason noted), and the result is recorded with store.progress.upsert({ itemId: "interview:" + id, kind: "lesson", completedAt }) if the kind union allows; otherwise note it.
3. Add nav entries only if src/components/ui/shell.tsx exposes a NAV list. You don't own that file, so put the exact lines to add in your summary instead of editing it.
Tests: vitest for the component-diff and timer logic, and `npm run build`.
