---
title: "Domains agents"
summary: "The agents domain loads and validates worker recipes, normalizes their specs, and exposes a catalog for dispatch, plus the typed result contracts and fleet-contract machinery that bound what each worker may claim and change."
sources:
  - "src/domains/agents/index.ts"
  - "src/domains/agents/spec.ts"
  - "src/domains/agents/recipe.ts"
  - "src/domains/agents/recipe-schema.ts"
  - "src/domains/agents/registry.ts"
  - "src/domains/agents/result-contract.ts"
  - "src/domains/agents/playbook.ts"
  - "src/domains/agents/playbook-commands.ts"
  - "src/domains/agents/catalog.ts"
  - "src/domains/agents/extension.ts"
  - "src/domains/agents/write-boundary.ts"
  - "src/domains/agents/contract.ts"
symbols:
  - "AgentsDomainModule"
  - "AgentsContract"
  - "AgentRecipe"
  - "AgentSpec"
  - "normalizeAgentSpec"
  - "assertAgentSpecPolicy"
  - "resolveAgentToolCompatibility"
  - "discoverAgentRecipes"
  - "mergeRecipes"
  - "parseAgentRecipeSchema"
  - "ResultContract"
  - "validateResultContract"
  - "validateRecipeResult"
  - "resultContractOutputBytes"
  - "FleetContract"
  - "FleetContractStep"
  - "parseFleetContract"
  - "validateFleetGraph"
  - "fleetStepWriteBoundary"
  - "renderFleetPromptSection"
  - "WriteBoundary"
  - "normalizeWriteBoundary"
  - "writeBoundaryCovers"
  - "FleetCommandRegistry"
  - "parseFleetCommands"
  - "validateFleetCommandArgs"
tests:
  - "tests/contracts/worker-boundary.test.ts"
  - "tests/contracts/dispatch-admission.test.ts"
  - "tests/contracts/scout-grep-grounding.test.ts"
invariants:
  - "A recipe's `audience` is provenance, not a self-declaration: only `builtin` recipes may name `base`, `shadow`, or `internal`; `user` and `project` recipes must declare `custom`."
  - "A `workspace-edit` capability class requires both `read` and a mutation tool (`write` or `edit`) in `tools.required`."
  - "A `readonly` fleet step is the empty write allowlist, not an absence; `readonly` in a version-4-or-later contract means the step changes nothing."
  - "A fleet contract below version 4 may not declare a `writes` key on any step; the declaration is refused by name rather than as an unknown property."
  - "A `dispatch` tool call is only allowed on an `orchestration` capability class; a non-orchestration agent that declares `dispatch` fails policy."
  - "A result contract that a coordinator authors (`council-ballot`, `code-report`) may not be declared by a recipe; a recipe that names it is rejected by `parseResultContract`."
validate:
  - "pnpm test"
---

# Domains agents

The agents domain is the harness's single source of truth for *who can be dispatched*. It loads worker recipes from Markdown files, strictly validates their front matter, normalizes each into a typed `AgentSpec`, enforces a capability/policy boundary, and exposes the result through an `AgentsContract` that the dispatch domain, the CLI, and the session prompt all consume. A second half of the domain defines the typed `ResultContract` union that every worker run's terminal output must satisfy, and the fleet-contract machinery that lets a repository pin a deterministic, versioned, write-bounded DAG of steps. The domain never runs a model; it decides what a model is allowed to claim.

## What this area does

The domain owns three distinct artifacts, each with its own strict schema:

- **Recipes** (`src/domains/agents/builtins/*.md`, `~/.config/clio-coder/agents/*.md`, `.clio-coder/agents/*.md`). A recipe is a Markdown file with YAML front matter declaring `tools`, `audience`, `category`, `capabilityClass`, `latencyClass`, `budget`, `resultContract`, and `tags`, followed by a persona prompt body. The file's basename (without `.md`) is its stable `id`; the id is never read from front matter. The schema is strict: every retained field is parsed, no front matter value is coerced or silently lost.
- **Result contracts** (`src/domains/agents/result-contract.ts`). A discriminated union of terminal shapes — `scout-report`, `verifier-report`, `mutation-report`, `code-report`, `council-report`, `artifact-report`, `oracle-report`, and others — that a worker's final text must conform to. Each kind has a strict validator, a quality label (`pass` / `fail` / `unmeasured`), and a repair shape quoted to the model verbatim.
- **Fleet contracts** (`.clio-coder/fleets/*.md`). A versioned Markdown file with a typed DAG of `agent`, `code`, `loop`, `gate`, and `plan` steps, a strict `{{var}}` prompt template, and a write-boundary policy. The fleet is the repository's work policy, kept in-repo and strictly validated.

The domain also exposes a **catalog** (`src/domains/agents/catalog.ts`) that renders the current spec set into a compact fleet prompt section for the orchestrator's system prompt, and a **command registry** (`src/domains/agents/playbook-commands.ts`) that maps code-step command ids to operator-owned `argv` lists, so a model can never invent a shell invocation.

## What owns it

### Domain module and contract

`src/domains/agents/index.ts` exports `AgentsDomainModule`, which binds `AgentsManifest` (name `"agents"`, depends on `config`) to `createAgentsBundle`. The `AgentsContract` interface in `src/domains/agents/contract.ts` is the one surface the rest of the harness reads:

- `revision()`: a monotonic counter that increments on rediscovery and on changes to `integrations.externalAgents.entries` settings.
- `list()`: raw `AgentRecipe` values as loaded from disk.
- `get(id)`: one recipe by id.
- `listSpecs()` / `getSpec(id)`: normalized, policy-bearing `AgentSpec` values. `listSpecs()` also appends ACP delegation agents synthesized from `settings.integrations.externalAgents.entries[]`.

### Recipe lifecycle

`src/domains/agents/extension.ts` (`createAgentsBundle`) owns the discovery lifecycle:

1. `start()` calls `discover()` which calls `discoverAgentRecipes(process.cwd())`.
2. `discoverAgentRecipes` in `src/domains/agents/registry.ts` reads four source roots in precedence order — builtin, plugin, user, project — then merges them via `mergeRecipes`.
3. Each recipe is parsed by `parseAgentRecipeSchema` (`src/domains/agents/recipe-schema.ts`) and then policy-checked by `assertAgentSpecPolicy(normalizeAgentSpec(recipe))` before it enters any catalog.
4. The extension subscribes to `BusChannels.PluginsReloaded` to rediscover when the plugin generation changes, and to config changes on `integrations.externalAgents.entries` to bump the revision.

`src/domains/agents/recipe.ts` defines the `AgentRecipe` interface and `parseAgentBudget`, which strictly validates the `{toolCalls, readReserve, synthesis, maximum?}` budget shape. `recipeIdFromPath` derives the id from the file's position, refusing nested directories and non-`.md` extensions.

### Spec normalization and policy

`src/domains/agents/spec.ts` is the heart of the domain. It defines:

- `AgentCategory`, `AgentCapabilityClass`, `AgentLatencyClass`, `AgentProjectContextTier`, `AgentAudience`, `AgentProduct` as closed string unions with corresponding `is*` type guards.
- `AGENT_AUTOMATION_AUTHORITIES` = `["read-only", "verification", "artifact-write", "workspace-edit"]`, the four authority classes a coordinator plan may grant.
- `AgentSpec` with a `version: 1` literal and a `toolRequirements` field that carries `required` and `optional` semantics separate from the flattened `tools` array.
- `normalizeAgentSpec(recipe)` which flattens `toolRequirements` into `tools` and validates that every declared tool is referenced by either a required or an optional requirement.
- `agentSpecFingerprint(spec)` which hashes the identity fields that change what a route means — `id`, `tools`, `toolRequirements`, `capabilityClass`, `latencyClass`, `projectContextTier`, `audience`, `skills`, `resultContract`, `budget`, and a SHA-256 of `body` — excluding display-only metadata (`name`, `description`, `category`, `tags`, `source`, `filepath`).
- `agentSpecPolicyErrors(spec)` and `assertAgentSpecPolicy(spec)` which enforce the capability-to-tool mapping.

