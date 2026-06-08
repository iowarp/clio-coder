# Extensions, Prompt Templates, Skills, and Share Archives

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/extensions_blueprint.html](html/extensions_blueprint.html) (Version: 0.2.2).

Clio Coder has lightweight community-oriented resource packaging. Extensions are filesystem bundles that contribute prompts, skills, and future theme resources. Share archives are portable JSON files for moving project/user Clio resources between machines or collaborators.

Source of truth: `src/domains/extensions/**`, `src/domains/resources/**`, `src/domains/share/**`, `src/cli/extensions.ts`, and `src/cli/share.ts`.

---

## Resource roots and precedence

Prompts and skills are loaded from package, user, and project roots. Higher-ranked roots override lower-ranked resources with the same name.

Prompts use the three-tier precedence:

| Rank | Scope | Root |
| --- | --- | --- |
| 0 | package | enabled extension resource roots |
| 1 | user | `<configDir>/prompts` |
| 2 | project | `.clio/prompts` |
| 3 | cli | reserved for call-site injected resources |

Skills add Agent Skills compatibility roots so that skills installed by other agents are usable without copying. The skill precedence, lowest to highest, is:

| Precedence | Scope | Source | Root |
| --- | --- | --- | --- |
| 10 | package | extension | enabled extension resource roots |
| 20 | user | agents / claude / codex / copilot / opencode | `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.copilot/skills`, `~/.config/opencode/skills` |
| 30 | user | clio | `<configDir>/skills` |
| 40 | project | agents / claude / codex / copilot / opencode | `.agents/skills`, `.claude/skills`, `.codex/skills`, `.github/skills`, `.opencode/skills` (untrusted by default) |
| 50 | project | clio | `.clio/skills` |
| 60 | cli | path | reserved for call-site injected resources |

Clio-native roots intentionally outrank shared compatibility roots at the same scope, so `.clio/skills` overrides a project `.codex/skills` skill of the same name, and `<configDir>/skills` overrides `~/.agents/skills`. If multiple compatibility roots contain the same skill name at the same precedence, Clio resolves the collision deterministically by file path and records a diagnostic. If two roots resolve to the same canonical `SKILL.md` through a symlink, Clio keeps the higher-precedence entry and records a diagnostic.

---

## Prompt templates

Prompt templates are Markdown files under a prompt root. Filename is the command name.

Example `.clio/prompts/bugfix.md`:

```md
---
description: Focused bug-fix prompt
argument-hint: "<file> <symptom>"
---

Investigate {{1}} for this symptom: {{2}}

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

Templates without frontmatter are accepted; Clio derives a fallback description from the first non-empty line. Invalid frontmatter degrades to a warning for prompt templates rather than failing the whole load.

---

## Skills

Skills follow the Agent Skills `SKILL.md` format. A skill is a directory containing `SKILL.md`, or a single Markdown file under a skill root. YAML frontmatter is required and must include a `description`. A missing description is the only hard rejection; every other validation issue degrades to a warning and the skill still loads.

Example `.clio/skills/hdf5-review/SKILL.md`:

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
/skills
/skill:hdf5-review review the output validation path
```

`/skills [query]` lists every discovered skill with its scope, source, and trust state. `/skill:name args` force-activates a skill by expanding its body into the submitted message. The same expansion runs in headless mode, so `clio run "/skill:name args"` matches the interactive behavior.

Every activation records a session ledger entry with the skill name, file path, hash, source, trigger (`slash-command` or `tool`), and turn id when one is available. The same ledger is mirrored into session metadata, prompt diagnostics, and run receipts. Compaction keeps the newest active skill turn in the retained suffix so a loaded skill is not silently summarized away.

### Naming and validation

The canonical invocation name is the frontmatter `name` when present, otherwise the directory or file subject. When `name` differs from the path subject Clio records a warning and keeps the frontmatter name, which lets shared cross-agent skill folders load without renaming. Names should use lowercase letters, numbers, and single hyphens; format violations warn but do not block loading.

Recognized frontmatter fields:

- `name`, `description`: core identity.
- `disable-model-invocation: true`: hides the skill from the model-visible catalog while keeping it loadable by `/skill:name`.
- `license`, `version`, `compatibility`, `allowed-tools`, and any other keys: captured as skill metadata and surfaced by `read_skill`.
- `source-url`, `registry-id`, `installed-at`, `updated-at`, `audit`: captured as install provenance when present.

### Trust and compatibility roots

Shared user roots are model-visible by default, like the Clio user root. Project-local compatibility roots are discovered but **untrusted by default**: they appear in `/skills` with an `untrusted` marker, but they are excluded from the model-visible catalog and cannot be loaded by `read_skill`. This prevents an unreviewed project checkout from injecting skills the model will act on.

Opt in to model-visible project compatibility roots by setting `skills.trustProjectCompatRoots: true` in `settings.yaml`. `CLIO_TRUST_PROJECT_SKILLS=1` remains an environment override. `.clio/skills` is always trusted as the Clio-native project root.

### read_skill and create_skill

`read_skill` loads a skill body after the model matches the catalog. It returns structured metadata (`name`, `description`, `path`, `base_dir`, `hash`, `source`, `scope`, `disable_model_invocation`, diagnostics, and frontmatter metadata) plus the body. Pass `include_tree: true` (optionally with `max_tree_entries`) to list sibling files under the skill base directory. `read_skill` never executes bundled scripts and only resolves skills the model is allowed to see.

