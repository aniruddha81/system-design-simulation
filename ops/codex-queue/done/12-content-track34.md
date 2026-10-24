<!-- title: Add Track 3 reliability and Track 4 security lessons, plus Track 6 interview craft -->
<!-- paths: content/en/reliability content/en/security content/en/interview-craft content/matrix.json src/lib/content/variants.ts -->
First read ops/codex-queue/PREAMBLE.md and follow it. Then read PLAN.md §2, §3 (Tracks 3, 4 and 6), §9 and Appendix A; content/en/building-blocks/caching.mdx (the quality bar and format); src/lib/content/schema.ts (frontmatter and registered widgets); src/lib/content/variants.ts; src/lib/content/content.test.ts; and content/matrix.json.

Task: write every lesson in these three tracks. Add missing entries to matrix.json `lessons` and set them live.
- **Track 3 (reliability):**
  - metrics, logs and traces;
  - SLI/SLO/error budgets (variant: error budget minutes from SLO and window);
  - failure modes: cascading failure, thundering herd, retry storm, metastable failure, split brain, gray failure;
  - disaster recovery (RPO/RTO, backups);
  - multi-region (active-passive / active-active);
  - deployments (blue/green, canary, feature flags, rollback);
  - capacity planning, using Scale mode: link to /sandbox and describe the breaking-point sweep.
- **Track 4 (security and data):**
  - authN/authZ;
  - sessions vs JWT;
  - OAuth/OIDC flows (ordering question for the authorization code + PKCE flow);
  - encryption in transit and at rest;
  - key management and secrets;
  - DDoS mitigation;
  - abuse prevention;
  - multi-tenancy isolation;
  - privacy and data deletion.
- **Track 6 (interview craft):** the framework, clarifying questions, communicating trade-offs, common mistakes. Link to /interview.
Same standards as the existing lessons:
- every step interactive;
- solver-checked variants (appended to variants.ts) with per-mistake feedback;
- per-distractor feedback;
- a MasteryCheck;
- real sources: Google SRE book chapters, RFC 6749/7636/7519, OWASP, the NIST SP 800-57 key management guidance, the Metastable Failures paper (Bronson et al. 2021), etc.;
- limitations;
- lastReviewed 2026-10-24.
Update the Appendix A rows. The content tests must pass.
