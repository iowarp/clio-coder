# Extensions, Prompt Templates, Skills, and Share Archives

Clio Coder has lightweight community-oriented resource packaging. Extensions are filesystem bundles that contribute prompts, skills, and future theme resources. Share archives are portable JSON files for moving project/user Clio resources between machines or collaborators.

Source of truth: `src/domains/extensions/**`, `src/domains/resources/**`, `src/domains/share/**`, `src/cli/extensions.ts`, and `src/cli/share.ts`.

---

## Resource roots and precedence

Prompts and skills are loaded from package, user, and project roots. Higher-ranked scopes override lower-ranked resources with the same name.

| Rank | Scope | Root |
| --- | --- | --- |
| 0 | package | enabled extension resource roots |
| 1 | user | `<configDir>/prompts` and `<configDir>/skills` |
| 2 | project | `.clio/prompts` and `.clio/skills` |
| 3 | cli | reserved for call-site injected resources |

Project resources override user resources; user/project resources override extension defaults.

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

Skills require YAML frontmatter and stricter naming. They may be a single Markdown file or a directory containing `SKILL.md`.

Example `.clio/skills/hdf5-review/SKILL.md`:

```md
---
name: hdf5-review
description: Review HDF5/NetCDF validation logic and output assumptions.
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

Skill names must match their path subject, use lowercase letters/numbers/hyphens, avoid leading/trailing hyphens, and stay within length limits. `disable-model-invocation: true` hides a skill from the automatic model-visible catalog while keeping it loadable by explicit command/tool paths.

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

---

## Share archives

Share archives are single JSON files:

```json
{
  "kind": "clio-share-archive",
  "formatVersion": 1,
  "manifest": {
    "format": "clio.share.v1",
    "clioVersion": "0.2.1",
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
