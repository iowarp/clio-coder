---
title: "Telemetry domain: journals, read models, live views and shares"
summary: "How the telemetry domain records and reads a session's call journal, folds bus events into run snapshots, feeds live views, and builds privacy-filtered share archives and imports. Read this before changing any telemetry reader, projection or share profile."
sources:
  - "src/domains/telemetry/index.ts"
  - "src/domains/telemetry/share.ts"
  - "src/domains/telemetry/share-projection.ts"
  - "src/domains/telemetry/projection.ts"
  - "src/domains/telemetry/call-journal.ts"
  - "src/domains/telemetry/telemetry-live.ts"
  - "src/domains/telemetry/worker-progress.ts"
  - "src/domains/telemetry/read-model.ts"
symbols:
  - "TelemetryDomainModule"
  - "planShare"
  - "sealSharedScope"
  - "importShareArchive"
  - "telemetryShareSource"
  - "SHARE_PROFILES"
  - "projectRecord"
  - "createTelemetryProjection"
  - "openCallJournal"
  - "subscribePersistedTelemetry"
  - "createLiveTelemetryModel"
  - "telemetryView"
  - "createWorkerProgressFold"
tests:
  - "tests/contracts/telemetry-share.test.ts"
invariants:
  - "A share built with the content-free or structural profile keeps only records whose tier and content class the profile admits, and projects each kept record through the share allowlist; free text is withheld and identities become anonymous ids keyed by the installation's secret."
  - "A shared scope is resealed with a share.sealed record whose chain covers exactly the bytes the archive carries, so a verifier can detect any edit after sealing."
  - "An import verifies the whole archive before writing, never overwrites an existing scope, and places a scope under the imported install directory only after its files are staged and the parent directory is rechecked."
  - "The projection's terminal history is capped at MAX_PROJECTION_RUNS settled runs; active runs are always retained."
  - "Live telemetry listener updates are coalesced to at most one per MIN_UPDATE_MS, and a failing journal listener does not reach the writer."
validate:
  - "pnpm run test:file -- tests/contracts/telemetry-share.test.ts"
---

# Telemetry domain: journals, read models, live views and shares

The telemetry domain is the part of Clio Coder that records what a session and its runs did, reads those records back for inspection, and produces shareable copies of them. A reader needs this page when changing how a run or session is summarized, how the live view is fed, how a call journal is opened or subscribed to, or how the `telemetry share` and `telemetry import` flows select, filter and verify data.

The module entry point is `src/domains/telemetry/index.ts`. It exports `TelemetryDomainModule`, which pairs the domain manifest with `createTelemetryBundle` from `extension.ts`, and `createTelemetryDomain`, which the interactive composition root lists instead so it keeps the run-reader binder the published contract does not carry. It re-exports the read model, share, projection, journal path, fold and run-history helpers that other domains and the CLI import. Many modules import this index: the GUI server adapters, the CLI run and fleet commands, and dispatch (`src/domains/dispatch/extension.ts`, among others).

## Components

| Concern | Owner | What it does |
| --- | --- | --- |
| Call journal | `src/domains/telemetry/call-journal.ts` | Opens the owner's journal under one writer lease, appends durable batches, and notifies subscribers after fsync. |
| Bus projection | `src/domains/telemetry/projection.ts` | Folds dispatch and evidence bus events into a bounded run snapshot for operator surfaces. |
| Worker progress | `src/domains/telemetry/worker-progress.ts` | Derives a worker's live phase, tail and action trail from streamed events, under byte and rate bounds. |
| Read model | `src/domains/telemetry/read-model.ts` | Builds session, run, call, cost, cache, timeline and explain reports from a loaded source. |
| Live model | `src/domains/telemetry/telemetry-live.ts` | Binds to a session, seeds it from a cold read, and merges later journal batches into a view. |
| Share | `src/domains/telemetry/share.ts` | Plans, filters, reseals and packs a share archive; verifies and imports archives. |
| Share allowlist | `src/domains/telemetry/share-projection.ts` | Declares, field by field, what each shareable event and object keeps, withholds or anonymizes. |

## Call journal and subscription

`openCallJournal` in `src/domains/telemetry/call-journal.ts` opens a journal under `telemetryJournalPath(options.directory)`, creating its directory first. The file comment states the lease is held for the writer's lifetime and is adjudicated by host, pid and birth token. Before a writer acquires a journal, `callJournalHeader` builds the `segment.open` header: schema set `clio-telemetry/1`, the capture mode, the writer identity, and a clock origin with host, pid, birth token and the process time origin.

Durable batches reach readers through `publishPersisted`. The `PersistedTelemetry` union has three cases: `appended` (bytes plus clock origin, published after fsync), `rewritten` (the writer replaced bytes an earlier read may hold, so a reader must re-read), and `failed`. Listeners register with `subscribePersistedTelemetry(owner, listener)` for one owner, or `subscribeAllPersistedTelemetry(listener)` for every owner. `publishPersisted` calls each listener inside a `try` block and discards its errors, so a reader failure does not reach the writer. The source comments state that the durable write has already happened by the time listeners run.

