---
title: "System prompt compilation and project preload"
summary: "How Clio Coder assembles the session and worker system prompts from versioned fragments, and how project handbook context is budgeted into the prompt. Read this before changing prompt sections, fragment files, or the preload limits."
sources:
  - "src/domains/prompts/index.ts"
  - "src/domains/prompts/contract.ts"
  - "src/domains/prompts/extension.ts"
  - "src/domains/prompts/compiler.ts"
  - "src/domains/prompts/preload.ts"
  - "src/domains/prompts/fragment-loader.ts"
  - "src/domains/prompts/hash.ts"
  - "src/domains/prompts/memory-intervention.ts"
symbols:
  - "createPromptsDomainModule"
  - "createPromptsBundle"
  - "PromptsContract"
  - "compile"
  - "compileWorker"
  - "selectProjectPreload"
  - "loadFragments"
  - "sha256"
  - "canonicalJson"
tests:
  - "tests/contracts/project-preload-budget.test.ts"
  - "tests/extended/prompt-prefix-layout.test.ts"
invariants:
  - "Full project preload is used only when the rendered context is at most 24,000 UTF-16 code units and 220 lines; otherwise the selector emits a partial, prefix-based preload with omission notices."
  - "loadFragments throws on a missing or malformed frontmatter, a non-conforming id, a version other than 1, an empty description, or a duplicate id, so the compiler never receives a partially loaded table."
  - "compileSessionPrompt and compileWorkerPrompt throw when the fragment table is not loaded or contains no fragments."
  - "compileWorker throws when the persona is dynamic or empty, when hasCanonicalContext disagrees with the attached tool surface, or when bound skills are requested without canonical context."
  - "The session prompt section order is pinned by SESSION_PROMPT_SECTION_ORDER: identity precedes operating-contract, which precedes safety and tool-contract, which precede project-context, memory, and runtime."
validate:
  - "pnpm run test:file -- tests/contracts/project-preload-budget.test.ts"
  - "pnpm run test:file -- tests/extended/prompt-prefix-layout.test.ts"
---

# System prompt compilation and project preload

The prompts domain builds the system prompt that every Clio Coder session and every mediated fleet worker receives. Read this page when you change a prompt section, add or edit a fragment file, change how project handbook text is budgeted into the prompt, or change how a prompt is cached and hashed.

## What this area does

The domain has three responsibilities:

- It loads prompt fragments, which are Markdown files with YAML frontmatter, from a fragments directory and indexes them by a dot-separated id (`loadFragments` in `src/domains/prompts/fragment-loader.ts`).
- It compiles the layered system prompt for an interactive or headless session (`compile` in `src/domains/prompts/compiler.ts`) and a canonical harness for a worker (`compileWorker` in the same file).
- It selects how much project handbook text enters the session prompt (`selectProjectPreload` in `src/domains/prompts/preload.ts`).

Hashing is a shared primitive. `sha256` and `canonicalJson` in `src/domains/prompts/hash.ts` supply content hashes for fragments, sections, and the compiled prompt.

## Ownership and entry points

- `src/domains/prompts/index.ts`: `createPromptsDomainModule` builds the domain module. When `noContextFiles` is set it removes the `context` dependency from the manifest. It re-exports `PromptsManifest` and the compiler types.
- `src/domains/prompts/contract.ts`: `PromptsContract` is the public surface. It exposes `inputEpoch`, `compileSessionPrompt`, `compileWorkerPrompt`, and an optional `renderSessionPostureUpdate`.
- `src/domains/prompts/extension.ts`: `createPromptsBundle` implements the contract. It holds the loaded fragment table, the session source snapshots, and the hot-reload subscription.
- `src/domains/prompts/compiler.ts`: `compile` and `compileWorker` are pure functions over a `FragmentTable`. The file also defines `SessionPromptInputs`, `WorkerPromptInputs`, `CompiledSessionPrompt`, and the approval and claim guidance constants.
- `src/domains/prompts/preload.ts`: `selectProjectPreload` and the limit constants `FULL_PROJECT_CONTEXT_MAX_CHARS` (24,000) and `FULL_PROJECT_CONTEXT_MAX_LINES` (220).
- `src/domains/prompts/fragment-loader.ts`: `loadFragments`, the `LoadedFragment` and `FragmentTable` types, and the frontmatter validation.
- `src/domains/prompts/memory-intervention.ts`: system prompts and `buildMemoryInterventionUserPrompt` for the memory intervention and consolidation passes.

