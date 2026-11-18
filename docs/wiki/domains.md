---
title: "Domain modules: application boundaries and aggregate ownership"
summary: "Maps active arena, campaign, claims, components, config, evolution, report, research, semantic-app, share, store, turn-control and user-task entry points."
sources:
  - "src/domains/arena/index.ts"
  - "src/domains/campaign/index.ts"
  - "src/domains/claims/index.ts"
  - "src/domains/components/index.ts"
  - "src/domains/config/index.ts"
  - "src/domains/evolution/index.ts"
  - "src/domains/report/index.ts"
  - "src/domains/research/index.ts"
  - "src/domains/semantic-app/index.ts"
  - "src/domains/share/index.ts"
  - "src/domains/share/archive.ts"
  - "src/domains/store/index.ts"
  - "src/domains/turn-control/index.ts"
  - "src/domains/user-tasks/store.ts"
symbols:
  - "openSemanticApp"
  - "refreshSemantic"
  - "searchSemantic"
  - "qualifySemantic"
  - "embedForExtension"
  - "ShareDomainModule"
  - "createShareArchive"
  - "planShareImport"
  - "importShareArchive"
  - "ConfigDomainModule"
  - "createConfigDomainModule"
  - "createUserTasksStore"
  - "UserTasksStore"
  - "UserTasksStoreError"
tests:
  - "tests/extended/user-task-acceptance.test.ts"
  - "tests/contracts/telemetry-share.test.ts"
invariants:
  - "Semantic search and refresh refuse to run when the semantic setting is disabled or lacks a pinned target, model and asset identity (`configured` in src/domains/semantic-app/index.ts)."
  - "Semantic media paths are accepted only when they are not symlinks, lie under a registered inbox root, pass the safety read policy, and are at most 8 MiB (`providerInput`)."
  - "An operator task may move from open to handed only, and to done or dropped only from open, handed or picked (`createUserTasksStore` in src/domains/user-tasks/store.ts)."
  - "A task store file is rejected on a bad version, unknown keys, duplicate ids, or a nextId that would reuse an existing id (`parseFile`)."
  - "Share import performs no writes when the plan contains an error or conflict diagnostic, or when dryRun is set (`importShareArchive`)."
validate:
  - "pnpm exec vitest run tests/extended/user-task-acceptance.test.ts"
  - "pnpm exec vitest run tests/contracts/telemetry-share.test.ts"
  - "pnpm run typecheck"
---

# Domain modules: application boundaries and aggregate ownership

This page aggregates active boundaries under `src/domains/` that lack dedicated wiki pages. Follow the named implementation modules before changing policy, persistence or validation details.

## Current aggregate ownership

| Domain | Entry-point ownership |
| --- | --- |
| Arena | `arena/index.ts`: blind identity/order, contender environment and facts, run validation, standings, persistent matches/votes and blinded views. |
| Campaign | `campaign/index.ts`: roster load/parse, metric folding and the multi-entry campaign runner/probe validation. |
| Claims | `claims/index.ts`: verification-claim capture, hypothesis binding, edges/disputes/regressions, journal compaction and bounded delivery registrations. |
| Components | `components/index.ts`: create/load/diff snapshots backed by `scan.ts`, `snapshot.ts`, `hash.ts` and `diff.ts`. |
| Config | `config/index.ts`: strict-startup domain binding, bundle creation, settings classification, agent namespaces and manifest/contract exports. |
| Evolution | `evolution/index.ts`: versioned change manifests, authority levels, summarization, loading and validation. |
| Report | `report/index.ts`: draft/scrub/canary consent, bundles, outbox/rate limits, reviewed send flow, transport, sharing and follow-up. |
| Research | `research/index.ts`: open/resume/run loop, measurement/grading, budgets, journal folding, reports and resume planning. |
| Semantic app | `semantic-app/index.ts`: settings/target/safety composition around the semantic store and embedding service. |
| Share | `share/index.ts`: archive creation, import planning/conflicts and verified archive installation. |
| Store | `store/index.ts`: local versus explicitly selected `clio-core` backend, refusal patterns, locks and workspace signals; explicit unusable selection does not silently fall back. |
| Turn control | `turn-control/index.ts`: workflow decisions/hashes, facts/outcomes, bounded collected rendering and workflow settings. |
| User tasks | `user-tasks/store.ts`, `acceptance.ts`, `active-acceptance.ts`, `handoff.ts`: task-file transitions, normalized acceptance and active-session handoff ownership. |

## Semantic app

`src/domains/semantic-app/index.ts` composes the semantic index from settings, an embedding service, the safety policy engine, memory records and run evidence. It exports the operations `openSemanticApp`, `previewSemanticInbox`, `refreshSemantic`, `reembedSemantic`, `reembedSemanticFrom`, `searchSemantic`, `statusSemantic`, `qualifySemantic` and `embedForExtension`.

