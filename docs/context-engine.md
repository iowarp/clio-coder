# Context Engine

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/context_blueprint.html](html/context_blueprint.html) (Version: 0.3.2).

Clio Coder tracks context pressure, records per-turn snapshots, and protects the provider context with bounded tool results plus single-threshold compaction.

Source of truth lives in `src/domains/session/context-accounting.ts`, `src/domains/session/context-ledger.ts`, `src/domains/session/compaction/`, `src/domains/session/migrations/index.ts`, and the chat-loop integration in `src/interactive/chat-loop.ts`.

## Context window resolution

Each target has a declared, desired, and effective context window. The effective window is the operating ceiling used by budget checks and compaction. Sources rank most-live first: the window discovery reports the model is loaded at, then a probed window, then a target override, then a model hint, catalog knowledge, a local-native default, and finally a descriptor default.

The loaded window outranks the declared one because it is the only figure describing what the backend will serve. LM Studio routinely opens a model well below its `max_context_length`, and a run planned against the larger number overruns the server before compaction ever fires. Discovery carries that number per model in `discoveredModelStates[<model>].contextLength`, and the residency notice reads the same entry, so a model Clio is budgeting a loaded window for is never announced as absent.

Local-native runtimes use a recommended minimum desired window of 128,000 tokens. If the live model reports a smaller loaded context window, Clio re-resolves the target so accounting uses the actual ceiling.

The `/context` overlay states which layer answered, next to the token total: `loaded`, `probed`, `configured`, `declared`, or `assumed`.

## Token accounting and snapshots

The estimator in `context-accounting.ts` uses a four-characters-per-token family for hot-path accounting. It estimates system prompt, tools, messages, pending input, and runtime categories without calling a model tokenizer on every TUI refresh.

At submit time, Clio captures a context snapshot and persists a slim JSONL record under the session directory as `context-snapshots.jsonl`. The slim record keeps token counts, segment metadata, signatures, and hashes, not the heavy prompt or transcript text. When provider usage arrives, `reconcileSnapshot` folds actual input and output counts back into the ledger.

Session metadata enforces session format version 3 (`CURRENT_SESSION_FORMAT_VERSION = 3`). Before resuming any session, Clio checks `sessionFormatVersion`; earlier formats are rejected outright with an error rather than silently migrated.

The `/context` overlay and footer meter read the same ledger categories: `system`, `tools`, `agents`, `skills`, `memory`, `project`, `messages`, `pending`, `reserve`, `free`, and `streaming`.

## Single-threshold compaction

Auto-compaction is controlled by one pressure threshold. Pressure is `estimated_tokens / context_window`. The default threshold is `0.8`.

When `compaction.auto` is enabled and pressure crosses the threshold before a request, Clio first masks stale tool observations and stale thinking older than `excludeLastTurns`. This is a cheap local rewrite. Tool call and result structure remain present, but the observation body is replaced with a marker and stale assistant thinking content is dropped from replay.

Marker format:

```text
[Observation masked: <tool> output was <lines> lines, <chars> chars - contents masked to save context. Re-run the tool for current content.] Preview: <preview>
```

Already-compacted entries are not masked again. Recent turns keep their full observations and thinking. If masking drops pressure below the threshold, Clio sends the request without an LLM summary. If pressure remains above the threshold, Clio runs the summary compaction path, appends a compaction summary entry, refreshes replay messages from the session, and continues.

Manual `/context compact`, `CLIO_CODER_FORCE_COMPACT=1`, and overflow recovery force the LLM summary path directly. The overflow guard runs before the user turn is committed, so a blocked oversized request does not leave an unanswered user entry in the ledger.

## Cache-divergence honesty

Compaction rewrites the replayed history. On a local backend with a single prefix-cache slot, the next turn after compaction is expected to be cold because the byte prefix changed. Dispatch traffic can disturb the same slot.

Clio records these disturbances once on the next assistant entry as `promptCache.expectedColdReasons`. The user sees one dim notice, and the same reasons persist on that entry in the session ledger next to the per-call cache data.

Per-call cache verdicts are `hot`, `partial`, `cold`, and `small`. They are derived from provider usage and persisted with `timing { ttftMs, apiMs }` and `promptCache { input, cacheRead, cacheWrite, backendVerdict }` when available.

## Settings

The public settings block has one threshold and one recent-turn horizon:

```yaml
compaction:
  auto: true
  threshold: 0.8
  excludeLastTurns: 6
  # model: provider/summary-model-id
  # systemPrompt: ~/.config/clio-coder/prompts/compaction.md
```

`auto` controls the pre-request trigger. Manual `/context compact` still runs when `auto` is false. `model` optionally selects a dedicated summarization model. `systemPrompt` optionally points at a prompt override file for compaction.