`ownedCallJournal(context)` returns the journal this process already holds for a telemetry owner, so coordinator evidence reuses the scope's single writer instead of opening a second one. `seedForkCallJournal` creates the journal for a newly forked child session at a path that must not already exist; it throws `fork journal already exists` otherwise.

## Bus projection

`createTelemetryProjection(bus, deps)` in `src/domains/telemetry/projection.ts` returns a `TelemetryProjection` with `snapshot()`, `subscribe(listener)`, `refresh()` and `stop()`. It keeps a `Map` of `RunEntry` values keyed by run id. Each entry carries a `WorkerProgressFold` from `src/domains/telemetry/worker-progress.ts`, and the snapshot strips that fold and replaces it with `progressFold.snapshot()`.

Two bounds apply. `MAX_PROJECTION_RUNS` is 50 and `PROJECTION_FLUSH_DEBOUNCE_MS` is 16. In `markChanged`, a run enters `terminalHistory` only when it is terminal and not pending a retry; a `dead` run counts only when it has a `finishedAtMs`. When `terminalHistory` exceeds 50, the oldest entries are removed from `runs` and `fleetPhases`. Active runs are never in `terminalHistory`, so they are not evicted by this cap. `scheduleFlush` coalesces notifications into one timer, which is `unref`'d so a one-shot CLI run is not kept alive. `flush` runs each listener in its own `try`, and a crashing listener is reported through `writeDiagnostic`.

Payloads from the bus are not trusted. `num`, `asRunId`, `parseRuntimeKind`, `parseEndpointCapacity` and related helpers coerce each field to a known shape and fall back when the input is invalid. `settleFromRunResult` replaces the completion text only when the run result's artifact integrity state is `verified`; a failed seal does not supply the board's answer.

## Worker progress bounds

`src/domains/telemetry/worker-progress.ts` defines the limits a live worker view is held to. `WORKER_LIVE_TAIL_LINES` is 40, `WORKER_LIVE_TAIL_MAX_BYTES` is 4096, `WORKER_TOOL_NAME_LIMIT` is 8, `WORKER_ACTION_TRAIL_LIMIT` is 4, `WORKER_PROGRESS_WINDOW_MS` is 250 and `WORKER_PROGRESS_WINDOW_BYTES` is 16384. Its comments state that the tail keeps the newest lines and that whole lines leave the head until the byte bound is met, with a single oversized line cut at its head. The rate window counts and drops accepted delta bytes past the budget within one window. `WorkerProgressPhase` is `starting`, `thinking`, `writing`, `tool`, `waiting` or `settled`, and the source comment states it is derived from the event stream and not from reasoning content. This page reads these declarations and their comments; This page does not trace the fold's enforcing branches, so treat their exact behavior as described only at the level of these declarations.

## Live model