`create_skill` writes a `SKILL.md` folder. It defaults to project scope, refuses to overwrite without `overwrite: true`, and warns when the destination is gitignored. Pass `with_scaffold: true` to also create `scripts/`, `references`, and `assets` folders, and supply `license`, `version`, `compatibility`, `allowed_tools`, or `metadata` to populate frontmatter.

### Skills CLI

```bash
clio skills list [--json] [--all]
clio skills inspect <name> [--json]
clio skills validate [path] [--json]
clio skills create <name> [--user|--project]
```

Headless runs also accept `--no-skills` to disable discovery and repeatable `--skill <path>` to load one explicit `SKILL.md` file or skill directory for that run. Explicit `--skill` paths are honored even when `--no-skills` is set.

### Agent Skills compatibility

Clio is local-first. Skills run from disk and no chat turn depends on network access. Because the compatibility roots above use the standard `SKILL.md` shape, skills installed by the Skills.sh CLI for other agents are usable directly:

```text
npx skills add <skill> -a codex   # installs into ~/.codex/skills
```

Clio does not call Skills.sh during startup or prompt assembly, and does not emit its own telemetry. If you run `npx skills`, its telemetry follows that CLI and can be disabled with `DISABLE_TELEMETRY=1`. Remote search, audit, and install through Clio are deferred and not enabled in this release.

### Prompt envelope and safety

The skills catalog is included in the prompt only when `read_skill` or `create_skill` is active for the turn, and it is suppressed entirely on no-tool turns. The catalog lists names, scopes, sources, and short content hashes plus a `catalog_hash`; full bodies are never sent until a skill is explicitly activated. Skills are prompt resources, not execution grants: any script a skill references still runs through normal Clio tools and safety gates.

---

## Extension package manifest

An extension root contains `clio-extension.yaml`, `clio-extension.yml`, or `clio-extension.json`.

```yaml
manifestVersion: 1
id: lab-pack
name: Lab Pack
version: 1.0.0
description: Prompts and skills for this lab
resources:
  prompts: prompts
  skills: skills
  themes: themes
compatibility:
  clio: ">=0.2.0"
```

Required fields are `manifestVersion: 1`, `id`, `version`, and `description`. `name` defaults to `id` when absent. The current resource kinds are `prompts`, `skills`, and `themes`; theme loading is reserved and currently returns an empty list in the resource loader.

IDs must be lowercase and may include numbers, dots, underscores, and hyphens; they must start/end alphanumeric.

---

## Extension CLI

```bash
clio extensions list [--all] [--json] [--user|--project]
clio extensions discover <path> [--json]
clio extensions install <path> [--user|--project] [--force] [--json]
clio extensions enable <id> [--user|--project] [--json]
clio extensions disable <id> [--user|--project] [--json]
clio extensions remove <id> [--user|--project] [--json]
```

Install locations:

| Scope | Root |
| --- | --- |
| user | `<configDir>/extensions/<id>` |
| project | `.clio/extensions/<id>` |

Project extensions shadow user extensions with the same ID. Use `--all` to list shadowed/disabled entries.

### Skill pack distribution

Clio Coder should not grow built-in skills in the harness. Distribute reusable Clio skills as extension packages instead. A future `iowarp/clio-kit` bundle can carry `clio-extension.yaml` plus a `skills/` directory, and users can install it with `clio extensions install <path> --user` or `--project`.

Recommended layout:

```text
clio-kit/
  clio-extension.yaml
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
  "kind": "clio-share-archive",
  "formatVersion": 1,
  "manifest": {
    "format": "clio.share.v1",
    "clioVersion": "0.2.2",
    "createdAt": "...",
    "files": []
  },
  "files": []
}
```

Every file entry is base64 encoded and SHA-256 checked on import.

### Export

```bash
clio share export --out project.clio-share.json --project
clio share export --out all.clio-share.json --both --all
```

Options:

| Flag | Meaning |
| --- | --- |
| `--project` | Export project resources only. Default scope. |
| `--user` | Export user resources only. |
| `--both` | Export both user and project resources. |
| `--context` | Include project context files (`CLIO.md`, `AGENTS.md`, `CODEX.md`, `GEMINI.md`, `CLAUDE.md`). |
| `--prompts` | Include prompt templates. |
| `--skills` | Include skills. |
| `--settings` | Include non-secret settings fragment. |
| `--extensions` | Include extension bundle files, excluding extension `state.json`. |
| `--all` | Include every supported resource class. |

If no include flags are supplied, export includes all supported classes for the selected scope.

Settings fragments include non-secret UI/runtime preferences such as `defaultMode`, `safetyLevel`, `scope`, `budget`, `theme`, `terminal`, `keybindings`, `compaction`, and `retry`. Targets and credentials are not included.

### Import and inspect

```bash
clio share inspect project.clio-share.json
clio share import project.clio-share.json --dry-run
clio share import project.clio-share.json --force
```

Dry-run imports produce a plan and report conflicts without writing. Without `--force`, conflicting destination files block writes. With `--force`, conflicting files are overwritten and supported settings-fragment keys are merged into the current settings file.

Aliases:

```bash
clio export --out project.clio-share.json
clio import project.clio-share.json --dry-run
```

---

## Community packaging guidance

- Keep extension packages small and reviewable.
- Treat prompts and skills as source code: document assumptions, expected evidence, and validation commands.
- Do not put secrets in extension packages or share archives.
- Prefer project-scoped resources for repository-specific instructions and user-scoped resources for personal workflow helpers.