Control flow for a search: `searchSemantic` calls `openSemanticApp`. If that throws an authentication-unavailable error, it retries with `offline: true`, so existing generations remain searchable without a model request. It then loads memory records, computes the eligible memory ids for the active repository, and calls `SemanticIndex.search` with an `allowsRecord` predicate. That predicate admits a memory record only when its content hash matches the eligible hash, and admits evidence, recording, inbox and project records only when their path lies under the corresponding root.

`openSemanticRoute` is the shared base. It rejects the request unless `settings.context.semantic` is enabled and usable (`configured`), resolves the target from `settings.targets`, and requires the target runtime to be `llamacpp-embed` or `litellm`. It builds the embedding profile with `embeddingGemma2Q8Profile` and only resolves auth when `offline` is false. `embedForExtension` uses this route only and never builds the index. It rejects a request whose `expectedProfileIdentity` differs from the current profile, with the message that saved vectors must be re-embedded.

Media inputs go through `providerInput`. Video input throws. An image must be png, jpeg or webp; audio must be wav, mpeg, flac or ogg. The file is re-resolved with `realpath`, must not be a symlink, must be a regular file under an allowed root, and must pass `readablePath` from the safety policy engine. It is limited to 8 MiB.

`sampleQualifiedWav` is the only media sampler passed to `extractInbox`, and only when audio is in `modalities`. It accepts mono 16 kHz PCM or float WAV and rejects other formats or durations above the media budget. Non-WAV files return no pieces.

`refreshSemantic` collects project run evidence from the dispatch ledger (`openLedger().list`), keeps only runs whose cwd resolves to the project, and includes recordings whose manifest hash is present. It then merges extraction results from project sources, recordings and each registered inbox, and calls `index.refreshExtracted`. `reembedSemanticFrom` accepts only a 64-character lowercase hex profile identity and reads canonical records from the old profile's cache directory; it throws if any non-memory record is no longer readable under the current policy.

`qualifySemantic` is an explicit operator canary. It embeds a generated PNG, a generated 16 kHz WAV tone and a mixed part, according to `config.modalities`, and returns the qualified profile for the caller to persist.

Callers: this module's exports are consumed by the semantic CLI and extension bridge (see `tests/contracts/semantic-cli.test.ts` for the CLI path, which this page did not read in detail). Downstream dependencies include `src/domains/semantic/index.ts`, `src/domains/providers/embedding/index.ts`, `src/domains/safety/policy-engine.ts`, `src/domains/dispatch/index.ts` and `src/domains/telemetry/paths.ts`. The semantic index, its storage and the embedding providers are documented on their own pages, not here.

## Share archives

`src/domains/share/index.ts` re-exports the archive API from `src/domains/share/archive.ts` and exposes `ShareDomainModule`, which pairs `ShareManifest` with `createShareBundle`. The archive API is `createShareArchive`, `writeShareArchive`, `planShareImport` and `importShareArchive`.

`createShareArchive` builds a v1 archive of `project-context`, `prompt`, `skill`, `agent`, `playbook`, `extension` and `settings` entries. Scope selection (`requestedScopes`) and the include flags are defaulted by `defaultedIncludes`. When no include flag is passed, all categories are included. When any include flag is passed, only explicitly true flags are included. Project-context files come from `PROJECT_CONTEXT_FILES` and are only added for the project scope. Extension trees skip dot-directories and `state.json`. Settings are serialized as a YAML fragment with `settingsFragment`. The result's `manifest.files` omits the data buffers, and the file list is sorted by `archivePath`.

`writeShareArchive` writes the archive as stable JSON through `safeResourceWrite`.

Import uses `prepareShareImport`, which validates the archive shape in `parseArchive` (kind `clio-coder-share-archive` or the legacy `clio-share-archive`, `formatVersion` 1, manifest format `clio-coder.share.v1` or `clio.share.v1`). It then builds the action list and diagnostics. A destination file that already exists with different content produces a `conflict` diagnostic and a `skip` action. Extension packages are staged and checked; an existing extension without the archive's verified digest produces a conflict unless `force` is set. Settings fragment keys that differ from current settings produce conflicts, and `force` filters conflicts out of that list.

`importShareArchive` returns the plan without writing when `dryRun` is set, when the archive is absent, or when any diagnostic is `error` or `conflict`. Otherwise it installs extension packages through the canonical installer, checks the resulting content digest against the archive, and merges the settings fragment through `updateSettings`, which re-validates the settings. Written paths and backups are recorded in the returned plan's recovery information.

