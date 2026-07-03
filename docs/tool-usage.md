# Tool Usage Reference

This is the deep usage reference behind the deliberately terse tool descriptions in the prompt envelope. Toolkit v2 keeps rich guidance out of tool descriptions and puts it here, where `context(scope="docs", query=...)` retrieves it section by section. Each tool below has its own self-contained `##` section covering the argument surface, defaults, truncation and continuation behavior, and concrete calls. Source of truth is `src/tools/`.

## Observation envelope: truncation notices, offload, next hints, and the turn budget

The six OBSERVE tools (read, grep, find, ls, code_nav, context) share one result envelope, implemented in `src/tools/observation.ts`.

Per-call byte caps: read 50KB (env `CLIO_READ_MAX_BYTES`), grep 16KB for mode=content and 8KB for mode=files/count, find 8KB, ls 8KB, code_nav 16KB, context 16KB for scope=docs and 50KB for scope=skills/workspace.

Truncated text results append exactly one notice line:

```text
[<tool>: <shown>/<total> <unit> shown (<shownSize> of <totalSize>) | full: <offloadPath> | next: <exact-call>]
```

Segments that do not apply are omitted. `<total>` renders as `N+` when the search stopped early at its item limit, so the true total was never counted. `next:` is an exact argument fragment (for example `limit=200` or `offset=451`); re-issue the same call with that argument changed to continue.

Offload: when the byte cap cut content that was already collected, the complete rendering is written to `<clio state dir>/scratch/<sessionId>/<toolCallId>.txt` and the notice's `full:` segment names the path. Read it with `read` using offset/limit. Tools offload only when the byte cap cut collected content; a bare item-limit truncation continues via `next` and does not offload. `read` never offloads, because the source file is directly re-addressable via `offset`.

JSON-format results (code_nav, context scope=docs/workspace) never get an appended notice. An oversize JSON payload is replaced whole by the parseable stub `{"error":"result exceeded <cap>","offloadPath":"...","next":"..."}` so the model never receives JSON cut mid-document. Empty results are also valid JSON with empty arrays and `next` populated.

Turn budget: all six OBSERVE tools draw from one shared pool of 192KB per turn (env `CLIO_OBSERVATION_TURN_BUDGET_BYTES`, keyed on `sessionId:turnId`). When the remaining pool shrinks a call below its self cap, a note is appended naming the bytes already used. When the pool is exhausted, the call short-circuits with `[observation budget exhausted for this turn before <tool> ...]` instead of paying for a search whose output cannot be returned. Use narrower arguments or continue in a follow-up turn.

## read: page through a file with offset, limit, and tail

Reads one UTF-8 text file. Source: `src/tools/read.ts`.

Arguments:

- `path` (required). Relative or absolute; `~` expands to the home directory.
- `offset` (optional). 1-indexed start line; default 1.
- `limit` (optional). Max lines to return.
- `tail` (optional). Return the last N lines (jump to EOF). Overrides offset/limit.

Each call is capped at 2000 lines or 50KB, whichever hits first (`CLIO_READ_MAX_BYTES` overrides the byte cap; the per-turn observation budget can shrink it further). Files larger than 20MB error outright; use grep/find to locate the relevant region instead. A missing file errors with a hint to locate it via code_nav, find, or ls.

Continuation: a truncated result's notice carries `next: offset=<first unshown line>`. read does not offload; the file itself is the continuation source. If a single line exceeds the byte cap, the result is that line's UTF-8 prefix plus an explanatory note suggesting grep with a narrower pattern or edit with exact surrounding text. An `offset` beyond EOF errors with the file's total line count.

Reach for read when you know the path and need contents. Use grep first to find where something lives, then read the cited region with offset/limit instead of paging a large file from the top. Use `tail` for logs and build output where the interesting lines are at the end.

```text
read(path="src/tools/observation.ts")
read(path="src/interactive/chat-loop.ts", offset=451, limit=120)
read(path="build.log", tail=100)
```

## edit: exact text replacements in one file

Applies targeted replacements to an existing file. Sources: `src/tools/edit.ts`, `src/tools/edit-diff.ts`.

Arguments:

- `path` (required).
- `edits` (required). Array of `{oldText, newText}` objects. Each `oldText` must match exactly one region of the original file, and regions must not overlap.

