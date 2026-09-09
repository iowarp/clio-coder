# Skills in the library

> **Visual blueprint:** See the [Skills visual reference](../html/skills_blueprint.html) in the source checkout.

Skills are one kind of [library package](resource-library.md). `/library skill` and bare `/skill` open the Library overlay's skill tab. The other four tabs are plugins, agents, prompts and fleets. Skill packages use the same manifest, version, full-tree digest, origins, scope and lifecycle as every other package.

```bash
clio-coder library search grill --kind skill
clio-coder library install skill:grill-me --project --dry-run
clio-coder library install skill:grill-me --project
clio-coder library skills --all --json
```

The bundled index makes complete packages available without installing them. An ordinary packaged skill copies from Clio's shipped files without network access. Local user and project registrations can add packages. Automatic offers and `/skill <name>` use the same library entries and package installer. An unmanaged `SKILL.md` remains a valid runtime resource; preparing a distributable requires a package manifest as described in [authoring](authoring-plugins.md).

## Operator ownership

Active `.clio-coder/skills/`, `<configDir>/skills/`, and managed package trees are operator-owned. Main and worker tool admission refuses recognized model writes, edits, deletes and shell mutations to those trees at every autonomy level. Library install, update, registration, enable/disable, removal and pin actions are reserved for the operator; install/update `--dry-run`, search, inspection and draft validation remain available. This is a tool-admission boundary, not an operating-system sandbox for arbitrary scripts or dynamically constructed shell commands.

Draft outside active roots, for example `draft-skills/example/`. The operator can review `library validate draft-skills/example/SKILL.md`, then register and install a complete package. Explicitly accepted skill offers install through the library. A lexical match alone never grants installation authority, including at `full-auto`.

## Library keys and runtime use

| Key | Action |
| --- | --- |
| Type | Filter rows |
| Left / Right | Change kind tab |
| `s` | Switch user/project action scope |
| `Enter` | Use a selected runtime resource or inspect a plugin |
| `i` | Review installation; a second request can include missing requirements |
| `u` | Review update |
| `e` | Enable or disable the selected installed copy |
| `r` | Review removal |
| `p` | Verify and show the recorded package pin |
| `d` | Check installed drift |
| `Esc` | Close or cancel |

`/skill <name> [task]` activates a skill; `/skill off` clears the session's tool-surface narrowing. Loading can narrow allowed tools but cannot grant tools the host disallows. At `read-only` and `suggest`, activation requires an operator request; `auto-edit` and `full-auto` may activate installed skills. Listing available skills does not load their bodies.

Model-visible skills must be trusted and permit model invocation. Foreign project resources and all interop-adopted foreign skills require `integrations.projectResources.trustProjectImports`. A project resource adopted into user scope retains foreign trust. Disabled, incompatible or drifted package resources do not load. `/library reload` refreshes an active session after a lifecycle change.

## Matching, authoring and evals

Authored whole-phrase triggers rank before incidental name or description overlap. Matches are lexical suggestions, not evidence that a model will offer or successfully use a skill. Headless sessions emit passive library-install guidance and do not open an interview. Interactive offers require a bound operator answer.

House skills live in `skills/<category>/<name>/`, with `SKILL.md`, a package `plugin.json`, and authored `evals.md` scenarios. `skills:check` checks authoring metadata and normalized audit evidence; `library:check` verifies the distributable's complete tree. Only the latter is an installation pin. Explicit catalog-directory and old skill-index probes remain available to authoring utilities for unmanaged source audits; automatic library installation does not use those as a separate installer.

Named suite evals use `clio-coder eval run --package skill:<name> --eval <suite>`. The experimental `clio-coder eval skill <name|path>` runs `evals.md` baseline, treatment and model-judge scenarios. Fixture commands require `--trust-fixtures`; network tools remain off unless `--allow-network` is requested. Those measurements are separate from deterministic package validation.
