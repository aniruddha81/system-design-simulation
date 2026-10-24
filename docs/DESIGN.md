# The engineer's field notebook

The interface is a working notebook on a drafting table: graphite diagrams, an editorial serif, ruled records, and corrections in vermilion. A learner reads a short explanation, changes a system, observes a failure, then records what happened. The same visual vocabulary carries from the home page into lessons, reference tables, settings and progress.

This identity replaces the earlier dark-first, Geist and gradient directions in PLAN §12 and the original token examples in WORKSTREAMS. Public token names and saved preference values remain compatible.

## Themes and tokens

`src/app/globals.css` is the colour source of truth. Components use CSS variables or their Tailwind aliases; no literal colours in components. Browser theme-colour metadata repeats the two canvas colours because it cannot resolve CSS variables.

| Role | Paper — default | Slate — alternative |
| --- | --- | --- |
| Canvas `--bg` | Warm paper `#f2efe6` | Green-black chalkboard `#111916` |
| Sheet `--surface` | `#faf8f2` | `#19231e` |
| Recess `--surface-2` | `#eae5da` | `#232e29` |
| Ink `--text` | Graphite `#19201c` | Chalk `#eceae1` |
| Secondary ink `--ink-2` | `#383f3b` | `#d3d1c8` |
| Pencil `--text-muted` | `#5a5c53` | `#a9aca3` |
| Action `--accent` | Vermilion `#c12b09` | Chalk vermilion `#f8875a` |
| Second pen `--accent-2` | Teal ink `#156864` | Mint chalk `#7dd9ba` |
| Marker `--highlight` | Sodium yellow `#f9d047` | Sodium yellow `#f4cd4b` |

`--highlight-mark` is the theme-adjusted band behind text. In Slate it is darkened so chalk remains legible. Never use bright yellow as a small-text foreground. `--accent-ink` is the foreground on primary actions. `--accent-hover`, `--focus`, `--danger`, `--warning`, and `--success` cover interaction and semantic states.

