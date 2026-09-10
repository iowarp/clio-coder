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

Portable identity and publisher metadata remain at the root. The root schema permits `$schema`, `name`, `version`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, and `extensions`. Names have 1 to 64 lowercase letters, digits, hyphens or periods, begin and end with an alphanumeric character, and contain neither `--` nor `..`. Clio reserves `state.json` as an installation bookkeeping name. Every package, including a local authoring install, requires an explicit Semantic Version. Numeric prerelease identifiers cannot contain leading zeros.

## Native Clio components

`extensions["ai.iowarp.clio"]` holds optional Clio metadata inside the portable manifest. A plugin containing `skills/<name>/SKILL.md` needs only the root identity fields above: Clio discovers the conventional `skills/` directory. A standalone skill package with a root `SKILL.md` declares `kind: "skill"`, `resources.skills: "."` and its one public skill component through the extension; the supplied skill template demonstrates that form. Clio prompts, strict agent recipes, fleets and explicit component graphs also use this metadata. The key does not select a directory: its `resources` map names the paths the package actually uses.

Use `extensions["ai.iowarp.clio"]` as the manifest metadata key to declare Clio prompts, strict agent recipes, and fleets. In modern packages, resources use ordinary top-level directories (`agents/`, `prompts/`, `skills/`, `fleets/`), while `assets/` holds shared supporting files. (Historical bundles such as `materio` may nest resources under `ai.iowarp.clio/` for backward compatibility, but top-level directories are recommended for new packages.)

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

Create every declared directory and file before validation. Resource kinds are `skills`, `prompts`, `agents`, `fleets`, and `themes`. Component kinds are `skill`, `prompt`, `agent`, `fleet`, `script`, `resource`, and `tool`. A component has a stable `kind:id` identity, one contained file path, and optional `requires` references to other components in the same bundle. A skill points to its `SKILL.md`. Dependencies must exist and form an acyclic graph. Native discoverable components must live beneath their declared resource root. Component metadata records relationships; it does not execute scripts or register tool implementations.

Clio text can refer to `${pluginRoot}/assets/methods.md` or `${component:resource:methods}`. Prompts, agent bodies, and skills recognize prose markers with portable, space-free slash suffixes. For a filename containing spaces or Unicode, declare a component and refer to its `kind:id`. The referenced target must exist within the declaring package. Fleet argument paths use a separate complete-path parser: the reference must occupy the whole argument, and containment is checked after expanding the entire suffix, including spaces and Unicode. A reference embedded in an option such as `--file=${pluginRoot}/data.csv` is rejected; pass the path as its own argument. These are Clio reference forms; peer exports translate instructions and paths for their native host. Portable skill text should use relative file references where practical.

Prompt names follow their path beneath the prompts root. The example exposes `/lab-research:start`. Give agent and fleet filenames a package prefix to keep their registered identities unambiguous. Agent recipes retain the strict version 1 contract, including required and optional tool lists, custom audience, budget, and result contract. Recipes bind skills from their own package. Interviews belong to the orchestrator; a worker returns its need for input and is redispatched after the researcher answers.

## Validation and lifecycle

```bash
clio-coder library validate ./lab-research --json
clio-coder library inspect ./lab-research --json
clio-coder library install ./lab-research --project
clio-coder library list --all --json
clio-coder library drift lab-research --project
```

`library validate <package-path> --json` performs a read-only content and payload validation before any installation or registration:
- **Manifest validity**: Parses `plugin.json` against the schema, verifying identifiers, SemVer compliance, and declared resource roots.
- **Payload & schema validation**: Validates agent recipes against strict v1 schemas, policy budgets, and custom audience rules; parses fleet DAGs, loop boundaries, and write boundaries; and checks prompt loadability.
- **Package reference resolution**: Ensures all `${component:...}` and `${pluginRoot}` references point to existing files within the package boundary and form an acyclic graph.
- **Prerequisite separation**: Reports required external commands or core agents as environment prerequisites rather than failing package content validity.
- **Read-only**: Leaves package files, repository files, and installation state roots completely unchanged.

Installation validates the exact manifest bytes included in the tree digest, copies into private staging, verifies that source and staging still match, and publishes the package and installation record with rollback on failure. Pins bind filenames, entry kinds, bytes, symlink targets and empty directories. Escaping links, hard links, unsupported filesystem entries and a root `state.json` are rejected. A catalog's expected identity, version and digest cannot be bypassed with `--force`.

User installations live in the Clio configuration directory's `plugins/`; project installations live in `.clio-coder/plugins/`. State is outside the bundle, in the parent `state.json`. Installations also retain their source origin for updates. A valid project copy takes precedence over the user copy; disabling that project copy suppresses both. Changed or unverifiable content cannot load or be enabled. Update refuses local drift unless explicitly forced, and replacement or removal preserves changed files in a reported recovery copy.

An active session observes additions and replacements after `/library reload` or restart. Removal, disabling and digest drift revoke subsequent resource discovery even when an earlier snapshot remains committed. Executable harness tool schemas have a separate lifecycle and require a new session after changes.

## Host projections and runtime capabilities

Agent Plugins 1.0.0 standardizes skills and MCP declarations. Clio currently consumes portable skills and its native manifest extension; it preserves MCP files but does not execute MCP servers. Claude Code and Gemini have their own native manifests and component formats. A package exporter must translate those formats and report which features are native, adapted as instructions, or unavailable. An exported skill workflow does not establish that a peer host executes Clio fleets.

