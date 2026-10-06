# Portable plugins and the library

A plugin is an Agent Plugin: a complete, versioned package of content with a portable root `plugin.json` that follows [Agent Plugins 1.0.0](https://agent-plugins.org/). It is content only. Clio Coder reads its own prompts, agents, and playbooks from the Clio namespace of that manifest, `extensions["ai.iowarp.clio"]`, and from the `ai.iowarp.clio/` directory. Installing a plugin keeps its content and references together, pins the whole tree by SHA-256, and never runs code inside Clio Coder.

This page is the concept map. Each contract is stated once, in the page named in the last table. A library plugin is unrelated to `integrations.runtimePlugins`, which lists pi-ai compatibility plugins loaded by the engine; see [pi-boundary.md](../architecture/pi-boundary.md).

## Package kinds

The library distributes six package kinds. The five content kinds share one engine, one state file per scope, and one lifecycle. The sixth, `extension`, is Clio Coder code and has its own manifest, state file, and consent. A kind names what a package exposes.

| Kind | Exposes |
| --- | --- |
| `plugin` | Any mix of skills, prompts, agents, playbooks, scripts, and reference files. The default content kind. |
| `skill` | One skill. |
| `agent` | One strict-v1 agent definition. |
| `prompt` | One prompt template. |
| `playbook` | One playbook, the plan the fleet runs. |
| `extension` | Clio code in its own process; see [Extensions](harness-extensions.md). |

User plugins install under `<configDir>/plugins/<name>/` and project plugins under `.clio-coder/plugins/<name>/`; extensions install under `<configDir>/extensions/<id>/` and `.clio-coder/extensions/<id>/`. A valid project copy wins over the user copy, and a disabled project copy still suppresses it. A project copy loads only while the operator has approved the workspace's `.clio-coder/plugins/state.json` (or `.clio-coder/extensions/state.json` for an extension); an unapproved project copy neither loads nor suppresses the user copy. See [Library packages](resource-library.md).

## Plugins, extensions, loose resources, and share archives

| | Plugin | Extension | Loose resource | Share archive |
| --- | --- | --- | --- | --- |
| Installed with | `clio-coder library install plugin:<name>`, `/library` | `clio-coder library install extension:<name>`, `/library` (Extensions tab), `clio-coder extensions install` | Copy into a resource root | `clio-coder share import` |
| Manifest | `plugin.json` | `clio-coder-extension.yaml`, `.yml` or `.json` | None (`SKILL.md` frontmatter) | JSON archive |
| Contributes | Content: skills, prompts, agents, playbooks, scripts, reference files | Clio code in its own process: hooks, runtime tools, commands, workspaces and skins, interviews | One skill, prompt, agent, or playbook | Copies of loose resources, extension packages, a settings fragment |
| Runs code in Clio | Never | Only after the operator reviews its capability envelope | Never | Never; extension entries go through the extension installer |
| State | `plugins/state.json` | `extensions/state.json` | None | None |
| Reload | `/library reload` | `/extensions reload`; tool schemas stay frozen for the session | Next discovery | Not applicable |

The two package systems never overlap. An extension manifest that declares `skills`, `prompts`, `agents`, `playbooks`, or `resources` is refused with a pointer to `clio-coder library install <path>`, and an extension root never holds a `plugin.json`. A plugin may carry scripts that a skill or playbook runs explicitly, but installing or loading a plugin never registers hooks, tools, commands, or UI.

### Pairing a plugin with an extension

A plugin and an extension are separate packages, each with its own manifest, digest, state file, and consent. An extension may name the one plugin it serves with a top-level `plugin: <name>` in `clio-coder-extension.yaml`. That link alone lets one of its commands declare `replaces: prompt` and answer the plugin's `/<plugin>:<command>` prompt of the same name, and the takeover applies only while the plugin is installed and enabled. The extension's runtime snapshot carries the served plugin as `snapshot.plugin`. The plugin's prompts keep a working fallback for when the extension is absent, so a plugin installed alone starts no runtime. The Library detail view names each side's partner and says whether it is installed and in effect. Installing a plugin never installs its extension, so the operator installs `extension:<name>` separately. See [Extensions](harness-extensions.md).

## How plugin resources reach a session

- Skills load from the enabled plugin skill roots at package precedence (10), with provenance `source: plugin`.
- Prompts load from enabled plugin prompt roots. A prompt's command name is its path beneath the prompts root with directory separators written as colons.
- Agents and playbooks register through the agent and playbook loaders. An agent ID comes from its definition filename, and a playbook keeps its authored name.
- A session sees additions and replacements after `/library reload` or a restart. Removal, disabling, and digest drift revoke discovery on the next read.
- A root `mcp.json` is preserved and reported as a warning. Clio Coder does not execute MCP servers or plugin hooks from a plugin.
- A plugin that still declares `resources.fleets`, kind `fleet`, or a `fleet:` requirement was built for an older Clio. Discovery refuses it with the rename that fixes it (`fleets` to `playbooks`); `clio-coder upgrade` converts existing installations once, and there are no `fleets` reads or aliases.
- Foreign packages (from `interop adopt` or `library import`) install with foreign trust, and their skills and prompts load only while `integrations.projectResources.trustProjectImports` is true.
- Project packages of every kind load only after workspace trust approves the project's plugin state (`clio-coder config trust plugins`). The operator's first project install into a workspace with no plugin state approves it; an import, an adoption and every later project change do not. User packages need no workspace approval. The two gates are independent, so a foreign package at project scope needs both.

## Where each contract lives

| Contract | Page |
| --- | --- |
| Package invariants: identity, integrity digest, state, precedence, dependencies, trust origins, operator authority, lifecycle plans | [Library architecture](../architecture/library.md) |
| Manifest fields, kinds, components, references, validation, templates | [Authoring plugins](authoring-plugins.md) |
| Operator commands, index format, import, extension review, lifecycle receipts, scope and drift, the Library overlay, inventory, workspace trust of project packages | [Library packages](resource-library.md) |
| Skill install rule, marketplace offers, registry and pins, `library:pin` | [Skills in the library](skills-marketplace.md) |
| Prompt and skill roots, collisions, trust, share archives | [Prompts, skills, and share archives](extensions-and-sharing.md) |
| Extension manifest, capability envelope, hooks, runtime tools, commands, workspaces, sandbox, lifecycle, workspace trust of project extensions | [Extensions](harness-extensions.md) |
