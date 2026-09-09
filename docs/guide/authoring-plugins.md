# Authoring a portable agent plugin

> **Visual blueprint:** See the [visual reference](../html/authoring_plugins_blueprint.html) in the source checkout.

An agent plugin packages a workflow and its supporting resources as one versioned installation. Its canonical identity is the [Agent Plugins 1.0.0 manifest](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json). Clio keeps the complete package together, verifies its full-tree digest, and discovers the resources supported by the current runtime.

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

Portable identity and publisher metadata remain at the root. The root schema permits `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, and `extensions`. Names have 1 to 64 lowercase letters, digits, hyphens or periods, begin and end with an alphanumeric character, and contain neither `--` nor `..`. Clio reserves `state.json` as an installation bookkeeping name. Supply a version when publishing to the pinned library.

## Native Clio components

Use `extensions["ai.iowarp.clio"]` to declare Clio prompts, strict agent recipes and fleets. Keep native files in `ai.iowarp.clio/`, portable skills in `skills/`, and shared supporting content in `assets/` or skill-local reference directories.

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
        "prompts": "ai.iowarp.clio/prompts",
        "agents": "ai.iowarp.clio/agents"
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
          "path": "ai.iowarp.clio/agents/lab-research-researcher.md",
          "requires": ["skill:research"]
        },
        {
          "kind": "prompt",
          "id": "start",
          "path": "ai.iowarp.clio/prompts/lab-research/start.md",
          "requires": ["agent:researcher"]
        }
      ]
    }
  }
}
```

Create every declared directory and file before validation. Resource kinds are `skills`, `prompts`, `agents`, `fleets`, and `themes`. Component kinds are `skill`, `prompt`, `agent`, `fleet`, `script`, `resource`, and `tool`. A component has a stable `kind:id` identity, one contained file path, and optional `requires` references to other components in the same bundle. A skill points to its `SKILL.md`. Dependencies must exist and form an acyclic graph. Native discoverable components must live beneath their declared resource root. Component metadata records relationships; it does not execute scripts or register tool implementations.

Clio text can refer to `${pluginRoot}/assets/methods.md` or `${component:resource:methods}`. Prompts, agent bodies, and skills recognize prose markers with portable, space-free slash suffixes. For a filename containing spaces or Unicode, declare a component and refer to its `kind:id`. The referenced target must exist within the declaring package. Fleet argument paths use a separate complete-path parser: the reference must occupy the whole argument, and containment is checked after expanding the entire suffix, including spaces and Unicode. A reference embedded in an option such as `--file=${pluginRoot}/data.csv` is rejected; pass the path as its own argument. These are Clio reference forms; peer exports translate instructions and paths for their native host. Portable skill text should use relative file references where practical.

Prompt names follow their path beneath the prompts root. The example exposes `/lab-research:start`. Give agent and fleet filenames a package prefix to keep their registered identities unambiguous. Agent recipes retain the strict version 1 contract, including required and optional tool lists, custom audience, budget, and result contract. Recipes bind skills from their own package. Interviews belong to the orchestrator; a worker returns its need for input and is redispatched after the researcher answers.

## Validation and lifecycle

```bash
clio-coder plugins inspect ./lab-research --json
clio-coder plugins install ./lab-research --project
clio-coder plugins list --all --json
clio-coder plugins drift lab-research --project
```

Installation validates the exact manifest bytes included in the tree digest, copies into private staging, verifies that source and staging still match, and publishes the package and installation record with rollback on failure. Pins bind filenames, entry kinds, bytes, symlink targets and empty directories. Escaping links, hard links, unsupported filesystem entries and a root `state.json` are rejected. A catalog's expected identity, version and digest cannot be bypassed with `--force`.

User installations live in the Clio configuration directory's `plugins/`; project installations live in `.clio-coder/plugins/`. State is outside the bundle, in the parent `state.json`. Installations also retain their source origin for updates. A valid project copy takes precedence over the user copy; disabling that project copy suppresses both. Changed or unverifiable content cannot load or be enabled. Update refuses local drift unless explicitly forced, and replacement or removal preserves changed files in a reported recovery copy.

An active session observes additions and replacements after `/resources plugins reload` or restart. Removal, disabling and digest drift revoke subsequent resource discovery even when an earlier snapshot remains committed. Executable harness tool schemas have a separate lifecycle and require a new session after changes.

## Host projections and runtime capabilities

Agent Plugins 1.0.0 standardizes skills and MCP declarations. Clio currently consumes portable skills and its native manifest extension; it preserves MCP files but does not execute MCP servers. Claude Code and Gemini have their own native manifests and component formats. A package exporter must translate those formats and report which features are native, adapted as instructions, or unavailable. An exported skill workflow does not establish that a peer host executes Clio fleets.

The bundled `materio` plugin includes a tested Python exporter for Codex, Claude Code and Gemini. See its package README for commands and capability reports. It also provides a complete worked example of explicit component relationships and shared domain references.

Harness extensions register runtime tools through the [harness extension contract](harness-extensions.md). They use a separate extension manifest and installation state. Legacy version 1 resource extensions remain readable, preserving existing WTF-P installations while new packages adopt the plugin engine. See [plugin library usage](plugins.md) for catalogs, updates, pins and terminal UI operations.
