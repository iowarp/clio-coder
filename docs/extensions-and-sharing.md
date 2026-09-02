# Extensions, Resources, and Share Archives

> [!TIP]
> **Interactive Spec Available:** A source-checkout dashboard is available at [docs/html/extensions_blueprint.html](https://github.com/iowarp/clio-coder/blob/main/docs/html/extensions_blueprint.html).

Clio Coder has lightweight community-oriented resource packaging. Extensions are filesystem bundles that can contribute prompts, skills, agent recipes, and fleet contracts. Manifests may also reserve a theme root, but the runtime does not apply extension themes. Share archives are portable JSON files for moving project and user Clio resources between machines or collaborators.

Source of truth: `src/domains/extensions/**`, `src/domains/resources/**`, `src/domains/share/**`, `src/cli/extensions.ts`, and `src/cli/share.ts`.

---

## Resource roots and precedence

Prompts and skills are loaded from package, user, and project roots. Higher-ranked roots override lower-ranked resources with the same name.

Prompts and skills both add compatibility roots so that the command and skill files other agents already have on the machine are usable without copying. Both root lists come from the interop agent registry (`src/domains/interop/registry.ts`), so the two kinds cannot drift apart. The prompt precedence, lowest to highest, is:

| Precedence | Scope | Source | Root |
| --- | --- | --- | --- |
| 10 | package | extension | enabled extension resource roots |
| 20 | user | claude / codex / opencode | `~/.claude/commands`, `~/.codex/prompts`, `~/.config/opencode/command` |
| 30 | user | clio | `<configDir>/prompts` |
| 40 | project | claude / codex / opencode | `.claude/commands`, `.codex/prompts`, `.opencode/command` (untrusted by default) |
| 50 | project | clio | `.clio-coder/prompts` |

The skill precedence, lowest to highest, is:

| Precedence | Scope | Source | Root |
| --- | --- | --- | --- |
| 10 | package | extension | enabled extension resource roots |
| 20 | user | agents / claude / codex / copilot / opencode | `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.copilot/skills`, `~/.config/opencode/skills` |
| 30 | user | clio | `<configDir>/skills` |
| 40 | project | agents / claude / codex / copilot / opencode | `.agents/skills`, `.claude/skills`, `.codex/skills`, `.github/skills`, `.opencode/skills` (untrusted by default) |
| 50 | project | clio | `.clio-coder/skills` |
| 60 | cli | path | reserved for call-site injected resources |

Clio-native roots intentionally outrank shared compatibility roots at the same scope, so `.clio-coder/skills` overrides a project `.codex/skills` skill of the same name, and `<configDir>/skills` overrides `~/.agents/skills`. If multiple compatibility roots contain the same name at the same precedence, the tie breaks by the registry's agent order rather than by path spelling, so a skill symlinked into two foreign roots resolves to the same winner on every machine. If two roots resolve to the same canonical `SKILL.md` through a symlink, Clio keeps the higher-precedence entry and records a diagnostic naming the path that is in use.

---

## Prompt templates

Prompt templates are Markdown files under a prompt root. Filename is the command name.

Example `.clio-coder/prompts/bugfix.md`:

```md
---
description: Focused bug-fix prompt
argument-hint: "<file> <symptom>"
---

Investigate $1 for this symptom: $2

Return:
1. likely root cause;
2. minimal patch plan;
3. validation commands.
```

Use in the TUI:

```text
/resources prompts
/bugfix src/parser.ts empty input crashes
```

Templates without frontmatter are accepted; Clio derives a fallback description from the first non-empty line. Invalid frontmatter degrades to a warning for prompt templates rather than failing the whole load.

### Foreign prompt roots

A Claude Code slash command in `.claude/commands`, a Codex prompt in `.codex/prompts`, and an OpenCode command in `.opencode/command` are prompt templates Clio reads directly, at both user and project scope. A foreign prompt is text substituted into a message the operator typed, so it keeps the untrusted-by-project default that skills have and never gains an execution grant of its own.

User-scope foreign prompts are trusted because they came from the operator's
machine. A project-scope prompt lists in `/resources prompts` with an
`untrusted` marker and refuses substitution until
`integrations.projectResources.trustProjectImports: true` opts in. An untrusted
template sends nothing to the model. A token naming neither a command nor a
template reports `is not a command`.

---

## Skills

Skills follow the Agent Skills `SKILL.md` format. A skill is a directory containing `SKILL.md`, or a single Markdown file under a skill root. YAML frontmatter is required and must include a `description`. A missing description is the only hard rejection; every other validation issue degrades to a warning and the skill still loads.

Example `.clio-coder/skills/hdf5-review/SKILL.md`:

```md
---
name: hdf5-review
description: Review HDF5/NetCDF validation logic and output assumptions.
license: MIT
allowed-tools:
  - Read
  - Grep
---

When asked to review scientific array output:
- identify expected dimensions and attributes;
- ask for validation data when absent;
- prefer deterministic scripts over visual inspection;
- cite files and commands used.
```

Use in the TUI:

```text
/skill
/skill hdf5-review review the output validation path
```

`/skill` opens the Skills Hub with discovered project skills, user skills, and marketplace entries. `/skill <name> [args]` submits `args` with a pending skill request; the model must call `context` (scope="skills") for that skill before following the workflow. The same pending-request path runs in headless mode, so `clio-coder run "/skill hdf5-review inspect the writer"` matches the interactive behavior.

Every activation records a session ledger entry with the skill name, file path, hash, source, trigger (`slash-command` or `tool`), and turn id when one is available. The same ledger is mirrored into session metadata, prompt diagnostics, and run receipts. Compaction keeps the newest active skill turn in the retained suffix so a loaded skill is not silently summarized away.

### Naming and validation

The canonical invocation name is the frontmatter `name` when present, otherwise the directory or file subject. When `name` differs from the path subject Clio records a warning and keeps the frontmatter name, which lets shared cross-agent skill folders load without renaming. Names should use lowercase letters, numbers, and single hyphens; format violations warn but do not block loading.

Recognized frontmatter fields:

- `name`, `description`: core identity.
- `disable-model-invocation: true`: hides the skill from the model-visible catalog while keeping it loadable by `/skill <name>`.
- `allowed-tools`, `disallowed-tools`: parsed as tool policy fields for the loaded skill workflow.
- `license`, `version`, `compatibility`, and other non-core keys: captured as skill metadata and surfaced when the skill loads through `context`.
- `source-url`, `registry-id`, `installed-at`, `updated-at`, `audit`: captured as install provenance when present.

### Trust and compatibility roots

Shared user roots are model-visible by default, like the Clio user root. Project-local compatibility roots are discovered but **untrusted by default**: they appear in `/skill` with an `untrusted` marker, but they are excluded from the model-visible catalog and cannot be loaded through `context`. This prevents an unreviewed project checkout from injecting skills the model will act on.

Opt in to model-visible project compatibility roots by setting `integrations.projectResources.trustProjectImports: true` in `settings.yaml`. `.clio-coder/skills` is always trusted as the Clio-native project root.

### Loading with context, writing directly

`context(scope="skills")` lists model-visible skills when called with no `name`, or loads a pending skill body by `name`. It returns structured metadata (`name`, `description`, `path`, `base_dir`, `hash`, `source`, `scope`, `disable_model_invocation`, parsed tool policy fields, diagnostics, and frontmatter metadata) plus the body. Pass `include_tree: true` to list sibling files under the skill base directory, capped internally at 50 entries. The skills scope never executes bundled scripts and only resolves skills the model is allowed to see.

Creating a skill is writing a `SKILL.md` file with the ordinary write tool: `.clio-coder/skills/<name>/SKILL.md` for project scope, or the Clio config skills directory for user scope. The loader validates frontmatter on load (`clio-coder skills validate` reports diagnostics), and the `skill-craft` shipped skill documents the frontmatter contract and craft rules.

### Skills CLI

```bash
clio-coder skills list [--json] [--all]
clio-coder skills search <query> [--json]
clio-coder skills inspect <name> [--json]
clio-coder skills validate [path] [--json]
clio-coder skills install <name|path|github-url> [--user|--project] [--name <name>] [--force]
clio-coder skills update <name> | --all [--force]
clio-coder skills sync [--force]
clio-coder skills eval <name|path> [--scenario <id>] [--target <id>] [--workspace <path>] [--timeout <seconds>] [--trust-fixtures] [--allow-network] [--json]
```

`eval` (experimental) executes a skill's `evals.md` RED-GREEN scenarios with
baseline, treatment, and judge runs; see
[skills-marketplace.md](skills-marketplace.md) for the catalog contract it
verifies. Fixture commands in an `evals.md` are real shell and only run with
`--trust-fixtures`.

Every arm runs hermetic in a disposable workspace: the network tool plane is stripped from child runs so a scenario measures the skill against its workspace and not against the open web. Baseline and treatment arms run with `full-auto` autonomy; the judge does not receive that flag. `--allow-network` keeps the web tools, and the run reports which network policy was in force. The per-arm execution timeout is set with `--timeout <seconds>`.

Exit code is 1 when a treatment bullet fails. Exit code is 3 when a scenario goes unmeasured, such as when judge output is truncated, missing, or unparseable, or when a run dies at a permission wall. Permission-wall deaths and harness infrastructure failures are classified as unmeasured infrastructure errors rather than negative verdicts on the skill.


Headless runs also accept `--no-skills` to disable discovery and repeatable `--skill <path>` to load one explicit `SKILL.md` file or skill directory for that run. Explicit `--skill` paths are honored even when `--no-skills` is set.

### Agent Skills compatibility

Clio is local-first. Skills run from disk and no chat turn depends on network access. Because the compatibility roots above use the standard `SKILL.md` shape, skills installed by the Skills.sh CLI for other agents are usable directly:

```text
npx skills add <skill> -a codex   # installs into ~/.codex/skills
```

Clio does not call Skills.sh during startup or prompt assembly, and does not emit its own telemetry. If you run `npx skills`, its telemetry follows that CLI and can be disabled with `DISABLE_TELEMETRY=1`. Skills.sh remote search and audit are not enabled in this release. Clio does support local marketplace search plus `clio-coder skills install <name|path|github-url>`: bare names resolve through the local marketplace, and explicit local paths or GitHub URLs install directly.

### Prompt envelope and safety

Skill bodies never enter the prompt uninvited. The model discovers skills only through `context(scope="skills")`: a call with no `name` returns a one-line listing (name, scope, description) of model-visible skills, and a body loads only when the pending-skill policy authorizes that name for the turn, which requires an explicit operator invocation such as `/skill <name>`. Skills are prompt resources, not execution grants: any script a skill references still runs through normal Clio tools and safety gates, and a loaded skill's `allowed-tools` declaration narrows the tool surface at admission (reason code `skill_surface`) without ever granting anything the host would refuse.

---

## Extension package manifest

An extension root contains `clio-coder-extension.yaml`, `clio-coder-extension.yml`, or `clio-coder-extension.json`.

```yaml
manifestVersion: 1
id: lab-pack
name: Lab Pack
version: 1.0.0
description: Prompts and skills for this lab
resources:
  prompts: prompts
  skills: skills
  agents: agents
  fleets: fleets
  themes: themes
compatibility:
  clio: ">=0.2.0"
```

Required fields are `manifestVersion: 1`, `id`, `version`, and `description`. `name` defaults to `id` when absent, and `resources` is optional. When `resources` is present it must be an object containing only `prompts`, `skills`, `agents`, `fleets`, and `themes`, each with a non-empty relative directory path. Clio consumes prompt, skill, agent, and fleet roots. A manifest may reserve a `themes` path for forward compatibility, but Clio does not apply theme resources.

IDs must be lowercase and may include numbers, dots, underscores, and hyphens; they must start/end alphanumeric.

`compatibility.clio` is optional. When present, it must be a valid SemVer range such as `>=0.3.8`, `^0.3.8`, or `0.3.x`. Installation refuses a package whose range excludes the running Clio version and names the extension, its declared range, and that running version. Clio repeats the check whenever it loads installed extensions, so a package that becomes incompatible after a Clio version change stays visible in `extensions list` with its diagnostic but contributes no resources. An incompatible project package does not hide a compatible user package with the same ID. A manifest without `compatibility.clio` keeps the existing unrestricted behavior.

### Extensions that dispatch

An extension that builds a `DispatchRequest` against the `DispatchContract` is a
dispatch producer and is bound by the typed-intent compatibility rules like any
other. Build the declaration with `declaredScopeIntent()` from the dispatch
domain rather than assembling the normalized object by hand: it runs the same
path grammar, caps, deduplication, and provenance construction the dispatch tool
uses, so an extension cannot mint an intent shape the tool could not.

```ts
import { declaredScopeIntent } from "../domains/dispatch/index.js";

const built = declaredScopeIntent({ readRoots: ["src/"], writeRoots: ["src/generated/"] });
if (!built.ok) throw new Error(`${built.reason}: ${built.message}`);
await dispatch.dispatch({ agentId: "coder", executionRole: "builder", task, intent: built.intent });
```

An extension that declares nothing keeps working: scope falls back to legacy
inference over its task and briefing text, and the request is refused only when
it states a contradiction, such as a legacy `writeRoots` disagreeing with a
declared `write_roots`. Declaring is what stops an applicable project rule from
being missed because the task text happened not to spell a path. See
[dispatch-typed-intent.md](dispatch-typed-intent.md).

---

## Extension CLI

```bash
clio-coder extensions list [--all] [--json] [--user|--project]
clio-coder extensions discover <path> [--json]
clio-coder extensions install <path> [--user|--project] [--force] [--json]
clio-coder extensions enable <id> [--user|--project] [--json]
clio-coder extensions disable <id> [--user|--project] [--json]
clio-coder extensions remove <id> [--user|--project] [--json]
```

Install locations:

| Scope | Root |
| --- | --- |
| user | `<configDir>/extensions/<id>` |
| project | `.clio-coder/extensions/<id>` |

Project extensions shadow user extensions with the same ID. Use `--all` to list shadowed/disabled entries.

Installed packages are admitted only when their current tree matches the SHA-256 digest in `extensions/state.json`. `clio-coder upgrade` adds digests to pre-digest v1 install records after validating and hashing each installed tree, preserves `disabled`, `source`, and `installedAt`, and backs up the original state before the atomic rewrite. Invalid or changing trees are not blessed: they stay visible and inactive with reinstall guidance. Listing extensions, booting Clio, inspection, and plain doctor runs never perform this migration.

### Generations and reload

A running session does not read installed packages on every resource load. While domains start, the extensions domain publishes nothing: readers use an ephemeral generation-0 projection. The composition root then asks the extensions domain to build an immutable candidate for the session's working directory and builds the matching user-hook registration table from it. After validating that both candidates are still current, the composition root publishes the snapshot and hooks with two adjacent reference assignments. That paired boot snapshot is generation 1. It contains package identity and provenance, the resolved skill, prompt, agent, fleet, and theme roots of each loadable package, and the parsed `hooks.yaml` declarations captured from the exact bytes the install digest covered. Every consumer in the process then reads the committed generation, so consecutive loads within one turn agree on the package set.

`/resources extensions reload` is the only in-session way to publish a later generation. It rebuilds the snapshot from disk, re-verifies every installed tree against `state.json`, builds the user-hook registrations for the candidate, validates both candidates, and then performs the same two adjacent assignment-only publications. No callback, event, log, or refusal sits between them; conflict diagnostics and the `extensions.reloaded` event run only after both references are live. Observers therefore see the previous resources with the previous hooks or the new ones with the new ones, never an intermediate pairing. The command reports the new generation, which packages were added, removed, or modified, and how many hooks were registered, dropped, or rejected. A tree that no longer verifies is listed as inactive and contributes nothing until it is reinstalled. A build failure or stale candidate publishes neither side and reports why.

Reloading an unchanged tree still publishes a new generation with the same content digest; content identity is the digest, not the generation number. Installs, enables, disables, and removes performed by `clio-coder extensions` in another process are invisible to a running session until the operator reloads or restarts. There is no filesystem watcher, so a CLI mutation never becomes an implicit mid-turn hook change. Resource files themselves (skill and prompt bodies, agent and fleet recipes) are still read at use time; a package mutated on disk after its generation was built can serve changed files until the next reload detects the drift and deactivates it.

If extension state is corrupt, loading remains fail-closed. A normal reinstall refuses it; `extensions install <valid-source> --force` backs up the corrupt state and parks the previous package bytes before installing and recording the verified replacement. `extensions remove <id>` can also remove an unverifiable package from the load path while preserving both its bytes and any corrupt state in the paths printed by the command. These recovery backups are deliberately not treated as installed packages.

### Skill pack distribution

Clio Coder should not grow built-in skills in the harness. Distribute reusable Clio skills as extension packages instead. A future `iowarp/clio-kit` bundle can carry `clio-coder-extension.yaml` plus a `skills/` directory, and users can install it with `clio-coder extensions install <path> --user` or `--project`.

Recommended layout:

```text
clio-kit/
  clio-coder-extension.yaml
  skills/
    hpc-review/
      SKILL.md
      references/
      scripts/
    release-check/
      SKILL.md
```

This keeps the runtime local-first and small. Clio Coder discovers enabled extension skill roots, records provenance as `source: extension`, and still requires normal tool safety gates for any script a skill asks the agent to run.

---

## Share archives

Share archives are single JSON files:

```json
{
  "kind": "clio-coder-share-archive",
  "formatVersion": 1,
  "manifest": {
    "format": "clio-coder.share.v1",
    "clioCoderVersion": "0.4.2",
    "createdAt": "...",
    "files": []
  },
  "files": []
}
```

Every file entry is base64 encoded and SHA-256 checked on import.
Readers continue to accept the released legacy identities `clio-share-archive`,
`clio.share.v1`, and `clioVersion`, then normalize them to the canonical shape.
New exports use only the `clio-coder` names above.

### Export

```bash
clio-coder share export --out project.clio-coder-share.json --project
clio-coder share export --out all.clio-coder-share.json --both --all
```

Options:

| Flag | Meaning |
| --- | --- |
| `--project` | Export project resources only. Default scope. |
| `--user` | Export user resources only. |
| `--both` | Export both user and project resources. |
| `--context` | Include project context files (`CLIO-CODER.md`, `AGENTS.md`, `CODEX.md`, `GEMINI.md`, `CLAUDE.md`). |
| `--prompts` | Include prompt templates. |
| `--skills` | Include skills. |
| `--settings` | Include non-secret settings fragment. |
| `--extensions` | Include extension bundle files, excluding extension `state.json`. |
| `--agents` | Include agent recipe files. |
| `--fleets` | Include fleet contract files. |
| `--all` | Include every supported resource class. |

If no include flags are supplied, export includes all supported classes for the selected scope.

Settings fragments are version 2 documents containing only
`chat.modelPicker.cycleSet`, `chat.retry`, `fleet.concurrency`,
`context.compaction`, `safety.autonomy`, `safety.limits.sessionCostUsd`, and the
`interface` settings block. Targets and credentials are not included.

### Import and inspect

```bash
clio-coder share inspect project.clio-coder-share.json
clio-coder share import project.clio-coder-share.json --dry-run
clio-coder share import project.clio-coder-share.json --force
```

Dry-run imports produce a plan and report conflicts without writing. Without `--force`, conflicting destination files block writes. With `--force`, conflicting files are overwritten and supported settings-fragment keys are merged into the current settings file.

Extension entries are grouped into complete packages, staged, strictly validated, and passed through the canonical extension installer. A successful import therefore records the installed content digest before the package can contribute resources. A destination tree is skipped only when it already matches a verified install record; an unrecorded, drifted, or corrupt destination requires `--force`, which uses the same backup-preserving recovery contract as `extensions install --force`. Invalid archived packages fail preflight before destination writes.

Archives accept `agent` and `fleet` file entry types alongside prompts and skills. Agent entries import into the user agent root and must pass the recipe parser and policy checks. Fleet entries import into the user fleet root and must pass `parseFleetContract` before any write. Dry-run plans report both types by kind.

Aliases:

```bash
clio-coder export --out project.clio-coder-share.json
clio-coder import project.clio-coder-share.json --dry-run
```

---

## Community packaging guidance

- Keep extension packages small and reviewable.
- Treat prompts and skills as source code: document assumptions, expected evidence, and validation commands.
- Do not put secrets in extension packages or share archives.
- Prefer project-scoped resources for repository-specific instructions and user-scoped resources for personal workflow helpers.