The bundled `materio` plugin includes a tested Python exporter for Codex, Claude Code and Gemini. See its package README for commands and capability reports. It also provides a complete worked example of explicit component relationships and shared domain references.

Two layouts need no exporter at all, because Claude Code and Codex load them directly from the unchanged package:

- A standalone skill package with a root `SKILL.md`, no `skills/` directory and no top-level `skills` manifest field. Claude Code loads it as a single-skill plugin and takes the invocation name from the `SKILL.md` frontmatter. Codex finds the same directory under any of its skills roots.
- A bundle with a real `skills/` directory. Both hosts publish exactly those skills.

What a peer host does *not* load matters just as much. Claude Code scans a plugin root for `agents/`, `commands/`, `hooks/`, `output-styles/` and `.mcp.json` with no manifest asking it to. A Clio strict-v1 recipe sitting in a top-level `agents/` directory is therefore picked up and shown as a native Claude agent, tools, model and budget fields included, none of which that host honors. Clio `prompts/` and `fleets/` are inert to it.

That leaves a real choice when a package should serve both audiences. Ordinary top-level `agents/` and `prompts/` directories are the recommended Clio layout and stay a valid first-class library package; the repository marketplace simply does not publish such a package, and `pnpm run library:pin` prints the reason. To publish it as well, declare its Clio resource roots at paths no peer host scans, for example `"agents": "native/agents"` in the manifest's `resources` map, and put the recipes there. The bundled `materio` package does this with its own historical directory name.

Keep the skill surface intact when you edit a package: adding a `skills/` directory to a standalone skill silently stops its root `SKILL.md` from loading. `tests/contracts/library-portability.test.ts` asserts all of this for every curated package, and `scripts/verify-portable-hosts.sh` re-measures it against the real host CLIs. See [coding agent interoperability](interop.md) for the exact install commands.

Harness extensions register runtime tools through the [harness extension contract](harness-extensions.md). They use a separate extension manifest and installation state, and they cannot declare domain resources: prompts, agents, skills, fleets and reference files ship in a plugin. See [plugin library usage](plugins.md) for catalogs, updates, pins and terminal UI operations.

## Authoring templates and contributor journey

Clio Coder provides working, valid authoring templates for all five package kinds in `library/_authoring/templates/`:

- `library/_authoring/templates/skill/`: Standalone skill with house conventions, triggers, and recorded eval scenarios.
- `library/_authoring/templates/agent/`: Standalone agent recipe using strict v1 fields, `skills: []`, and `audience: custom`.
- `library/_authoring/templates/prompt/`: Parameterized prompt with path-derived invocation (`/<name>`) and `$ARGUMENTS` expansion.
- `library/_authoring/templates/fleet/`: Multi-agent coordination contract with a valid DAG and documented prerequisites.
- `library/_authoring/templates/plugin/`: Composite bundle showing an agent binding a contained skill, prompts, and supporting assets.

Templates are reference models and are excluded from `library/registry.yaml`. Follow this unified contributor journey:

1. **Choose package kind**: Decide whether your package is a single-kind package (`skill`, `agent`, `prompt`, `fleet`) exposing exactly one public recipe, or a composite `plugin` bundle combining multiple resources.
2. **Copy authoring template**: Copy from `library/_authoring/templates/<kind>/` into your project or repository.
3. **Author resources**:
   - Single-kind packages expose exactly one public resource file in their declared resource directory (`skills`, `agents`, `prompts`, or `fleets`).
   - Keep `README.md` at the package root, outside the resource directory, so the loader does not discover it as a second public recipe.
   - Packages may carry explicitly invoked scripts (e.g., for offline evaluation or verification tasks); these are declared metadata and are strictly distinct from harness extensions, which register runtime tools and hooks.
4. **Validate**:
   Run `clio-coder library validate ./lab-research --json` to verify manifest schemas, resource payloads, reference syntax, and loadability.
5. **Pin and check**:
   Maintainers run `pnpm run library:pin` and `pnpm run library:check` to refresh and verify full-tree distribution pins. For curated skills, maintainers also run `pnpm run skills:pin` and `pnpm run skills:check`.
   - **Full-tree pins** (`library/registry.yaml`) cover every distributed byte to verify package integrity.
   - **Normalized skill evidence** (`library/skills/registry.yaml`) records normalized skill body hashes as provenance evidence for reviewed instructions.
6. **Try in isolated project**:
   Register locally with `clio-coder library register ./lab-research --project`. Registration writes identity, version, source, and full-tree SHA-256 into the scoped `library.yaml`. Preview and install with `library install plugin:lab-research --project --dry-run`, then `library install plugin:lab-research --project`. Test invocation through `/skills`, `/run`, prompt slash commands, or `/fleet run`.
7. **Submit a focused fork PR**:
   Push your topic branch to your fork and submit a PR against `main`.

Package dependencies live in `extensions["ai.iowarp.clio"].requires`, such as `["skill:ship"]`; copy the same requirements into the index. They name packages, while component `requires` names files within one package. Neither declares an execution hook.

Declare runnable eval suites using `"evals": {"scripts": "evals/scripts.yaml"}` in the Clio extension. Paths must identify contained files. Validate with `clio-coder eval validate --package ./lab-research --eval scripts` and run with `clio-coder eval run --package ./lab-research --eval scripts`. Use the standard version-2 eval suite schema. Materio's [worked suite](../../library/plugins/materio/evals/scripts.yaml) runs Python contracts in a temporary package copy; package installation never runs evals.

See [Library packages](resource-library.md) for every lifecycle command and [Library architecture](../architecture/library.md) for identity, trust, pin and namespace invariants.
