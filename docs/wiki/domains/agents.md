---
title: "Agent recipes, playbooks and result contracts"
summary: "How Clio discovers and validates agent recipes, playbooks and their command registry, and how worker results are checked against declared contracts. Read this when adding a recipe, changing a playbook, or tracing why a recipe or result is rejected."
sources:
  - "src/domains/agents/index.ts"
  - "src/domains/agents/registry.ts"
  - "src/domains/agents/recipe-schema.ts"
  - "src/domains/agents/spec.ts"
  - "src/domains/agents/result-contract.ts"
  - "src/domains/agents/playbook.ts"
  - "src/domains/agents/playbook-commands.ts"
  - "src/domains/agents/harness-validate.ts"
symbols:
  - "discoverAgentRecipes"
  - "loadRecipesFromDir"
  - "parseAgentRecipeSchema"
  - "parseAgentRecipeSchemaIssues"
  - "normalizeAgentSpec"
  - "agentSpecPolicyErrors"
  - "assertAgentSpecPolicy"
  - "parsePlaybookCommands"
  - "loadPlaybookCommands"
  - "validatePlaybookCommandArgs"
  - "loadPlaybook"
  - "listPlaybooks"
  - "renderPlaybookPrompt"
  - "validateResultContract"
  - "parseResultContract"
  - "validateHarness"
  - "collectHarnessInput"
tests:
  - "tests/extended/fleet-command-args.test.ts"
  - "tests/contracts/playbook-cli.test.ts"
invariants:
  - "A recipe found under a user or project agents directory must declare audience 'custom'; any other audience is rejected at parse time."
  - "A non-builtin recipe whose id is worker, delegate or auto is ignored during merge, never added to the catalog."
  - "A builtin recipe that fails parsing or policy aborts discovery; a user, project or plugin recipe that fails is quarantined with a diagnostic."
  - "A recipe that fails agent policy (for example a read-only recipe requesting write tools) throws before it enters the catalog."
  - "A playbook command invoked with a number of arguments different from its declared argumentSlots is rejected, and an argument beginning with a dash is rejected."
  - "A playbook command registry that is absent yields null from loadPlaybookCommands, which is distinct from an empty registry."
validate:
  - "pnpm run test:file -- tests/extended/fleet-command-args.test.ts"
  - "pnpm run test:file -- tests/contracts/playbook-cli.test.ts"
---

# Agent recipes, playbooks and result contracts

This area defines what an agent is in Clio: a markdown recipe with a strict frontmatter schema, the policy that constrains what a recipe may request, the playbooks that sequence agent and deterministic steps, and the result contracts that decide whether a worker's output is accepted. A reader needs this page when adding or changing a builtin or custom recipe, changing a playbook or its `commands.yaml` registry, or tracing why a recipe was quarantined or a result failed validation. Worker execution itself lives in the dispatch and worker areas.

## What this area does

- Discovers agent recipes from the shipped builtins directory, enabled plugins, the operator's user config directory, and the project's `.clio-coder/agents` directory, then merges them into one catalog.
- Parses each recipe's frontmatter with a strict schema, normalizes it into an `AgentSpec`, and checks the spec against capability-class policy.
- Discovers playbooks from the same layered sources and loads a named one, resolving its references and validating its code steps against the project command registry.
- Validates a worker's output against the result contract the recipe or dispatch declared.
- Checks an authored harness (recipes, skills and settings) for problems, for operator inspection.

## What owns it

- `src/domains/agents/index.ts` is the public surface. `AgentsDomainModule` binds the manifest to `createAgentsBundle` from `extension.ts`, and the file re-exports the playbook, recipe, spec, result-contract and write-boundary helpers.
- `src/domains/agents/registry.ts` owns discovery. `loadRecipesFromDir` reads one directory, and `discoverAgentRecipes` runs a discovery pass over the builtin, plugin, user and project sources. `mergeRecipes` applies precedence.
- `src/domains/agents/recipe-schema.ts` owns the frontmatter schema. `RECIPE_KEYS` and `OPTIONAL_RECIPE_KEYS` list the accepted keys. `parseAgentRecipeSchema` throws on the first problem, and `parseAgentRecipeSchemaIssues` returns the full issue list.
- `src/domains/agents/spec.ts` owns the closed enumerations (`AgentCategory`, `AgentCapabilityClass`, `AgentAudience`, `AgentProduct`), `normalizeAgentSpec`, `agentSpecPolicyErrors`, and `assertAgentSpecPolicy`.
- `src/domains/agents/playbook.ts` owns playbook parsing and listing. `loadPlaybook` resolves a name, `listPlaybooks` enumerates all sources with per-file errors, and `renderPlaybookPrompt` renders `{{var}}` placeholders strictly.
- `src/domains/agents/playbook-commands.ts` owns the operator's `commands.yaml` registry. `parsePlaybookCommands` and `loadPlaybookCommands` read it, and `validatePlaybookCommandArgs` enforces declared argument slots.
- `src/domains/agents/result-contract.ts` owns the `ResultContract` union and `validateResultContract`, which dispatches on `contract.kind` to a per-kind validator.
- `src/domains/agents/harness-validate.ts` owns `validateHarness`, which checks recipe, skill and settings files, and `collectHarnessInput`, which gathers those inputs from a workspace.