Focused test: `tests/contracts/telemetry-share.test.ts` covers an import of a telemetry share archive. It calls `importShareArchive(maintainer, archive)` and asserts that a second import reports `identical: true` for the same session. A separate case asserts that `importShareArchive` rejects a claimed archive with `/beyond the content-free projection/`. These cases exercise the telemetry-share path. The test does not exercise the project-context, prompt or settings branches of `createShareArchive` in `src/domains/share/archive.ts`, and no focused test for those branches was found.

Things to watch when editing: the import short-circuit on `error` and `conflict` diagnostics is the only write guard visible in `importShareArchive`. Add new diagnostic types in `prepareShareImport` with that in mind.

## Operator task store

`src/domains/user-tasks/store.ts` persists operator-owned tasks in the project file at `USER_TASKS_RELATIVE_PATH`, which is `${CLIO_PROJECT_DIR}/user-tasks.json`. `createUserTasksStore({ cwd })` returns a `UserTasksStore` with `snapshot`, `get`, `add`, `setAcceptance`, `hand`, `done`, `drop`, `recordPicked`, `recordDone` and `reconcile`. Dependencies can be injected through `UserTasksStoreDeps` (`exists`, `read`, `write`, `now`).

Statuses are `open`, `handed`, `picked`, `done` and `dropped`. Every mutation reloads the file, checks the transition, updates `updatedAt`, and saves the whole file with `atomicWrite`. The transitions enforced by `mutate` are:

- `hand`: from `open` only, and it records `handedSessionId` when a session id is passed.
- `done`: from `open`, `handed` or `picked`.
- `drop`: from `open`, `handed` or `picked`.

`recordPicked` and `recordDone` go through `recordLink`, which refuses tasks already `done` or `dropped`.

`parseFile` rejects corrupt JSON, unknown top-level or task keys, a wrong version, a non-integer `nextId`, a task id that does not match `^u[1-9]\d*$`, duplicate ids, and a `nextId` that does not exceed the highest existing id. Acceptance values are validated by `normalizeUserTaskAcceptance` from `src/domains/user-tasks/acceptance.ts`, which this page did not read. Read and write failures are rethrown as `UserTasksStoreError`.

`reconcile(links, sessionId)` updates tasks from board-task links. A completed link moves the task to `done`. An active or pending link moves it to `picked`. If no link exists, a task in `picked` whose `handedSessionId` matches the caller is moved back to `handed` and its `boardTaskId` is removed. The source comment states that an empty link set releases work only for the session that owns it, so one session cannot release another session's pickup.

Callers and dependencies: the store imports `atomicWrite` from `src/engine/session.ts`, `CLIO_PROJECT_DIR` from `src/core/artifact-paths.ts`, and `normalizeUserTaskAcceptance` from `src/domains/user-tasks/acceptance.ts`. Its callers are outside the anchor set and were not read.

Focused test: `tests/extended/user-task-acceptance.test.ts` creates a store, adds a task with `expectedOutputs` containing `" ./src//solver.ts "` and `"src/solver.ts"`, and asserts that the stored acceptance is normalized to `["src/solver.ts"]`. It then mutates the returned arrays and asserts that a new store instance still reads the original values, which shows that returned tasks are detached copies. A later assertion checks that the file is unchanged after a set of invalid updates, though the exact invalid inputs were not read in full.

## Entry-point details

`src/domains/config/index.ts` exports `ConfigDomainModule`, which uses `createConfigBundle(context)`, and `createConfigDomainModule(initialSettings, options)`, which binds a startup settings snapshot. It also re-exports `ConfigManifest`, `diffSettings`, `assertAgentIdNamespace` and the `ConfigContract` type. The implementation is split across `extension.ts`, `classify.ts`, `agent-namespace.ts`, `keybindings.ts` and `watcher.ts`; their policy branches are not exhaustively described here.

`src/domains/evolution/index.ts` re-exports the change-manifest API from `./manifest.js` and `src/domains/evolution/validate.ts`, including `validateChangeManifest`, `loadChangeManifestJson`, `summarizeChangeManifest` and the authority-level constants. The exported validator authority is current; individual validation branches are intentionally outside this aggregate page.

`src/domains/turn-control/index.ts` re-exports the decision, facts, outcome, record, render and settings modules: `decide`, `decisionHash`, `factsDigest`, `reduceTurnOutcome`, `renderCollectedBlock` with its `TURN_CONTROL_BLOCK_MAX_CHARS` limit, and `TURN_CONTROL_WORKFLOWS`. The exported decision/outcome/render APIs are current; per-workflow behavior is not expanded here.

`src/domains/components/index.ts` re-exports `createComponentSnapshot`, `loadComponentSnapshot` and `diffComponentSnapshots`. Scan exclusions and diff semantics should be read in the implementation files, not inferred from this barrel.

## Coverage gaps

This aggregate deliberately stops at entry-point ownership. Consult the named implementation files before changing detailed validation, scan, persistence or policy behavior.
