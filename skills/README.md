# Clio Skills Marketplace

Curated, version-controlled skills that Clio Coder's authors have reviewed and
approved. This folder is the **marketplace catalog**, which acts as a publishing shelf rather than a
runtime store.

## Marketplace vs runtime

Clio's engine discovers *runtime* skills from these roots (see
`src/domains/resources/skills/loader.ts`):

- extension roots
- `~/.agents`, `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.copilot` → their `skills/` subdir
- `<clio-config>/skills` (per-user)
- project `.agents` / `.claude` / `.codex` / `.opencode` / `.github` → their `skills/` subdir
- `.clio/skills` (per-project)

This repo's `skills/` directory is **not** one of those roots, so nothing here
auto-loads. That gap is deliberate.

| | Runtime skill | Marketplace skill (here) |
|---|---|---|
| Location | a discovery root above | `skills/<name>/` in this repo |
| Author | any user or harness | Clio authors, reviewed |
| Provenance | none required | `registry-id` + `source-url` + `audit: pass` |
| Auto-loaded | yes | no, as it must be installed |

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
| [`clio-test`](clio-test/) | reference | Writing or verifying changes to Clio against the real harness (contracts / smoke / boundaries). |
| [`arxiv-literature`](arxiv-literature/) | research | Searching arXiv, summarizing papers, comparing papers, or producing compact literature surveys while protecting main-agent context. |
| [`scientific-debugging`](scientific-debugging/) | workflow | Debugging has stalled or produces wrong numbers, NaNs, or flaky results. Forces falsifiable hypotheses across fault classes and evidence-cited verdicts before any fix. |
| [`experiment-protocol`](experiment-protocol/) | workflow | A benchmark, optimization, or numerical comparison needs success criteria locked before results exist. Pre-registers thresholds into the repo validation contract. |
| [`design-council`](design-council/) | workflow | A design decision has real tradeoffs and needs several composed expert perspectives that debate through read-only dispatched workers before code is written. |
| [`find-skills`](find-skills/) | workflow | A capability might exist as an installable skill. Searches with `clio skills search`, browses the ecosystem read-only, and installs only through `clio skills install`. |
| [`credentials`](credentials/) | discipline | A task needs an API key, token, or facility credential. Verifies presence without exposing values, collects new secrets via hidden terminal input, and contains leaks. |
| [`workflow-distiller`](workflow-distiller/) | workflow | A workflow that just ran should become a reusable skill. Reconstructs it from the session record, interviews, checks overlap, gates on approval, then writes it following `skill-craft`. |
| [`skill-craft`](skill-craft/) | reference | Writing, reviewing, or pruning any SKILL.md: invocation cost, trigger-only descriptions, completion criteria, progressive disclosure, and the pruning pass. |

Each SKILL.md may declare `allowed-tools` / `disallowed-tools`. After a skill
loads, Clio enforces that declaration at tool admission until the turn (or
worker run) ends: calls outside the merged surface are blocked with reason
code `skill_surface`, with `context` and `ask_user` always admitted. A
skill can narrow its tool surface but never grant tools the host would not
allow. Full semantics: docs/safety-model.md, "Skill tool surface narrowing".

## Install (activate a marketplace skill)

`clio skills install` is the bridge from marketplace to runtime. It copies a
skill into a discovery root and stamps install provenance so Clio can load it.

```bash
# Project scope (default): copy into <repo>/.clio/skills
clio skills install context-handoff

# User scope: copy into the Clio config skills dir, available everywhere
clio skills install clio-dev --user
```

Bare names resolve through the local marketplace (this catalog when run from
the repo, `CLIO_SKILL_CATALOG_DIR`, or the skill-marketplace.json index); an
existing local path always wins over a same-named marketplace entry.

After install, confirm Clio sees it:

```bash
clio skills list            # human view
clio skills inspect context-handoff # full metadata + provenance
```

Installed copies are frozen; refresh them from their `source-url` provenance
with `clio skills update <name>` or `clio skills sync`. While developing a
catalog skill, load it directly without installing:
`clio --skill skills/<name>/SKILL.md`.

Uninstall is just removing the copy: `rm -r .clio/skills/<name>` (or the
user-scope equivalent). Installs never write outside `.clio/skills` or the
user config skills dir, both of which are gitignored / outside the repo.

### Skill discovery and find-skills precedence

Clio ships [`find-skills`](find-skills/) so that discovery and installation
both route through `clio skills`. A community skill of the same name is
commonly present in the compat roots (`~/.agents/skills`,
`~/.claude/skills`) and drives the external `npx skills` installer, which
bypasses Clio. Compat roots stay enabled, and the loader resolves name
collisions by precedence: the Clio user root and `.clio/skills` outrank the
compat roots. Install the catalog copy so it wins:

```bash
clio skills install find-skills --user   # or --project for one repo
```

## Contributing / approval

A skill is "approved for the marketplace" when a maintainer:

1. Reviews `SKILL.md` against [`skill-craft`](skill-craft/) (trigger-only
   description, checkable completion criteria, progressive disclosure, pruning
   pass, evals present).
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
against (RED-GREEN per [`skill-craft`](skill-craft/)). `clio skills eval <name>`
executes those scenarios instead of trusting the prose; the eval lane is the
curation gate for this catalog, not an end-user feature.

`npm run skills:pin` enforces this contract structurally: it refuses to pin a
catalog where any skill is missing the required frontmatter, `audit: pass`, or
its `evals.md`, and `npm run skills:check` (run in CI) fails on any drift
between the catalog and `registry.yaml`. Pinned hashes are provenance-stripped
(install-lifecycle stamps like `installed-at` do not count as drift; content
and registry-identity edits do), so a copy installed via `clio skills install`
still verifies against its audited source at activation.

A skill may declare typed dependencies with `requires: [skill:<name>, ...]`
frontmatter; the loader warns at load time when a required skill is not
installed, keeping composed workflows (for example a distilled skill that
references `credentials`) auditable instead of silently incomplete.
