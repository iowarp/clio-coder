# Authoring a portable agent plugin

`isPluginId` in [discovery.ts](../../src/domains/plugins/discovery.ts) validates package identifiers. An agent plugin packages a workflow and its supporting resources as one versioned installation. Its canonical identity is the [Agent Plugins 1.0.0 manifest](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json). Clio keeps the complete package together, verifies its full-tree digest, and discovers the resources supported by the current runtime. This page owns the manifest fields. Package invariants are in [library architecture](../architecture/library.md) and operator commands are in [library packages](resource-library.md).

The minimal package has a root `plugin.json` and an immediate child skill directory:

```text
lab-research/
  plugin.json
  skills/
    research/
      SKILL.md
```

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "lab-research",
  "version": "1.0.0",
  "description": "Research from supplied lab evidence"
}
```

## Root manifest fields

The root schema permits exactly these keys, and any other key is a validation error.

| Key | Rule |
| --- | --- |
| `$schema` | Required. Must equal `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`. |
| `name` | Required. 1 to 64 lowercase letters, digits, hyphens or periods, beginning and ending with an alphanumeric character, with neither `--` nor `..`. `state.json` is reserved as installation bookkeeping. |
| `version` | Required, including for a local authoring install. An explicit Semantic Version of at most 256 characters, with no `v` prefix. Numeric prerelease identifiers cannot contain leading zeros. |
| `description`, `homepage`, `repository`, `license` | Optional strings. |
| `author` | Optional object with string `name`, `email` and `url`. |
| `keywords` | Optional array of strings. |
| `extensions` | Optional map of namespaced objects. Clio reads only `ai.iowarp.clio`. |

A root `state.json` is rejected, and `plugin.json` must be a regular file at the package root. A root `mcp.json` is preserved and reported as a warning, because this Clio version does not execute MCP servers.

## Native Clio components

`extensions["ai.iowarp.clio"]` holds optional Clio metadata inside the portable manifest. A plugin containing `skills/<name>/SKILL.md` needs only the root identity fields above: Clio discovers the conventional `skills/` directory. A standalone skill package with a root `SKILL.md` declares `kind: "skill"`, `resources.skills: "."` and its one public skill component through the extension; the supplied skill template demonstrates that form. Clio prompts, strict agent recipes, fleets and explicit component graphs also use this metadata. The key does not select a directory: its `resources` map names the paths the package actually uses.

| Field | Rule |
| --- | --- |
| `manifestVersion` | Must be `1` whenever the object is present. |
| `kind` | `plugin` (default), `skill`, `agent`, `prompt` or `fleet`. |
| `requires` | Package dependencies as `kind:name` references (see [Package dependencies](#package-dependencies)). |
| `compatibility.clio` | Optional SemVer range. Install and load refuse a package whose range excludes the running Clio. |
| `resources` | Map from `skills`, `prompts`, `agents` or `fleets` to a relative directory inside the package. |
| `components` | Up to 1024 component declarations (see [Components and references](#components-and-references)). |
| `evals` | Retired. A manifest that still declares it keeps loading and Clio ignores the value. The key is accepted until the v0.7.0 compatibility window. |

In modern packages, resources use ordinary top-level directories (`agents/`, `prompts/`, `skills/`, `fleets/`), while `assets/` holds shared supporting files. (Historical bundles such as `materio` nest resources under `ai.iowarp.clio/` for backward compatibility, but top-level directories are recommended for new packages.) Portable skills must use the root `skills` directory unless the package is a standalone skill package.

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "lab-research",
  "version": "1.0.0",
  "description": "Research from supplied lab evidence",
  "extensions": {
    "ai.iowarp.clio": {
      "manifestVersion": 1,
      "compatibility": { "clio": ">=0.4.7" },
      "resources": {
        "skills": "skills",
        "prompts": "prompts",
        "agents": "agents"
      },
      "components": [
        {
          "kind": "resource",
          "id": "methods",
          "path": "assets/methods.md"
        },
        {
          "kind": "skill",
          "id": "research",
          "path": "skills/research/SKILL.md",
          "requires": ["resource:methods"]
        },
        {
          "kind": "agent",
          "id": "researcher",
          "path": "agents/lab-research-researcher.md",
          "requires": ["skill:research"]
        },
        {
          "kind": "prompt",
          "id": "start",
          "path": "prompts/lab-research/start.md",
          "requires": ["agent:researcher"]
        }
      ]
    }
  }
}
```

Create every declared directory and file before validation. A manifest declaring any other resource kind, `themes` included, fails validation.

### Package kinds

A `plugin` may bundle many public resources. Every other kind is a single-resource package, and the manifest parser and `library validate` enforce these rules:

- It declares exactly one public component of its own kind (`skill`, `agent`, `prompt` or `fleet`).
- Its `resources` map holds only its own resource root (`skills`, `agents`, `prompts` or `fleets`).
- The resource root exposes exactly the declared file: a `SKILL.md` for a skill, a single Markdown file otherwise. Private supporting files may sit elsewhere in the package.
- A standalone skill package uses `resources.skills: "."` with a root `SKILL.md`.
- A standalone agent package declares `skills: []`, because a recipe cannot bind a skill outside its own package.
- `README.md` stays at the package root, outside any resource directory, so the loader does not discover it as a second public recipe.

### Components and references

Component kinds are `skill`, `prompt`, `agent`, `fleet`, `script`, `resource`, and `tool`. A component has a stable `kind:id` identity (id: lowercase letters, digits, dots, underscores and hyphens, at most 80 characters), one contained file path, and optional `requires` references to other components in the same bundle. A skill points to its `SKILL.md`. Dependencies must exist and form an acyclic graph. Native discoverable components (`skill`, `prompt`, `agent`, `fleet`) must live beneath their declared resource root, and agent and fleet files must sit directly in that root because nested ones cannot be discovered. Component metadata records relationships; it does not execute scripts or register tool implementations.

Clio text can refer to `${pluginRoot}/assets/methods.md` or `${component:resource:methods}`. Prompts, agent bodies, and skills recognize prose markers with portable, space-free slash suffixes. For a filename containing spaces or Unicode, declare a component and refer to its `kind:id`. The referenced target must exist within the declaring package. Fleet argument paths use a separate complete-path parser: the reference must occupy the whole argument, and containment is checked after expanding the entire suffix, including spaces and Unicode. A reference embedded in an option such as `--file=${pluginRoot}/data.csv` is rejected; pass the path as its own argument. These are Clio reference forms; peer exports translate instructions and paths for their native host. Portable skill text should use relative file references where practical.

Prompt names follow their path beneath the prompts root, with directory separators written as colons. The example exposes `/lab-research:start`. Give agent and fleet filenames a package prefix to keep their registered identities unambiguous. Agent recipes retain the strict version 1 contract, including required and optional tool lists, custom audience, budget, and result contract. A plugin's recipes may bind skills from their own package, and a bound skill must be trusted and live inside that package. Workers have no `ask_user`; interviews belong to the orchestrator.

### Package dependencies

Package dependencies live in `extensions["ai.iowarp.clio"].requires` as typed references such as `["skill:ship"]`, matching `kind:name` with a lowercase name. Copy the same requirements into the library index row, because install refuses a package whose manifest and index rows disagree. They name packages, while component `requires` names files within one package. Neither declares an execution hook. The dependency rules (acyclic, installed, enabled, loadable) are invariant 6 of the [library architecture](../architecture/library.md).

## Validation

```bash
clio-coder library validate ./lab-research --json
clio-coder library inspect ./lab-research --json
```

`library validate <package-path|SKILL.md>` performs a read-only content and payload validation before any installation or registration. It exits 0 for a valid package and 1 otherwise, and a `SKILL.md` argument validates one skill file. With `--json` it prints the candidate manifest plus `manifestValid`, `valid` and a `validation` object holding `contentValid`, per-resource `resources`, `diagnostics` (each with a `severity`, a code such as `ERR_MANIFEST`, `ERR_SKILL`, `ERR_PROMPT`, `ERR_AGENT`, `ERR_FLEET`, `ERR_COMPONENT` or `ERR_PACKAGE_REFERENCE`, and a path) and `prerequisites`.

- **Manifest validity**: parses `plugin.json` against the schema, verifying identifiers, SemVer compliance, and declared resource roots.
- **Payload and schema validation**: validates skills, prompt loadability, and agent recipes against strict v1 schemas, policy budgets, and custom audience rules; parses fleet DAGs, loop boundaries, and write boundaries.
- **Package reference resolution**: ensures all `${component:...}` and `${pluginRoot}` references point to existing files within the package boundary.
- **Prerequisite separation**: reports required external commands and core agents as environment prerequisites (`type` is `command` or `agent`) rather than failing package content validity.
- **Read-only**: leaves package files, repository files, and installation state roots completely unchanged.

`library inspect <path>` prints the manifest candidate without the content checks. Installation validates the exact manifest bytes included in the tree digest, then stages and publishes the package; see [library packages](resource-library.md) for the install, update, drift and removal commands, and the [library architecture](../architecture/library.md) for the integrity and state rules.

## Host projections and runtime capabilities

Agent Plugins 1.0.0 standardizes skills and MCP declarations. Clio currently consumes portable skills and its native manifest extension; it preserves MCP files but does not execute MCP servers. Claude Code and Gemini have their own native manifests and component formats. A package exporter must translate those formats and report which features are native, adapted as instructions, or unavailable. An exported skill workflow does not establish that a peer host executes Clio fleets.

