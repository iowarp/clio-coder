# Skills in the library

Skills are one kind of [library package](resource-library.md). `/skills` opens the Library overlay's skill tab directly, while `/library` opens the full overlay (covering skills, plugins, agents, prompts, and fleets). `/skill <name>` invokes a skill, and `/skill off` clears the session's active tool surface; bare `/skill` returns usage guidance pointing to `/skills`. Skill packages use the same manifest, version, full-tree digest, origins, scope and lifecycle as every other package.

```bash
clio-coder library search grill --kind skill
clio-coder library install skill:grill-me --project --dry-run
clio-coder library install skill:grill-me --project
clio-coder library skills --all --json
```

The bundled index makes complete packages available without installing them. An ordinary packaged skill copies from Clio's shipped files without network access. Local user and project registrations can add packages. Automatic offers and `/skill <name>` use the same library entries and package installer. An unmanaged `SKILL.md` remains a valid runtime resource; preparing a distributable requires a package manifest as described in [authoring](authoring-plugins.md).

## Operator ownership of installed skills

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

For duplicate skill names or paths, trusted candidates take precedence over untrusted candidates. An untrusted `.claude/skills` or `.agents/skills` copy cannot hide a trusted Library installation. Normal scope precedence still decides between trusted copies, including project compatibility roots the operator explicitly trusts. A named load of an untrusted or manual-only skill reports that restriction instead of claiming the skill is unknown.

## Matching, authoring and evals

Authored whole-phrase triggers rank before incidental name or description overlap. Matches are lexical suggestions, not evidence that a model will offer or successfully use a skill. Headless sessions emit passive library-install guidance and do not open an interview. Interactive offers require a bound operator answer.

House skills live in `library/skills/<category>/<name>/`, with `SKILL.md`, a package `plugin.json`, and authored `evals.md` scenarios. `skills:check` checks authoring metadata and normalized audit evidence; `library:check` verifies the distributable's complete tree. Only the latter is an installation pin. Explicit catalog-directory and old skill-index probes remain available to authoring utilities for unmanaged source audits; automatic library installation does not use those as a separate installer.

Named suite evals use `clio-coder eval run --package skill:<name> --eval <suite>`. The experimental `clio-coder eval skill <name|path>` runs `evals.md` baseline, treatment and model-judge scenarios. Fixture commands require `--trust-fixtures`; network tools remain off unless `--allow-network` is requested. Those measurements are separate from deterministic package validation.

## Publishing a skill

To publish a skill, prepare a complete skill package with `SKILL.md` and a portable root `plugin.json`. Declare kind `skill`, an explicit Semantic Version, the skill resource root and one public skill component. Validate the package with `clio-coder library validate ./my-skill`, then register its local source with `clio-coder library register ./my-skill --project`. Registration records its full-tree digest without installing it. Install the candidate with `clio-coder library install skill:<name> --project` and verify its behavior before sharing.

For a curated contribution, add the reviewed package beneath `library/skills/<category>/<name>/`, include authored eval scenarios, and regenerate both the skill authoring records (`pnpm skills:pin`) and complete library package pins (`pnpm library:pin`). A shared remote index must name an explicit supported GitHub tree source, version and full-tree SHA-256. The [package authoring guide](authoring-plugins.md) defines the manifest and index fields; publishing does not itself install or activate the skill for another operator.