Matching runs a cascade: exact substring match first, then a fuzzy match that normalizes Unicode punctuation, non-breaking spaces, and trailing whitespace, then an indentation-relaxed match that compares lines with leading whitespace stripped and re-applies the file's actual indentation to `newText`. If `oldText` matches more than once the call errors and asks for more surrounding context; if it matches nowhere the call errors telling you the text must match exactly including whitespace and newlines; if the result would be byte-identical the call errors with "No changes made".

The file's BOM and CRLF/LF line endings are preserved: content is normalized to LF for matching and the original ending restored on write. Same-file mutations from edit and write are serialized through a mutation queue. Success returns `edited <path>: N replacement(s)` with `details = {diff, firstChangedLine, paths}`.

Argument tolerance: `edits` sent as a JSON string is parsed, and a legacy top-level `{oldText, newText}` pair is folded into `edits`.

Prefer edit over write for any change to an existing file; the diff in details is the review surface. Batch related changes to one file into a single call with multiple disjoint edits.

```text
edit(path="src/tools/ls.ts", edits=[{oldText: "const DEFAULT_LIMIT = 500;", newText: "const DEFAULT_LIMIT = 1000;"}])
edit(path="README.md", edits=[
  {oldText: "## Install", newText: "## Installation"},
  {oldText: "npm i clio", newText: "npm install clio"}
])
```

## write: create or overwrite a whole file

Writes a complete UTF-8 file, creating parent directories as needed and overwriting silently if the file exists. Source: `src/tools/write.ts`.

Arguments:

- `path` (required).
- `content` (required). The full file contents.

Success reports the byte count written. If the previous content ended with a newline and the new content does not, the result appends a note so the dropped trailing newline is visible. Writes to the same path are serialized with edit through the file mutation queue.

Use write for new files or full regeneration. Use edit for surgical changes to an existing file; write replaces everything and produces no diff.

```text
write(path="src/tools/new-tool.ts", content="import { Type } from \"typebox\";\n...")
write(path=".clio/notes/session.md", content="# Session notes\n\n...")
```

## bash: run a shell command

Executes a command via `/bin/bash -lc` and returns combined stdout and stderr. Sources: `src/tools/bash.ts`, `src/core/bash-exec.ts`.

Arguments:

- `command` (required).
- `cwd` (optional). Working directory.
- `timeout_ms` (optional). Default 300000 (5 minutes).

Output shaping is tail-biased: the display keeps the LAST 16KB / 2000 lines, because the failing assertion, compiler error, and exit summary live at the end. Before truncating, the full output is spilled to the per-session scratch file and the appended note names the path; read it with offset/limit. A command producing more than 16MB of output is stopped with an error. A timeout or nonzero exit returns the shaped output plus a status line (`bash: command timed out after <ms>ms`, `bash: command failed (exit N)`).

Reach for bash for builds, git, package managers, and anything without a dedicated tool. Prefer the dedicated tools over their shell equivalents: grep/find/read/ls get envelope truncation, exact continuation hints, and the shared ignore policy that `cat`, shell `grep`, and shell `find` do not. Prefer `verify` over bash for declared package.json verification scripts, since verify produces typed evidence.

```text
bash(command="git status --short")
bash(command="git log --oneline -10")
bash(command="npm run build", timeout_ms=600000)
```

## grep: search file contents with ripgrep

Content search over a directory or single file, backed by ripgrep with a bounded pure-Node fallback when rg is not on PATH. Source: `src/tools/grep.ts`.

Arguments:

- `pattern` (required). Regex by default.
- `path` (optional). Directory or file; default `.`.
- `mode` (optional). `content` (default) returns matching lines with paths and line numbers, `files` returns only matching file paths (rg `-l`), `count` returns per-file match counts (rg `-c`).
- `glob` (optional). File filter, e.g. `*.ts`.
- `ignore_case` (optional boolean).
- `literal` (optional boolean). Treat the pattern as fixed text.
- `context` (optional). Context lines per match; mode=content only. Context comes from rg's `--json` stream, never a second file read.
- `limit` (optional). Max matches; default 100.
- `include_ignored` (optional boolean).

