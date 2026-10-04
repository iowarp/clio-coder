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
package without fetching the library from GitHub. Skill source URLs point
back to this repository; they do not replace the bundled package source.

## Install and use

```bash
clio-coder library search research --kind skill
clio-coder library install skill:plan-interview --project --dry-run
clio-coder library install skill:plan-interview --project
clio-coder library skills --all --json
clio-coder library update skill:plan-interview --project
clio-coder library disable skill:plan-interview --project
clio-coder library remove skill:plan-interview --project
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

For the 0.6.2 name changes and explicit installed-copy migration, see
[skill migration](../../docs/guide/skills-marketplace.md#skill-names-and-installed-copy-migration-in-062).

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

`map-codebase` creates native interactive HTML maps using Clio's repository
index and source navigation. Run `/skill map-codebase` for an explained map,
or `clio-coder context map` for direct generation. No separate renderer is
needed. Packages retain normal integrity, trust and permission controls.