The bundled `materio` plugin includes a Python exporter, `library/plugins/materio/assets/scripts/project_plugin.py`, for Codex, Claude Code and Gemini. See its package README for commands and capability reports. It also provides a complete worked example of explicit component relationships and shared domain references.

Two layouts need no exporter at all, because Claude Code and Codex load them directly from the unchanged package:

- A standalone skill package with a root `SKILL.md`, no `skills/` directory and no top-level `skills` manifest field. Claude Code loads it as a single-skill plugin and takes the invocation name from the `SKILL.md` frontmatter. Codex finds the same directory under any of its skills roots.
- A bundle with a real `skills/` directory. Both hosts publish exactly those skills.

What a peer host does *not* load matters just as much. Claude Code scans a plugin root for `agents/`, `commands/`, `hooks/`, `output-styles/` and `.mcp.json` with no manifest asking it to. A Clio strict-v1 recipe sitting in a top-level `agents/` directory is therefore picked up and shown as a native Claude agent, tools, model and budget fields included, none of which that host honors. Clio `prompts/` and `fleets/` are inert to it.

That leaves a real choice when a package should serve both audiences. Ordinary top-level `agents/` and `prompts/` directories are the recommended Clio layout and stay a valid first-class library package; the repository marketplace simply does not publish such a package, and `pnpm run library:pin` prints the reason. To publish it as well, declare its Clio resource roots at paths no peer host scans, for example `"agents": "native/agents"` in the manifest's `resources` map, and put the recipes there. The bundled `materio` package does this with its own historical directory name.

Keep the skill surface intact when you edit a package: adding a `skills/` directory to a standalone skill silently stops its root `SKILL.md` from loading. [library-portability.test.ts](../../tests/extended/library-portability.test.ts) asserts all of this for every curated package, and [verify-portable-hosts.sh](../../scripts/verify-portable-hosts.sh) re-measures it against the real host CLIs. See [coding agent interoperability](interop.md) for the exact install commands.

Harness extensions register runtime tools through the [harness extension contract](harness-extensions.md). They use a separate extension manifest and installation state, and they cannot declare domain resources: prompts, agents, skills, fleets and reference files ship in a plugin.

## Authoring templates and contributor journey

Clio Coder provides working, valid authoring templates for all five package kinds in `library/_authoring/templates/`:

- `library/_authoring/templates/skill/`: Standalone skill with house conventions and triggers.
- `library/_authoring/templates/agent/`: Standalone agent recipe using strict v1 fields, `skills: []`, and `audience: custom`.
- `library/_authoring/templates/prompt/`: Parameterized prompt with path-derived invocation (`/<name>`) and `$ARGUMENTS` expansion.
- `library/_authoring/templates/fleet/`: Multi-agent coordination contract with a valid DAG and documented prerequisites.
- `library/_authoring/templates/plugin/`: Composite bundle showing an agent binding a contained skill, prompts, and supporting assets.

Templates are reference models and are excluded from `library/registry.yaml`. Follow this unified contributor journey:

1. **Choose package kind**: Decide whether your package is a single-kind package (`skill`, `agent`, `prompt`, `fleet`) exposing exactly one public recipe, or a composite `plugin` bundle combining multiple resources.
2. **Copy authoring template**: Copy from `library/_authoring/templates/<kind>/` into your project or repository.
3. **Author resources**: Single-kind packages expose exactly one public resource file in their declared resource directory. Packages may carry explicitly invoked scripts (for example for offline evaluation or verification tasks); these are declared metadata and are strictly distinct from harness extensions, which register runtime tools and hooks.
4. **Validate**: Run `clio-coder library validate ./lab-research --json` to verify manifest schemas, resource payloads, reference syntax, and loadability.
5. **Pin and check**: Maintainers run `pnpm run library:pin` and `pnpm run library:check` to refresh and verify full-tree distribution pins, which also refreshes the normalized skill evidence. The registry files and pin stages are described in [skills-marketplace.md](skills-marketplace.md#registry-and-pins).
6. **Try in an isolated project**: Register locally with `clio-coder library register ./lab-research --project`. Registration writes identity, version, source, and full-tree SHA-256 into the scoped `library.yaml` without installing. Preview and install with `library install plugin:lab-research --project --dry-run`, then `library install plugin:lab-research --project`. In a project with no `.clio-coder/plugins/state.json`, that first install also approves the project's plugin state. Every later project install, update, enable, disable or remove changes the state file, and the project's packages stay unloaded until `clio-coder config trust plugins --hash <sha256>` approves the new bytes. Test invocation through `/skills`, `/run`, prompt slash commands, or `/fleet run`.
7. **Submit a focused fork PR**: Push your topic branch to your fork and submit a PR against `main`.
