# Frontmatter Contract

The frontmatter contract, current as of this
writing: `name`, `description` (third-person triggers, no "I"/"you"),
`triggers` (a non-empty list), `version` (start `0.1.0`), `license`,
`allowed-tools` (canonical lowercase Clio tool names only, such as `bash`/`git`
capitalized or spelled differently is rejected), and `requires` when Phase 3
found a reference. If in doubt about the exact shape, `read` an already-
installed skill's `SKILL.md` (this skill's own file is always available) and
mirror its frontmatter keys rather than guessing or trying to load
skill-authoring.