## Session prompt flow

`createPromptsBundle` returns a `compileSessionPrompt` method. It runs in this order:

1. It throws if the table is not loaded or is empty.
2. It reads the autonomy level from the input, then from settings, defaulting to `"default"`. The safety fragment id is `safety.<level>`.
3. It captures a per-session source snapshot with `sessionSourceSnapshot`. This snapshot holds the project context, customization sources, workspace facts, and catalogs.
4. Unless `noContextFiles` is set, it passes the project context to `selectProjectPreload`. It keeps the returned text as `contextFiles` and the classification as `projectPreload`.
5. It builds `sessionInputs` from the caller's inputs, adding `hasFleetNodes` from settings, `skillDiscoveryEnabled: false` when `noSkills` is set, and `contextFiles` when non-empty.
6. It calls `compile` with the identity, operating contract, and safety ids, plus `additionalFragments` that carry the workspace root, optional fleet inventory, Clio repo awareness, self-development skills, catalogs, and customization fragments.
7. It returns the compiled prompt with `projectPreload`, `projectHandbookFiles`, and `priorSessionFact` added.

`compile` then assembles the prompt. Its fixed identifiers are `identity.clio`, `operating.contract`, and `safety.<level>`. It uses `lookupFragment`, which throws when an id is missing. Each section is pushed through `push`, which trims the body, skips empty bodies, and records a section entry with a token estimate and a content hash. The attended and headless split controls which optional fragments are included. For example, `operating.contract-attended` is used only when the session is not headless, and `operating.contract-headless` is used only when it is.

`compile` returns the systemPrompt, its hash, the section list, and a fragment manifest. The `stablePrefix` value it returns is derived from the identity and operating contract, so the prefix is the same whenever those two fragments are the same.

## Worker prompt flow

`compileWorkerPrompt` strips `cwd` and `workingContextPaths` from its input, computes customization fragments with `customizationFragments`, and calls `compileWorker` with those fragments as `additionalFragments`. It then adds `rulesApplied` and `operatorProfileApplied` to the result.

`compileWorker` validates its input before it renders. It throws when the persona is dynamic or empty. It also throws when `hasCanonicalContext` does not match whether `context` is in the attached canonical tool list for a provider that supports tools. Bound skills without canonical context also throw. The safety fragment is `safety.yolo-worker` when `permit.allowance.executeAutonomy` is `"yolo"`, and `safety.default` otherwise. The read-only fragment `dispatch.read-only` is added when `readOnly` is true. The persona is pushed before the additional fragments, which come last.

## Project preload

`selectProjectPreload` takes a `ProjectPromptContext` and returns the text to inject with a classification. It works in this order:

- If the full context text fits within both limits, it returns the text unchanged with mode `"full"`, or `"none"` when the text is empty. Each handbook source is recorded with full coverage.
- Otherwise it builds a partial preload. The header tells the reader that omitted guidance is not known from the preload. The retrieval instruction depends on `providerSupportsTools` and on whether external read tools are available. The text names `read` with `offset` and `limit: 200` when tools are available.
- The handbooks are then filled nearest first, while the fragments keep their ancestor-first order. For each handbook the selector tries prefixes produced by `safePrefixOffsets`. It keeps the longest prefix that still fits with the reserved metadata notice.
- Support fragments are added while they fit. Any that do not fit are counted in the omission notice.
- The result is checked by a postcondition. If the text still does not fit, the selector throws.

The classification records mode, sizes, per-source coverage, and a `reason` of `"size"` or `"lines"` for partial preloads. The label names the omitted physical line ranges.

The focused test `tests/contracts/project-preload-budget.test.ts` builds a 200-line handbook with dense lines. Its first case asserts that `selectProjectPreload` returns `mode === "full"` and that the text contains `LAST RULE`. Its second case asserts that `buildBootstrapPrompt` receives the whole handbook, including `LAST RULE`.

## Fragment loading

`loadFragments` walks the fragments directory recursively, sorting entries with `localeCompare`. `defaultRootDir` resolves to `src/domains/prompts/fragments` under the package root. For each `.md` file, `parseFragment` enforces these rules:

- The file must start with a YAML frontmatter block. Otherwise it throws.
- The frontmatter must parse to a YAML object.
- `id` must be a string matching `^[a-z0-9-]+(?:\.[a-z0-9-]+)+$`.
- `version` must equal `1`.
- `description` must be a non-empty string.
- `dynamic`, if present, must be a boolean.

Duplicate ids throw. The `contentHash` is the SHA-256 of the whole raw file, not just the body.

Note that `reload` in `src/domains/prompts/extension.ts` catches a failed `loadFragments` and writes a diagnostic. The previous table is then left unchanged. This differs from a failure during the initial load, which surfaces through the domain start.

## Hashing

`sha256` returns a lowercase hex digest of a UTF-8 string. `canonicalJson` sorts object keys recursively and omits `undefined` object values. It throws on non-finite numbers, bigints, symbols, and functions. The bundle's `inputEpoch` combines the fragment epoch, the agents revision, the session source epoch, and a hash of the fleet inventory into one string.

## Session snapshots and cache behavior

`createPromptsBundle` keeps a `sessionSourceSnapshots` map keyed by session id and working directory. It also keeps `pinnedWorkspaceRoots`, so workspace git facts are captured once per process. The `inputEpoch` contract text says that project handbooks, rules, the operator profile, and repo awareness are frozen per session until a config invalidation, an explicit context operation in the workspace or an ancestor, or a new session. The code that performs this freezing is `sessionSourceSnapshot` and `captureSessionSourceSnapshot` in `src/domains/prompts/extension.ts`. Those functions were only partly read for this page. The invalidation rules are therefore taken from the contract comment and are not independently traced.

The layout tests in `tests/extended/prompt-prefix-layout.test.ts` pin the section order. The first case compiles with every input present and asserts that the section ids equal `[...SESSION_PROMPT_SECTION_ORDER, ...tailIds]`. The second case asserts that `identity` precedes `operating-contract`, which precedes `delegation`, `skills`, `safety`, and `tool-contract`, and that `tool-contract` precedes `project-context`, `memory`, and `runtime`. It also asserts that `runtime` is last. The test comment states that the order is a cache decision for issue #249.

## Extension seams

- Fragments: add or edit a Markdown file under `src/domains/prompts/fragments`. The frontmatter rules above apply, and the file is loaded by `loadFragments`. Compile functions look fragments up by fixed id, so renaming an id that `compile` or `compileWorker` references breaks compilation with a "fragment id not found" error.
- Additional sections: `compile` and `compileWorker` accept `additionalFragments`. The bundle appends its own sources there. A new source is added in `compileSessionPrompt` or `compileWorkerPrompt`, not inside `compile`.
- Preload limits: `FULL_PROJECT_CONTEXT_MAX_CHARS` and `FULL_PROJECT_CONTEXT_MAX_LINES` in `src/domains/prompts/preload.ts`. The `maxChars` option of `selectProjectPreload` overrides the character limit for a call.

## Decisions and recorded choices

No recorded decisions were supplied for this page, so the body cites none.

## Things to watch when editing

- The section order is pinned by `SESSION_PROMPT_SECTION_ORDER` and by the layout tests. Moving a section changes the cache prefix, which the tests treat as a deliberate decision.
- A partial preload is a prefix of each handbook, so the omission notice matters. The header says that omitted guidance is unknown from the preload. The code comment explains that a partial preload is not treated as a safe fallback.
- `compileWorker` validates the relationship between `hasCanonicalContext`, the attached tool list, and bound skills. Changing dispatch's tool surface requires keeping those inputs consistent, or compilation throws.
- Changing a fragment's frontmatter `id` changes the lookup key. The compile functions use fixed ids, so the id and its references must change together.
- The memory intervention prompts in `src/domains/prompts/memory-intervention.ts` were located but not traced to their callers for this page. Their owning behavior belongs to the memory domain.

## Related pages

- [Domains memory](memory.md) owns the memory store that the memory intervention prompts act on.
- [Domains context](context.md) owns project handbook loading and the `renderPromptContext` source that feeds `selectProjectPreload`.
- [Domains session](session.md) owns the session that calls `compileSessionPrompt`.
- [Domains dispatch](dispatch.md) owns the worker inputs that feed `compileWorkerPrompt`.
