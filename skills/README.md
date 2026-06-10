# Clio Skills Marketplace

Curated, version-controlled skills that Clio Coder's authors have reviewed and
approved. This folder is the **marketplace catalog** — a publishing shelf, not a
runtime store.

## Marketplace vs runtime

Clio's engine discovers *runtime* skills from these roots (see
`src/domains/resources/skills/loader.ts`):

- extension roots
- `~/.agents`, `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.copilot` → `/skills`
- `<clio-config>/skills` (per-user)
- project `.agents` / `.claude` / `.codex` / `.opencode` / `.github` → `/skills`
- `.clio/skills` (per-project)

This repo's `skills/` directory is **not** one of those roots, so nothing here
auto-loads. That gap is deliberate.

| | Runtime skill | Marketplace skill (here) |
|---|---|---|
| Location | a discovery root above | `skills/<name>/` in this repo |
| Author | any user or harness | Clio authors, reviewed |
| Provenance | none required | `registry-id` + `source-url` + `audit: pass` |
| Auto-loaded | yes | no — must be installed |

"Approved" is visible in the frontmatter: a maintainer set `audit: pass` and a
`version`. A skill a user wrote themselves carries none of those fields.

## Catalog

| Skill | Type | Use when |
|---|---|---|
| [`grill-me`](grill-me/) | interview | A plan or idea needs stress-testing through a one-question-at-a-time interview before code is written. Ends with a decision log. |
| [`prd`](prd/) | interview | An idea must become a locked product spec via a phase-gated interview, ending in PRD.md plus milestone prompts. |
| [`cut-it`](cut-it/) | workflow | A plan, PRD, or milestone must become an executable sprint of dependency-ordered slices with done-when criteria. |
| [`context-prime`](context-prime/) | workflow | A session begins and you need to load project state, the last handoff, and orientation before acting. |
| [`context-handoff`](context-handoff/) | workflow | A session is ending and work continues in a new session or another agent. Writes the artifact `context-prime` reads. |
| [`clio-dev`](clio-dev/) | discipline | Modifying Clio's own source in this repo; deciding whether a change stays local or becomes a contribution. |
| [`clio-test`](clio-test/) | reference | Writing or verifying changes to Clio against the real v0.2.2 harness (contracts / smoke / boundaries). |

Each SKILL.md may declare `allowed-tools` / `disallowed-tools`. After a skill
loads, Clio merges that declaration with host policy; a skill can narrow its
tool surface but never grant tools the host would not allow.

## Install (activate a marketplace skill)

`install.sh` is the bridge from marketplace to runtime. It links a skill into a
discovery root so Clio can load it.

```bash
# Project scope (default): link into <repo>/.clio/skills, live edits apply
skills/install.sh context-handoff

# User scope: link into the Clio config skills dir, available everywhere
skills/install.sh clio-dev --user

# Distribute a frozen copy (stamps installed-at) instead of a live symlink
skills/install.sh clio-test --copy

# Everything at once
skills/install.sh --all
```

After install, confirm Clio sees it:

```bash
clio skills list            # human view
clio skills inspect context-handoff # full metadata + provenance
```

Uninstall is just removing the link: `rm .clio/skills/<name>` (or the user-scope
equivalent). `install.sh` never writes outside `.clio/skills` or the user config
skills dir, both of which are gitignored / outside the repo.

## Contributing / approval

A skill is "approved for the marketplace" when a maintainer:

1. Reviews `SKILL.md` against `superpowers:writing-skills` and Anthropic's skill
   authoring guidance (concise, trigger-rich description, progressive
   disclosure, one excellent example, evals present).
2. Confirms it carries the provenance frontmatter below and sets `audit: pass`.
3. Sets / bumps `version`.

Required frontmatter for every catalog skill:

```yaml
---
name: <name>                 # lowercase, hyphens, matches the folder
description: Use when ...     # triggers only, third person, <=1024 chars
version: 0.1.0
license: Apache-2.0
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/<name>
audit: pass
---
```

Each skill ships an `evals.md` recording the baseline scenarios it was tested
against (RED-GREEN per `superpowers:writing-skills`).