Keep `--bg`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-muted`, `--accent`, `--accent-2`, `--danger`, `--warning`, `--success`, all radius, elevation and font tokens. Legacy `--brand` now resolves to flat vermilion; `--brand-angle` remains available, and `--grid-line` aliases grid ink. New roles extend the contract. `--border` separates decorative sheets; `--rule` supplies the stronger boundary for controls and meaningful marks. Do not use decorative borders as the only indication of a control.

Paper is used when no theme is saved, including on an OS set to dark. Settings offers explicit System, Paper and Slate choices. Persisted values remain `system`, `light`, and `dark`. The bootstrap in `layout.tsx` and the client preference application in `shell.tsx` must agree before first paint. Existing explicit preferences survive this identity change.

## Typography and layout

- **Display:** Fraunces, exposed through `--font-display`. Use for page and section titles, lesson headings, figure captions and occasional italic margin notes. Keep paragraphs in the body face.
- **Body:** Schibsted Grotesk through `--font-sans`. Comfortable 16–18 px running text, approximately 1.5–1.7 line height, and 45–70 characters per reading line.
- **Data:** IBM Plex Mono through `--font-mono`. Use for units, aligned numbers, keys, IDs, code, section references and step numbers. The `.num` utility adds tabular figures.

Next/font self-hosts all three families. Serif, sans-serif and monospace fallbacks preserve their roles while fonts load. These three deliberate roles, the paper grid, manual rules, highlighter marks and figure numbers are requirements of this brand, even where a generic frontend style guide recommends fewer typefaces or no rules.

Use the existing 4 px spacing scale. Reading pages share equal outer gutters, at least 16 px on phones, and maximum widths suited to their content: broad curriculum, narrower lessons and forms. Panels have small 2/4/6 px corners. Quiet elevation suggests paper; never use glow or blur. Navigation tabs wrap instead of hiding destinations beyond the phone viewport.

## Drawing and annotation

`--paper-grid` is the minor grid ink colour, also usable as an SVG stroke by the sandbox. `--paper-grid-image` holds the CSS image for a 24 px engineering grid with a major line every fifth square, sized by `--paper-grid-size`. The `.paper-grid` class applies that image. Use it on drawing areas and the learning path, not beneath every paragraph. Grain is subtle and decorative.

Reuse `.marker`, `.margin-note`, `.figcap`, `.sec`, `.rule-manual`, `.leader`, `.ruled`, and `.stamp`. Marker bands sit behind ink, never over letters. A stamp communicates a real state or a clearly captioned example. Mathematical symbols, arrows and monochrome text checkmarks are allowed; emoji pictograms are not.

Sketch paths use roughjs with fixed seeds, computed on the server. The home drawing illustrates cache-aside routing. Its cache control sits in a separate toolbar above the SVG. Database labels sit on an opaque sheet patch above the load hatching. The figure is explanatory; its fixed example rates are not a live engine benchmark. It must never obscure the primary page action.

## Component pencils and heat

Every engine component has a stable pencil token in both themes. Use the token alongside its shape and written label; colour alone never identifies a component.

| Token suffix | Pencil family |
| --- | --- |
| `client` | Graphite |
| `loadBalancer` | Deep teal |
| `service` | Leaf green |
| `cache` | Ochre |
| `database` | Petrol blue |
| `rateLimiter` | Red clay |
| `dns` | Sky ink |
| `cdn` | Turquoise |
| `apiGateway` | Sienna |
| `kvStore` | Forest green |
| `queue` | Copper |
| `worker` | Olive |
| `objectStore` | Umber |
| `searchIndex` | Brass |
| `dedupStore` | Sepia |
| `autoscaler` | Moss |
| `circuitBreaker` | Red oxide |

The full names are `--kind-<suffix>`, preserving engine camelCase. The 17 colours identify categories, not text colours; use normal ink for labels. Never substitute indigo, violet, purple, mauve or navy to spread the palette.

`--heat-0` through `--heat-4` progress from verdigris to moss, sodium ochre, orange and vermilion. Heat is operational load, not identity. Pair heat with a utilisation value and explicit status such as “Within capacity”, “Near saturation”, or “Overloaded”.

## Page vocabulary

| Surface | Treatment |
| --- | --- |
| Header and footer | Opaque paper/chalkboard grounds, notebook divider tabs, drawn topology mark, manual rule and a serif closing statement |
| Home | Editorial promise beside an interactive cache-aside drawing; contents list, three-step learning path and captioned inspection slip |
| Learn | A contents page grouped by track, ruled lesson entries, explicit Live/Planned and progress text |
| Lesson | Serif heading, learning objectives between rules, numbered step tabs and checkmarks; one step visible at a time |
| Questions | Exercise sheet with strong top/bottom rules; checked choices show a native control and a neutral selected fill; feedback names Correct/Not quite |
| Progress | A ruled record with plain counts, review queue and rows for lessons and challenges; empty states explain what creates a record |
| Settings | Ruled sections, named Paper/Slate choices, visible radio selection, existing import/export and reset protection |
| Reference | Manual sections, aligned mono units, teal logarithmic bars and inset calculation results; on phones numeric table columns remain visible while redundant bars are hidden |
| 404 | A missing notebook page with links back to real lessons and destinations |

Keep existing routes, progress IDs, solver logic, storage and backup behaviour. A visual change must not reset progress or weaken data deletion safeguards.

## Accessibility and motion

Text roles target at least 4.5:1 against all three opaque surfaces in each theme; meaningful control boundaries, component outlines and heat marks target at least 3:1. Normal text uses full ink, secondary ink or the tested pencil colour. Disabled controls are visibly disabled rather than represented by colour alone. Keep visible focus, semantic labels, keyboard controls and targets at least 24 by 24 CSS pixels. Numbered step tabs include an accessible step name, current state, completion state and native disabled state.

The home traffic has a visible Pause/Resume control. Full motion may draw strokes and move request packets. System follows the OS reduced-motion preference; Reduced removes movement, and Off removes animations and transitions. Completed strokes and all content remain visible with animation disabled. CSS and Motion's `MotionConfig` share these preferences.

`src/components/ui/identity.test.ts` checks the two token sets, all 17 kinds, five heat colours, primary-action contrast and before-paint theme resolution, including blocked storage. These checks protect the palette contract; they do not prove composed-page accessibility. Before release, inspect every owned route at desktop, tablet and phone widths in both themes; exercise cache kill/restart, pause, lesson answers, step navigation, calculators, settings and keyboard focus. Run axe on rendered pages and retain the manual assistive-technology pass from PLAN §13.

## Prohibited treatments

No purple/indigo/violet palette, navy ground, blue-purple gradients, glassmorphism, emoji icons, generic gradient fills or stock neon glow. Grid lines and highlighter bands are functional notebook textures, not gradient decoration. No hard-coded colours outside the token sheet and required browser metadata.
