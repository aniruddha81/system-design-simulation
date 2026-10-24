# Manual accessibility release checklist

Target: WCAG 2.2 AA (PLAN §13). Run against the production build for every release,
in both Paper and Slate themes. Axe is an additional CI gate; it cannot verify
keyboard usability, reading order, announcements, or understanding of a simulation.

Release / commit: __________  Date: __________  Tester(s): __________

Record browser, OS, assistive technology versions and device in the evidence log.
For every cell below write **PASS** or **FAIL**, with an evidence reference. An
empty cell is untested. Any failure blocks release; missing functionality is a
failure for a release that claims that flow. Do not mark a flow passed just because
axe passes.

| Flow and verification | Keyboard only (desktop) | NVDA + Firefox | VoiceOver + Safari macOS | VoiceOver + Safari iOS | Evidence / issue |
| --- | --- | --- | --- | --- | --- |
| Home → curriculum → lesson: skip link, landmarks, headings, navigation, current location and focus order are understandable | | | | | |
| Complete caching lesson: move calculator sliders, answer numeric and single/multiple-choice questions, hear feedback, advance/back, finish mastery, reload progress | | | | | |
| Ordering questions: reorder with named up/down controls, understand the new position, submit, correct an error | | | | | |
| Matching questions: choose and change pairings, understand their relationships, submit and hear feedback | | | | | |
| List editor: add, name, connect, edit and delete components/edges, inspect parameters, undo/redo; no canvas interaction required | | | | | |
| Canvas keyboard paths: focus/select a node, move with arrows, Enter opens inspector, C opens connection target picker, connect/delete/undo without dragging | | | | | |
| Build cache-aside: insert cache on both service–DB paths, review rewritten routes, submit, understand verdict/stars and reload saved progress | | | | | |
| Simulation: Run, Pause, Resume, Step, adjust speed; state and errors use text/icons, topology has a text summary, live summary is polite and throttled to at least 5 s | | | | | |
| Results: understand goodput, latency, capacity and invariant failures from summaries and chart tables, without colour or moving packets | | | | | |
| Trace waterfall: choose input/request, follow nested calls, timings, status and keys in a readable order without relying on graphical position | | | | | |
| Interview mode: choose 45/60 minutes or untimed, pause/extend timing, complete stages, notes, deep dives and rubric; no penalty for pausing | | | | | |
| Import/export: export design and backup, import/restore safely, open/save share copy; invalid, oversized and newer-schema files explain rejection | | | | | |
| Storage unavailable: persistent “progress will not be saved” warning is announced, Export works, editing still works | | | | | |
| Dialogs: accessible name/description, initial focus, focus trapped while open, Escape/Cancel, focus restored to opener, destructive action clearly described | | | | | |
| Settings: switch Paper/Slate and System theme; Full/Reduced/Off motion; analytics choice, reset confirmation and backup are usable | | | | | |
| Navigation: leave/revisit running editor, progress and lesson; focus remains logical, no hidden route captures focus, run remains paused until Resume | | | | | |
| Reflow: 200% zoom and 320 CSS px width, no lost content/controls; use list alternative where a two-dimensional canvas is necessary | | | | | |
| Controls: visible focus, focus not obscured, ≥24×24 CSS px targets or valid spacing exceptions; meaningful labels and errors | | | | | |
| Status and contrast: both themes convey states with text/icons as well as colour; text, controls, focus and meaningful graphical boundaries have sufficient contrast | | | | | |
| Motion and timing: OS reduced-motion is respected, Off stops continuous animation; >5 s autoplay has visible Pause; quizzes have no time limit | | | | | |
| Media: any newly added video/narration has captions and an equivalent accessible explanation (none planned for v1) | | | | | |

On iOS use the touch equivalents (swipe order, rotor, double-tap, adjustable
controls); also verify external-keyboard operation when available. Desktop
keyboard-only runs use Tab/Shift+Tab, arrows, Enter/Space and Escape with the mouse
unused. For screen-reader runs, verify names, roles, values, reading order and
announcements as well as whether the task can be completed.

## Evidence and release decision

| ID | Environment / version / device / theme | Steps and expected result | Actual result | PASS / FAIL | Issue / recording / owner |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

Release decision: __________  Blocking issues: __________  Sign-off: __________

## Automated checks and limits

`npm run build` then `npx --no-install playwright test` runs Chromium against
`next start` at `http://127.0.0.1:3100`. The suite covers every production route
template in both themes, including a loaded local sandbox draft, a challenge and
404s. Development preview routes deliberately return 404 in production. Reports,
axe JSON, screenshots and failure traces go to `e2e/.report` and `e2e/.results`.
Those generated directories are ignored by `e2e/.gitignore`.

The worker-navigation test counts actual live workers via Playwright; it does not
need a production debug hook. This does not count GSAP ScrollTriggers. No current
flow is silently weakened to accommodate an application bug.

CI requires typecheck, lint, Vitest, content validation/solver variants, golden
replay runs, build, Playwright/axe and bundle budgets. Engine throughput benchmarks
are a separate informational job: `baseline.json` was recorded on a specific
Windows desktop CPU, while hosted runners vary in processor, OS, contention and
virtualization. A >15% difference there is evidence to investigate, not a reliable
regression verdict. Keep the speed gate on the baseline machine; golden replay
compatibility remains required in CI. This task does not add the separate
Lighthouse navigation/timespan gates described in PLAN §§18–20.
