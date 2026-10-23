# Project skills for UI work

These are project-level Claude Code skills. Claude loads each one automatically when a task matches its description. They were vendored on 2026-10-24 from the most-starred UI skill repositories.

| Skill folder | Source (commit) | ★ at vendoring | License | Use it for |
|---|---|---|---|---|
| `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) (`dbd4588`) | 183k | Apache-2.0 (`LICENSE.txt`) | Distinctive art direction, avoiding a templated look |
| `ui-ux-pro-max` | [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) (`d14efff`) | 139k | MIT | Searchable styles, palettes, font pairs, UX rules and GSAP presets; generates a design system |
| `taste-skill` (skill name `design-taste-frontend`) | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) (`6010f91`) | 102k | MIT | Awwwards-style art directions, an "anti-slop" lint, and a screenshot look-and-fix loop |
| `impeccable` | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) (`6ba3f6a`) | 85k | Apache-2.0 | `/impeccable audit`, `critique`, `polish`, `animate`, `bolder`, ... |
| `react-view-transitions` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) (`063bee9`) | 33k | MIT (frontmatter) | React `<ViewTransition>` route and shared-element animations in Next.js |
| `web-design-guidelines` | vercel-labs/agent-skills (`063bee9`) | 33k | per repo | Review UI against Vercel's Web Interface Guidelines |
| `gsap-core`, `gsap-react`, `gsap-scrolltrigger`, `gsap-timeline`, `gsap-plugins`, `gsap-performance`, `gsap-utils` | [greensock/gsap-skills](https://github.com/greensock/gsap-skills) (`aed9cfd`) | 17k | MIT | Official GSAP guidance (`useGSAP`, ScrollTrigger, timelines, plugins) |

## Local changes

- `ui-ux-pro-max`:
  - Script paths changed from `${CLAUDE_PLUGIN_ROOT}/.claude/skills/...` to `.claude/skills/...`. That variable only exists for plugins, and this is a project skill.
  - Upstream `scripts/tests/` was dropped.
- `gsap-frameworks` (Vue/Svelte) was not vendored because this is a React project.

## Read before use

- **`impeccable`** runs `scripts/impeccable`. On first use, that launcher downloads a native engine binary from `github.com/pbakaus/impeccable/releases`, checks it against a `.sha256` file from the same release, then executes it.
  - To avoid this, set `IMPECCABLE_BIN` to a binary you installed yourself.
  - Alternatively, use only the reference docs.
- **`web-design-guidelines`** fetches its rules from `raw.githubusercontent.com/vercel-labs/web-interface-guidelines` every time it runs.
- **`taste-skill`** launches a local headless Chrome for screenshots, and `assets.mjs` searches Openverse and Wikimedia for images.
- **`ui-ux-pro-max`** needs Python 3 and has no dependencies.
- **Overlap**: `frontend-design`, `taste-skill`, `impeccable` and `ui-ux-pro-max` all trigger on "design a page". Name the skill you want, e.g. "use taste-skill for the landing hero" or "/impeccable audit src/app".
- **Plan precedence**: the motion rules in `docs/PLAN.md` §12 take precedence over skill defaults (GSAP for cinematic scenes, Motion for components, `<ViewTransition>` for routes, Lenis deferred).

## Updating

Re-clone the source repo at a newer commit, copy the same folder over, re-apply the local changes above, and update the commit column. Also update the Codex copies in `.agents/skills/` (see its README).