## Discovery and precedence

`discoverAgentRecipes(cwd)` runs `discoverAgentRecipesInPass` inside `withPluginDiscoveryPass`, which shares a skill-catalog cache for the one pass. The sources are loaded in this order and passed to `mergeRecipes`:

1. Builtins from the package's `src/domains/agents/builtins` directory.
2. Plugin agent roots, sorted by plugin source name, each bound to its plugin skill root.
3. The user agents directory under the Clio config directory.
4. The project `.clio-coder/agents` directory.

`mergeRecipes` then applies these rules, each recorded as a diagnostic of kind `ignored` or `overridden`:

- A non-builtin recipe whose id is `worker`, `delegate` or `auto` is ignored with reason `reserved-agent-id`.
- A plugin recipe whose id matches a builtin is ignored with reason `reserved-builtin`.
- A user recipe whose id matches a builtin that is a shadow or internal agent is ignored with reason `reserved-shadow`.
- A project recipe whose id matches a builtin is ignored with reason `reserved-builtin`.
- Otherwise a later source overrides an earlier one with the same id.

Diagnostics are bounded to `MAX_AGENT_RECIPE_DIAGNOSTICS` (256) entries and are an inspection aid, not a second catalog.

`loadRecipesFromDir` treats failure differently by source. A builtin file that fails parsing or policy throws and aborts discovery. For any other source, the error is recorded as a `quarantine` diagnostic and written to the diagnostic stream, and the file is skipped.

## Recipe schema and policy

`parseAgentRecipeSchemaIssues` checks each frontmatter key against `RECIPE_KEYS` and `OPTIONAL_RECIPE_KEYS` (`product` and `permissions`). Two rules are worth knowing before editing a recipe:

- Audience is set by location, not by the file. `parseAudience` accepts `custom` only for a non-builtin recipe, and rejects `custom` for a builtin. A recipe under a user or project root that declares any audience other than `custom` is rejected with an error that says audience follows where the recipe was discovered.
- `product` is a closed enum. `AGENT_PRODUCTS` currently contains only `orientation`. The type comment on `AgentProduct` states that an unrecognized value must be a parse error, so it cannot silently fall back to the default reserve set.

After parsing, `loadRecipesFromDir` calls `assertAgentSpecPolicy(normalizeAgentSpec(recipe))`. `agentSpecPolicyErrors` checks the spec against its capability class. Representative rules, all taken from that function:

- A `workspace-edit` agent must require `read` and a `write` or `edit` tool.
- A `verification` agent must require `verify`, and must not request write, dispatch, system-modify, destructive or git-destructive tools, or `bash`.
- An `artifact-write` agent may write only through `artifact`. Execute, dispatch, system-modify and destructive tools are rejected.
- A `read-only` agent may request only tools whose action class is `read`.
- Any agent that declares `skills` must expose and require `context`.
- `ask_user` is rejected for every recipe because it is available only to the orchestrator.

Policy violations are collected and thrown together as one `agent policy violation` error.

`normalizeAgentSpec` produces the `AgentSpec` used everywhere downstream. `agentSpecFingerprint` hashes the fields that change what a route means (tools, requirements, capability, budget, result contract, permissions, and a SHA-256 of the body) and excludes display metadata. `isUserVisibleAgent` returns true only for `base` and `custom` audiences. `isShadowAgent` is true for `shadow` and `internal`.

## Playbooks and the command registry

`loadPlaybook(cwd, name)` locates the name across the playbook sources, searching the last-listed source first so that later sources shadow earlier ones. It then parses the file, resolves references, and calls `validatePlaybookCommands(playbook, loadPlaybookCommands(cwd))`. A missing playbook throws `playbook not found`.

`listPlaybooks(cwd)` does the same across every source but never throws for an individual file. Each invalid file becomes a listing with `error` set. If the command registry failed to parse and a playbook contains code steps, the registry error is attached to that playbook. `needsCommands` is set only for a `PlaybookCommandRegistryMissingError`, which the caller uses to distinguish unfinished setup from a real error.

`loadPlaybookCommands(cwd)` returns `null` when `.clio-coder/playbooks/commands.yaml` does not exist, and `parsePlaybookCommands` otherwise. The parser:

- Parses the YAML and validates it against a TypeBox schema, reporting the first failing path.
- Requires each command id to match `^[a-z0-9][a-z0-9._-]{0,63}$`, each executable to be nonempty, and each `env` entry to match an uppercase variable-name pattern.
- Rejects a `cwd` that is absolute or climbs out of the workspace.
- Defaults `timeoutMs` to `PLAYBOOK_COMMAND_DEFAULT_TIMEOUT_MS` when absent.
- Accepts `argumentSlots` only after checking each slot through `validatePlaybookCommandArgs` in template mode.

`validatePlaybookCommandArgs` is the enforcement point for argument data. It requires the number of supplied arguments to equal the number of declared slots, and each non-template argument to be nonempty, at most `maxLength` characters, free of NUL, and not starting with `-`. The error text tells the operator that fixed flags belong in `argv`.

`renderPlaybookPrompt` replaces every `{{name}}` with a supplied variable and throws one error listing all missing names. It does not render partial output.

## Result contracts

`ResultContract` is a discriminated union. Each kind names a postcondition a worker's output must satisfy. `validateResultContract(input)` switches on `contract.kind` and delegates to a per-kind validator, returning a `ResultContractValidation` whose `quality` is `pass`, `fail` or `unmeasured`. Some kinds are restricted by the parser: the doc comments on `ResultContract` state that `council-ballot`, `code-report` and `context-handbook` cannot be declared by a recipe, and that Scout subtasks cannot request several kinds. The scout branch shows the citation check: a scout report with no degraded reason is also checked by `validateScoutCitations`, and a failure there returns `fail`.

`artifact-report` is a notable case in its comment: the artifact on disk is the postcondition, and validation checks only readability and a nonempty file at a caller-bound path. It does not establish freshness, authorship or accuracy.

`src/domains/agents/index.ts` re-exports `parseResultContract`, `validateRecipeResult` and related parsers, so callers outside this area import them from the domain index.

## Harness validation

`validateHarness(input)` is pure. It runs recipe, skill and settings checks over a `HarnessInput` and returns `HarnessIssue` values. `collectHarnessInput(workspaceRoot, options)` reads the recipe directories, the catalog from `discoverAgentRecipes`, and `package.json` scripts, and it returns `null` for a package script check when `package.json` is missing or cannot be parsed. Unreadable recipe files are skipped in the same way the registry skips them, so harness validation does not report them.

## Focused tests

- `tests/extended/fleet-command-args.test.ts` exercises the argument-slot rules through `runCodeStep`. A command with no declared slots fails when given extra arguments (`expected 0 declared argument slots`). With a `taskDir` slot of `maxLength: 12`, the value `--eval` is rejected with `leading dash`, and a 13-character value is rejected with `at most 12`. `validatePlaybookCommands` with `taskDir: "--eval"` also throws `leading dash`.
- `tests/contracts/playbook-cli.test.ts` builds a `commands.yaml` with an `argumentSlots: [{name: fixture, maxLength: 64}]` stage and exercises the playbook CLI path over it.
- `tests/extended/plugin-resource-loading.test.ts` writes a `commands.yaml` with an `evidencePath` slot and loads the `materio-code` playbook through `loadPlaybook`, so plugin-provided playbooks are covered by at least one test.

Searches for `discoverAgentRecipes`, `loadRecipesFromDir` and `parseAgentRecipeSchema` found references in `tests/contracts` and `tests/extended`. The individual cases in those files were not read for this page, so no assertion about them is made here.

## Callers and dependencies

- `src/cli/playbook-preflight.ts` calls `loadPlaybook`, `loadPlaybookCommands` and `renderPlaybookPrompt` in `inspectPlaybook`, passing `process.cwd()` and optional `--var` values.
- `src/domains/agents/extension.ts` imports `discoverAgentRecipes` and `loadRecipesFromDir`, and `src/domains/resources/library-inventory.ts` also depends on the discovery module.
- The registry depends on `readSettings`, `writeDiagnostic`, plugin resource roots, the skill loader and `parseFrontmatter`. The spec module depends on the tool-name catalog, the action classifier and the worker-permit declaration checks.

## Things to watch when editing

- Recipe frontmatter keys are a closed set. Adding a key means updating `RECIPE_KEYS` or `OPTIONAL_RECIPE_KEYS`, the parser, and `normalizeAgentSpec`. The schema comment says the release check `scripts/check-release.mjs` enforces the same key list against built recipes, so both sides must change together.
- Enumerations such as `AgentProduct` are intentionally closed. A new value needs both the type and the runtime array updated, or the parser will reject it.
- Policy rules in `agentSpecPolicyErrors` apply to every discovered source, including user and project recipes, so a change there can make previously accepted operator recipes fail discovery and be quarantined.
- Playbook argument slots are opt-in. Fixed flags belong in `argv`, and any data argument that a playbook passes must be declared as a slot in the operator's `commands.yaml`.
- The fingerprint in `agentSpecFingerprint` is designed to exclude display metadata. A change to a field included in the hash changes the route identity used for measured history.
