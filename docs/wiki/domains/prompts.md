---
title: "Prompt Compiler"
summary: "How prompt fragments are loaded from disk, compiled into a stable system prompt, and cached for prefix reuse."
sources:
  - "src/domains/prompts/compiler.ts"
  - "src/domains/prompts/fragment-loader.ts"
  - "src/domains/prompts/extension.ts"
  - "src/domains/prompts/contract.ts"
  - "src/domains/prompts/hash.ts"
  - "src/domains/prompts/preload.ts"
  - "src/domains/prompts/memory-intervention.ts"
  - "src/domains/prompts/index.ts"
symbols:
  - "compile"
  - "compileWorker"
  - "loadFragments"
  - "createPromptsBundle"
  - "selectProjectPreload"
  - "canonicalToolPromptHints"
  - "canonicalJson"
  - "sha256"
tests:
  - "tests/contracts/self-knowledge-prompt.test.ts"
  - "tests/contracts/headless-approval-prompt.test.ts"
  - "tests/contracts/gateway-prompt.test.ts"
  - "tests/contracts/prompt-skill-policy.test.ts"
  - "tests/extended/prompt-cache-correctness.test.ts"
invariants:
  - "Fragment ids are dot-separated namespaces validated at load time; duplicate ids throw."
  - "The compiled system prompt is byte-for-byte reproducible for identical inputs; `canonicalJson` sorts object keys recursively and drops undefined values."
  - "The stable prefix (identity + operating contract) survives changes to any runtime input, as measured by `stablePrefix.bytes` and `stablePrefix.hash`."
  - "Worker persona must be a stable fragment; `compileWorker` throws on `persona.dynamic === true` or an empty persona body."
validate:
  - "pnpm run test:file -- tests/contracts/self-knowledge-prompt.test.ts"
  - "pnpm run test:file -- tests/contracts/headless-approval-prompt.test.ts"
  - "pnpm run test:file -- tests/contracts/gateway-prompt.test.ts"
---

# Prompt Compiler

## What this area does

The prompts domain compiles the system prompt for every session and fleet worker. It reads markdown fragments from `src/domains/prompts/fragments/**` at startup, validates them, and assembles a deterministic, layered system prompt from disk content plus typed runtime inputs. The compiler separates immutable identity and contract text from volatile runtime guidance so that a local model's prefix cache survives changes to model, autonomy, tool surface, or memory.

The domain owns three responsibilities:

1. **Fragment loading and validation** — `loadFragments` walks `src/domains/prompts/fragments/**/*.md`, parses YAML frontmatter, rejects duplicate ids and malformed fragments, and returns a `FragmentTable` keyed by fragment id.
2. **Layered prompt assembly** — `compile` (session) and `compileWorker` (fleet worker) render fragments into ordered sections, compute a SHA-256 hash of the final text, and return a `CompiledSessionPrompt` with per-section token estimates and a flat fragment manifest.
3. **Session-source snapshotting** — `createPromptsBundle` in `extension.ts` captures a per-session snapshot of project context, customization rules, workspace root, and Clio repo awareness. This snapshot freezes the disk-input inputs so that recompile cycles caused by runtime changes (turn scope, skill inventory) still read from the same project sources.

The `memory-intervention.ts` module is a separate prompt for the memory intervention sub-agent: it defines the system prompt that instructs a small model to write memory notes and occasionally pass a reminder back to the action agent. It is not part of the main session prompt compilation pipeline.

## Source ownership and key symbols