Settings validation is strict: an older file still carrying the removed `compaction.thresholds` block fails to load with the exact key path during normal startup. Edit removed or unknown keys deliberately; `clio-coder doctor --fix` does not transform settings into the current schema.

---

## Directory-scoped project handbooks

Project guidance is resolved from the filesystem root to the working directory. An ordinary `CLIO-CODER.md` adds a layer for its directory and descendants. `CLIO-CODER.override.md` starts a replacement boundary: it wins over `CLIO-CODER.md` in the same directory, discards all handbook layers inherited from ancestors, and remains effective below that directory. Ordinary handbooks in deeper directories may add new layers after the override. A sibling outside the override's subtree keeps its own inherited chain.

For example, a session in `repo/src/parser/` loads `repo/src/CLIO-CODER.override.md` followed by `repo/src/parser/CLIO-CODER.md`; it does not load `repo/CLIO-CODER.md`. A session in `repo/docs/` still loads `repo/CLIO-CODER.md`. Surviving files are rendered in ancestor-to-descendant order as separate `<project-context path="...">` blocks, preserving the source of every instruction. The nearest surviving handbook supplies the project name used by compact reporting, while conventions, hard invariants, imported context, and custom sections layer in order.

An unreadable or malformed override fails closed. Clio warns about that file but does not reactivate the inherited or same-directory handbook it replaced. `clio-coder config inspect` lists every effective handbook and its layer number.

Handbook resolution is read-only. `/context init` and its CLI form continue to author only the exact `CLIO-CODER.md` in the current directory, and `/context refresh` may curate only that exact standard file. They never rewrite an inherited file or an override. A same-directory override therefore continues to shadow a standard handbook created or updated by those maintenance commands until the operator removes the override. Normal reset preserves both handbook names; `context reset --all` may remove the local standard `CLIO-CODER.md` after its second confirmation but always preserves `CLIO-CODER.override.md` as operator-authored context.

## Project-context preload class

The compiled session prompt preloads the full rendered project context (the effective handbook fragments plus project-type and codewiki markers) only when at least one selected handbook parses and the rendered text stays within 8000 characters and 220 lines; otherwise it preloads a compact synopsis. The rule lives in `src/domains/prompts/preload.ts` and every reporting surface classifies with it:

- `/context init` and `clio-coder context init` print `preload: full (N.NkB, N lines)` or `preload: synopsis (reason: size|lines)` after the summary, and warn when a full preload is within 10% of either limit.
- `clio-coder config inspect` shows the shared preload class and layer position on every effective handbook entry.
- The `/context` overlay shows a `project preload:` line under the category legend once a session prompt has compiled.

## Context refresh

`/context refresh` and `clio-coder context refresh` rebuild the structural codewiki
and restamp `.clio-coder/state.json` without reading or writing inherited handbooks or overrides. The CLI
flag `--wiki` is the only refresh path that may update the Markdown wiki, and
it only runs when an existing wiki metadata file is present. Regenerating or
updating the exact local standard handbook stays with `/context init`.

`clio-coder context init` is model-driven by default. The `--heuristic` flag is the sole deterministic flag for offline handbook generation. The `--propose` flag writes ignored drafts to `.clio-coder/proposals/`, `--apply` updates from the existing handbook, and `--rewrite` generates a fresh handbook.

When bootstrapping across local runtimes such as `llamacpp` where strict grammar/schema enforcement might be rejected by the endpoint, generator logic retries automatically using a bounded prompt-parser fallback. If `--rewrite` was requested but the model generation fails to produce a valid handbook rewrite, `clio-coder context init` prints a notice and exits with code 1 rather than leaving an inconsistent state.


---

## Codewiki and Wiki

Project context has two local layers. The structural layer is model-free and
feeds navigation. The Markdown wiki layer is agent-authored and exists only
when the operator explicitly asks for it.

| Layer | Artifact | Producer | Model use | Prompt surfacing |
| --- | --- | --- | --- | --- |
| Structural codewiki | `.clio-coder/codewiki.json` plus `.clio-coder/state.json` | `context init`, `context refresh`, `context index`, session freshness checks, and incremental mutation observers | None | `<codewiki>available...; use code_nav</codewiki>` |
| Markdown wiki | `.clio-coder/wiki/**/*.md` plus `.clio-coder/wiki/meta.json` | `clio-coder context wiki` or `clio-coder context refresh --wiki` | Yes, one planning dispatch plus one dispatch per page | `<wiki>N pages at .clio-coder/wiki (start: quickstart.md)...</wiki>` |

### Structural Index

