<!-- title: Add site search command palette, OG images and SEO metadata -->
<!-- paths: src/components/search src/lib/search src/app/opengraph-image.tsx src/app/learn/[track]/[lesson]/opengraph-image.tsx src/app/case-studies/[id]/opengraph-image.tsx src/app/sitemap.ts src/app/robots.ts scripts/build-search-index.mjs public/search-index.json -->
First read ops/codex-queue/PREAMBLE.md and follow it. Then read PLAN.md §16 (SEO and search), §12 (motion) and §13; docs/DESIGN.md; src/lib/content/loader.ts; content/matrix.json; src/content/case-studies; src/engine/types.ts (component kinds for search); and the existing src/app/sitemap.ts and robots.ts.

Task:
1. Site search (§16):
   - scripts/build-search-index.mjs builds a MiniSearch index at build time over lessons (title, objectives, description), glossary terms (derive them from lesson frontmatter or headings), case studies and simulator component kinds, writing public/search-index.json.
   - src/components/search exports `<CommandPalette />`: ⌘K / Ctrl+K opens it; it lazy-loads the index and minisearch; it is keyboard-first (arrow keys, Enter), a proper combobox/listbox with ARIA and a focus trap; results are grouped by type. Style it per docs/DESIGN.md.
   You do not own layout.tsx or package.json: in your summary, give the exact line to mount `<CommandPalette />` in the layout and the "prebuild" script line to add.
2. OG images: opengraph-image.tsx for the site, for lessons and for case studies, using next/og per the installed Next docs. Design them in the field-notebook identity (paper, ink, vermilion), not generic gradients.
3. sitemap.ts includes every live lesson and case study. robots.ts keeps /sandbox and /dev disallowed. Make sure JSON-LD Course/LearningResource exists on lesson pages; if it is missing, report it, because you don't own those pages.
Tests: vitest for the index builder (every live lesson indexed, and a query for "cache" finds the caching lesson). Run `npm run build`.
