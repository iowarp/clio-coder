---
title: "Context Domain"
summary: "The context domain owns project handbook management, codemap indexing, bounded orientation, wiki generation, external agent-rule adoption, and the working-set eviction policies that control what the model sees on each request."
sources:
  - "src/domains/context/index.ts"
  - "src/domains/context/extension.ts"
  - "src/domains/context/contract.ts"
  - "src/domains/context/bootstrap.ts"
  - "src/domains/context/adoption.ts"
  - "src/domains/context/codewiki/indexer.ts"
  - "src/domains/context/codewiki/tree-sitter.ts"
  - "src/domains/context/codewiki/coordinator.ts"
  - "src/domains/context/wiki/generate.ts"
  - "src/domains/context/wiki/map-seed.ts"
  - "src/domains/context/wiki/plan.ts"
  - "src/domains/context/working-set/policies/index.ts"
  - "src/domains/context/working-set/policies/structural.ts"
  - "src/domains/context/working-set/contract.ts"
  - "src/domains/context/state.ts"
  - "src/domains/context/fingerprint.ts"
symbols:
  - "ContextContract"
  - "ContextDomainModule"
  - "createContextBundle"
  - "runBootstrap"
  - "scanAgentConfigs"
  - "buildCodewiki"
  - "updateCodewikiPaths"
  - "coordinateCodewikiWrite"
  - "runWikiGenerate"
  - "buildArchitectureSeed"
  - "structuralPolicy"
  - "planWikiGeneration"
  - "computeFingerprint"
  - "readClioState"
tests:
  - "tests/contracts/context-pressure.test.ts"
  - "tests/extended/context-map-seed.test.ts"
invariants:
  - "The codewiki coordinator serializes all writes per workspace through an in-process queue and a cross-process file lease; no two writers can produce overlapping generations."
  - "The structural-v2 working-set policy is the default eviction strategy; it is a pure function of PolicyInput, so live and replay execution produce identical selections."
  - "Wiki generation acquires a single-flight lock at .clio-coder/wiki.lock before any write; a live holder blocks the run and a stale lock is reclaimed by pid liveness."
  - "The codewiki index is deterministic for a given tree: file ids are sha256 of the path, content hashes are sha256 of the text, and symbols are sorted by line, name, and kind."
validate:
  - "npx pnpm run test:file -- tests/contracts/context-pressure.test.ts tests/extended/context-map-seed.test.ts"
---

# Context Domain

The context domain manages project handbooks, imported agent rules, the structural codemap, bounded project orientation, generated wiki pages, and working-set eviction policies. The domain registers through `ContextDomainModule` in `src/domains/context/runtime.ts`, which composes the `ContextManifest` with `createContextBundle` from `src/domains/context/extension.ts`. The manifest declares a dependency on the `resources` domain. The authored [project-context architecture](../../architecture/project-context.md) defines the responsibilities and freshness contracts of these artifacts.

## Ownership and Entry Points

The domain's public surface is `ContextContract` in `src/domains/context/contract.ts`. It declares seven operations: `runBootstrap`, `runContextClear`, `runContextRefresh`, `renderPromptContext`, `contextState`, `startupHints`, and `noteFileChanges`. The extension in `src/domains/context/extension.ts` implements this contract by wiring the domain's internal modules together:

- **Bootstrap** (`runBootstrap` in `src/domains/context/bootstrap.ts`): initializes the project handbook, infers conventions and invariants from the codebase, and optionally generates structured context through a model dispatch.
- **Adoption** (`scanAgentConfigs` in `src/domains/context/adoption.ts`): discovers and imports agent rules from external tools such as Claude Code, Gemini, Cursor, and Codex.
- **Codewiki** (`buildCodewiki`, `updateCodewikiPaths`, `syncCodewiki` in `src/domains/context/codewiki/indexer.ts`): builds and maintains the code index.
- **Wiki generation** (`runWikiGenerate` in `src/domains/context/wiki/generate.ts`): orchestrates the creation and update of project documentation.
- **Working-set policies** (`structuralPolicy`, `ageHorizonPolicy` in `src/domains/context/working-set/policies/`): pure selection functions that decide which tool results and thinking blocks leave the working set.

The domain also owns `ContextState` (a snapshot of CLIO-CODER.md status and memory count), `ProjectPromptContext` (the rendered prompt context for the current project), and `ProjectStructuredContext` (structured fields projected into worker prompts).

## Orientation and current project evidence