`.clio-coder/codewiki.json` uses schema v5 and is written as compact JSON. File
records contain a stable id, path, language, line count, role, per-file content
hash, extracted import specifiers, and an optional first docstring/JSDoc
summary. Symbol records store declaration-level symbols only (such as classes, interfaces, types, global functions, and methods) and intentionally skip function-local symbols. Each record stores name, kind, file id, line, and optional signature. Edges are built from imports and record either an internal file id target or an external module string.

In Git workspaces, the indexer uses the same visible file set across full builds,
incremental updates, fingerprints, and project profiles: tracked files plus
untracked, unignored work in progress. It excludes symlinks, submodule gitlinks,
generated output, scratch space, and local-state directories such as `.git`,
`.clio-coder`, `.superpowers`, `.codex`, `.claude`, `.clio-coder-benchmark`, `node_modules`,
`dist`, `build`, `coverage`, virtualenvs, `target`, and `vendor`. Non-Git
workspaces use a bounded filesystem walk with the same directory exclusions.
Source coverage spans TypeScript, JavaScript, Python, Rust, Go, C, C++, CUDA
(`.cu` and `.cuh`), Java, Ruby, and C#, with config entries for manifests such
as `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`,
`CMakeLists.txt`, `Gemfile`, and `*.csproj`.

Extraction is async and tree-sitter-first. Clio loads WASM grammars for the ten
source language grammars above, extracts symbols/imports/exports from the parsed tree,
and merges regex import extraction for languages with regex extractors. If a
tree-sitter parse fails for one file, that file falls back to the available
regex extractor instead of aborting the whole build. C# is covered by the
tree-sitter C# grammar.

Ambiguous `.h` files are classified deterministically by `classifyCHeaderLanguage` (`src/core/c-header-language.ts`). The scanner removes comments before checking C++-only standard-library includes, and removes comments and literals before checking C++ syntax markers such as templates, namespaces, class/member declarations, scope resolution, C++ casts, and C++ qualifiers. If any C++ marker is present, the header is indexed as `c++`; otherwise, it defaults to `c`. This guarantees that both full indexing and incremental file syncs assign identical language tags to `.h` files. Declaration-only C/C++ APIs are indexed so header-heavy MPI, CUDA, and scientific libraries remain navigable even when implementations live elsewhere.

Incremental updates are real updates, not a full rebuild hidden behind the
name. Successful file-mutating tools report changed paths through the
middleware observer. The context domain coalesces those paths, checks per-file
content hashes and reparses only changed files (`perf(context)` optimization),
reads only the changed indexable files for path-based updates, replaces their file and symbol records, removes
deleted records, and rebuilds edges from the merged import set. Non-indexable
paths are no-ops.

### Markdown Wiki & `code_nav` Resolution

The wiki lives under `.clio-coder/wiki/` as a nested tree and is written by the
`wiki-writer` agent. Model agents resolve pages dynamically through `code_nav`
with `mode: "wiki"`; an optional query resolves a page id or title, where the id
is the page's path without its extension (`domains/dispatch`), and returns its
summary and path. That gives deterministic on-demand navigation without loading
whole pages into prompt context.

The unit of work is one page, not one wiki. A run makes a single planning
dispatch, then one dispatch per page, each with a fresh context holding only that
page's plan entry, its anchor sources, and the sibling paths it may link to. The
repository-wide payload, including the codewiki digest, appears only in the
planning prompt. Because a static prompt is re-sent on every round of a run, this
is what keeps prefill cost from growing quadratically with the size of the wiki.

`_plan.json` is the skeleton and the checkpoint. It is derived deterministically
from the codewiki index, so a usable plan exists before any model runs; the
planning dispatch may merge, split, rename, drop, or re-anchor entries by
rewriting it, and a malformed rewrite falls back to the candidate. The harness
owns each entry's status and rewrites the file after every page, so a run that
ends early records exactly which pages are still owed. Staging survives such a
run and the next one resumes from it.

Every page opens with front matter carrying `title`, `summary`, `sources`,
`symbols`, `tests`, `invariants`, and `validate`. That is the retrieval layer:
`quickstart.md`, every directory `index.md`, and the task-routing table are
generated from it after each run, so navigation cannot drift or miss a page and
no writer has to remember to update it.

Assembly repairs rather than rejects. A missing H1, absent or malformed front
matter, a dangling `sources` entry, a link to a page that was never written, and
a citation to a path that does not exist are all mechanically fixable, so each is
fixed or recorded in a `<!-- clio:wiki ... -->` marker and reported; none fails a
run. An empty page is dropped and its plan entry stays owed. An update run's
scope is computed, not guessed: a page is rewritten when git reports a change to
one of the sources its own front matter claims.

`meta.json` records `updatedAt`, `gitHead`, the indexed source-tree hash, the
model label, a content hash over the page tree, the page list, and the plan.
`generation.pagesPlanned` and `generation.pagesWritten` say whether a run
finished; when they differ, `clio-coder context wiki --update` completes the rest.

