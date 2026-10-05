# Prompts, skills, and share archives

Clio Coder has two package systems. A plugin is a domain bundle of prompts, skills, agent recipes, fleet contracts, scripts, and reference files, installed with `clio-coder library install <path>`. A harness extension is executable runtime capability (command tools, operator commands, and hook declarations), installed with `clio-coder extensions install <path>`. Only plugins contribute resources. See [plugins.md](plugins.md) for the concept map and [harness-extensions.md](harness-extensions.md) for the extension contract.

This page covers how prompt templates and skills are discovered, ranked, trusted, and invoked, and how share archives move user and project resources between machines.

Source of truth: `src/domains/resources/`, `src/domains/plugins/`, `src/domains/interop/registry.ts`, `src/domains/share/`, [share.ts](../../src/cli/share.ts), and [skills.ts](../../src/cli/skills.ts).

---

## Resource roots and precedence

Prompts and skills are loaded from package, user, and project roots. Higher-ranked roots override lower-ranked resources with the same name.

Prompts and skills both add compatibility roots so that the command and skill files other agents already have on the machine are usable without copying. Both root lists come from the interop agent registry ([registry.ts](../../src/domains/interop/registry.ts)), so the two kinds cannot drift apart. The prompt precedence, lowest to highest, is:

| Precedence | Scope | Source | Root |
| --- | --- | --- | --- |
| 10 | package | plugin | enabled plugin resource roots |
| 20 | user | claude / codex / opencode | `~/.claude/commands`, `~/.codex/prompts`, `~/.config/opencode/command` |
| 30 | user | clio | `<configDir>/prompts` |
| 40 | project | claude / codex / opencode | `.claude/commands`, `.codex/prompts`, `.opencode/command` (untrusted by default) |
| 50 | project | clio | `.clio-coder/prompts` |

The skill precedence, lowest to highest, is:

| Precedence | Scope | Source | Root |
| --- | --- | --- | --- |
| 9 | project | clio (self-development) | `library/skills/meta/clio-coder-dev` and `clio-coder-test`, only inside Clio Coder's own repository and only when no installed package owns the name |
| 10 | package | plugin | enabled plugin resource roots |
| 20 | user | agents / claude / codex / copilot / opencode | `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.copilot/skills`, `~/.config/opencode/skills` |
| 30 | user | clio | `<configDir>/skills` |
| 40 | project | agents / claude / codex / copilot / opencode | `.agents/skills`, `.claude/skills`, `.codex/skills`, `.github/skills`, `.opencode/skills` (untrusted by default) |
| 50 | project | clio | `.clio-coder/skills` |
| 60 | cli | path | `--skill <path>` explicit paths |

Inside Clio Coder's own repository, attended sessions are told to load `clio-coder-dev` before the first edit and `clio-coder-test` when choosing validation ([extension.ts](../../src/domains/prompts/extension.ts)). Headless runs are told to take conventions from the code and neighboring tests and not to load either, and both skills stay discoverable.

Clio Coder-native roots intentionally outrank shared compatibility roots at the same scope, so `.clio-coder/skills` overrides a project `.codex/skills` skill of the same name, and `<configDir>/skills` overrides `~/.agents/skills`. Project roots may not leave the workspace and user roots may not leave the home directory through a symlink; an escaping skill is skipped with a warning.

### Skill collision resolution

Candidate resolution for skills is implemented in [loader.ts](../../src/domains/resources/skills/loader.ts). `compareSkillCandidates` orders competing candidates for one name and for one canonical file, and the last one wins:

1. **Trust first.** A trusted candidate beats an untrusted one. An untrusted project compatibility copy (an unvetted `.claude/skills/my-skill` or `.agents/skills/my-skill`) therefore cannot win a collision against an admitted native skill and then disappear at model visibility time.
2. **Ownership.** A skill from a plugin, a Clio Coder root, or an explicit path outranks a loose compatibility discovery, so an imported copy that still awaits trust owns its name over a loose file.
3. **Precedence tier**, from the table above.
4. **Registry agent order** for compatibility roots in the same tier: the earlier agent in the interop registry (claude, codex, opencode, copilot, agents) wins, so a skill symlinked into two foreign roots resolves to the same winner on every machine.
5. **File path**, as the final tie-break.

