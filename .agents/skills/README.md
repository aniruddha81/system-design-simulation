# Codex project skills

Codex reads project skills from `.agents/skills/`. The skills here are the same set as `.claude/skills/`, which is where Claude Code reads them. Sources, commits, licenses and the read-before-use notes are in [`../../.claude/skills/README.md`](../../.claude/skills/README.md).

The Codex copies differ from the Claude copies in two places:

- `impeccable` is upstream's Codex build (`pbakaus/impeccable` `.agents/skills/impeccable`, commit `6ba3f6a`).
  - Its commands are `$impeccable …` instead of `/impeccable …`.
  - Its subagents are defined in `agents/*.toml`.
- `ui-ux-pro-max` script paths point to `.agents/skills/ui-ux-pro-max/scripts/`.

When you update a skill, update both folders.
