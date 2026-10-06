# Skills in the library

`loadSkills` in [loader.ts](../../src/domains/resources/skills/loader.ts) selects runtime skills. The [library architecture](../architecture/library.md) explains package integrity.

Skills are one kind of [library package](resource-library.md). `/skills` opens the Library on its Skills tab, while `/library` opens the full overlay (skills, agents, prompts, playbooks, plugins, and extensions). `/skill <name> [task]` invokes a skill, `/skill off` clears the session's skill tool-surface narrowing without erasing instructions already loaded in the transcript, and bare `/skill` returns a usage error pointing to `/skills`. Skill packages use the same manifest, version, full-tree digest, origins, scope and lifecycle as every other package. The SKILL.md format, discovery roots, collision order and trust rules are in [extensions-and-sharing.md](extensions-and-sharing.md#skills).

```bash
clio-coder library search interview --kind skill
clio-coder library install skill:plan-interview --project --dry-run
clio-coder library install skill:plan-interview --project
clio-coder library skills --all --json
```

The bundled index makes complete packages available without installing them. An ordinary packaged skill copies from Clio Coder's shipped files without network access. Local user and project registrations can add packages. Slash commands are entered in Clio Coder, not in a shell. An unmanaged `SKILL.md` remains a valid runtime resource; preparing a distributable requires a package manifest as described in [authoring](authoring-plugins.md).

`/skill <name>` for a skill that is not installed but has an index entry asks the operator whether to install it: "Install and run" (user scope), "Install for this project and run", or "Cancel". An accepted choice installs through the library installer, reloads resources, and runs the skill. A name with no installed or indexed skill reports that no local marketplace entry is available.

