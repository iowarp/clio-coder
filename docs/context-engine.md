# Context Engine

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/context_blueprint.html](html/context_blueprint.html) (Version: 0.2.8).

Clio Coder tracks context pressure, records per-turn snapshots, and protects the provider context with bounded tool results plus single-threshold compaction.

Source of truth lives in `src/domains/session/context-accounting.ts`, `src/domains/session/context-ledger.ts`, `src/domains/session/compaction/`, and the chat-loop integration in `src/interactive/chat-loop.ts`.

## Context window resolution

Each target has a declared, desired, and effective context window. The effective window is the operating ceiling used by budget checks and compaction. It can come from a live loaded model config, a probe, a target override, a model hint, catalog knowledge, a local-native default, or a descriptor default.

Local-native runtimes use a recommended minimum desired window of 128,000 tokens. If the live model reports a smaller loaded context window, Clio re-resolves the target so accounting uses the actual ceiling.

## Token accounting and snapshots

The estimator in `context-accounting.ts` uses a four-characters-per-token family for hot-path accounting. It estimates system prompt, tools, messages, pending input, and runtime categories without calling a model tokenizer on every TUI refresh.

At submit time, Clio captures a context snapshot and persists a slim JSONL record under the session directory as `context-snapshots.jsonl`. The slim record keeps token counts, segment metadata, signatures, and hashes, not the heavy prompt or transcript text. When provider usage arrives, `reconcileSnapshot` folds actual input and output counts back into the ledger.

The `/context` overlay and footer meter read the same ledger categories: `system`, `tools`, `agents`, `skills`, `memory`, `project`, `messages`, `pending`, `reserve`, `free`, and `streaming`.

## Single-threshold compaction

Auto-compaction is controlled by one pressure threshold. Pressure is `estimated_tokens / context_window`. The default threshold is `0.8`.

When `compaction.auto` is enabled and pressure crosses the threshold before a request, Clio first masks stale tool observations and stale thinking older than `excludeLastTurns`. This is a cheap local rewrite. Tool call and result structure remain present, but the observation body is replaced with a marker and stale assistant thinking content is dropped from replay.

Marker format:

```text
[Observation masked: <tool> output was <lines> lines, <chars> chars - contents masked to save context. Re-run the tool for current content.] Preview: <preview>
```

Already-compacted entries are not masked again. Recent turns keep their full observations and thinking. If masking drops pressure below the threshold, Clio sends the request without an LLM summary. If pressure remains above the threshold, Clio runs the summary compaction path, appends a compaction summary entry, refreshes replay messages from the session, and continues.

Manual `/context compact`, `CLIO_FORCE_COMPACT=1`, and overflow recovery force the LLM summary path directly. The overflow guard runs before the user turn is committed, so a blocked oversized request does not leave an unanswered user entry in the ledger.

## Cache-divergence honesty

Compaction rewrites the replayed history. On a local backend with a single prefix-cache slot, the next turn after compaction is expected to be cold because the byte prefix changed. Dispatch traffic can disturb the same slot.

Clio records these disturbances once on the next assistant entry as `promptCache.expectedColdReasons`. The user sees one dim notice, and `turn-report.mjs` renders the expected-cold line next to per-call cache data.

Per-call cache verdicts are `hot`, `partial`, `cold`, and `small`. They are derived from provider usage and persisted with `timing { ttftMs, apiMs }` and `promptCache { input, cacheRead, cacheWrite, backendVerdict }` when available.

## Settings

The public settings block has one threshold and one recent-turn horizon:

```yaml
compaction:
  auto: true
  threshold: 0.8
  excludeLastTurns: 6
  # model: provider/summary-model-id
  # systemPrompt: ~/.config/clio/prompts/compaction.md
```

`auto` controls the pre-request trigger. Manual `/context compact` still runs when `auto` is false. `model` optionally selects a dedicated summarization model. `systemPrompt` optionally points at a prompt override file for compaction.

Settings validation is strict: an older file still carrying the removed `compaction.thresholds` block fails to load with the exact key path during normal startup. Run `clio doctor --fix` to repair known legacy compaction shapes, or update unrelated unknown keys by hand.

---

