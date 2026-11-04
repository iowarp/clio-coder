---
title: "Semantic index domain"
summary: "How the semantic domain builds, persists, refreshes and searches a per-project vector index over project sources, memory, evidence and inboxes. Read this before changing ingestion, the generation or checkpoint format, embedding budgets, or search filtering."
sources:
  - "src/domains/semantic/index.ts"
  - "src/domains/semantic/service.ts"
  - "src/domains/semantic/storage.ts"
  - "src/domains/semantic/ingestion.ts"
  - "src/domains/semantic/frames.ts"
  - "src/domains/semantic/types.ts"
  - "src/domains/semantic-app/index.ts"
symbols:
  - "SemanticIndex"
  - "SemanticStorage"
  - "extractProjectSources"
  - "extractInbox"
  - "sampleMediaFrames"
  - "SemanticFilters"
tests:
  - "tests/contracts/semantic-index.test.ts"
  - "tests/contracts/semantic-frames.test.ts"
invariants:
  - "In SemanticIndex.runRefresh, the manifest is the only visibility switch: a refresh that does not finish embedding leaves the previously committed generation as the one search reads."
  - "In SemanticIndex.searchVector, global records require includeGlobal, private records require includePrivate, and memory records are returned only when their memoryId is in eligibleMemoryIds."
  - "SemanticIndex.checkpoint rejects a stored checkpoint whose projectId or profileKey differs from the index, at construction."
  - "In runRefresh, embedding spend is written to the persisted checkpoint before the embed call for that reservation is made."
validate:
  - "pnpm run test:file tests/contracts/semantic-index.test.ts"
  - "pnpm run typecheck"
---

# Semantic index domain

The semantic domain holds a per-project vector index over text and media sources. It turns
project code, wiki pages, memory records, sealed evidence, registered inboxes and recordings into
`SemanticRecord` values, embeds them through a caller-supplied embedder, persists the result as a
generation file, and answers search requests with filtered, scored hits. A reader needs this page
when changing what gets indexed, how the index is persisted, how embedding work is budgeted, or
which records a search may return.

## What the area does

- **Types** (`src/domains/semantic/types.ts`) define the record shape (`SemanticRecord`), the
  embedder contract (`SemanticEmbed`), the profile identity (`SemanticProfile`), search filters
  (`SemanticFilters`), hits and results (`SemanticHit`, `SemanticSearchResult`), and limits
  (`SemanticLimits`).
- **Storage** (`src/domains/semantic/storage.ts`) owns the on-disk format. A `manifest.json` names
  one generation file, named `generation-` plus the manifest's `generation` ID plus `.json` (built as `generation-${manifest.generation}.json` in `src/domains/semantic/storage.ts`), whose ID must match `^[a-f0-9-]+$` when loaded.
  A `checkpoint.json` holds in-progress vectors keyed by record fingerprint. Vectors are stored as
  base64-encoded Float32 arrays. `SEMANTIC_FORMAT` is `2`.
- **Index service** (`src/domains/semantic/service.ts`) is the `SemanticIndex` class. It opens the
  stored generation, validates records, runs budgeted refreshes, and performs scored search.
- **Ingestion** (`src/domains/semantic/ingestion.ts`) turns project files, notebooks, PDFs,
  memory, evidence, inbox roots and recordings into records and per-source `SourceState` values.
- **Frames** (`src/domains/semantic/frames.ts`) samples GIF and video containers through `ffmpeg`
  into bounded PNG frames.
- **Barrel** (`src/domains/semantic/index.ts`) re-exports the public surface.

## Index construction and identity

`new SemanticIndex(options)` in `src/domains/semantic/service.ts` requires a non-empty `projectId`,
deep-copies the profile, and derives `profileKey` through `semanticProfileKey`. That function
accepts only a 64-character lowercase SHA-256 `profileIdentity` and a dimension between 1 and 8192.
Limits are merged over `DEFAULT_SEMANTIC_LIMITS`, and every limit must be a safe integer of at
least 1. The storage directory is `<cacheDir>/semantic/<sourceHash(projectId)>/<profileKey>`, so each
project and profile has its own directory. The constructor then calls `storage.load`, adopts the
result, and calls `checkpoint()`.