Visibility follows the shared ignore policy (`src/tools/ignore-policy.ts`): `.gitignore` is honored natively, `.clio`/`.fallow`/`.git` are always excluded, and a fixed generated-dirs list (`node_modules`, `dist`, `build`, `coverage`, `target`, `.venv`, `.next`, `.cache`, `.pytest_cache`, `.turbo`) is force-excluded even when a project forgot to gitignore it. `include_ignored=true` lifts the gitignore and generated layers together; the clio-internal layer always stands. Pointing `path` directly inside an excluded directory searches it. grep and find answer visibility from the same policy, so `grep mode=files` and `find` never disagree about which paths exist.

Rendering: match lines print as `path:line: text`, context lines as `path-line- text`. Lines longer than 500 characters are cut with a note suggesting read for the full line. No matches returns `No matches found`.

Truncation: hitting the match limit gives `next: limit=<2x>` with the total rendered as `N+`. Hitting the byte cap (16KB content, 8KB files/count) offloads the full rendering and, in content mode, suggests `next: mode=files`. Searches are killed after 30 seconds with a hint to narrow the pattern, path, or glob.

The fallback searcher (rg absent) skips files over 20MB and binary files, walks the same ignored-dir set, and stops at the match limit.

Reach for grep to find where something lives; use mode=files to map breadth cheaply before reading, and mode=count to size a rename or sweep.

```text
grep(pattern="finalizeObservation", path="src", mode="files")
grep(pattern="observationBudget", glob="*.ts", ignore_case=true)
grep(pattern="TODO|FIXME", path="src/tools", context=2, limit=50)
grep(pattern="reserveObservation(", literal=true, path="src")
```

## find: locate files and directories by glob pattern

Finds paths matching a glob, backed by fd with a bounded dirent-only fallback walker. Source: `src/tools/find.ts`.

Arguments:

- `pattern` (required). Glob dialect: `*`, `**`, `?`, `[abc]`.
- `path` (optional). Directory to search; default `.`.
- `order` (optional). `path` (default, fd's native order) or `mtime` (newest first).
- `limit` (optional). Max results; default 500.
- `include_ignored` (optional boolean).

Results are relative to the search directory, with a `/` suffix on directories. A bare pattern like `*.md` matches at any depth; a pattern containing `/` matches against the search-root-relative path and is auto-prefixed with `**/` unless anchored with `/` or `**/`. Visibility follows the same shared ignore policy as grep (see the grep section); `include_ignored=true` reveals the same extra paths in both tools.

`order="mtime"` never walks the whole tree: it collects a bounded candidate set of `max(4 * limit, 2000)` paths, stats only those, sorts newest first, and slices to `limit`. `details.candidates = {cap, collected, capHit, note?}` records the bound; when the cap was hit the ordering is approximate and `next: order=path` is suggested.

Truncation: hitting the result limit gives `next: limit=<2x>` with the total rendered as `N+`; the 8KB byte cap offloads the full path list. No matches returns `No files found matching pattern`. Searches are killed after 30 seconds.

Reach for find when you know the file's name or shape; use `order="mtime"` with a small limit to answer "what changed recently". When you know contents but not names, use `grep mode=files` instead.

```text
find(pattern="*.test.ts", path="tests")
find(pattern="src/**/*.ts", limit=200)
find(pattern="*", path="src/tools", order="mtime", limit=10)
find(pattern="**/dist/**", include_ignored=true)
```

## ls: list one directory

Lists the entries of a single directory, non-recursive. Source: `src/tools/ls.ts`.

Arguments:

- `path` (optional). Default `.`.
- `limit` (optional). Max entries; default 500.

Entries are sorted alphabetically case-insensitively, directories carry a `/` suffix, and dotfiles are included. ls reads the directory raw and applies no ignore policy, so `node_modules/` and `.git/` appear if present. Entries that vanish or cannot be statted mid-scan are skipped. An empty directory returns `(empty directory)`.

Truncation: hitting the entry limit gives `next: limit=<2x>`; the 8KB byte cap offloads the full listing. Reach for ls to orient in one directory; use find for recursive matching.

```text
ls()
ls(path="src/tools")
ls(path="docs", limit=100)
```

## dispatch: run bounded tasks on fleet agents

Dispatches one or more tasks to Clio fleet agents and returns per-run receipt summaries. Source: `src/tools/dispatch.ts`.

Arguments:

- `tasks` (required unless `list:true`). Array of task strings or `{task, agent, target, model, cwd}` objects. Per-item fields override the top-level defaults below.
- `mode` (optional). `parallel` (default) runs items concurrently; `sequential` runs them one at a time, each completing before the next dispatches. A single task always runs down the sequential path.
- `list` (optional boolean). Returns the agent catalog instead of dispatching.
- `agent` (optional). Default agent recipe for items that do not name one; default `coder`. `agent_id` is accepted as an alias inside items.
- `target` (optional). Default configured target id.
- `model` (optional). Default model override.
- `thinking_level` (optional). One of `off|minimal|low|medium|high|xhigh`, applied to all items.
- `cwd` (optional). Default agent working directory.
- `timeout_ms` (optional). Aborts the whole dispatch; in sequential mode remaining tasks are skipped and the skip is reported.
- `max_output_bytes` (optional). Summary byte budget; default 20000, split across runs with at least 1024 bytes each.

Argument tolerance: `tasks` sent as a JSON string is parsed, a single object or bare string is wrapped into an array, and a top-level `task` with no `tasks` becomes a one-element array.

Output is one batch-shaped summary even for a single task: a header `dispatch (<mode>) total=N failed=M`, the run id list, then one receipt line per run (run id, agent, exit code, target, model, tokens, receipt path, failure message if any) followed by the worker's final assistant text. `details = {mode, runIds, receiptCount, failedCount, runs[]}`. Any run with a nonzero exit turns the whole result into an error carrying the same summary. A run that succeeded without a single successful tool call carries a `note=` marker; do not treat such a run as validated work.

Treat the receipts and output as evidence, and do not repeat an identical successful dispatch in the same user turn. Follow up with `monitor` for status, event tails, and receipts, and `steer` to guide or cancel a running worker.

```text
dispatch(list=true)
dispatch(tasks=["Run the contract tests in tests/contracts/dispatch.test.ts and report each failure with its assertion"])
dispatch(tasks=[
  {agent: "researcher", task: "Map every caller of finalizeObservation and summarize the envelope shapes"},
  {agent: "coder", task: "Fix the failing assertion in tests/contracts/safety.test.ts; run verify(check=\"test\") before finishing"}
], mode="parallel")
dispatch(tasks=["Refactor step 1", "Refactor step 2"], mode="sequential", timeout_ms=600000)
```

## verify: run declared verification checks

One EXECUTE entry point for declared verification. Sources: `src/tools/verify/index.ts`, `src/tools/verify/scripts.ts`, `src/tools/verify/frontend.ts`.

Arguments:

- `check` (optional). A declared package.json script name or `"frontend"`. Omit to list available checks.
- `path` (check=frontend). Artifact file under the workspace root.
- `args` (optional). Extra arguments passed to the script after `--`. A JSON-string array is tolerated and parsed.
- `browser` (check=frontend). `auto` (default), `required`, or `off`.
- `cwd` (optional). Working directory.
- `timeout_ms` (optional). Default 120000.

`verify()` with no check lists declared checks grouped by source; today the only source is package.json scripts whose names match the verification family `test*/lint*/build*/typecheck*/check*/format*/ci*` (a family prefix, optionally followed by `:`, `.`, or `-` and a suffix, e.g. `test:unit`). `verify(check="typecheck")` runs `npm run typecheck` through the safe-exec spine with no shell; output is capped at 600000 bytes and `details = {command, cwd, exitCode, durationMs, timedOut, outputCapped}`. A script name outside the family is rejected with a pointer to run it through bash.

`verify(check="frontend", path=<file>)` validates an HTML, CSS, or JavaScript artifact without shell access. The path must stay inside the workspace root and end in `.html`, `.htm`, `.css`, `.js`, `.mjs`, or `.cjs`. Checks per type: HTML tag balance (comment-aware, HTML5 optional end tags honored), inline and referenced script syntax (classic scripts parsed in-process, modules via `node --check`), inline and linked CSS brace/string/comment balance, local script and stylesheet references resolved and existence-checked (external and root-relative references are skipped), and an optional headless browser load. `browser="auto"` warns when no chromium/chrome/edge executable is on PATH, `"required"` fails, `"off"` skips. Each check reports pass, warn, fail, or skip; any fail makes the whole result an error. `details = {action: "verify", check: "frontend", path, browserMode, status, checks}`.

Prefer verify over bash for the verification family: the typed result feeds the finish contract as validation evidence.

```text
verify()
verify(check="typecheck")
verify(check="test", args=["tests/contracts/dispatch.test.ts"])
verify(check="frontend", path="site/index.html", browser="off")
```

## context: workspace snapshot, docs retrieval, and skills

One OBSERVE entry point for material about the working environment rather than the tree itself. Sources: `src/tools/context/index.ts`, `src/tools/context/docs-engine.ts`.

Arguments:

- `scope` (required). `workspace`, `docs`, or `skills`.
- `query` (scope=docs, required). Question or terms.
- `limit` (scope=docs). Max sections; default 5, max 12.
- `name` (scope=skills). Skill to load; omit to list.
- `include_tree` (scope=skills, boolean). List up to 50 files under the skill's base_dir.

`scope="workspace"` returns the session's git/project snapshot as JSON, probing and caching it on first call. When model-visible skills are installed, the payload carries a one-line `skills` pointer (count plus the suggest protocol) so orientation surfaces the catalog; the pointer never includes catalog entries and never changes the load gate. It requires a bound session; worker registries without one get a clean error. 50KB cap.

`scope="docs"` runs deterministic, offline retrieval over Clio's bundled docs (every `docs/*.md` plus README.md, CHANGELOG.md, and CLIO.md), indexed as heading-delimited sections with light stemming, Clio vocabulary aliases, phrase boosts, and BM25-style body scoring. The JSON payload carries `corpus`, the expanded `terms`, and ranked `results` with `file`, `heading`, `breadcrumb`, `anchor`, `lines`, `snippet`, `score`, `coverage`, `matchedTerms`, and `signals`, plus an `omitted` count. Follow the `followUp` guidance: read the cited file and line range when you need the full section. Empty results are still valid JSON with `next` populated (the closest vocabulary expansion, or `query=overview`). 16KB cap; an oversize payload is replaced by the parseable JSON stub. The old `docs_search` `file` filter was dropped in the consolidation.

`scope="skills"` with no `name` lists installed skills with descriptions; the listing asks the model to match the current task against the catalog and, on a fit, to open its reply with `Suggested skill: /skill:<name>` (a comma-separated sequence when skills compose) and wait for the operator. Loading a body is policy-gated: a skill loads only after an explicit operator request (a `/skill:<name>` or `/skill <name>` task, including one picked from the Skills Hub), and recipe-bound workers may load only their declared skills. A load attempt without a pending request is denied with the model's compliant next move spelled out: do not retry, open the reply with the `Suggested skill: /skill:<name>` line and wait for the operator, or continue without skills. On the first substantive turn of a session with model-visible skills installed, a once-per-session middleware reminder in the user message teaches the same protocol. A pending request's task text is surfaced with the body. Marketplace-installed skills are drift-checked against their pinned hash; a mismatch annotates the result with a `skill_drift` warning but never blocks. 50KB cap; a truncated body offloads in full.

```text
context(scope="workspace")
context(scope="docs", query="dispatch receipts evidence", limit=8)
context(scope="skills")
context(scope="skills", name="context-prime", include_tree=true)
```

## code_nav: navigate the codewiki index

Structural navigation over the persisted codewiki index (`.clio/codewiki.json`, built by `clio context-index`). Source: `src/tools/codewiki/code-nav.ts`. Errors cleanly when the index has not been built.

Arguments:

- `mode` (required). `symbol`, `path`, `entries`, `outline`, `deps`, or `dependents`.
- `query` (required for every mode except `entries`). Symbol name, indexed path, path pattern, or path substring.
- `limit` (optional). Default 50 (25 for `entries`), max 200.

Modes:

- `symbol`: exact symbol name lookup. Returns the definition records (name, kind, path, line, signature) plus owning file summaries, so you get the exact `file:line` without grepping. No match suggests `next: mode=path query=<q>`.
- `path`: match indexed file paths by glob, `/regex/flags`, regex-looking pattern, or plain substring.
- `entries`: likely entry points, ranked from file roles and package.json `main`/`bin`.
- `outline`: all symbols declared in one file, sorted by line.
- `deps`: a file's internal and external imports. `dependents`: the files that import it.

For `outline`, `deps`, and `dependents` the query must resolve to exactly one indexed file: an exact path or a substring matching one path. An ambiguous substring errors with the match count. Output is always parseable JSON (empty results carry empty arrays, an `omitted` count, and `next`); an omitted remainder suggests `next: limit=<2x>`. 16KB cap with the JSON stub on overflow.

Reach for code_nav instead of grep when you want a definition site, a file's structure, or change-impact fan-out; it reads the local index, not the tree.

```text
code_nav(mode="symbol", query="finalizeObservation")
code_nav(mode="outline", query="src/tools/grep.ts")
code_nav(mode="dependents", query="src/tools/observation.ts")
code_nav(mode="entries")
```

## monitor: inspect dispatched runs

Read-only visibility into dispatched runs, built on the dispatch domain's ledger, live snapshot, and the event stream the dispatch tool consumes. Source: `src/tools/monitor.ts`. Read class; runs in parallel with other reads.

Arguments:

- `run_id` (optional). A run id from dispatch output.
- `mode` (optional). `list`, `status`, `peek`, or `receipt`. Default is `status` when `run_id` is given, `list` otherwise.

Modes:

- `list`: up to 20 known runs, newest first, scoped to this session when it has runs and otherwise all sessions. Each line carries the run id, agent, state, start time, tokens, and receipt path.
- `status`: one run's state and outcome, target/model/runtime, start/end times, exit code, tokens, cost, and receipt path. A still-running run adds a live line with phase, heartbeat, elapsed seconds, and token count.
- `peek`: the bounded tail of the run's recent events buffered in this process (an in-process ring of 100 events per run across at most 64 runs, heartbeats excluded, 8KB output with the oldest entries trimmed first). Runs dispatched by another process, or before this process started, have no tail; monitor says so and points at `mode="receipt"` or `mode="status"`.
- `receipt`: the stored receipt JSON, truncated at 14KB with a note naming the receipt path so you can read the rest.

Use monitor to check on parallel workers without interrupting them; pair with steer when a run needs correction.

```text
monitor(mode="list")
monitor(run_id="run-01H...")
monitor(run_id="run-01H...", mode="peek")
monitor(run_id="run-01H...", mode="receipt")
```

## steer: guide or cancel a running worker

Controls a running dispatched worker. Source: `src/tools/steer.ts`. Dispatch class; sequential.

Arguments:

- `run_id` (required). A run id from dispatch output.
- `action` (required). `guide` or `cancel`.
- `message` (required for `guide`). The steering text.

`action="guide"` injects the message through the dispatch contract's stdin steer channel; the worker sees it as a user message at its next turn boundary, so delivery is acknowledged immediately but takes effect on the worker's next turn. Guide reaches native workers only; other runtimes return the contract's structured "no input channel" error verbatim.

`action="cancel"` aborts a non-terminal run; the run finalizes with `outcome=canceled` and its receipt records the cancellation. A run that already finished (completed, failed, interrupted, stale, or dead) errors with its state, since there is nothing to cancel.

Prefer guide over cancel-and-redispatch when the worker is on track but needs a scope correction; the worker keeps its context.

```text
steer(run_id="run-01H...", action="guide", message="Skip the docs sweep; limit the fix to tests/contracts and report the diff.")
steer(run_id="run-01H...", action="cancel")
```

## artifact: plans, reviews, and reports

Terminal document writers behind one surface. Source: `src/tools/artifact.ts`.

Arguments:

- `kind` (required). `plan`, `review`, or `report`.
- `content` (required). Full Markdown body.
- `title` (optional). Document title.
- `path` (optional). Override the default artifact path.

`kind=plan|review|report` writes a Markdown document to PLAN.md, REVIEW.md, or REPORT.md at the project root by default; `path` may override the destination but must stay inside the workspace. When `content` does not already start with `#`, a non-empty `title` is prepended as an H1. These kinds are TERMINAL: writing the artifact completes the turn and the harness skips the follow-up model call, so the artifact body itself is the answer. Put everything the reader needs in `content`; there is no closing message after the write.

Skills are not artifacts. A skill is a `SKILL.md` folder written with the ordinary write tool into `.clio/skills/<name>/` (or the user skill store) and validated by the skills loader; the `skill-craft` shipped skill documents the format and craft rules.

```text
artifact(kind="plan", content="# Migration plan\n\n## Step 1 ...")
artifact(kind="report", title="Benchmark results", path="docs/reports/bench.md", content="...")
artifact(kind="review", content="# Review: toolkit-v2\n\n## Findings ...")
```
