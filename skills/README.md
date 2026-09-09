# Clio skill packages

This tree contains reviewed skill instructions and authoring evidence. Complete
packages participate in the same [library](../docs/guide/resource-library.md) as
plugins, agents, prompts and fleets. Nothing in this source tree loads merely
because it ships with Clio.

## Install and use

```bash
clio-coder library search research --kind skill
clio-coder library install skill:grill-me --project --dry-run
clio-coder library install skill:grill-me --project
clio-coder library skills --all --json
clio-coder library update skill:grill-me --project
clio-coder library disable skill:grill-me --project
clio-coder library remove skill:grill-me --project
```

In a session, `/library skill` browses skill packages and `/skill <name> [task]`
activates one. Installed skill packages live beneath the selected scope's
`plugins/<name>/`, with one complete-tree digest and the common package state.
Unmanaged local `SKILL.md` files still load from established Clio and foreign
resource roots. Foreign project imports and interop-adopted resources retain
their trust requirements. Plugin resource roots are the packaged resource tier;
harness extensions do not contribute skills.

Installations, updates and active resource trees belong to the operator. Models
may draft outside active roots and inspect or validate the result, but recognized
model shell mutations of library packages are refused at every autonomy level.
Interactive offers commit only after the bound operator answer. Skill tool
restrictions last for the session until replaced or cleared with `/skill off`;
worker activations remain scoped to their run. A skill can narrow tools but never
grant authority the host disallows.

## Source organization

| Directory | Subject |
| --- | --- |
| `coding/` | Implementation, structural search, prototyping and tests |
| `context/` | Repository orientation and task handoff |
| `git/` | Tickets, patches, worktrees and review closeout |
| `meta/` | Skill authoring, Clio development, credentials and external tools |
| `planning/` | Product intent, architecture, requirements and backlog |
| `research/` | Literature, experiments, scientific debugging and modernization |
| `workflow/` | Interviews, sprint planning, design review and workflow capture |

Each complete package contains `plugin.json`, `SKILL.md`, authored `evals.md`
scenarios, and any supporting files. Standalone skill manifests set
`extensions["ai.iowarp.clio"].kind` to `skill`, declare `resources.skills: "."`,
and declare exactly one skill component at `SKILL.md`. The package name and
explicit Semantic Version identify the distributable.

Archify's package is an instruction wrapper for an independently installed
upstream renderer. It does not claim to ship that renderer's executable,
schemas or examples. Follow the skill's prerequisite check before using it.
The raw-source overlay helpers and `remote.yaml` remain authoring/preparation
utilities; the library installs complete, manifest-bearing trees through the
common package engine.

## Authoring contract

House skills require `name`, `description`, `version`, and `license` frontmatter,
and a nested `clio-coder:` map with `registry-id`, `source-url`, `provenance`, and
`eval-status`. Set `audit: pass` after review. Provenance is `designed`, `adapted`,
or `imported`. Declare optional whole-phrase `triggers` to improve lexical
matching. `allowed-tools` and `disallowed-tools` must name canonical Clio tools.
The description should say when to load the skill; detailed procedure belongs
in the body or supporting references.

Create an `evals.md` beside every house skill with realistic baseline/treatment
scenarios and explicit expected evidence. Metadata saying scenarios are recorded
is not a claim that a model evaluation passed. The existing `skill-craft` skill
provides the authoring and review procedure.

```bash
clio-coder library validate skills/workflow/grill-me/SKILL.md
clio-coder library validate skills/workflow/grill-me
pnpm skills:pin
pnpm skills:check
pnpm library:pin
pnpm library:check
```

`skills:pin` and `skills:check` retain the authoring audit records in
`skills/registry.yaml` and `skills/skill-marketplace.json`. Those normalized
skill-body hashes describe reviewed instruction content and are advisory
provenance evidence; they are not library installation pins. `library:pin`
generates the canonical `library/registry.yaml` from complete package trees.
`library:check` verifies every distributed byte and runs in release hygiene.
Changes to scripts, references, manifests or evals require repinning the library
just as changes to instructions do.

For local publication, run `clio-coder library register <package-root> --user`
or `--project`, then install its typed reference. Remote index entries require
an explicit GitHub tree URL, the manifest version and a complete-tree SHA-256.
Read the [package authoring guide](../docs/guide/authoring-plugins.md) for the
portable manifest and component contract.

## Evaluation

Named suite evals belong in the package manifest's `evals` map and run through
`clio-coder eval validate/run --package skill:<name> --eval <suite>`. The same
suite contract works for all five package kinds.

The experimental `clio-coder eval skill <name|path>` lane executes authored
`evals.md` RED/GREEN scenarios. It runs a baseline without the skill, a treatment
with it, and a judge over the expected evidence. `--scenario` selects a scenario;
`--target`, `--workspace`, and `--timeout` configure the run. Fixture shell needs
`--trust-fixtures`; network tools need `--allow-network`. Unmeasured judge output
is reported separately from a failed treatment. These model-based measurements
are independent of deterministic package and script validation.