| File | Key symbols | Role |
|---|---|---|
| `src/domains/prompts/compiler.ts` | `compile`, `compileWorker`, `SESSION_PROMPT_SECTION_ORDER`, `canonicalToolPromptHints`, `renderToolContractBlock`, `renderWorkerToolContractBlock`, `workerSafetyOneLiner` | Pure compiler: fragments + typed inputs → `CompiledSessionPrompt` |
| `src/domains/prompts/fragment-loader.ts` | `loadFragments`, `parseFragment`, `walk`, `fragmentIdRegex` | Disk I/O, YAML frontmatter parsing, id validation |
| `src/domains/prompts/extension.ts` | `createPromptsBundle`, `captureSessionSourceSnapshot`, `sessionSourceSnapshot`, `invalidateSessionSources`, `renderCustomizationFragments`, `workspaceRootFragment`, `clioRepoAwarenessFragments`, `selfDevelopmentSkillFragments` | Domain bundle: lifecycle, snapshot cache, customization rendering |
| `src/domains/prompts/contract.ts` | `PromptsContract`, `CompileSessionPromptInput`, `CompileWorkerPromptInput` | Public interface consumed by session and dispatch domains |
| `src/domains/prompts/hash.ts` | `sha256`, `canonicalJson` | Single hash primitive and deterministic JSON serialization |
| `src/domains/prompts/preload.ts` | `selectProjectPreload`, `FULL_PROJECT_CONTEXT_MAX_CHARS`, `FULL_PROJECT_CONTEXT_MAX_LINES`, `ProjectPreloadClass` | Project context budgeting and partial-preload classification |
| `src/domains/prompts/preload-prefix.ts` | `safePrefixOffsets`, `sourceLineCount` | Conservative block boundaries for partial preload |
| `src/domains/prompts/index.ts` | `createPromptsDomainModule` | Entry point that wires the extension factory |
| `src/domains/prompts/manifest.ts` | `PromptsManifest` | Domain manifest declaring dependencies on config, context, resources, agents |
| `src/domains/prompts/memory-intervention.ts` | `MEMORY_INTERVENTION_SYSTEM_PROMPT`, `buildMemoryInterventionUserPrompt` | Separate system prompt for the memory intervention agent |

## Fragment loading

`loadFragments` (`src/domains/prompts/fragment-loader.ts:122`) resolves the default root to `src/domains/prompts/fragments` relative to the package root via `resolvePackageRoot()`. It then recursively walks directories with `readdirSync` and collects `.md` files in lexicographic order.

Each file is parsed by `parseFragment` (`src/domains/prompts/fragment-loader.ts:59`):

- **Frontmatter regex** matches `---\n...\n---\nbody`. A missing or malformed frontmatter throws `fragment-loader: <relPath>: missing or malformed YAML frontmatter`.
- **YAML parsing** uses the `yaml` package; parse failures throw with the error message.
- **Validation**: `id` must match `/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/` (dotted namespace), `version` must be `1`, `description` must be a non-empty string, and `dynamic` must be a boolean when present.
- **Content hash**: `sha256(raw)` of the entire file content, used as the reproducibility seed.

The returned `FragmentTable` is a map from fragment id to `LoadedFragment`. Duplicate ids throw: `fragment-loader: duplicate fragment id "<id>" in <relPath1> and <relPath2>`.

Fragment files are organized under `src/domains/prompts/fragments/` in subdirectories:

- `identity/` — `clio.md` (main session identity), `clio-worker.md` (worker identity), `self-awareness.md` (Clio's self-knowledge), `docs-routing.md`, `settings-routing.md`
- `operating/` — `contract.md` (shared operating contract), `delegation.md` (fleet delegation rules), `skills.md` (skill activation policy), `worker.md` (worker-specific contract)
- `safety/` — `default.md`, `yolo.md` (autonomy level fragments)
- `dispatch/` — `read-only.md` (dispatch read-only restriction)

## Compilation: session prompt

`compile(table, inputs)` in `src/domains/prompts/compiler.ts` is the core pure function. It takes a `FragmentTable` and `CompileInputs` and returns a `CompiledSessionPrompt`.

### Section order

The volatility order is `SESSION_PROMPT_SECTION_ORDER`: `identity`, `operating-contract`, `delegation`, `skills`, `safety`, `tool-contract`, `fleet`, `retrieval-hints`, `project-context`, `harness-awareness`, `memory`, `runtime`. A legacy order (`LEGACY_SESSION_PROMPT_SECTION_ORDER`) is exported for test purposes only; nothing in `src/` passes `sectionOrder: "legacy-0.3.8"`.

The volatility rule: sections earlier in the order are more stable across runtime inputs. Identity and the operating contract are the most stable; the tool contract and runtime block are the most volatile.

### Section rendering

Each section is rendered by a dedicated function:

- **Identity**: renders `identity.clio` fragment body, plus `identity.self-awareness` with `{CLIO_DOCS_PATH}`, `{CLIO_SRC_PATH}`, `{CLIO_CODEWIKI_PATH}`, `{CLIO_SETTINGS_PATH}`, and `{CLIO_STATE_PATH}` placeholders substituted via `resolvePackageRoot()` and `resolveClioDirs()`. The self-awareness block also includes `identity.docs-routing` (when gateway is on the surface and `clio_docs` is allowed) and `identity.settings-routing` (when `context` is on the surface), with `{SETTINGS_CHANGE_POLICY}` substituted based on autonomy level and `canConfigureClio`.
- **Operating contract**: `operating.contract` body plus optional `DEMO_GUIDANCE` when `sessionInputs.demo` is true.
- **Delegation**: `operating.delegation` fragment, rendered only when `sessionCanDispatch` is true (gateway is on the surface, `dispatch` tool is allowed, provider supports tools).
- **Skills**: `operating.skills` fragment with `{SKILL_ACTIVATION_POLICY}` substituted based on `modelMayActivateSkills()` and autonomy level.
- **Safety**: `renderSafetySection` renders `Autonomy: <level>. <one-liner>` plus the safety fragment body. The approval semantics sentence is `SESSION_APPROVAL_SEMANTICS` for attached sessions or `HEADLESS_SESSION_APPROVAL_SEMANTICS` for headless runs.
- **Tool contract**: `renderToolContractBlock` renders the `# Tool Contract` heading, `TOOL_RESULT_TRUST_CONTRACT`, the direct tool surface list, capability kind explanations, inventory guidance, and per-tool hints sorted by tool name.
- **Fleet**: `renderFleetBlock` returns the fleet roster string when `sessionCanDispatch` is true and mode is not `answer`.
- **Retrieval hints**: static guidance about what is and is not preloaded.
- **Project context**: `renderProjectBlock` returns the project context files text.
- **Harness awareness**: the self-awareness block described above.
- **Memory**: `renderMemoryBlock` deduplicates the `# Memory` header — if the input already starts with a Memory heading, it is not re-prepended.
- **Runtime**: `renderRuntimeBlock` renders provider, model, context window, and thinking guidance.

### Additional fragments

`compile` appends `inputs.additionalFragments` after the main sections but before the turn scope. These are rendered inline fragments from the extension (workspace root, Clio repo awareness, self-development skills, project rules, operator profile).

### Turn scope

`renderTurnGuidance` renders the current task scope from `turnConstraints`. This is the most volatile section and is pushed last.

### Stable prefix

`prefixIdentity(identity, contract)` computes the UTF-8 byte length and SHA-256 of the identity and operating contract concatenated. This is returned as `stablePrefix` in the `CompiledSessionPrompt`. The test in `tests/contracts/prompt-skill-policy.test.ts` verifies that switching autonomy from `default` to `yolo` changes the system prompt hash but restores the identical prompt on switch-back, confirming determinism.

## Compilation: worker prompt

`compileWorker(table, inputs)` in `src/domains/prompts/compiler.ts` compiles the canonical stable prompt for a fleet worker. Key differences from session compilation:

- **Section order** is fixed: `identity`, `operating-contract`, `tool-contract`, `safety`, optional `dispatch.read-only`, `persona`, additional fragments, `turn-scope`.
- **Identity**: `identity.clio-coder-worker` fragment.
- **Operating contract**: `renderWorkerOperatingContract` concatenates `operating.contract`, `operating.worker`, and `WORKER_CLAIM_GUIDANCE` (the worker-side mirror of the parent's spot-check guidance).
- **Tool contract**: `renderWorkerToolContractBlock` handles three cases: `providerSupportsTools === false` (no tools), `providerSupportsTools === null` (unknown inventory), and normal (canonical tool names and hints).
- **Safety**: `renderWorkerSafetySection` uses `workerSafetyOneLiner` which always says "workspace edits and recognized commands run; other commands require approval" plus the permission routing sentence from `workerPermissionSentence`.
- **Read-only**: `dispatch.read-only` fragment is included when `inputs.readOnly === true`.
- **Persona**: the worker's persona fragment, which must be stable (`persona.dynamic === false`) and non-empty.

### Worker validation guards

`compileWorker` throws on:
- `persona.dynamic === true` — the worker persona must be a stable fragment
- `persona.body.trim().length === 0` — the persona must not be empty
- `hasCanonicalContext !== contextIsAttached` — the caller must match the actual attached tool surface
- `hasBoundSkills === true && hasCanonicalContext === false` — bound skills require canonical context

## The contract and domain bundle

`PromptsContract` (`src/domains/prompts/contract.ts`) exposes three methods:

- `inputEpoch()` — returns a string combining the fragment epoch, agents domain revision, and session source epoch. This is used by the prompt cache to detect when a recompile is required.
- `compileSessionPrompt(input)` — compiles the session prompt with project context, fleet roster, and customization fragments.
- `compileWorkerPrompt(input)` — compiles the worker prompt and returns `rulesApplied` and `operatorProfileApplied` provenance.

`createPromptsBundle` (`src/domains/prompts/extension.ts:57`) creates the domain bundle. Its lifecycle:

1. **`start()`** — calls `loadFragments()` and sets `fragmentEpoch`. Subscribes to `ContextSourcesChanged` (invalidates session sources for the given cwd), `ConfigHotReload` (invalidates all session sources, reloads fragments if the diff touches prompt files), and `PluginsReloaded` (reloads fragments).
2. **`stop()`** — unsubscribes all handlers and clears session source snapshots.

### Session source snapshot

`sessionSourceSnapshot(sessionId, cwd)` captures and caches a snapshot per `(sessionId, cwd)` pair. The snapshot includes:

- **Project context** — from `contextDomain().renderPromptContext(cwd)`, unless `--no-context-files` is set.
- **Customization** — project rules from `.clio-coder/rules/**` and the operator profile.
- **Workspace root** — absolute path, OS account, hostname.
- **Clio repo awareness** — whether the workspace is Clio's own source tree.

The snapshot is invalidated by `invalidateSessionSources(cwd)`:
- `cwd === undefined` clears all snapshots.
- `cwd` specified: only snapshots for descendant workspaces (relative to the given cwd) are deleted. Ancestor handbooks are layered into descendant sessions, including sessions captured before the ancestor had a handbook.

### Customization fragments

`renderCustomizationFragments` renders project rules and the operator profile into inline `RenderedPromptFragment` objects:

- **Project rules**: `selectActiveRules` selects rules from the project's `.clio-coder/rules/**` that apply to the current working context. Unconditional rules load with project context; path-scoped rules activate when a matching file is in working context.
- **Operator profile**: `renderOperatorProfile` renders the operator's custom profile.

Both are best-effort: load failures inject nothing.

## Project preload

`selectProjectPreload` (`src/domains/prompts/preload.ts`) selects how much project context to include in the prompt:

- **Full preload**: the entire project context fits within `FULL_PROJECT_CONTEXT_MAX_CHARS` (24,000 UTF-16 code units) and `FULL_PROJECT_CONTEXT_MAX_LINES` (220 lines).
- **Partial preload**: the context exceeds the budget. The function allocates excerpts from the nearest handbook first, using `safePrefixOffsets` to find conservative block boundaries (respecting code fences). It includes a `<project-preload>` header explaining which lines are omitted and how to read them.
- **None**: the context is empty.

The `ProjectPreloadClass` tracks mode, included vs. available characters and lines, per-source coverage, and whether the provider supports tools (for the retrieval guidance text).

## Hash and canonical JSON

`sha256` (`src/domains/prompts/hash.ts`) is the single hash primitive. `canonicalJson` provides deterministic JSON serialization: object keys are sorted recursively, arrays preserve element order, `undefined` values in objects are dropped, and non-finite numbers and symbols throw. This ensures that any structural input (fragment manifests, rendered prompt text) lands on a byte-identical hash whenever the underlying content is equivalent.

## Control flow through a real caller

The upstream caller is `src/interactive/turn-context.ts`, which calls `deps.prompts.compileSessionPrompt` via `ensureSessionPrompt`. The flow:

1. **Turn context** builds a `CompileSessionPromptInput` with `sessionId`, `sessionInputs` (provider, model, tool surface, constraints, etc.), `autonomy`, and `cwd`.
2. **`createPromptsBundle.compileSessionPrompt`** resolves the session source snapshot, selects project preload, renders fleet roster, and calls `compile` with `additionalFragments` from the snapshot.
3. **`compile`** renders all sections in `SESSION_PROMPT_SECTION_ORDER`, computes the system prompt hash, and returns the `CompiledSessionPrompt`.

The downstream dependency is the Pi SDK, which consumes the `systemPrompt` string and the attached tool schemas. The prompts domain never imports Pi SDK types; it exports erased shapes through `CompiledSessionPrompt`.

Another upstream caller is `src/domains/dispatch/extension.ts`, which calls `prompts.compileWorkerPrompt` to compile each fleet worker's system prompt.

## Enforced boundaries and lifecycle

### Fragment loading boundary

`loadFragments` throws on duplicate ids and malformed fragments. The `FragmentTable` is immutable once loaded. The extension's `reload()` function (triggered by `ConfigHotReload` when the diff touches `prompt` or `fragment` paths, or by `PluginsReloaded`) reloads fragments and increments `fragmentEpoch`, which changes `inputEpoch()` and forces a recompile on the next turn.

### Snapshot lifecycle

The session source snapshot is frozen at first capture. Subsequent `compileSessionPrompt` calls with the same `sessionId` and `cwd` read from the cached snapshot, even if project context has changed on disk. This is intentional: the snapshot freezes the disk-input inputs so that runtime recompile cycles (turn scope changes, skill inventory changes) do not re-read project files. The snapshot is invalidated only by:
- `ContextSourcesChanged` bus event (explicit context operation in the workspace or an ancestor)
- `ConfigHotReload` (config invalidation)
- A new session

### Worker persona stability

`compileWorker` enforces that the worker persona is a stable fragment (`persona.dynamic === false`). This prevents the worker's system prompt from containing dynamic content that would change the prompt between dispatches, breaking prefix caching for the worker model.

### Byte-for-byte reproducibility

The compiler ensures byte-for-byte reproducibility through:
- **Deterministic section order** (`SESSION_PROMPT_SECTION_ORDER`)
- **Sorted tool names** (`canonicalWorkerTools`, `capabilityNames.sort()`)
- **Sorted and deduplicated tool hints** (`canonicalToolPromptHints` sorts by tool name and hint text, then deduplicates)
- **`canonicalJson`** for any structural serialization
- **`sha256`** for content hashing

The test in `tests/contracts/prompt-skill-policy.test.ts` verifies that switching autonomy from `default` to `yolo` changes the system prompt hash but restores the identical prompt on switch-back, confirming determinism.

## Extension seams

### Adding a new fragment

New fragments are added as markdown files under `src/domains/prompts/fragments/**` with YAML frontmatter:

```markdown
---
id: namespace.fragment
version: 1
description: One-line description
dynamic: false
---
Fragment body here.
```

The `id` must be a dot-separated namespace (e.g., `identity.clio`, `safety.default`). The `dynamic` flag defaults to `false`; set it to `true` for fragments whose content changes at runtime (these cannot be used as worker personas).

The fragment is loaded at startup by `loadFragments` and becomes available to the compiler by its `id`. The compiler references fragments by id in `lookupFragment`, which throws if the id is not found.

### Adding a new section

New sections are added by:
1. Adding the section id to `SESSION_PROMPT_SECTION_ORDER` in `src/domains/prompts/compiler.ts`.
2. Rendering the section content in the `compile` function's `rendered` map.
3. Calling `push(sectionId, content)` in the order loop.

The volatility rule governs placement: more stable sections go earlier in the order.

### Customization extension

Project rules and the operator profile are rendered by `renderCustomizationFragments` in `src/domains/prompts/extension.ts`. New customization sources are added by extending `captureCustomizationSources` and `renderCustomizationFragments`. The result includes `activeRuleIds` and `operatorProfileApplied` provenance, which dispatch reads for receipt accounting.

### Memory intervention

The memory intervention prompt is a separate concern from the main session prompt. `MEMORY_INTERVENTION_SYSTEM_PROMPT` in `src/domains/prompts/memory-intervention.ts` is a static string that defines the behavior of the memory intervention sub-agent. It is not loaded from fragments and is not part of the `FragmentTable`.

## Focused tests

### `tests/contracts/self-knowledge-prompt.test.ts`

Tests that the prompt points to Clio's self-knowledge sources (live settings, bundled docs, code map) whenever the tool that reaches them is on the surface. Key cases:

- `points settings questions at the live snapshot whenever context is on the surface` — verifies that `context(scope="settings")` appears when `context` is on the tool surface, regardless of skill discovery or turn constraints.
- `teaches the configure_clio preview only where the tool is registered and autonomy lets it run` — verifies that the `configure_clio` preview sentence appears only when `canConfigureClio` is true and autonomy is `default` or `yolo`, and that the sentence text differs between autonomy levels.
- `names the shipped code map and never routes to the removed docs scope` — verifies that the compiled prompt references `dist/assets/codewiki.json` and does not contain unsubstituted `{CLIO_*}` placeholders.

### `tests/contracts/headless-approval-prompt.test.ts`

Tests that a headless `clio-coder run` denies approval asks instead of pausing. Key cases:

- `tells a headless session at <level> that approval-required calls are denied` — verifies that `HEADLESS_SESSION_APPROVAL_SEMANTICS` appears in the safety section when `headless: true`, and that `SESSION_APPROVAL_SEMANTICS` does not.
- `keeps the operator-confirmation sentence for an attached session at <level>` — verifies the reverse.
- `marks the session inputs headless only when the entry says so` — verifies that the `headless` flag is threaded from the turn context into the compiled session inputs.

### `tests/contracts/gateway-prompt.test.ts`

Tests that gateway-dependent guidance is gated on the tool surface. Key cases:

- `gates documentation and skill catalog guidance for <surface>` — verifies that Clio documentation routing and skill catalog guidance appear only when gateway and/or context are on the surface, and that the retired `context(scope="docs")` and `context(scope="library")` calls never appear.
- `lists the direct surface, points tool usage at the gateway, and shrinks the attached schema bytes` — verifies the attached-schema budget and that the gateway schema stays small.

### `tests/contracts/prompt-skill-policy.test.ts`

Tests that compiled skill instructions agree with actual session-skill admission. Key cases:

- `compiled skill instructions agree with actual session-skill admission at <level>` — verifies that the skill activation policy text in the prompt matches whether `modelMayActivateSkills()` allows activation, and that the `context(scope="skills")` call appears only when context is on the surface.
- `omits skill activation guidance at <level> with context=<bool>, tools=<bool>` — verifies that the skills section is absent when context or tools are not on the surface.
- `recipe-bound worker admission remains narrowed at <level>` — verifies that a worker with `hasBoundSkills: true` does not include the skill activation guidance.
- `autonomy transitions change the existing prompt cache identity and compiled activation guidance` — verifies that switching autonomy changes the prompt hash but restoring the same autonomy restores the identical prompt.

### `tests/extended/prompt-cache-correctness.test.ts`

Tests the prompt cache identity and recompile behavior. Key cases:

- `is deterministic and changes for every live byte-affecting input class` — verifies that the cache identity changes for every class of input that affects the prompt bytes (turn constraints, skill inventory, prompt epoch, target, runtime, model, autonomy, session, cwd, working context, context window, etc.).
- `resolves runtime inputs and exact attached schemas before deciding reuse` — verifies that `compileSessionPrompt` is called once for identical resolved inputs, and that changing attached schemas, context window, memory, skill count, or turn constraints triggers a recompile.
- `recompiles on prompt-input epoch changes and reports only byte changes as cold` — verifies that an epoch change triggers a recompile, but a byte-identical output does not report a cold prefix.

## Things to watch when editing

- **Fragment ids are immutable once referenced.** The compiler references fragments by id in `lookupFragment`, which throws if the id is not found. Renaming a fragment id requires updating all references in `compile` and `compileWorker`.
- **`exactOptionalPropertyTypes` is on.** Pass optional fields with `...(x !== undefined ? { x } : {})`, never `x: undefined`. The compiler's `SessionPromptInputs` and `WorkerPromptInputs` have many optional fields.
- **The stable prefix is identity + operating contract only.** Changing either fragment invalidates the stable prefix for every session. The `DEMO_GUIDANCE` appended to the operating contract in `compile` does not affect the stable prefix because it is appended after the contract body in the `rendered` map, but it does affect the system prompt hash.
- **`canonicalToolPromptHints` sorts and deduplicates.** If you add a tool hint with the same tool name and hint text as an existing hint, it will be silently dropped. The sorting is lexicographic on tool name, then hint text.
- **The memory block deduplicates the `# Memory` header.** If you change the memory section to start with a different heading, the deduplication logic in `renderMemoryBlock` will not match and the header will be duplicated.
- **Worker personas must be stable.** `compileWorker` throws on `persona.dynamic === true`. If you need dynamic content in a worker prompt, use `additionalFragments` instead.
- **The session source snapshot is frozen at first capture.** Changes to project context on disk are not reflected in a running session until the session is invalidated by a `ContextSourcesChanged` event or a config hot reload. This is intentional for prefix cache stability.
- **The `--no-context-files` flag suppresses project context.** When `noContextFiles` is true, the context domain dependency is removed from `PromptsManifest.dependsOn` and `projectContext` is not captured in the session source snapshot.

<!-- clio-coder:wiki unresolved sources: src/domains/prompts/fragments/**, src/domains/prompts/fragments/**/*.md -->