`checkpoint()` reads `checkpoint.json` and ignores it unless its `version` equals `SEMANTIC_FORMAT`.
A matching-version checkpoint whose `projectId` or `profileKey` differs from the index throws
`"Semantic checkpoint identity mismatch"`.

`SemanticStorage.load` in `src/domains/semantic/storage.ts` returns `null` when the manifest is
absent or has a different `version`, so an older format is treated as derived data to be replaced
on the next refresh. A manifest whose project or profile differs, or whose generation ID fails the
pattern, throws `"Semantic manifest identity mismatch"`. The generation file's text is hashed with
`sourceHash` and compared to the manifest's `sha256`; a mismatch, or a generation whose embedded
identity or profile key disagrees, throws `"Semantic generation checksum or identity mismatch"`.
When the generation file is missing or unreadable and the manifest now names a different
generation, `load` retries up to `attempts` times (default 2). A decoded generation is cached in a
module-level `lastLoaded` value keyed by directory, manifest hash and file size and mtime.

The test `"generation corruption is detected before records or vectors can be disclosed"` in
`tests/contracts/semantic-index.test.ts` refreshes one record, rewrites the stored generation's
`records[0].text` to `"tampered"`, and asserts that constructing a new `SemanticIndex` throws
`/checksum/`.

## Record validation

`validateRecords` in `src/domains/semantic/service.ts` runs on every adopted generation and on every
refresh input. It rejects a record set above `maxRecords`. Each record must have a non-empty `id`
that is not `__proto__`, `constructor` or `prototype`, must be unique within the set, must carry
the index's `projectId`, and must have non-empty `sourceId`, `contentHash`, `extractionVersion`,
`path` and `location`. `scope` must be `project` or `global`, and `visibility` must be `project`,
`global` or `private`. A `global` scope requires `global` visibility, a `memory` record requires a
`memoryId`, and text (or text input) longer than `maxTextChars` is rejected.

## Refresh lifecycle

`refresh` and `reembed` both call `runRefresh` with a `force` flag of `false` and `true`
respectively. `refreshExtracted` is the entry point for extraction output. It keeps previously
indexed records whose `path` is under a source reported as `state: "failed"` and that the new
extraction did not re-emit, then sorts the combined set by `TRIM_ORDER` (memory first, code last).
Records are kept while both `maxRecords` and the byte budget (`storage.maxBytes - 4096`, where
`storage.maxBytes` is `limits.maxBytes / 3`) allow, using `storedRecordBytes` as the size estimate.
Records that do not fit are dropped and `truncated` is set in the result.

`runRefresh` does the following, in order:

1. Copies and sorts the input records by `id` with code-unit comparison, then validates them.
2. Takes `withStateFileLock` on `manifest.json` with a 1000 ms timeout, honoring the caller's
   `AbortSignal`.
3. Reloads the committed generation and prunes other generation files.
4. Computes `snapshotHash` over `[force, records]` and reads the prior checkpoint. Vectors are
   carried into the new checkpoint keyed by `recordFingerprint`, which hashes the extraction
   version and input. Vectors from the committed generation are reused first. Vectors from the
   prior checkpoint are reused too, but only if `!force` or the prior snapshot hash equals this
   one. Each reused checkpoint vector is decoded and validated.
5. Computes `pending` as the records whose fingerprint has no vector. The per-call budget is
   `options.maxEmbeddings` when given, otherwise `maxEmbeddingsPerDay`.
6. Loops in batches of up to `min(batchSize, charged)`, skipping duplicate fingerprints within a
   batch. Before each network call, when no charge is outstanding, it reserves
   `min(CHARGE_AHEAD, requestedBudget - embedded, maxEmbeddingsPerDay - spent)` (`CHARGE_AHEAD` is
   256) and writes `checkpoint.json` before calling `embed`. A batch failure records each record's
   message in `failed` and breaks the loop. A missing `options.embed` or a `shouldYield()` returning
   true also breaks the loop without error.
7. In the `finally` block it refunds unused charge from `spent`, sets `pending` to the remaining
   record IDs, and writes the checkpoint.