The project-scope choice does not approve workspace trust, and neither does the marketplace question below. A skill installed into a project this way loads only while the project's `.clio-coder/plugins/state.json` is approved, which `clio-coder library install <ref> --project` does for the workspace's first project install and `clio-coder config trust plugins` does afterwards. See [workspace trust for project packages](resource-library.md#workspace-trust-for-project-packages).

## Operator ownership of installed skills

Active `.clio-coder/{skills,plugins,extensions}/` and `<configDir>/{skills,plugins,extensions}/` trees are operator-owned. Main and worker tool admission refuses recognized model writes, edits, deletes and shell mutations to those trees at both autonomy levels (`default` and `yolo`) with reason `skill-authority`, and reads stay allowed. A model shell call is also inspected for the operator CLI:

| Model shell call | Disposition |
| --- | --- |
| `clio-coder library install`, `import`, `update`, `remove`, `enable`, `disable`, `pin`, `register`, `sync`, `push`, `remote` | One-shot operator confirmation in `default` (reason `library-confirm`). Admitted in `yolo` unless a damage-control rule also matches. A headless run denies the ask. |
| `clio-coder library install --dry-run`, `import --dry-run`, `update --dry-run`, `enable --dry-run`, `disable --dry-run`, `remove --dry-run`, and `search`, `list`, `components`, `inspect`, `validate`, `drift`, `reload`, `skills`, `inventory` | Not treated as mutations. A `--dry-run` builds the plan and writes nothing, so it never asks. |
| `clio-coder share import` without `--dry-run`, `clio-coder extensions test`, `clio-coder extensions validate` | One-shot operator confirmation in `default`, admitted in `yolo` unless a damage-control rule also matches, denied in a headless run. An import installs packages from an archive the model may have written, and the other two run a package's own code. |
| `clio-coder extensions` install, update, remove, enable, disable, pin; `clio-coder interop adopt --yes`; any `clio-coder config trust` | Blocked at every autonomy level. The trust form is blocked as `trust-authority`, so the model cannot approve a project's extensions, plugins or other surfaces. |

This is a command-inspection and tool-admission boundary, not an operating-system sandbox for arbitrary scripts or dynamically constructed shell commands.

Draft outside active roots, for example `draft-skills/example/`. The operator can review `library validate draft-skills/example/SKILL.md`, then register and install a complete package. Explicitly accepted skill offers install through the library. A lexical match alone never installs a skill in either mode.

## Attended install rule

The `operating.skill-installs` fragment ([skill-installs.md](../../src/domains/prompts/fragments/operating/skill-installs.md)) is attended-only. The compiler appends it to the skills section of the main prompt for TUI, GUI and ACP sessions whenever skills are usable, right after `operating.discovered-skills`. Headless `clio-coder run` prompts carry the discovery fragment without it, and worker prompts carry neither. When asked to install a skill, Clio Coder follows these rules:

- Install only when the operator requests or approves it.
- When a `[Marketplace]` reminder arrives, ask with `ask_user` (header "Install skill") and offer exactly "Install for this project", "Install globally", "Not now", and "Never offer this skill". A declined installation settles the offer for this task. The harness acts only on an answer that carries the offer's binding tag and performs the install itself, so the model never installs or loads a skill in the offer flow.
- For an explicit operator request, the documented route is `clio-coder library install kind:name --user|--project` through bash with operator approval, and `--dry-run` previews it without a write or an approval prompt.
- After an approved install, inspect readiness again and report `/library reload` if the running session has not admitted the skill. A committed `library install` itself ends with `A running session picks this up after /library reload.` in plain output.
- `/skill` is an interactive command, not a shell command.
- Do not bypass integrity, import trust or workspace trust checks.

Activation is separate from installation. In `default` and `yolo` the model loads a matching ready skill itself through `context(scope="skills", name="<name>")` and follows its workflow and tool restrictions. A read-only dispatched run cannot activate skills. Loading narrows allowed tools and can never grant a tool the host disallows.

## Marketplace offers

The marketplace offer is the unsolicited path. It is local: the matcher in [promotion.ts](../../src/domains/resources/skills/promotion.ts) scores the operator's request against the pinned index with no model call and no network access, and the request text never leaves the process.

- A whole-phrase match on an authored `triggers` entry (at least 4 characters) fires, and so does an overlap of at least 3 distinctive name and description tokens. Authored trigger hits rank before incidental overlap. The reminder tells the model not to ask when built-in tools already cover the request, such as parallel worker dispatch or git operations.
- An offer needs a substantive operator turn with no pending operator skill request. Each skill is offered at most once per session. "Not now" or a typed answer instead of an option pauses offers for the rest of the session, and a failed install declines that skill for the session. "Never offer this skill" also pauses offers and persists in `<configDir>/skill-promotion-declines.json`, keyed by name and catalog version, so a later version can be offered again.
- A consented install passes `assertPromotionInstallSource`, which accepts only Clio Coder's own marketplace: the shipped package catalog (a local path) or `https://github.com/iowarp/clio-coder/` URLs. Any other source is rejected in code. Operator-driven `library install` of other indexed sources is unaffected.
- Headless runs and ACP sessions get passive guidance (`install with clio-coder library install <name>`) and no question. Workers never see or trigger offers.

## Visibility and reload

The Library overlay keys are in [resource-library.md](resource-library.md#interactive-library). Pin verification and drift checks are CLI-only: `clio-coder library pin` and `clio-coder library drift`.

Model visibility and the trust rules for imported and loose skills are in [extensions-and-sharing.md](extensions-and-sharing.md#trust-and-compatibility-roots). Disabled, incompatible or drifted package resources do not load, and neither do the packages of a project whose plugin state the operator has not approved. `/library reload` refreshes an active session after a lifecycle change or a new approval.

## Model-facing inventory

`context(scope="skills")` with no `name` returns a bounded listing in these sections:

1. **Ready skills in Clio Coder.** Trusted, model-invocable skills from Clio Coder roots and enabled library packages, each with source, scope and description. A skill whose content no longer matches its recorded pin carries a `[drifted]` marker and an explanatory notice, and loading it adds a `skill_drift` warning.
2. **Explicitly supplied session skills.** Skills loaded by `--skill <path>`, which are not installed packages.
3. **Installed packages providing skills.** Package, scope, origin, path and state.
4. **Marketplace.** Indexed skills not yet installed, omitted for workers, for `--no-skills` runs, and for runs bound to an agent definition.

The listing accepts `query`, `limit` (at most 200) and `offset`, and cuts by whole rows to fit the observation budget. Other agents' skill folders are discovery-only and never listed as ready, and availability through another agent's skill root does not mean Clio installed or copied that skill. Resetting Clio does not remove those external files.

Readiness is separate from installation. A package's state reads `ready`, `requires trust` (a foreign package while `integrations.projectResources.trustProjectImports` is off, or an enabled project package while the project's plugin state is not approved), `pending reload; run /library reload`, `no ready skills; inspect /library`, `damaged`, `shadowed`, `disabled`, `incompatible`, or `invalid`. An install performed in another process appears as installed before `/library reload` admits it into the session. Only `ready` skills are advertised for use, and marketplace suggestions exclude actual Clio copies, not loose discoveries from other agents. A named load of an installed skill that is not ready reports its state and tells the model not to reinstall it.

## Registry and pins

Every distributable byte is pinned by SHA-256, and the pins are generated, never edited by hand.

| File | Role |
| --- | --- |
| `library/registry.yaml` | The bundled library index. One row per package with its full-tree `sha256`, version, `triggers`, `audit`, and `provides` hints. The runtime resolves installs from it. |
| `library/skills/registry.yaml` | Normalized skill-body hashes (install-lifecycle provenance stripped). At activation, an installed skill carrying `registry-id` provenance is compared with its pinned hash and a mismatch surfaces a drift warning. This is authoring and provenance evidence, not an installation pin. |
| `library/skills/skill-marketplace.json` | Published by `skills:pin` for authoring and provenance inspection. Runtime discovery and installation use `library/registry.yaml`, so this is not a second installation authority. |
| `.claude-plugin/marketplace.json` | A projection of the pins for Claude Code, so another agent can install the packages from the repository. |

`pnpm library:pin` runs four stages. It validates every package under `library/{skills,agents,prompts,playbooks,plugins,extensions}` and the authoring templates, requiring the package kind to match its kind directory and identities to be unique. It refreshes the normalized skill evidence, the same work as `pnpm skills:pin`. It writes `library/registry.yaml` from the actual manifests and complete package trees, and it re-fetches each blessed remote row (a GitHub tree `sourceUrl`, such as the `wtfp` plugin) to verify its digest, keeping the previous pin with a warning when the fetch fails. Finally it regenerates `.claude-plugin/marketplace.json`. `pnpm library:check` repeats every stage as a check, fails on stale metadata or digests, and runs inside `pnpm lint` as the `library-pin` hygiene gate. `pnpm skills:pin` and `pnpm skills:check` run the skill-evidence stage alone.

A catalog skill must carry `name`, `description`, `version` and `license` frontmatter and a nested `clio-coder:` block with `registry-id`, `source-url` (ending in its catalog path) and `audit: pass`. Tool-surface lists must use Clio Coder tool names in lowercase. `triggers`, when present, is a non-empty list of strings.

The marketplace file makes the packages installable from the repository: `claude plugin marketplace add iowarp/clio-coder`, then `claude plugin install <name>@clio-coder`. Codex can read the same canonical directories once you link them into `~/.agents/skills`; the checkout does not ship those links. Neither surface holds a copied component body, and `library:check` fails on a stale one. A package publishes there only when a peer host would load a real skill surface from it and nothing it would default-scan into a native component. The pin run prints each package it left out and why, and leaving one out is not a failure. See [coding agent interoperability](interop.md).

## Publishing a skill

To publish a skill, prepare a complete skill package with `SKILL.md` and a portable root `plugin.json` that declares kind `skill`, an explicit Semantic Version, the skill resource root and one public skill component; the [contributor journey](authoring-plugins.md#authoring-templates-and-contributor-journey) walks the steps. Validate with `clio-coder library validate ./my-skill`, register its local source with `clio-coder library register ./my-skill --project` (which records its full-tree digest without installing), install the candidate with `clio-coder library install skill:<name> --project`, and verify its behavior before sharing.

For a curated contribution, add the reviewed package beneath `library/skills/<category>/<name>/` with `SKILL.md` and a package `plugin.json`, then run `pnpm library:pin`. A shared remote index must name an explicit supported GitHub tree source, version and full-tree SHA-256. Publishing does not itself install or activate the skill for another operator. The `skill-authoring` shipped skill documents the frontmatter contract and craft rules.

## Native workflow skills

Use names that describe the work: `plan-interview`, `sprint-plan`,
`map-codebase`, `skill-authoring`, and `workflow-capture`.
The catalog, package identities, and worker bindings use these names directly.

`map-codebase` uses Clio Coder's own repository index, navigation and HTML rendering.
Install with `clio-coder library install skill:map-codebase --user` (or
`--project`), inspect with `clio-coder library inspect skill:map-codebase`,
and reload the Library. Invoke `/skill map-codebase` for Clio Coder to explain and
refine the map, or run `clio-coder context map` to generate it directly.
Use `--out <path.html>` for a requested destination. The standalone HTML opens
without network access or a separate renderer. Clio runs the frontend check on the final artifact
and reports the actual browser outcome.

Curated publication metadata no longer requires or emits `provenance` ancestry
categories or `origin` author claims. `registry-id`, `source-url`, `audit`,
normalized instruction hashes, complete-package SHA-256 pins, install records,
and trust controls remain. Required notices for retained third-party material
remain with that material.