Ordinary prompt rendering reads the small `.clio-coder/state.json` snapshot and bounded root inputs. It does not enumerate or hash the source tree, parse the codemap, read generated wiki bodies, or call a model. State orientation records declared identity and commands, source/test counts, areas, and entry candidates with workspace scope, observation time, and input identities. Changed checked root inputs or a copied worktree state invalidate that view; unreadable inputs remain unknown.

`code_nav mode=project` obtains current Git HEAD, branch, and bounded porcelain status asynchronously, and validates durable operator tasks from `.clio-coder/user-tasks.json`. It reports provenance and unknown observations. Recorded task completion is separate from passing verification. If codemap reconstruction fails, available Git and task observations still return with `orientation: null` and a codemap unknown reason.

Dispatched workers receive bounded orientation and retrieval support independently of handbook presence. Structural facts use the worker's worktree; authored guidance follows its existing scope and role policy. Workers with project-context tier `none` retain that policy.

## The Codemap Index

The codemap is a versioned index of the project's source files, symbols, and import edges. Its canonical workspace artifact is `.clio-coder/codemap.json`; Clio's installed navigation artifact is `dist/assets/codemap.json`. Readers accept the legacy `codewiki.json` filename only when the canonical file is absent. Existing internal `Codewiki` API names and schema v5 remain compatible. Its schema is defined in `src/domains/context/codewiki/schema.ts` as the `Codewiki` interface, which carries a version constant (`CODEWIKI_VERSION = 5`), a language type, an array of `CodewikiFile` records, an array of `CodewikiSymbol` records, and an array of `CodewikiEdge` records (either internal file-to-file edges or external module references).

### Build Pipeline

