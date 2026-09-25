# Clio skill packages

This tree contains reviewed skill instructions and authoring evidence. Complete
packages participate in the same [library](../../docs/guide/resource-library.md) as
plugins, agents, prompts and fleets. Bundling a package does not activate it.
Inside a detected Clio source checkout, the two self-development skills described
below are also available directly from their authoring directories.

`library/skills/` is the canonical source for Clio Coder's curated skills. The npm
package includes this tree, `library/plugins/`, and the `library/registry.yaml` index.
The index points to these bundled directories relative to its own location,
so discovery and installation work from a source checkout or an installed
package without fetching the library from GitHub. Skill provenance URLs point
back to this repository; they do not replace the bundled package source.

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

### Developing Clio itself

When Clio detects its own Git checkout (including worktrees and subdirectory
launches), it discovers `clio-coder-dev` and `clio-coder-test` from
`library/skills/meta/` as native local skills. This does not install packages or
discover the rest of the catalog. Source roots must remain inside the checkout;
an unrelated nested Git repository does not inherit them.

The session prompt recommends `clio-coder-dev` for source changes and
`clio-coder-test` for validation. At `default` and `yolo`, the model can load
ready skills through `context(scope="skills", name="...")`. A read-only run
cannot load a skill. This is automatic discovery
and task-aware guidance, not automatic body injection or a guarantee of a model's
tool choice. `--no-skills`, hidden skills, and task/tool restrictions still apply.

An installed package owns its name even when disabled, damaged, or pending
reload; source discovery does not bypass it. Native local overrides keep their
precedence. Worker recipes retain their declared skill bindings; parent-session
activation is not inherited. A running process needs a new candidate build and
restart for runtime changes, while editing these source skills remains ordinary
repository work. Follow `CONTRIBUTING.md` and the skills' focused references.

## Catalog layout

| Directory | Subject |
| --- | --- |
| `coding/` | Implementation, structural search, prototyping and tests |
| `context/` | Repository orientation and task handoff |
| `git/` | Tickets, patches, worktrees and review closeout |
| `meta/` | Skill authoring, Clio development, credentials and external tools |
| `planning/` | Product intent, architecture, requirements and backlog |
| `research/` | Literature, experiments, scientific debugging and modernization |
| `workflow/` | Interviews, sprint planning, design review and workflow capture |

Each complete package contains `plugin.json`, `SKILL.md`, and any supporting
files. Standalone skill manifests set
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
and a nested `clio-coder:` map with `registry-id`, `source-url`, and `provenance`.
Set `audit: pass` after review. Provenance is `designed`, `adapted`,
or `imported`. Declare optional whole-phrase `triggers` to improve lexical
matching. `allowed-tools` and `disallowed-tools` must name canonical Clio tools.
The description should say when to load the skill; detailed procedure belongs
in the body or supporting references.

Authors can start by copying the standalone skill template from
`library/_authoring/templates/skill/`. The existing `skill-craft` skill provides
the authoring and review procedure.

```bash
clio-coder library validate library/skills/workflow/grill-me/SKILL.md
clio-coder library validate library/skills/workflow/grill-me --json
pnpm run skills:pin
pnpm run skills:check
pnpm run library:pin
pnpm run library:check
```

`skills:pin` and `skills:check` retain the authoring audit records in
`library/skills/registry.yaml` and `library/skills/skill-marketplace.json`. Those normalized
skill-body hashes describe reviewed instruction content and are advisory
provenance evidence; they are not library installation pins. `library:pin`
generates the canonical `library/registry.yaml` from complete package trees.
`library:check` verifies every distributed byte and runs in release hygiene.
Changes to scripts, references or manifests require repinning the library just
as changes to instructions do.

For local publication, run `clio-coder library register <package-root> --user`
or `--project`, then install its typed reference. Remote index entries require
an explicit GitHub tree URL, the manifest version and a complete-tree SHA-256.
Read the [package authoring guide](../../docs/guide/authoring-plugins.md) for the
portable manifest and component contract.