If two roots resolve to the same canonical `SKILL.md` through a symlink, Clio keeps the winner by the same order and records a diagnostic naming the path that is in use. Prompt collisions use the same trust and precedence rules, but ties inside one tier break by file path, not registry order.

A project-scoped package installation shadows a user-scoped package of the same ID through the managed package lifecycle (`plugins/state.json`), not through a filesystem switch on unmanaged files. A disabled project package still suppresses the user copy. That holds only while the operator has approved the workspace's `.clio-coder/plugins/state.json`; an unapproved project package does not load and does not suppress the user copy (see [Library packages](resource-library.md)).

---

## Prompt templates

Prompt templates are Markdown files under a prompt root. The command name is the path beneath the root without `.md`, with directory separators written as colons, so `prompts/bugfix.md` is `/bugfix` and a plugin's `prompts/lab-research/start.md` is `/lab-research:start`. Every loaded template is offered in the composer's slash autocomplete after the built-in commands, with its `description` and `argument-hint`; an unavailable template is listed disabled with its reason. A template whose name equals a built-in slash command is ignored with a collision diagnostic. Symbolic links inside a prompt root are ignored.

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
/prompts
/bugfix src/parser.ts empty input crashes
```

Arguments follow Pi 1.0 semantics: bash-style quoting splits the text after the command into positional arguments, and the placeholders `$1`, `$@`, `$ARGUMENTS`, `${N:-default}`, `${@:N}`, and `${@:N:L}` expand in one pass. Bare `$ARGUMENTS` inserts the raw payload byte for byte. The placeholder contract is in [prompt-envelope-and-tools.md](../architecture/prompt-envelope-and-tools.md).

Frontmatter fields are `description`, `argument-hint` (or `argumentHint`), and `display-only` (or `displayOnly`). Templates without frontmatter are accepted; Clio Coder derives a fallback description from the first non-empty line. Invalid frontmatter degrades to a warning rather than failing the whole load. A template whose package reference cannot resolve, or whose file cannot be read, still loads with an empty body and a reason, so invoking it reports the reason instead of "not a command".

### Display-only templates

A template whose body is written for the operator rather than the model, such as a package's `help` reference, declares `display-only: true` in its frontmatter:

```md
---
description: Overview of the package commands
display-only: true
---

Display the following:

```text
 /pkg:help      This reference
 /pkg:status    Project dashboard
```
```

Submitting `/pkg:help` renders the template locally as an operator card in the transcript, headed by the command name and its source package. Nothing is sent to the model, nothing is recorded in the model-facing session context, and no tokens are spent. The card shows the first fenced code block when the body has one, otherwise the whole body, wrapped to the terminal width with no truncation and scrollable like any other transcript output. Arguments after the command name are ignored. The composer's autocomplete lists such a template with a `reference` marker. Headless `clio-coder run /pkg:help` prints the same text to stdout and exits 0 without booting a provider or a session.

### Foreign prompt roots

Claude, Codex, and OpenCode prompt folders are discovered at user and project scope, but their loose templates cannot expand. Explicitly adopt them with `clio-coder interop adopt <host>` or import a package with `clio-coder library import <path>`. Imported foreign prompts additionally require `integrations.projectResources.trustProjectImports: true`. Clio Coder's own prompt roots remain usable. Discovery-only templates cannot shadow a trusted Clio Coder template and send nothing to the model.

---

## Skills

Skills follow the Agent Skills `SKILL.md` format. A skill is a directory containing `SKILL.md`, or a single Markdown file under a skill root. YAML frontmatter is required and must include a `description`. Frontmatter validation issues degrade to warnings and the skill still loads. A skill file is skipped only when the description is missing, the file is unreadable, larger than 1 MiB, not valid UTF-8 text, or has frontmatter that cannot be parsed, or when a package reference in the body cannot resolve.

Example `.clio-coder/skills/hdf5-review/SKILL.md`:

```md
---
name: hdf5-review
description: Review HDF5/NetCDF validation logic and output assumptions.
license: MIT
allowed-tools:
  - read
  - grep