8. If any records remain pending, it returns `{ complete: false, embedded, ...status }` and the
   committed generation is unchanged. Otherwise it writes a new generation through
   `storage.commit` unless the records are identical to the committed generation and the call was
   not `force`, adopts it, clears `pending`, `failed` and `vectors` in the checkpoint, and returns
   `{ complete: true }`.

The test `"interrupted jobs retain complete generation and resume checkpoint without redundant calls"`
in `tests/contracts/semantic-index.test.ts` uses `batchSize: 1`, indexes `old`, then calls
`refresh([new-a, new-b], { maxEmbeddings: 1 })`. It asserts `complete === false`, that the
generation equals the previous one, and that `pending` is `["new-b"]`. A fresh index still
searches `"old"` successfully. A second refresh reports `embedded === 1`, and the recorded embed
calls are `[["old"], ["new-a"], ["new-b"]]`. A pre-aborted signal passed to a later refresh
rejects with `/abort/i`.

The test `"persisted daily work budget and foreground yield survive reopening"` uses
`maxEmbeddingsPerDay: 1`. A refresh with `shouldYield: () => true` embeds nothing and makes no
calls. A later refresh completes the single record, and a reopened index refreshing `[a, b]`
reports `embedded === 0`, with one total embed call and `status().pending` equal to `["b"]`.

## Embedding calls

`embed` in `src/domains/semantic/service.ts` wraps `options.embed` with a timeout
(`queryTimeoutMs` for query tasks, `documentTimeoutMs` for document tasks) and forwards the caller's
`AbortSignal` through an internal controller. It rejects with `"Semantic embedding profile or batch count mismatch"` when
the returned `profileKey` differs from the index's or the vector count differs from the input
count, and it validates each vector with `validateVector`. A missing embedder throws
`"Semantic embedder unavailable"`.

`search` embeds the query only when an embedder is configured and the generation has records. If
embedding throws, `search` returns the lexical result from `searchVector` with `fallbackReason` set
to the error message. An abort is rethrown instead of falling back.

## Search

`searchVector` in `src/domains/semantic/service.ts` is the synchronous scoring path, and the tests
call it directly. `assertSearch` runs first and requires `filters.projectId` to match the index
(`"Semantic search project ownership mismatch"`) and the query to be at most `maxTextChars`. A
supplied embedding must carry the index's `profileKey`. Records are then filtered before scoring:

- `projectId` must match the record, and `scope: "global"` records require `includeGlobal`.
- `visibility: "private"` records require `includePrivate`.
- `kind: "memory"` records require their `memoryId` to be in `eligibleMemoryIds`.
- `kinds`, `visibility`, `runId`, `mediaType`, `after` and `before` filter on the matching record
  fields.
- `allowsRecord` is called with the record and must not return `false`.
- For non-memory records, `allowsPath` is called once per distinct path and cached. A missing
  `allowsPath` allows the path.

A record survives only if it matches an exact ID, source or path, has a positive lexical term
ratio over `path` plus `text`, or has a positive dot product with its stored vector. The limit is
clamped to 1..20 and defaults to 5. The score is `(exact ? 2 : 0) + 0.35 * lexical + 0.65 * max(0, semantic)`.
Without a `kinds` filter and with more than `limit` hits, the top three anchors add small
cross-reference bonuses, capped at 0.25 per mention and 0.1 per linked source. The result is then
diversified with quotas of one memory, one wiki and two code records, each required to clear a
score threshold relative to the top hit. Exact matches always stay.

The scan stops early and sets `truncated` when `searchBudgetMs` elapses. `fallbackReason` is set to
`"Semantic query vector unavailable; lexical retrieval"` when no query vector was produced.

The test `"scope, visibility and current memory eligibility precede scoring; fallback is bounded"`
in `tests/contracts/semantic-index.test.ts` indexes four records containing `"checkpoint retry"`:
`local`, a `global` record, a `private` record, and a `memory` record with `memoryId: "memory-1"`.
An offline search with only `projectId` returns only `["local"]`. Adding `includeGlobal`,
`includePrivate` and `eligibleMemoryIds: ["memory-1"]` returns four hits. Filtering by
`kinds: ["memory"]` without eligible IDs returns zero hits, and `limit: 1` returns one hit. An
`allowsRecord` predicate that accepts only `local` returns only that ID.

