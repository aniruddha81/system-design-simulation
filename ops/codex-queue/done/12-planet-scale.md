<!-- title: Add planet-scale reference designs with Scale-mode scenario packs -->
<!-- paths: src/content/reference-designs content/en/reference-designs -->
First read ops/codex-queue/PREAMBLE.md and follow it. Then read PLAN.md §5A in full (especially §5A.2 "Planet-scale reference designs"), src/engine/scale (README, index: runScale, sweep, whatIf, checkFidelity), src/engine/types.ts and src/engine/fixtures.ts.

Task: build the eight planet-scale reference designs: YouTube, WhatsApp, Uber, Twitter/X timeline, Netflix-style CDN, Stripe-style payments, Discord, Google-style search.
1. src/content/reference-designs/index.ts exports referenceDesigns[]. Each entry has:
   - id, title, design: Design (multi-region, with Design.regions latency matrix);
   - assumptions[] { claim, value, source: { title, url } }: public, cited, approximate numbers; cite only sources you are certain of, otherwise state the value as an illustrative assumption without a source;
   - an "illustrative" label;
   - a scenario pack of six Scale-mode scenarios: normal day, peak event, region outage, hot key/celebrity, dependency brownout, DDoS.
2. A vitest that runs checkFidelity and runScale on every design × scenario (keep step counts small) and asserts: no NaN/Infinity, conservation holds, and correctness is reported as "unknown". Also run one sweep per design and assert that a failure ladder is produced.
3. content/en/reference-designs/<id>.mdx: a short narrative per design covering what drives its scale, the failure ladder you observed, and what to try. Use the lesson frontmatter with track "reference-designs" and only registered widgets.
Routes are out of scope: list in your summary how the sandbox should open these (e.g. `?ref=<id>`).