---

When asked to review scientific array output:
- identify expected dimensions and attributes;
- ask for validation data when absent;
- prefer deterministic scripts over visual inspection;
- cite files and commands used.
```

Use in the TUI:

```text
/skills
/skill hdf5-review review the output validation path
```

Bare `/skill` returns a usage error that points to `/skills`, which opens the Library on its Skills tab. `/skill <name> [args]` submits `args` with a pending skill request; the model must call `context` (scope="skills") for that skill before following the workflow. `/skill off` clears the session's skill tool surface (see [skills-marketplace.md](skills-marketplace.md)). The same pending-request path runs in headless mode, so `clio-coder run "/skill hdf5-review inspect the writer"` matches the interactive behavior.

Every activation records a session ledger entry with the skill name, file path, hash, source, trigger (`slash-command` or `tool`), and turn id when one is available. The same ledger is mirrored into session metadata, prompt diagnostics, and run receipts. Compaction keeps the newest active skill turn in the retained suffix so a loaded skill is not silently summarized away.

### Naming and validation

The canonical invocation name is the frontmatter `name` when present, otherwise the directory or file subject. When `name` differs from the path subject Clio Coder records a warning and keeps the frontmatter name, which lets shared cross-agent skill folders load without renaming. Names should be at most 64 characters of lowercase letters, numbers, and single hyphens that neither start nor end the name. A description should be at most 1024 characters. Format violations warn but do not block loading. A `SKILL.md` over 50 KiB loads with a warning, but activation delivers at most 50 KiB.

Recognized frontmatter fields:

- `name`, `description`: core identity.
- `disable-model-invocation: true`: hides the skill from the model-visible catalog while keeping it loadable by `/skill <name>`.
- `allowed-tools`, `disallowed-tools`: a comma-separated string or a YAML list. Tool names are matched case-insensitively against Clio Coder's tools. A name Clio Coder does not have is a warning, and an `allowed-tools` list naming no Clio Coder tool narrows nothing. Loading narrows the tool surface and never grants a tool the host would refuse. Spell the names in Clio Coder's lowercase form (`read`, `grep`): Claude Code reads `allowed-tools` as a pre-approval grant, so a capitalized `Bash` in a skill that another host loads would auto-approve that tool there. Curated library skills are checked for the lowercase spelling.
- `requires: [skill:<name>]`: typed dependency. A name that resolves to no loaded skill is a warning.
- `license`, `version`, `compatibility`, and other non-core keys: captured as skill metadata and surfaced when the skill loads through `context`. A nested `clio-coder:` block lands in `metadata.clioCoder`.
- `source-url`, `registry-id`, `registry-url`, `installed-at`, `updated-at`, `installed-hash`, `audit` (`pass`, `warn`, `fail`, `unknown`), `installed-by`: captured as install provenance when present, nested under `clio-coder:` or flat.

### Trust and compatibility roots

Shared and other-agent user and project roots are discovery-only. Explicitly import the desired resources into Clio Coder, then review and enable `integrations.projectResources.trustProjectImports` (legacy control id `skills.trustProjectCompatRoots`) to use imported foreign packages. The setting applies to imported packages at either scope, despite its historical name. It never imports or activates loose `.claude`, `.agents`, `.codex`, or other compatibility roots. Clio Coder-native roots and trusted library packages remain usable. Imported foreign packages record `trust: "foreign"` at either scope; a project resource adopted into user scope keeps foreign trust. Workspace trust is a separate gate: a package installed at project scope, foreign or not, loads only while the operator has approved the project's plugin state with `clio-coder config trust plugins`, and an import or adoption never approves it.

Model visibility is `trusted && !disable-model-invocation`. Only visible skills appear in `context(scope="skills")` or are eligible for model invocation. `disable-model-invocation: true` keeps a skill in the catalog for manual `/skill` use while withholding it from the model. A named load of an untrusted, not-imported, or manual-only skill reports that specific restriction instead of calling the skill unknown.

`context(scope="skills")` with no `name` lists the catalog, with optional `query`, `limit`, and `offset`. With a `name` it loads that skill's body, returning structured metadata (`name`, `description`, `path`, `base_dir`, `hash`, `source`, `scope`, `disable_model_invocation`, parsed tool policy fields, diagnostics, and frontmatter metadata) plus the body. Pass `include_tree: true` to list sibling files under the skill base directory, capped at 50 entries. The skills scope never executes bundled scripts and only resolves skills the model is allowed to see. Listing sections and readiness rules are in [skills-marketplace.md](skills-marketplace.md).

Creation under protected roots is operator authority: the ordinary model `write` and `edit` tools cannot write active skill roots (`.clio-coder/skills/<name>/` or the user `<configDir>/skills/`). Model-authored skills must be created outside protected roots and then installed by the operator with `clio-coder library install <path> [--user|--project]`, or copied directly into an active root by the operator. `clio-coder library validate <package-path|SKILL.md>` reports diagnostics, and the `skill-authoring` shipped skill documents the frontmatter contract and craft rules.

### Skill commands and flags

The `library` verbs that install, validate, and list skills are in [resource-library.md](resource-library.md). `clio-coder library skills [--all] [--json]` lists runtime skills including unmanaged files.

The interactive session and `clio-coder run` accept `--no-skills` to disable discovery and repeatable `--skill <path>` to load one explicit `SKILL.md` file or skill directory at precedence 60. Explicit `--skill` paths are honored even when `--no-skills` is set. A `--skill` path that loads no skill fails a headless run before any model call.

### Agent Skills compatibility

Clio Coder is local-first. Skills run from disk and no chat turn depends on network access. Because the compatibility roots above use the standard `SKILL.md` shape, skills installed by the Skills.sh CLI for other agents are usable directly:

```text
npx skills add <skill> -a codex   # installs into ~/.codex/skills
```

Clio does not call Skills.sh during startup or prompt assembly and emits no telemetry of its own. If you run `npx skills`, its telemetry follows that CLI and can be disabled with `DISABLE_TELEMETRY=1`. Skills.sh remote search and audit are unavailable. Clio Coder's own package discovery and installation go through the library: bare names and `kind:name` references resolve through the library index, and local paths require a valid package containing a root `plugin.json`. Raw or unindexed GitHub URLs cannot be installed directly; remote package installation requires an index entry with version and full-tree SHA-256 pin.

### Prompt envelope and safety

Skill bodies never enter the prompt uninvited. The model discovers skills only through `context(scope="skills")`, and a body loads only when the pending-skill policy authorizes that name for the turn, which requires an explicit operator invocation such as `/skill <name>` or, where the autonomy level allows it, a model activation of a trusted installed skill. Skills are prompt resources, not execution grants: any script a skill references still runs through normal Clio Coder tools and safety gates, and a loaded skill's `allowed-tools` declaration narrows the tool surface at admission (reason code `skill_surface`) without ever granting anything the host would refuse.

---

## Share archives

Share archives are single JSON files for moving loose project and user Clio Coder resources between machines or collaborators. They carry the files under the prompt, skill, agent, fleet, and extension roots, project context files, and a settings fragment. Packages installed through `clio-coder library` live under `plugins/` and are not exported; distribute those through their source directory or a library index.

```json
{
  "kind": "clio-coder-share-archive",
  "formatVersion": 1,
  "manifest": {
    "format": "clio-coder.share.v1",
    "clioCoderVersion": "0.6.0",
    "createdAt": "...",
    "files": []
  },
  "files": []
}
```

Every file entry carries its type, scope, archive path, relative path, size, and base64 data, and its SHA-256 is checked on import. Readers continue to accept the released legacy identities `clio-share-archive`, `clio.share.v1`, and `clioVersion`, then normalize them to the canonical shape. New exports use only the `clio-coder` names above. Import warns when the archive's major or minor version differs from the running Clio Coder.

### Export

```bash
clio-coder share export --out project.clio-coder-share.json --project
clio-coder share export --out all.clio-coder-share.json --both --all
```

Options:

| Flag | Meaning |
| --- | --- |
| `--out <path>` | Required archive path. |
| `--project` | Export project resources only. Default scope. |
| `--user` | Export user resources only. |
| `--both` | Export both user and project resources. |
| `--context` | Include project context files (`CLIO-CODER.md`, `AGENTS.md`, `CODEX.md`, `GEMINI.md`, `CLAUDE.md`). Project scope only. |
| `--prompts` | Include prompt templates. |
| `--skills` | Include skills. |
| `--settings` | Include non-secret settings fragment. |
| `--extensions` | Include harness extension bundle files, excluding `state.json` files and hidden backup directories. |
| `--agents` | Include agent recipe files. |
| `--fleets` | Include fleet contract files. |
| `--all` | Include every supported resource class. |
| `--dry-run` | List the entries the archive would hold and write nothing. |
| `--json` | Print the archive, or with `--dry-run` its manifest, as JSON. |

If no include flags are supplied, export includes all supported classes for the selected scope. Naming any include flag makes every class opt-in. Each share command refuses, with exit 2, a flag it does not use: `export` takes no `--force`, `import` takes neither `--both`, `--out` nor include flags, and `inspect` takes only `--json`.

Settings fragments are version 2 documents containing only `chat.modelPicker.cycleSet`, `chat.retry`, `fleet.concurrency`, `context.compaction`, `safety.autonomy`, `safety.limits.sessionCostUsd`, and the `interface` settings block. Targets and credentials are not included.

### Import and inspect

```bash
clio-coder share inspect project.clio-coder-share.json
clio-coder share import project.clio-coder-share.json --dry-run
clio-coder share import project.clio-coder-share.json --force
```

`share import` also accepts `--user` or `--project` to force prompt, skill, and extension entries into one destination scope; otherwise each entry keeps its archived scope. Agent, fleet, and settings entries always import into the user config directory, and project context files into the working directory. Dry-run imports produce a plan and report conflicts without writing. Without `--force`, conflicting destination files block writes. With `--force`, conflicting files are overwritten, keeping a backup, and supported settings-fragment keys are merged into the current settings file. Every target path must stay inside its import root, including through symbolic links, or the whole import is refused before any write.

Extension entries are grouped into complete packages, staged, strictly validated, and passed through the canonical extension installer. A successful import therefore records the installed content digest before the package can contribute resources. A destination tree is skipped only when it already matches a verified install record; an unrecorded, drifted, or corrupt destination requires `--force`, which uses the same backup-preserving recovery contract as `extensions install --force`. Invalid archived packages fail preflight before destination writes. An import never approves workspace trust. When it writes `.clio-coder/extensions/state.json` at project scope, including the workspace's first such file, the project's extensions stay blocked until `clio-coder config trust extensions` approves the new bytes. Only `clio-coder extensions install <path> --project` approves a workspace's first project extension install (see [Harness extensions](harness-extensions.md)).

Archives accept `agent` and `fleet` file entry types alongside prompts and skills. Agent entries must pass the recipe parser and policy checks. Fleet entries must pass `parseFleetContract` before any write. Dry-run plans report both types by kind. Share commands exit 0 on success, 1 when the plan carries an error or conflict diagnostic, and 2 for a usage error.

### Aliases and session commands

```bash
clio-coder export --out project.clio-coder-share.json
clio-coder import project.clio-coder-share.json --dry-run
```

In a session, `/archive export <path>` writes a project-scope archive with every resource class, and `/archive import <path> [--dry-run] [--force]` imports one. `/share` shares a worker result with the main agent and is unrelated to archives. `/share export` and `/share import` are retired and refuse with a pointer to `/archive`.

---

## Community packaging guidance

- Keep plugin and extension packages small and reviewable.
- Treat prompts and skills as source code: document assumptions, expected evidence, and validation commands.
- Do not put secrets in packages or share archives.
- Prefer project-scoped resources for repository-specific instructions and user-scoped resources for personal workflow helpers.