## Project-context preload class

The compiled session prompt preloads the full rendered project context (the `CLIO.md` fragment plus project-type and codewiki markers) only when a parseable `CLIO.md` exists and the rendered text stays within 8000 characters and 220 lines; otherwise it preloads a compact synopsis. The rule lives in `src/domains/prompts/preload.ts` and every reporting surface classifies with it:

- `/context init` and `clio context init` print `preload: full (N.NkB, N lines)` or `preload: synopsis (reason: size|lines)` after the summary, and warn when a full preload is within 10% of either limit.
- `clio config inspect` shows the preload class in the `CLIO.md` entry's detail.
- The `/context` overlay shows a `project preload:` line under the category legend once a session prompt has compiled.

## Context refresh

`/context refresh` and `clio context refresh` rebuild the structural codewiki
and restamp `.clio/state.json` without reading or writing `CLIO.md`. The CLI
flag `--wiki` is the only refresh path that may update the Markdown wiki, and
it only runs when an existing wiki metadata file is present. Regenerating or
updating handbook prose stays with `/context init`.

---

## Codewiki and Wiki

Project context has two local layers. The structural layer is model-free and
feeds navigation. The Markdown wiki layer is agent-authored and exists only
when the operator explicitly asks for it.

| Layer | Artifact | Producer | Model use | Prompt surfacing |
| --- | --- | --- | --- | --- |
| Structural codewiki | `.clio/codewiki.json` plus `.clio/state.json` | `context init`, `context refresh`, `context index`, session freshness checks, and incremental mutation observers | None | `<codewiki>available...; use code_nav</codewiki>` |
| Markdown wiki | `.clio/wiki/*.md` plus `.clio/wiki/meta.json` | `clio context wiki` or `clio context refresh --wiki` | Yes, through the configured documenter dispatch path | `<wiki>N pages at .clio/wiki (start: quickstart.md)...</wiki>` |

### Structural Index

`.clio/codewiki.json` uses schema v4 and is written as compact JSON. File
records contain a stable id, path, language, line count, role, per-file content
hash, extracted import specifiers, and an optional first docstring/JSDoc
summary. Symbol records store declaration-level symbols only (such as classes, interfaces, types, global functions, and methods) and intentionally skip function-local symbols. Each record stores name, kind, file id, line, and optional signature. Edges are built from imports and record either an internal file id target or an external module string.

The indexer walks source files and config manifests while excluding generated, scratch, and local-state directories such as `.git`, `.clio`, `.superpowers`, `.codex`, `.claude`, `.clio-benchmark`, `node_modules`, `dist`, `build`, `coverage`, virtualenvs, `target`, and `vendor`. Source coverage spans TypeScript, JavaScript, Python, Rust, Go, C, C++, Java, Ruby, and C#, with config entries for manifests such as `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `CMakeLists.txt`, `Gemfile`, and `*.csproj`.

Extraction is async and tree-sitter-first. Clio loads WASM grammars for the ten
source languages above, extracts symbols/imports/exports from the parsed tree,
and merges regex import extraction for languages with regex extractors. If a
tree-sitter parse fails for one file, that file falls back to the available
regex extractor instead of aborting the whole build. C# is covered by the
tree-sitter C# grammar.

Incremental updates are real updates, not a full rebuild hidden behind the
name. Successful file-mutating tools report changed paths through the
middleware observer. The context domain coalesces those paths, reads only the
changed indexable files, replaces their file and symbol records, removes
deleted records, and rebuilds edges from the merged import set. Non-indexable
paths are no-ops.

### Markdown Wiki

The wiki lives under `.clio/wiki/` and is written by the `documenter` agent.
`quickstart.md` is mandatory and acts as the hub. The layout validator allows
at most eight Markdown pages, rejects empty pages, and requires
`quickstart.md`. `meta.json` records `updatedAt`, `gitHead`, the model label,
a content hash over the Markdown pages, and the page list. Metadata is written
only after the generated layout validates and the page content changed.

