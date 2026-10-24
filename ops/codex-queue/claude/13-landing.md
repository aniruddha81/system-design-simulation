<!-- title: Build the cinematic landing page with signature motion -->
<!-- paths: src/app/page.tsx src/components/landing -->
First read ops/codex-queue/PREAMBLE.md and follow it. Then read PLAN.md §12 (in full: ownership rules for GSAP/Motion/CSS/canvas, signature moments, motion settings, performance), §13 and §18 (LCP/CLS budgets); docs/DESIGN.md (the visual identity: this page is its showcase); .claude/skills/gsap-react/SKILL.md and .claude/skills/gsap-scrolltrigger/SKILL.md; the current src/app/page.tsx; and the engine API (createSimulation, fixtures).

Task (P6): rebuild the home page as the cinematic landing. It must be stunning and unmistakably this product, not a template.
- Hero: a live mini-simulation running behind the headline. Run the real engine on cacheAsideDesign in a worker, or replay a recorded snapshot stream, with packets drawn on a canvas overlay in the notebook style. Keep LCP-safe: the headline renders server-side, the sim is lazy and non-blocking, and there is no CLS.
- A scroll-scrubbed "life of a request" chapter (GSAP ScrollTrigger via useGSAP with scope and cleanup): DNS → CDN → LB → service → cache miss → DB → response, with annotations in the margin-note style.
- A "system breaks" moment when chaos hits (node shakes, red pulse, packets drop) and then recovers via the cache-aside fix.
- The pillars (Learn, Simulate, Practice, Interview, Reference) with real product glimpses, and CTAs.
- Motion settings: reduced motion → no parallax/scrub, crossfades only, packets become counters; "Off" pauses all continuous animation; a visible pause control for any animation longer than 5 s; off-screen animations stop (IntersectionObserver).
- Animate only transform/opacity. Refresh ScrollTrigger after document.fonts.ready and on resize (debounced).
Verify with `npm run build`, and check visually with Playwright screenshots at 1440 px and 390 px in both themes (save them under e2e/screenshots/ but do not list that path for commit).