`src/domains/agents/recipe-schema.ts` (`parseAgentRecipeSchema`) is the strict front-matter parser. It enforces:

- `RECIPE_KEYS` (version, name, description, tools, skills, audience, category, capabilityClass, latencyClass, projectContextTier, budget, resultContract, tags) are all present.
- `OPTIONAL_RECIPE_KEYS` is only `product`.
- `audience` follows discovery: `builtin` recipes may declare `base`, `shadow`, or `internal` (never `custom`); `user` and `project` recipes must declare `custom`.
- `tools` is a `{required, optional}` object where each `required` entry is either a tool name or `{anyOf: [...]}`, and every declared tool must appear in either `required` or `optional`.

### Result contracts

`src/domains/agents/result-contract.ts` defines the `ResultContract` union and its validators. Key exported symbols:

- `ResultContract`: a discriminated union of 14 kinds, including `scout-report`, `verifier-report`, `mutation-report`, `code-report`, `council-report`, `artifact-report`, `oracle-report`, `architect-plan`, `debugger-report`, `research-report`, `world-knowledge-report`, `provenance-report`, `external-delegation`, and `context-handbook`.
- `validateResultContract(input)`: dispatches on `contract.kind` to a per-kind validator that returns a `ResultContractValidation` with `conformance` (`pass`/`fail`), `quality` (`pass`/`fail`/`unmeasured`), `sourceId`, and `validatorDigest`.
- `validateRecipeResult(input)`: wraps `validateResultContract` in a `RecipeResultOutcome` that carries a `not-reached` conformance when the run never reached its terminal result (crash, abort, engine loop-guard).
- `resultContractOutputBytes(contract)`: returns the sealed-output bound for a mutation report (summary + commit message + headroom) or `null` for contracts with no bound of their own.
- `resultContractShape(contract)`: the one place the wire example for each kind is written, quoted verbatim to the model in repair rounds.
- `parseResultContract(value, path)`: the strict front-matter parser that rejects coordinator-authored kinds (`council-ballot`, `code-report`).
- `parseWorkerResultContract(value, path)`: the same parser with coordinator kinds admitted, used when a dispatch request overrides the seated recipe's postcondition.

The `ResultContractFilesystem` interface (`readFile`, optional `pathExists`, optional `isDirectory`) is injected by callers; `src/domains/agents/result-contract-filesystem.ts` (`nodeResultContractFilesystem`) is the one live-disk implementation, shared by the worker and the orchestrator so a capability added to the interface lands in both.

### Fleet contracts

`src/domains/agents/playbook.ts` defines:

- `FleetContract` with `version: 1|2|3|4|5`, `steps`, `maxWorkers`, `budgetUsd`, `onFailure`, optional `writers: 1`, `body`, and `path`.
- `FleetContractStep`: a discriminated union of `agent`, `code`, `loop`, `gate`, and `plan` steps.
- `FLEET_WRITE_BOUNDARY_VERSION = 4`: the version at which `writes` boundaries are declared and enforced.
- `FLEET_DYNAMIC_STEP_VERSION = 5`: the version that adds `target`/`profile` routing, `plan` steps, `gate` steps, and the `writers` literal.
- `FLEET_LOOP_MAX_ATTEMPTS = 5`: the upper bound on any declared loop.
- `parseFleetContract(raw, sourcePath)`: the structural parser that validates the front matter against a version-specific TypeBox schema, then runs `validateFleetGraph` and `validateWriteBoundaries`.
- `validateFleetGraph(contract)`: rejects duplicate or colliding ids, dangling dependencies, self-reference, cycles (Kahn's algorithm), and a `commitFrom` source that the commit step does not depend on.
- `fleetStepWriteBoundary(version, scope, writes)`: returns `undefined` for versions below 4, `[]` for `readonly`, and the normalized allowlist otherwise.
- `fleetStepBoundaries(contract)`: every position a contract runs, including both halves of every loop.
- `renderFleetPrompt(body, vars)`: strict `{{var}}` rendering; every placeholder must resolve or the run fails before any dispatch.
- `loadFleetContract(cwd, name)` / `listFleetContracts(cwd)`: discovery from builtin, plugin, user, and project roots, with project files shadowing builtins of the same name.

`src/domains/agents/playbook-commands.ts` defines the `FleetCommandRegistry` and:

- `parseFleetCommands(raw, sourcePath)`: validates the YAML registry against a TypeBox schema.
- `loadFleetCommands(cwd)`: returns the registry or `null` when the repo declares none; `null` is a distinct answer from an empty registry.
- `validateFleetCommandArgs(command, args, options)`: enforces operator-declared `argumentSlots`; contracts cannot append flags or executable code.
- `FLEET_COMMAND_BASE_ENV`: the closed environment variables every registered command receives (`PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`).

### Write boundary

`src/domains/agents/write-boundary.ts` is a thin re-export of `src/core/path-boundary.ts` that gives the agents domain its own naming for the declared write boundary. `WRITE_BOUNDARY_MAX_ENTRIES` caps the allowlist. `normalizeWriteBoundary` collapses duplicates and sorts. `writeBoundaryCovers` answers whether a boundary permits a change to one repo-relative path. The enforcement half lives in `src/domains/dispatch/write-boundary.ts`, because deciding what a step was allowed to write is contract policy and observing what it did write is a property of the checkout.

## How data flows through a caller

### Recipe discovery to dispatch admission

The flow from a user's `dispatch` tool call to a worker run is:

1. **CLI / orchestrator loads the domain.** `src/cli/agents.ts` (`runAgentsCommand`) calls `loadDomains([ConfigDomainModule, SafetyDomainModule, AgentsDomainModule])` and then reads `AgentsContract.listSpecs()`. The orchestrator (`src/entry/orchestrator.ts`) does the same and uses `renderAgentCatalogSectionsFromSpecs` to inject the fleet roster into the system prompt.

2. **Dispatch extension resolves the recipe.** `src/domains/dispatch/extension.ts` calls `agents.get(req.agentId)` and throws `dispatch: unknown agent recipe: <id>` if the id is not in the catalog. The resolved `AgentRecipe` is passed to `resolveDispatchTarget` to pick a model endpoint.

3. **Recipe is normalized to a spec.** `normalizeAgentSpec(recipe)` in `spec.ts` flattens `toolRequirements` into `tools` and validates that every declared tool has required/optional semantics. `assertAgentSpecPolicy` runs at discovery time, not at dispatch time, so a recipe that enters the catalog is already policy-clean.

4. **Result contract is attached to the worker spec.** The recipe's `resultContract` is parsed by `parseResultContract` at discovery time and carried into the `WorkerSpec`. At dispatch time, the coordinator may override it with `parseWorkerResultContract`, which admits coordinator-authored kinds like `council-ballot`.

5. **The worker's terminal output is validated.** After the worker run completes, `validateRecipeResult` is called with the contract, the output, and a `ResultContractFilesystem` (usually `nodeResultContractFilesystem`). The validator returns a `RecipeResultOutcome` that carries a `ResultContractFact` for the receipt. If the result fails, `resultContractRepairMessages` produces a synthetic tool exchange that quotes the validator's reason and the exact shape, and the worker gets up to `RESULT_CONTRACT_REPAIR_LIMIT` (2) repair rounds.

### Catalog rendering to the session prompt

`renderFleetPromptSection` in `src/domains/agents/catalog.ts` takes an array of `AgentSpec` values and:

- Sorts them by `category` then `id`.
- Splits them into `publicSpecs` (user-visible: `base` or `custom` audience) and `shadowSpecs` (dispatchable but not `/run` suggestions, excluding `oracle`).
- Renders a compact roster with the `FLEET_HANDOFF_RULE`, `FLEET_ANTI_CHURN_RULE`, `FLEET_REFUSAL_DISCLOSURE`, and `FLEET_SPECIALIST_ROUTING` rules.
- Returns a byte-stable string so the prompt prefix does not churn between turns.

### Fleet contract to plan execution

`listFleetContracts(cwd)` discovers fleet contracts from builtin (`src/domains/agents/playbooks/*.md`), plugin, user (`~/.config/clio-coder/fleets/*.md`), and project (`.clio-coder/fleets/*.md`) roots. Project files shadow builtins of the same name. Each contract is parsed by `parseFleetContract`, which:

- Reads the version literal and selects the matching TypeBox schema.
- Runs `assertNoWritesBefore` (version < 4), `assertNoV5FieldsBefore` (version < 5), and `assertNoGateWrites` (version >= 5) to refuse newer keys in older contracts.
- Validates the front matter against the schema.
- Normalizes each step via `normalizeStep`, which converts a `loop` step into its unrolled check/repair halves.
- Runs `validateFleetGraph` (cycle detection, id collision, dependency closure) and `validateWriteBoundaries` (version >= 4).
- Binds code-step command ids against the repository's command registry via `validateFleetCommands`.

`renderFleetPrompt` then renders the body with strict `{{var}}` substitution; an unresolved placeholder throws with the full list of missing names.

## Enforced boundaries and lifecycle ordering

### Capability-to-tool policy

`agentSpecPolicyErrors` in `spec.ts` enforces a strict mapping between `capabilityClass` and the tools a recipe declares:

- `workspace-edit` must require `read` and a mutation tool (`write` or `edit`).
- `verification` must require `verify` and must not request `write`, `dispatch`, `system_modify`, `git_destructive`, or `bash`.
- `artifact-write` must require `artifact` and may only write terminal artifacts; it must not request `execute`, `dispatch`, `system_modify`, `git_destructive`, or any `write` tool other than `artifact`.
- `read-only` must not request any tool whose action class is not `read`.
- A non-`orchestration` agent that declares `dispatch` fails policy.
- An agent that declares `ask_user` fails policy (`ask_user` is only available to the orchestrator).
- An agent that declares `skills` but does not expose `context` fails policy.

### Write boundary enforcement

A fleet contract below version 4 has no write-boundary claim; `fleetStepWriteBoundary` returns `undefined`. At version 4 and above, every `workspace` step must declare a non-empty `writes` allowlist, and `readonly` is the empty allowlist stated out loud. `validateWriteBoundaries` rejects a `workspace` step with no `writes` and a `readonly` step with `writes` declared. The enforcement half (observing what a step actually wrote) lives in `src/domains/dispatch/write-boundary.ts`.

### Result contract repair limit

`RESULT_CONTRACT_REPAIR_LIMIT = 2` in `result-contract.ts` is the whole allowance for a worker's terminal result to miss its contract. A repair round is a synthetic tool exchange: a synthetic assistant call to `result_contract` and a tool result that answers it, sharing the id `clio-result-contract-repair-N`. The assistant half carries explicit zero usage so the pi-ai context estimator does not throw on the next round.

### Fleet loop bound

`FLEET_LOOP_MAX_ATTEMPTS = 5` is the upper bound on any declared loop. A loop compiles to statically unrolled, conditionally executed plan nodes, so the execution plan stays a deterministic hashed DAG and every attempt keeps its own receipt. `maxAttempts` is the number of verifications, so the loop dispatches at most `maxAttempts - 1` repairs.

## Extension seams

### Adding a new worker recipe

A new builtin recipe goes in `src/domains/agents/builtins/<id>.md`. The id is the filename without `.md`. The front matter must satisfy `RECIPE_KEYS` and the `audience` rules: a builtin recipe may declare `base`, `shadow`, or `internal` (never `custom`). The recipe's `resultContract` must be a kind that `parseResultContract` admits (coordinator-authored kinds like `council-ballot` are rejected). The recipe's `tools` must satisfy the capability-to-tool policy in `agentSpecPolicyErrors`.

A user or project recipe goes in `~/.config/clio-coder/agents/<id>.md` or `.clio-coder/agents/<id>.md`. It must declare `audience: custom` and cannot use a reserved id (`worker`, `delegate`, `auto`). It is quarantined with a structured diagnostic on parse or policy failure; builtin defects abort discovery.

### Adding a new result contract kind

A new kind is added to the `ResultContract` union in `result-contract.ts`, a new case is added to `validateResultContract`, and the kind is added to `RECIPE_DECLARABLE_KINDS` (if a recipe may declare it) or `COORDINATOR_AUTHORED_KINDS` (if only the coordinator may author it). The repair shape is added to `resultContractShape`. The `resultContractOutputBytes` function must be updated if the kind carries a sealed-output bound.

### Adding a new fleet contract step kind

A new step kind is added to the `FleetContractStep` union in `fleet-contract.ts`, a new schema is added to `stepSchema`, and the kind is handled in `normalizeStep`. The new kind must be validated by `validateFleetGraph` and `validateWriteBoundaries`. The fleet version must be bumped to a new literal (1|2|3|4|5) because the difference between versions is not cosmetic: a reader that does not understand the new kind must refuse the whole contract rather than run a partial DAG.

### Adding a new fleet command

A new command is declared in `.clio-coder/fleets/commands.yaml` under the `commands:` key with an `argv` list, optional `argumentSlots`, `cwd`, `timeoutMs`, and `env`. The command id must match `/^[a-z0-9][a-z0-9._-]{0,63}$/u`. The `env` list must contain only variable names matching `/^[A-Z_][A-Z0-9_]*$/u`. The command is validated against the TypeBox schema in `parseFleetCommands`.

## Named focused tests and what they demonstrate

### `tests/contracts/worker-boundary.test.ts`

This test imports `parseAgentRecipeSchema`, `normalizeAgentSpec`, `resolveAgentToolCompatibility`, and `parseCodeReport` directly. It demonstrates:

- **Strict recipe parsing.** A recipe with `audience: custom`, `capabilityClass: verification`, `tools: {required: ["read", {anyOf: ["grep", "find"]}], optional: ["verify"]}`, `budget: {toolCalls: 8, readReserve: 2, synthesis: true}`, and `resultContract: {kind: "verifier-report"}` parses successfully. The flattened `tools` array is `["read", "grep", "find", "verify"]`.
- **Tool compatibility resolution.** `resolveAgentToolCompatibility(spec, ["read", "find"], {mediatesDispatch: true})` returns `{compatible: true, missingRequired: [], lostOptional: ["verify"]}`. With only `["read"]` available, it returns `{compatible: false, missingRequired: ["anyOf(grep|find)"], lostOptional: ["verify"]}`.
- **Unknown key rejection.** A recipe with `forbiddenRoutingHint: "model-x"` in front matter throws `/unknown key|is required/`.
- **Code report round-trip.** `parseCodeReport` accepts a fenced JSON code report with `passed: true, exitCode: 0, checks: [{name, passed, evidence}]`, `artifactPaths`, and `outputExcerpt`, and rejects one where `exitCode` disagrees with `passed`.

### `tests/contracts/dispatch-admission.test.ts`

This test imports `AgentsContract` and uses `assessCapabilityMismatch` from `src/domains/dispatch/capability-match.ts`. It demonstrates:

- **Capability mismatch refusal.** A pinned `verifier` (capabilityClass `verification`) for a mutation task is refused, with `suggestedAgentId: "coder"`. A `coder` (capabilityClass `workspace-edit`) for the same task with `resultContractKind: "mutation-report"` is admitted.
- **Scout investigation wording.** Scout (capabilityClass `read-only`) is admitted for investigation tasks like "Find where to add environment awareness" but refused for "Add environment awareness to the config loader" or "Write the report to disk".

### `tests/contracts/scout-grep-grounding.test.ts`

This test runs a live Scout worker run with `resultContract: {kind: "scout-report"}` and demonstrates:

- **Citation grounding.** A Scout that cites the line a `grep` match showed it (line 6 of `overlays.ts`) is accepted without a repair round. The `clio_coder_helper_result` event carries the finding with `line: 6`.
- **Ungrounded citation rejection.** A Scout that cites a line the `grep` did not show (line 2) fails grounding. After two repair rounds, the run exits with code 1 and `outcomeCode: "result_contract_exhausted"`, with a detail message naming the file, the cited line, and the read ranges the run actually used (`this run read only 6-6, 7-7`).

## Things to watch when editing

- **The `audience` field is provenance, not a claim.** A discovered recipe declaring `shadow` or `internal` would hide itself from `clio-coder agents` while staying reachable by internal orchestration, and one declaring `base` would present itself as shipped. The declaration is rejected rather than coerced, because a recipe whose audience was quietly rewritten is a recipe whose author still believes it is hidden. Do not relax `parseAudience` in `recipe-schema.ts`.

- **The `writes` key on a fleet step is a version-dependent claim.** A version-3 contract's `workspace` step means the whole checkout. Turning that into "the run fails if anything else changes" under a repo that never asked for it would break working pipelines on an upgrade. Do not add `writes` to the version-3 schema; it must be version 4 or later. Do not allow a `readonly` step to declare `writes`; that is the empty allowlist stated out loud.

- **The result contract's repair shape is the single source of truth.** `resultContractShape` in `result-contract.ts` is the one place a contract's wire example is written. Agent recipes, repair rounds, and a fleet node's own answer directive all cite it, so a prompt cannot drift from its validator. If you change a recipe's persona prompt to describe the result shape, you must also change `resultContractShape`.

- **The `dispatch` tool is orchestration-only.** A non-`orchestration` agent that declares `dispatch` fails policy. The `resolveAgentToolCompatibility` function also checks `mediatesDispatch`: if the available tools include `dispatch` but the orchestrator does not mediate dispatch, the agent is incompatible. This is the only place the runtime mediation check happens.

- **The `code-report` and `council-ballot` kinds are coordinator-authored.** They may not be declared by a recipe. `parseResultContract` rejects them; `parseWorkerResultContract` admits them. If a recipe declares one, it fails discovery. Do not add them to `RECIPE_DECLARABLE_KINDS`.

- **The `FLEET_LOOP_MAX_ATTEMPTS` bound is deliberate.** Five attempts already costs five verifications and four repair dispatches, and a workflow that needs more than that is not converging. Do not increase it without a corresponding change to the repair loop's cost model.

- **The `FLEET_COMMAND_BASE_ENV` is a closed list.** A command that genuinely needs one more variable names it in `env`. Do not add new base variables without updating the documentation and the tests that verify the environment is closed.

- **The `nodeResultContractFilesystem` is shared by the worker and the orchestrator.** A capability added to `ResultContractFilesystem` (like `isDirectory`) must be added to `nodeResultContractFilesystem` so both callers see it. If a capability is added to the interface and only to one of the implementations, a Scout citation could ground inside the worker's repair rounds and fail the orchestrator's sealed revalidation of the identical result.

- **The `agentSpecFingerprint` excludes display-only metadata.** A display-only edit (`name`, `description`, `category`, `tags`, `source`, `filepath`) must not invalidate measured history. Do not add display-only fields to the fingerprint payload.

- **The `RESERVED_CUSTOM_AGENT_IDS` set protects the dispatch protocol.** `worker`, `delegate`, and `auto` are reserved because they are ids the dispatch tool uses for special routing. A custom recipe with one of these ids is ignored at merge time. Do not add to this set without updating the dispatch tool's routing logic.

- **The `validateFleetGraph` cycle check uses Kahn's algorithm over declared steps only.** Loop members are internal and linear, so a contract-level cycle can only run through declared edges. Do not add a new step kind that can introduce a cycle without updating this check.

- **The `fleetStepBoundaries` function expands loops into their check/repair halves.** A loop's check is named `<loop>.check` and its repair is named `<loop>.repair`. A gate step inside a loop is named `<loop>.check` and has scope `workspace` with the gate's path as its write boundary. Do not rename these ids without updating the dispatch extension's plan-node lookup.

<!-- clio-coder:wiki unresolved sources: src/domains/agents/builtins/*.md, src/domains/agents/playbooks/*.md, src/domains/agents/builtins/<id>.md -->
