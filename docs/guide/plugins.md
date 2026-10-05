# Portable plugins and the library

A plugin is a complete, versioned bundle of skills and supporting files. The portable root `plugin.json` follows [Agent Plugins 1.0.0](https://agent-plugins.org/). Clio Coder reads native prompts, agent recipes, and fleets from its namespaced manifest extension, `extensions["ai.iowarp.clio"]`. Installing a bundle keeps those resources and their references together and pins the whole tree by SHA-256.

This page is the concept map. Each contract is stated once, in the page named in the last table. A library plugin is unrelated to `integrations.runtimePlugins`, which lists pi-ai compatibility plugins loaded by the engine; see [pi-boundary.md](../architecture/pi-boundary.md).

## Package kinds

The library distributes five package kinds through one engine, one state file per scope, and one lifecycle. A kind names what a package exposes.

| Kind | Exposes |
| --- | --- |
| `plugin` | Any mix of skills, prompts, agent recipes, fleet contracts, scripts, and reference files. The default kind. |
| `skill` | One skill. |
| `agent` | One strict-v1 agent recipe. |
| `prompt` | One prompt template. |
| `fleet` | One fleet contract. |

User packages install under `<configDir>/plugins/<name>/` and project packages under `.clio-coder/plugins/<name>/`. A valid project copy wins over the user copy, and a disabled project copy still suppresses it. A project copy loads only while the operator has approved the workspace's `.clio-coder/plugins/state.json`; an unapproved project copy neither loads nor suppresses the user copy. See [Library packages](resource-library.md).

## Plugins, harness extensions, loose resources, and share archives

| | Plugin | Harness extension | Loose resource | Share archive |
| --- | --- | --- | --- | --- |
| Installed with | `clio-coder library install`, `/library` | `clio-coder extensions install` | Copy into a resource root | `clio-coder share import` |
| Manifest | `plugin.json` | `clio-coder-extension.yaml`, `.yml` or `.json` | None (`SKILL.md` frontmatter) | JSON archive |
| Contributes | Prompts, skills, agents, fleets, scripts, reference files | Command tools, operator commands and panels, hook declarations | One skill, prompt, agent, or fleet | Copies of loose resources, extension bundles, a settings fragment |
| State | `plugins/state.json` | `extensions/state.json` | None | None |
| Reload | `/library reload` | `/extensions reload`; tool schemas stay frozen for the session | Next discovery | Not applicable |

The two package systems never overlap. An extension manifest that declares `skills`, `prompts`, `agents`, `fleets`, or `resources` is refused with a pointer to `clio-coder library install <path>`. A plugin may carry scripts that a skill or fleet runs explicitly, but installing or loading a plugin never registers harness tools, hooks, or UI.

## How plugin resources reach a session

- Skills load from the enabled plugin skill roots at package precedence (10), with provenance `source: plugin`.
- Prompts load from enabled plugin prompt roots. A prompt's command name is its path beneath the prompts root with directory separators written as colons.
- Agent recipes and fleet contracts register through the agent and fleet loaders. An agent ID comes from its recipe filename, and a fleet keeps its authored name.
- A session sees additions and replacements after `/library reload` or a restart. Removal, disabling, and digest drift revoke discovery on the next read.
- Foreign packages (from `interop adopt` or `library import`) install with foreign trust, and their skills and prompts load only while `integrations.projectResources.trustProjectImports` is true.
- Project packages of every kind load only after workspace trust approves the project's plugin state (`clio-coder config trust plugins`). The operator's first project install into a workspace with no plugin state approves it; an import, an adoption and every later project change do not. User packages need no workspace approval. The two gates are independent, so a foreign package at project scope needs both.

## Where each contract lives

| Contract | Page |
| --- | --- |
| Package invariants: identity, integrity digest, state, precedence, dependencies, trust origins, operator authority, lifecycle plans | [Library architecture](../architecture/library.md) |
| Manifest fields, kinds, components, references, validation, templates | [Authoring plugins](authoring-plugins.md) |
| Operator commands, index format, import, scope and drift, the Library overlay, inventory, workspace trust of project packages | [Library packages](resource-library.md) |
| Skill install rule, marketplace offers, registry and pins, `library:pin` | [Skills in the library](skills-marketplace.md) |
| Prompt and skill roots, collisions, trust, share archives | [Prompts, skills, and share archives](extensions-and-sharing.md) |
| Command tools, operator runtimes, hook declarations, extension lifecycle, workspace trust of project extensions | [Harness extensions](harness-extensions.md) |