A full build starts with `buildCodewiki` in `src/domains/context/codewiki/indexer.ts`, which enumerates workspace files through `enumerateWorkspaceFilesAsync`, filters them with `isIndexablePath`, and delegates to `buildFromPaths`. For each file, `buildFile` reads the source, classifies its language (using `classifyCHeaderLanguage` for ambiguous `.h` headers), and extracts symbols and imports. Symbol extraction prefers tree-sitter when available and falls back to per-language regex extractors (TypeScript/JavaScript, Python, Go, Rust, C/C++, Java, Ruby, C#). Files over `MAX_TREE_SITTER_SOURCE_CHARS` (512 KiB) skip tree-sitter and use the regex fallback directly, preventing an oversized tree-sitter parse from blocking the event loop.

Import resolution uses a per-run memo in `createImportResolver`, which caches candidate path lists by the importing file's directory and specifier. Repeated resolutions within one build reuse the cached candidates.

### Incremental Updates and Sync

`updateCodewikiPaths` applies incremental updates for a set of changed paths: it re-parses only the changed files, replaces their records and symbols in-place, and rebuilds edges from the merged file set. A batch with no index changes returns the original artifact without parsing.

`syncCodewiki` reconciles the index with the current workspace without re-parsing unchanged files. It reads and hashes every candidate file, then delegates extraction to the incremental updater only for additions, removals, and content changes. When content is unchanged and the index contains Python files, it rebuilds import edges to reconcile Python resolver changes.

### Write Coordination

`coordinateCodewikiWrite` in `src/domains/context/codewiki/coordinator.ts` is the only production codewiki commit transaction. It serializes writes through two mechanisms:

1. **In-process queue** (`enqueueWorkspace`): all demand, idle, incremental, and explicit operations for a workspace share one generation order, so overlapping writes cannot drop each other's records.
2. **Cross-process file lease** (`withStateFileLock`): the same order extends across Clio processes. The request is selected after the lease is held and the artifact has been re-read, so an incremental update can never be based on a generation another writer already replaced.

The coordinator delegates extraction to a worker thread (`executeInWorker`), which prevents a tree-sitter parse from holding the main event loop. The worker runs with `execArgv: []` to avoid inheriting test-runner `--import` hooks that would re-resolve from the fixture cwd. A 120-second timeout guards against hangs.

## Context Adoption

`scanAgentConfigs` in `src/domains/context/adoption.ts` discovers external agent configuration files and imports their rules into the project context. It walks a set of known directories (`.claude/commands`, `.claude/agents`, `.gemini/rules`, `.gemini/config`, `.cursor/rules`, and nested instruction files from the interop registry) and extracts rules from markdown bullet points and settings files.

Rules are classified by a source-priority function that orders instructions (0) below rules (1,000), settings (2,000), commands (3,000), agents (4,000), and skills (5,000), with project scope (0) before global (10,000). Conflicts between package managers and test runners are detected by regex and recorded as `AdoptionConflict` entries. The import plan deduplicates by normalized text and respects `MAX_IMPORTED_RULES` (20) and `MAX_RULES_PER_SOURCE` (4) limits.

Security boundaries include a file size cap (`MAX_SOURCE_BYTES = 128 KiB`), an aggregate budget (`MAX_TOTAL_SOURCE_BYTES = 1 MiB`), a recursive file limit (`MAX_RECURSIVE_FILES = 80`), rejection of symlinks, binary content, secret-like lines (detected by `SECRET_LINE_PATTERNS` covering private keys, API tokens, and bearer tokens), and unsafe path names (matching `UNSAFE_FILE_NAME_RE` for `.env`, `secret`, `credential`, `token`, `password`, `history`, `cache`, `session`, `.log`, `state.json`).

## Wiki Generation

`runWikiGenerate` in `src/domains/context/wiki/generate.ts` orchestrates the creation and update of project documentation. Its lifecycle:

1. **Lock acquisition**: `acquireWikiLock` creates `.clio-coder/wiki.lock` with `O_EXCL` and writes the holder's pid. A live holder blocks; a stale lock (dead pid) is reclaimed.
2. **Publication recovery**: `recoverPublication` handles a crash during a previous promotion by comparing content hashes of the live wiki and the previous directory.
3. **Codewiki loading**: `loadOrBuildCodewiki` ensures the codewiki index is current through `coordinateCodewikiWrite`.
4. **Staging**: `adoptOrCreateStaging` either adopts a staging tree left by an interrupted run (the resume mechanism) or creates a fresh one seeded from the live wiki.
5. **Plan resolution**: `resolvePlan` decides what the run owes, in precedence order: a staging tree's plan, the last promoted wiki's plan, or the candidate skeleton from `planWikiGeneration`.
6. **Generation dispatch**: the model runtime (`input.generate`) writes pages into the staging tree.
7. **Assembly**: `assembleWikiTree` produces navigation, repair, and issue reports.
8. **Promotion**: `promoteStaging` atomically swaps the staging directory into place, restoring the old wiki on rename failure.

The plan skeleton is built by `planWikiGeneration` in `src/domains/context/wiki/plan.ts`, which classifies repository depth (`simple`, `medium`, `detailed`) based on source file and line counts, then decomposes the repository into areas at the depth-appropriate granularity. Each area above a size threshold becomes a page; smaller areas fold into the nearest ancestor page. An `architecture.md` overview page is always included.

### Architecture Seed

`buildArchitectureSeed` in `src/domains/context/wiki/map-seed.ts` produces a model-free archify architecture specification derived from the codewiki index. Components are the index's largest directory areas (up to 12), connections are import edges collapsed area-to-area, and source citations reference the index's recorded file and line numbers. The seed is deterministic for one index: keys are sorted, ids derive from area paths, and rankings break ties on path order.

## Working-Set Policies

The working-set layer (`src/domains/context/working-set/`) decides which tool-result bodies and thinking blocks leave the working set. A policy is a pure function of `PolicyInput` (entries, view, settings, pressure, token estimator), so the same selection runs in both the live engine and the replay-lite runner. The `data-analysis` profile protects recent numeric command output; `web-design` protects recent reads of edited stylesheets and components and considers command output first in the age rung. `/context` shows the selected profile and rearm threshold. Live headroom uses projected ledger tokens. Recall by path is limited to visible eviction markers, while recall by reference can retrieve historical evidence; successful rereads retain their recall lineage.

The registry in `src/domains/context/working-set/policies/index.ts` resolves `structural-v1`, `structural-v2`, and the older `age-horizon` policy. Live settings default to `structural-v2`. Both structural policies use the shared composer, which applies protection cutoffs and profile pins, rejects duplicate or already-evicted units, and requires each eviction to free tokens after its marker cost.

`structuralV2Policy` applies these candidate rules in order:

1. **Stale after mutation**: a read of a file that was subsequently rewritten.
2. **Superseded read**: a read of lines that a later read covers.
3. **Failure resolved**: a failed tool call whose failure was resolved by a later success.
4. **Superseded call**: an earlier result replaced by a matching later call.
5. **Listing consumed**: a directory listing whose surfaced paths have all been read.
6. **Offloaded body**: a result whose complete body remains available through its recorded offload path.
7. **Thinking turn closed**: assistant reasoning from a closed turn.
8. **Age horizon**: candidates selected while projected tokens remain above the threshold, stopping at the target.

The composition also protects units recalled twice. `structural-v1` omits the offloaded-body rule and this recall protection. Candidate rules run newest-first within each rung; all selections remain subject to the composer's protections and net-token check.

## Pressure Evaluation

The budget sub-domain (`src/domains/context/budget/`) evaluates context pressure. `evaluatePressure` takes `PressureFacts` (input tokens, effective context window, output reserve, pending request overhead, reduction status) and a `ResolvedPressurePolicy`, and returns a decision with a phase (`normal`, `notice`, `prepare`, `reduce`, `recover`), an admission decision (`admit`, `reduce-first`, `unsafe`, `unknown`), and advisory hysteresis state. The test file `tests/contracts/context-pressure.test.ts` demonstrates the key cases: advisory levels derived from the reduce threshold, request admission against the output reserve, unknown and malformed measurements, advisory hysteresis (announce once, re-arm only after falling below the reset band), and no-useful-cut suppression scoped to the complete request identity.

## State and Fingerprinting

`readClioState` and `writeClioState` in `src/domains/context/state.ts` manage the `.clio-coder/state.json` file, which records the project type, fingerprint, codewiki version, bootstrap generation state, adoption source snapshots, and session timestamps. The state file is validated on read by `isProjectState`, which checks every field against its expected type and range.

`computeFingerprint` in `src/domains/context/fingerprint.ts` produces a `Fingerprint` (tree hash, git HEAD, LOC) by hashing every indexed file's content. The tree hash uses a v3 salt (`clio-codewiki-tree:v3`) to distinguish from legacy fingerprints. A 5-second TTL cache (`computeFingerprintCached`) avoids re-hashing on rapid successive calls.

## Extension Seams

The domain invites changes in several areas:

- **New working-set policies**: add a new `WorkingSetPolicy` implementation in `src/domains/context/working-set/policies/`, register it in the policy registry, and add it to the `WorkingSetPolicyId` union in `src/core/defaults.ts`.
- **New codewiki languages**: add a regex extractor to the `fallbackExtractors` array in `src/domains/context/codewiki/indexer.ts` and a tree-sitter extractor to `src/domains/context/codewiki/tree-sitter.ts`, then add the language to the `CodewikiLanguage` type and the grammar mapping.
- **New adoption providers**: add the provider to `INTEROP_AGENT_KINDS` in the interop registry and the provider to `AdoptionProvider` and `PROVIDER_LABELS` in `src/domains/context/adoption.ts`.
- **New wiki depth strategies**: add an entry to `WIKI_DEPTH_STRATEGY` in `src/domains/context/wiki/plan.ts` with area depth, area share, and minimum area lines.

## Things to Watch When Editing

- **The codewiki version constant** (`CODEWIKI_VERSION = 5` in `src/domains/context/codewiki/schema.ts`) must be incremented when the schema changes; the coordinator's `codewikiNeedsBackfill` check uses it to detect structural incompatibility.
- **The cooperative slicer** (`createSlicer` in `src/domains/context/codewiki/cooperative.ts`) yields between files, never inside one. The `MAX_TREE_SITTER_SOURCE_CHARS` cap (512 KiB) bounds the source submitted to tree-sitter in one parse.
- **The working-set policy must remain pure**: it is shared by the live engine and the replay-lite runner, and widening `PolicyInput` is an owner decision that workers build against.
- **Wiki staging survives interrupted runs**: the staging tree is the resume mechanism. Discarding it on the way out turns a timeout into total loss. The `adoptOrCreateStaging` function deliberately keeps the most recently modified staging tree that contains a plan file.
- **The codewiki coordinator's worker thread** runs with `execArgv: []` to prevent inheriting test-runner `--import` hooks; adding a new `--import` dependency to the worker will break hermetic fixtures.

## Focused Tests

- `tests/contracts/context-pressure.test.ts` exercises pressure policy resolution, phase transitions across window sizes, request admission against the output reserve, advisory hysteresis, no-useful-cut suppression, and material identity versus ordinary revision growth.
- `tests/extended/context-map-seed.test.ts` exercises `buildArchitectureSeed` with colliding directory and package identities, internal versus external import counts, component caps, grid placement, edge collapsing, deterministic serialization, and repository pinning for source citations.