## Ingestion and callers

`src/domains/semantic-app/index.ts` is the in-tree caller. `openSemanticApp` builds the
`SemanticIndex` from `embeddingProfileToSemanticProfile`, wires `options.embed` to a provider
service only when `options.offline` is not set, and checks media inputs against the registered
inbox roots and `pathPolicy.readablePath` in `providerInput`. `refreshSemantic` calls
`extractProjectSources` with the project root, memory records and evidence, then extracts each
registered inbox, merges the snapshots, and passes the result to `refreshExtracted`.
`reembedSemantic` loads the old profile's generation with `SemanticStorage.load` and rejects it if
any non-memory record is no longer readable under the current policy. Search callers pass
`allowsPath`, `allowsRecord` and `eligibleMemoryIds` built from the current policy and memory
eligibility.

In `src/domains/semantic/ingestion.ts`, `allowed` is the file gate for both `extractProjectSources`
and `extractInbox`. It rejects paths outside the root, names matching the protected-name pattern
(such as `.env`, `.ssh`, `.git`, `node_modules`, and `*.pem`/`*.key` files), paths refused by
`options.allowPath` or a `read` block in `pathPolicy`, any path whose ancestor within the root is a
symbolic link, and any path whose realpath lies outside the root. `discover` lists inbox files
with `rg --files` and throws when ripgrep is unavailable, exits with an error code, or exceeds its
output budget, because ignore rules depend on it. `secretContent` drops any text chunk that still
contains an unredacted private key or a password-like assignment after `[redacted:...]`
placeholders are removed. `textPieces` splits text into `maxTextChars` chunks, each a separate
record with a stable `sourceId#text:...` ID.

Frame sampling in `src/domains/semantic/frames.ts` maps the extension (`.gif`, `.mp4`, `.mov`,
`.webm`) to an ffmpeg demuxer and runs `ffmpeg` with a `pipe` protocol whitelist, one frame per
second, a 512 px scale, and at most 64 frames. Timestamps come from `showinfo` output on stderr.
Each PNG in the output must have a valid signature and an `IEND` chunk, and each timestamp must be
finite, non-negative, below `maxSeconds`, and strictly increasing. An unsupported extension, or an
`ENOENT` spawn error, throws `FrameDecoderUnavailable`. The test `tests/contracts/semantic-frames.test.ts`
generates GIF, MP4, WebM and MOV fixtures with `ffmpeg` and asserts, among other things, that
`extractInbox` produces eight frame records with `startSeconds` `[0, 1]`, that
`sampleMediaFrames` rejects with `/byte budget/` when `maxBytes: 1`, and that it rejects with
`FrameDecoderUnavailable` when `PATH` contains no `ffmpeg`. The test skips when `ffmpeg` is not
installed.

## Things to watch when editing

- The manifest is the only visibility switch. `storage.commit` writes the generation file before
  the manifest, and `load` reads the manifest first, so a change to either must preserve that
  ordering.
- `SEMANTIC_FORMAT` appears in every checkpoint and generation. A change to it makes older
  files ignored by `load` and `checkpoint()`, so they are rebuilt on the next refresh. A change to
  `SEMANTIC_EXTRACTION_VERSION` or `SEMANTIC_FRAME_EXTRACTION_VERSION` changes the fingerprint of
  affected records, which forces re-embedding of those records.
- `searchVector` treats a missing `allowsPath` as allowed. Callers that need path gating must pass
  the predicate, as `semantic-app` does.
- Vectors are validated as unit-length within a tolerance of 0.001 on both encode and decode, and
  `validateVector` requires each dimension to be finite.
- The daily budget is persisted in `checkpoint.json` through `spent`, keyed by a `day` string
  derived from `toISOString()`. The budget resets when the stored `day` differs.
- `TRIM_ORDER` decides which records survive a byte-budget trim. Changing it changes which
  records are dropped first.

## Related pages

Callers that consume search results and the agent-facing context tools are described in
[context](../tools/context.md) and [memory](memory.md). Evidence bundles referenced by `evidenceId` are
described in [evidence](evidence.md).