`clio-coder context wiki` creates a wiki when no metadata exists and updates one when metadata is present. During wiki generation, Clio automatically refreshes a stale codewiki index before grounding the model run. The decision to write new pages and update metadata is a no-op if the newly generated content's hash matches the existing content hash. `clio-coder context wiki --update` requests update mode explicitly. `clio-coder context wiki --status` only reads metadata and does not run a model. `clio-coder context refresh --wiki` first rebuilds the structural codewiki and then updates an existing wiki when `.clio-coder/wiki/meta.json` exists; when no wiki metadata exists, it performs no wiki generation.

### Lifecycle Matrix

| Event | Structural codewiki behavior | Markdown wiki behavior |
| --- | --- | --- |
| Session start | If state or `.clio-coder/codewiki.json` already exists, Clio checks freshness best-effort and performs a full rebuild when the index is stale, missing, unreadable, or needs v5 backfill. Never-indexed directories are skipped. | No generation or update. Existing wiki status may surface in the welcome dashboard. |
| In-session edits | Successful file mutations enqueue changed paths for incremental `updateCodewikiPaths`; the queue is serialized and best-effort. | No automatic update. |
| Session stop | Drains the incremental queue, then rebuilds only when state is stale, the index is missing, or v5 backfill is needed. State records `lastSessionAt`, `lastIndexedAt` when applicable, and `codewikiVersion`. | No automatic update. |
| `/context init` or `clio-coder context init` | Performs a full codewiki rebuild before generating, preserving, proposing, or previewing `CLIO-CODER.md`; writes state with the fingerprint and codewiki version when it writes state. | No wiki generation. |
| `/context refresh` or `clio-coder context refresh` | Performs a full codewiki rebuild and writes state. Does not touch `CLIO-CODER.md`. | If an existing wiki is stale and `--wiki` was not passed on the CLI, prints a hint to run `clio-coder context refresh --wiki` or `clio-coder context wiki --update`. |
| `clio-coder context refresh --wiki` | Performs the same full codewiki rebuild and state write. | Updates an existing wiki through the model-backed page dispatches. No wiki metadata means no wiki model call. |
| `clio-coder context wiki` | Automatically refreshes the codewiki index if stale before composing the wiki prompt. | Plans, then writes each owed page in its own dispatch, assembles and promotes whatever landed (no-op if content hashes match), and records any pages still owed. |
| `clio-coder context wiki --status` | No index rebuild. | Reads metadata and reports page count, update time, recorded git head, git-head drift, and how many planned pages remain unwritten. |

### Staleness

Codewiki staleness is controlled by one predicate:
`isStale(prev, curr)` compares only `fingerprint.treeHash`. The fingerprint
hash is mtime-aware: it walks the repository, excludes generated/local-state
directories and lock/archive files, and hashes each included relative path,
file size, and floored `mtimeMs`. The fingerprint also records `gitHead` and
`loc`; `loc` comes from the codewiki artifact when available, otherwise from a
line count over source extensions. Those fields are reporting data, not the
stale predicate.

`.clio-coder/state.json` stores the fingerprint and optional `codewikiVersion`.
Legacy v2/v3/v4 codewiki files can still be read as degraded v5 artifacts, but
their missing or deliberately invalidated per-file hashes make `codewikiNeedsBackfill` true. The
next session freshness check, `code_nav` demand load, wiki generation, or
explicit refresh rebuilds them into full v5.

Wiki staleness is separate. New `.clio-coder/wiki/meta.json` files record both the git
head and the indexed source-tree hash used when the wiki content last changed.
Clio reports drift at the same git head when tracked or untracked source files
change, and combines committed and working-tree evidence in its changed-file
count. Older metadata without a source-tree hash retains the git-head-only
check. Git-less or unreadable git states degrade to `fresh` with a warning when
Clio cannot prove drift.

### Surfacing and Navigation

The compiled prompt surfaces only markers, never the codewiki JSON or wiki page
contents. Fresh codewiki renders as `<codewiki>available; use code_nav</codewiki>`.
A stale codewiki marker adds `(stale; run /context refresh)`. A valid wiki marker
names the page count and `quickstart.md`; a stale wiki marker adds `(stale; run
clio-coder context wiki --update)`.

`clio-coder context` prints a structural digest from `renderCodewikiDigest`: schema
version, project language, file/config/symbol/edge counts, language and role
counts, top areas, entry points, key symbols, and dependency samples. The
welcome dashboard shows module count, wiki page count and freshness, and a
small entry-point excerpt from the same digest. Agents query the structural
layer through the read-only `code_nav` tool. See [tool-usage.md](tool-usage.md)
for the full mode reference.