`clio context wiki` creates a wiki when no metadata exists and updates one when metadata is present. During wiki generation, Clio automatically refreshes a stale codewiki index before grounding the model run. The decision to write new pages and update metadata is a no-op if the newly generated content's hash matches the existing content hash. `clio context wiki --update` requests update mode explicitly. `clio context wiki --status` only reads metadata and does not run a model. `clio context refresh --wiki` first rebuilds the structural codewiki and then updates an existing wiki when `.clio/wiki/meta.json` exists; when no wiki metadata exists, it performs no wiki generation.

### Lifecycle Matrix

| Event | Structural codewiki behavior | Markdown wiki behavior |
| --- | --- | --- |
| Session start | If state or `.clio/codewiki.json` already exists, Clio checks freshness best-effort and performs a full rebuild when the index is stale, missing, unreadable, or needs v4 backfill. Never-indexed directories are skipped. | No generation or update. Existing wiki status may surface in the welcome dashboard. |
| In-session edits | Successful file mutations enqueue changed paths for incremental `updateCodewikiPaths`; the queue is serialized and best-effort. | No automatic update. |
| Session stop | Drains the incremental queue, then rebuilds only when state is stale, the index is missing, or v4 backfill is needed. State records `lastSessionAt`, `lastIndexedAt` when applicable, and `codewikiVersion`. | No automatic update. |
| `/context init` or `clio context init` | Performs a full codewiki rebuild before generating, preserving, proposing, or previewing `CLIO.md`; writes state with the fingerprint and codewiki version when it writes state. | No wiki generation. |
| `/context refresh` or `clio context refresh` | Performs a full codewiki rebuild and writes state. Does not touch `CLIO.md`. | If an existing wiki is stale and `--wiki` was not passed on the CLI, prints a hint to run `clio context refresh --wiki` or `clio context wiki --update`. |
| `clio context refresh --wiki` | Performs the same full codewiki rebuild and state write. | Updates an existing wiki through the model-backed documenter path. No wiki metadata means no wiki model call. |
| `clio context wiki` | Automatically refreshes the codewiki index if stale before composing the wiki prompt. | Generates or updates `.clio/wiki/` through the configured documenter path (no-op if content hashes match) and validates the layout before writing metadata. |
| `clio context wiki --status` | No index rebuild. | Reads metadata and reports page count, update time, recorded git head, and git-head drift. |

### Staleness

Codewiki staleness is controlled by one predicate:
`isStale(prev, curr)` compares only `fingerprint.treeHash`. The fingerprint
hash is mtime-aware: it walks the repository, excludes generated/local-state
directories and lock/archive files, and hashes each included relative path,
file size, and floored `mtimeMs`. The fingerprint also records `gitHead` and
`loc`; `loc` comes from the codewiki artifact when available, otherwise from a
line count over source extensions. Those fields are reporting data, not the
stale predicate.

`.clio/state.json` stores the fingerprint and optional `codewikiVersion`.
Legacy v2/v3 codewiki files can still be read as degraded v4 artifacts, but
their missing per-file hashes/imports make `codewikiNeedsBackfill` true. The
next session freshness check, `code_nav` demand load, wiki generation, or
explicit refresh rebuilds them into full v4.

Wiki staleness is separate. `.clio/wiki/meta.json` records the git head used
when the wiki content last changed. If the current git head differs, Clio
counts changed files with `git diff --name-only <recorded>..HEAD` and reports
the wiki as stale. Git-less or unreadable git states degrade to `fresh` with a
warning because Clio cannot prove drift.

### Surfacing and Navigation

The compiled prompt surfaces only markers, never the codewiki JSON or wiki page
contents. Fresh codewiki renders as `<codewiki>available; use code_nav</codewiki>`.
A stale codewiki marker adds `(stale; run /context refresh)`. A valid wiki marker
names the page count and `quickstart.md`; a stale wiki marker adds `(stale; run
clio context wiki --update)`.

`clio context` prints a structural digest from `renderCodewikiDigest`: schema
version, project language, file/config/symbol/edge counts, language and role
counts, top areas, entry points, key symbols, and dependency samples. The
welcome dashboard shows module count, wiki page count and freshness, and a
small entry-point excerpt from the same digest. Agents query the structural
layer through the read-only `code_nav` tool. See [tool-usage.md](tool-usage.md)
for the full mode reference.