`createLiveTelemetryModel` in `src/domains/telemetry/telemetry-live.ts` is the live reader. Its options are `stateDir`, an optional lazy `loader` (the session domain's cold loader, imported on first seed), and an optional `process` accessor whose `flush()` runs before this process's own calls are read. The model exposes `bind(sessionId)`, `settled()` and `stop()`. Its constant `MIN_UPDATE_MS` is 100, so subscribers receive at most one update per 100 ms. `SEED_ATTEMPTS` is 3. The comment on `settled()` says the bound session's view waits until its cold seed has merged, so no whole-scope sum is partial.

`telemetryView(source, scope, verifiedRuns)` builds a `TelemetryView` from a loaded `SessionSource`. Its `run(runId)` method caches a result in `verifiedRuns` only when the run seal is `verified`, and the source comment says a verified seal closes the journal, so a cached DTO cannot change. Each other method delegates to a read-model function: `sessionTelemetry`, `callsReport`, `costReport`, `cacheReport`, `timeline`, `runsReport`, `whyStopped` and `explain`.

## Read model

`src/domains/telemetry/read-model.ts` exports the functions the view delegates to, along with `runCostReport`, `runRowTelemetry`, `runTelemetry`, `runTimeline`, `runEnqueued` and `foldTaskMemorySpend`. The functions take a loaded source, which the live model or a cold loader supplies. I inspected the exports and the `telemetryView` call sites but not the bodies of these report functions, so their internal rules are not described here.

## Share: selection, planning and sealing

A share is built in three stages in `src/domains/telemetry/share.ts`.

1. **Source identity.** `telemetryShareSource(stateDir)` reads the install file at `telemetryInstallPath(stateDir)`. If the file is absent (`ENOENT`), it mints a random `inst_` install id and a 32-byte anonymization key, writes the file with mode `0600`, and returns both. An existing file must match `InstallFileSchema`, or the function throws. The anonymization key never leaves the installation, and the source comment says a host or user name becomes an id that cannot be recovered by hashing guesses.

2. **Selection.** `ShareSelection` names explicit `sessions` and `runs`, an optional `repo` path, and optional ISO bounds on seal time. `resolveShareScopes` and `listShareCandidates` expand the selection. The comment on `ShareSelection` says the time bounds filter repository and time-range candidates but never named scopes.

3. **Planning and filtering.** `planShare` takes `scopes`, `skipped`, `profile` and `source`, then calls `filterScope` for each scope. `filterScope` keeps a record only when `admits` returns no violation: `admits` rejects a record whose tier is not in `profile.tiers`, or whose content class is not in `profile.classes`. A kept record then passes through `projectRecord`. For the `research` profile, `projectRecord` returns the record unchanged. For the other profiles it calls `projectSharedPayload` with `anonymousId` as the anonymizer, and a `null` result drops the record. Objects are kept according to the profile's `objects` setting (`none`, `structure` or `all`).

`SHARE_PROFILES` declares the presets. `content-free` admits the `accountability` and `operational` tiers and the `content-free` and `structural` classes, with no objects. `structural` keeps the same tiers and classes and adds structural objects. `research` adds the `research` tier, the `content-bearing` class and all objects. The profile definition comments say `research` applies only to scopes whose capture had consent.

`sealSharedScope` then produces each shared bundle. It appends a closing `segment.open` header whose `content` capture is true only for the `research` profile, encodes every line, and chains them with `chainTelemetryLine`. It writes a `share.sealed` record whose payload carries the chain head, the record ids, the segment digest and the object entries, and it returns a journal, a `bundle.json` manifest and the head. The `share.sealed` record is what a verifier checks against exactly those bytes.

## Share: archive, verification and import

`writeShare` packs a plan into a tar.gz whose `SHARE_MANIFEST_FILE` names the archive format, the profile, the source install id and the Clio version. `verifyShareArchive(archive)` checks an archive before anything is placed. It returns a `ShareArchiveCheck` with a `failure` string or `null`, plus the parsed `manifest` and `scopes`.

`importShareArchive(stateDir, archive)` in `src/domains/telemetry/share.ts` runs the following sequence. It calls `verifyShareArchive` and throws if the archive does not verify. It resolves a base directory `telemetryImportedStateDir(stateDir, installId)`, which keeps imported scopes apart from the operator's own telemetry. For each scope it calls `containedDirectory` to confirm every level under the state directory is a real directory. If a scope directory already exists, the import does not overwrite it. It reads and verifies the existing scope, reports it under `existing` with an `identical` flag and any `damaged` reason, and continues. Otherwise it writes the segments, objects and `bundle.json` into a `*.partial-*` staging directory with the `wx` flag, calls `containedDirectory` again to guard against a symlink swap, renames the staging directory into place, and verifies the placed scope from disk. A failed verification throws.

The test file `tests/contracts/telemetry-share.test.ts` exercises this path. Its first test, named "a content-free share drops a planted secret, verifies as an archive, and imports verified (#434)", starts at line 62 and runs a content-free share over a scope with a planted secret. It asserts the share verifies and imports. Further in the file, `planShare` is called at line 223 with `profile: "content-free"` and at line 258 with `profile: "structural"`, and one case edits a record at line 303 before verification. This page reads the test's call sites and test names; This page does not read the assertion bodies of every case, so the specific assertions at each site are not described here.

## Callers and dependencies

Upstream, the CLI share and telemetry commands (`src/cli/telemetry-share.ts`, `src/cli/share.ts`) and the share domain (`src/domains/share/archive.ts`, `src/domains/share/archive-commands.ts`) reach the functions above. The telemetry extension (`src/domains/telemetry/extension.ts`) and the GUI server telemetry adapter (`apps/clio-coder-gui/server/clio/adapters/telemetry.ts`) import this index. Downstream, the share code depends on the telemetry paths, the chain helpers, and the bundle and segment codecs. The allowlist in `src/domains/telemetry/share-projection.ts` imports the event schema from `src/core/telemetry/events.ts` and the tool-name table from `src/core/tool-names.ts`, and its `ShareableEventName` type excludes research-tier events by construction. Other pages describe those dependencies: see [Core telemetry](../core/telemetry.md) and [Domains safety](safety.md) for redaction, and [Domains dispatch](dispatch.md) for the run lifecycle that feeds the projection.

## Things to watch when editing

- The share allowlist is closed: a field or nested key that `src/domains/telemetry/share-projection.ts` does not name is dropped. A new event field therefore needs an entry in that table, or it will not survive a non-research share. The file comment says the boundary check walks every journal schema against this table.
- `projectRecord` returns the record unchanged for `research`. Changes to the other profiles must keep `projectSharedPayload` as the single filter, or a share can leak fields the allowlist would have removed.
- `importShareArchive` never overwrites an existing scope. A change to placement must preserve the check that a scope appears whole only after its bundle is written, and the post-rename verification.
- The live model's `verifiedRuns` cache is valid only because a verified seal closes the journal. Caching a run that is not sealed would serve stale data.
- Publish events to `publishPersisted` only after the bytes are durable. Listeners run inside the writer's flush, and the comment asks that they stay cheap.
- `MAX_PROJECTION_RUNS` evicts only settled runs. Changing the terminal condition in `markChanged` changes what can be evicted.
