# Tool Usage Reference

> [!TIP]
> **Interactive Spec Available:** An interactive seven-plane tool atlas and observation envelope truncation/offload calculator is located at [docs/html/tool_usage_blueprint.html](html/tool_usage_blueprint.html) (Version: 0.3.8).

This is the deep usage reference behind the deliberately terse tool descriptions in the prompt envelope. Toolkit v2 keeps rich guidance out of tool descriptions and puts it here, where `context(scope="docs", query=...)` retrieves it section by section. Each tool below has its own self-contained `##` section covering the argument surface, defaults, truncation and continuation behavior, and concrete calls. Source of truth is `src/tools/`.

In Clio Coder v0.3.7, `src/tools/agent-tools.ts` serves as the single agent-tool adapter across both orchestrator and worker runtimes. Both surfaces resolve their executable tools through the exact same `effectiveToolNames` narrowing, ensuring that attested tool schemas never drift from the tools available at runtime. Tools are keyed strictly by the `ToolName` union with no alias table. Argument leniency for weak-model callers is provided exclusively by per-tool `prepareArguments` normalizers declared on `ToolSpec`.

## Observation envelope: truncation notices, offload, next hints, and the turn budget

The six OBSERVE tools (read, grep, find, ls, code_nav, context) share one result envelope, implemented in `src/tools/observation.ts`.

Per-call byte caps: read 50KB (env `CLIO_CODER_READ_MAX_BYTES`), grep 16KB for mode=content and 8KB for mode=files/count, find 8KB, ls 8KB, code_nav 16KB, context 16KB for scope=docs and 50KB for scope=skills/workspace.

Truncated text results append exactly one notice line:

```text
[<tool>: <shown>/<total> <unit> shown (<shownSize> of <totalSize>) | full: <offloadPath> | next: <exact-call>]
```

Segments that do not apply are omitted. `<total>` renders as `N+` when the search stopped early at its item limit, so the true total was never counted. `next:` is an exact argument fragment (for example `limit=200` or `offset=451`); re-issue the same call with that argument changed to continue.

Offload: when the byte cap cut content that was already collected, the complete rendering is written to `<clio-coder state dir>/scratch/<sessionId>/<sha256 of the captured text>.txt` and the notice's `full:` segment names the path. Read it with `read` using offset/limit. Tools offload only when the byte cap cut collected content; a bare item-limit truncation continues via `next` and does not offload. `read` never offloads, because the source file is directly re-addressable via `offset`.

JSON-format results (code_nav, context scope=docs/workspace) never get an appended notice. An oversize JSON payload is replaced whole by the parseable stub `{"error":"result exceeded <cap>","offloadPath":"...","next":"..."}` so the model never receives JSON cut mid-document. Empty results are also valid JSON with empty arrays and `next` populated.

Turn budget: all six OBSERVE tools draw from one shared pool of 192KB per turn (env `CLIO_CODER_OBSERVATION_TURN_BUDGET_BYTES`, keyed on `sessionId:turnId`). When the remaining pool shrinks a call below its self cap, a note is appended naming the bytes already used. When the pool is exhausted, the call short-circuits with `[observation budget exhausted for this turn before <tool> ...]` instead of paying for a search whose output cannot be returned. Use narrower arguments or continue in a follow-up turn.

## read: page through a file with offset, limit, and tail

Reads one UTF-8 text file. Source: `src/tools/read.ts`.

Arguments:

- `path` (required). Relative or absolute; `~` expands to the home directory.
- `offset` (optional). 1-indexed start line; default 1.
- `limit` (optional). Max lines to return.
- `tail` (optional). Return the last N lines (jump to EOF). Overrides offset/limit.

Each call is capped at 2000 lines or 50KB, whichever hits first (`CLIO_CODER_READ_MAX_BYTES` overrides the byte cap; the per-turn observation budget can shrink it further). Files larger than 20MB error outright; use grep/find to locate the relevant region instead. A missing file errors with a hint to locate it via code_nav, find, or ls.

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

The file's BOM and CRLF/LF line endings are preserved: content is normalized to LF for matching and the original ending restored on write. Same-file mutations from edit and write are serialized through a mutation queue. Success returns `edited <path>: N replacement(s)` plus a one-line validation nudge (rerun the failing test or verify; navigation tools do not validate edits), with `details = {diff, firstChangedLine, paths}`.

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
write(path=".clio-coder/notes/session.md", content="# Session notes\n\n...")
```

## bash: run a shell command

Executes a command in a fresh `/bin/bash` per call and returns combined stdout and stderr. The login environment is captured once per process (one `bash -lc 'env -0'`) and reused, so every call gets the profile-shaped PATH without re-sourcing the profile chain; when the capture fails the tool falls back to per-call `-lc`. Sources: `src/tools/bash.ts`, `src/core/bash-exec.ts`.

Arguments:

- `command` (required).
- `cwd` (optional). Working directory; resolved against the session workspace and rejected when it escapes it. The safety net blocks an escaping cwd at admission, and the tool enforces the same rule itself.
- `timeout_ms` (optional). Default 300000 (5 minutes).
- `output_policy` (optional). Canonical model-context disposition: `full`, `bounded`, `summary`, or `metadata-only`. Omission is exactly `bounded`.

Workspace containment: commands whose filesystem targets resolve outside the session workspace escalate to `system_modify` and ask for one-shot confirmation at every autonomy level (headless runs deny asks). Recognized targets are shell redirects, `tee`/`mkdir`/`touch` path operands, `cp`/`mv`/`ln` destinations, in-place `sed -i` operands, and any `cd`/`pushd` whose directory leaves the workspace, since a `cd` outside re-bases every relative path that follows it. Inside-workspace equivalents stay plain `execute` with no new prompts.

The default `bounded` policy keeps a tail-biased model excerpt under the 16KB result budget, because the failing assertion, compiler error, and exit summary usually live at the end. `summary` is useful for noisy builds and test runs: code deterministically selects a bounded head, tail, and error-like lines, applies Clio's repository secret redactor, and records the source hash and algorithm in summary provenance. `metadata-only` is appropriate when the model needs only outcome and termination facts; stdout and stderr stay out of model context while the operator presentation, retained byte size, and retrieval path remain available. `full` is for output known to be small. It is admitted only when the complete captured result and its facts fit the bounded result/context budget; otherwise the result explicitly records a typed downgrade to tail-biased `bounded` and provides retrieval. Do not use `full` as the routine default.

Presentation is independent from model context. The operator-facing display remains folded and tail-biased under every policy. When the display or selected context omits captured content, the terminal result writes one per-session scratch artifact and names it in the result. Live updates use the selected policy, remain bounded, and never write per-update artifacts. Every terminal result records requested and applied context modes, captured/displayed/context bytes, truncation or downgrade state, and any offload path. Exit code, signal, timeout, abort, and output-cap facts survive every policy. Scratch retrieval may contain the raw retained output; the deterministic `summary` projection is the redacted surface.

A command producing more than 16MB of combined output is stopped with an error. UTF-8 decoding spans process chunks, and a code point split by the hard byte cap is discarded rather than replaced with an invalid character. Raw NUL bytes are removed from model context under every policy, which leaves multi-byte code points and ANSI escape sequences whole; the operator presentation and the scratch artifact keep the captured bytes, and the result still records the omission and its retrieval path. A timeout, abort, output cap, or nonzero exit preserves captured diagnostics and appends a status line such as `bash: command timed out after <ms>ms` or `bash: command failed (exit N)` before canonical shaping.

Reach for bash for builds, git, package managers, and anything without a dedicated tool. Prefer the dedicated tools over their shell equivalents: grep/find/read/ls get envelope truncation, exact continuation hints, and the shared ignore policy that `cat`, shell `grep`, and shell `find` do not. Prefer `verify` over bash for declared package scripts and project-catalog entries, since verify produces typed evidence.

```text
bash(command="git status --short")
bash(command="git log --oneline -10")
bash(command="npm run build", timeout_ms=600000)
bash(command="npm run test", timeout_ms=600000, output_policy="summary")
bash(command="make artifact", output_policy="metadata-only")
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

Visibility follows the shared ignore policy (`src/tools/ignore-policy.ts`): `.gitignore` is honored natively, `.clio-coder`/`.fallow`/`.git` are always excluded, and a fixed generated-dirs list (`node_modules`, `dist`, `build`, `coverage`, `target`, `.venv`, `.next`, `.cache`, `.pytest_cache`, `.turbo`) is force-excluded even when a project forgot to gitignore it. `include_ignored=true` lifts the gitignore and generated layers together; the clio-internal layer always stands. Pointing `path` directly inside an excluded directory searches it. grep and find answer visibility from the same policy, so `grep mode=files` and `find` never disagree about which paths exist.

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

## credential_present: check environment or file for a credential key

Checks whether a credential key is present in the process environment or an env-style file (like `.env`) without ever returning the value of the credential. Source: `src/tools/credential-present.ts`. Read class; parallel.

Arguments:

- `name` (required). Credential key name, e.g. `OPENAI_API_KEY`. Must match `[A-Za-z_][A-Za-z0-9_]*`.
- `source` (optional). One of `auto`, `environment` (or `env`), or `file`. Default `auto`.
  - `auto`: Checks the process environment, and checks the env-style file if `file` is supplied.
  - `environment`/`env`: Checks only the process environment.
  - `file`: Checks only the env-style file.
- `file` (optional). Env-style file path to check, e.g. `.env`.

Returns a JSON presence summary mapping containing:
- `name`: The checked credential key name.
- `present`: Boolean indicating if the credential is found in any checked source.
- `source`: The source that matched (`environment`, `file`, `both`, or `none`).
- `checked`: Array listing the sources actually checked (`environment` and/or `file`).
- `file`: The env-style file path checked, if applicable.
- `fileMissing`: True if the file path was specified but does not exist.

```text
credential_present(name="OPENAI_API_KEY")
credential_present(name="MY_SECRET_KEY", source="file", file=".env")
```

## dispatch: run bounded tasks on fleet agents

Dispatches one or more tasks to Clio fleet agents and returns per-run receipt summaries. Source: `src/tools/dispatch.ts`.

Arguments:

- `task` (required for the singular form unless `list:true`). One worker assignment/instruction string. It is distinct from briefing.
- `tasks` (required for the batch form unless `list:true`). Array of task strings or `{task, agent, target, model, cwd, briefing, intent, gate}` objects. Per-item fields override the top-level defaults below. Supplying both `task` and `tasks` is an error.
- `mode` (optional). `parallel` (default) runs items concurrently; `sequential` runs them one at a time, each completing before the next dispatches. `pipeline`, `compete`, and `council` select their named topologies. A single ordinary task always runs down the sequential path.
- `roster` (council only). Names one `workers.rosters` entry. Supply exactly one of `roster` or `members`.
- `members` (council only). Supplies two to five inline `{label,target,model?,thinking?}` entries.
- `synthesis` (council only). Accepts `none`, `judge`, or `vote`; the default is `none`.
- `rounds` (council only). Accepts an integer from 1 through 3; the default is 1.
- `judge` (council only with judge synthesis, or compete). Accepts optional `agent`, `model`, `target`, and `node` route fields.
- `detach` (optional boolean). For parallel fan-out, returns the durable batch id and assignment ids after registration while the shared event consumer continues in the background. An assignment id equals its first attempt's run id. This is the parent model's route to mid-run monitor/steer; ordinary synchronous, sequential, and pipeline calls auto-wait for each assignment's terminal attempt.
- `list` (optional boolean). Returns the agent catalog instead of dispatching.
- `agent` (optional). Default agent recipe for items that do not name one; default `coder`. `agent_id` is accepted as an alias inside items.
- `target` (optional). Default configured target id.
- `model` (optional). Default model override.
- `node` (optional). Default fleet-node pin.
- `failover` (optional). `none|approved|automatic`. Manual target/model/node pins default to `none`; `approved` requires `allowed_candidates`; `automatic` permits route-part-aware infrastructure failover.
- `allowed_candidates` (optional). Ordered exact `{agent, target, model, node}` tuples. Valid only with `failover:"approved"`; retries cannot escape this envelope.
- `thinking_level` (optional). One of `off|minimal|low|medium|high|xhigh|max`, applied to all items.
- `cwd` (optional). Default agent working directory.
- `timeout_ms` (optional). Aborts the whole dispatch; in sequential mode remaining tasks are skipped and the skip is reported.
- `briefing` (optional string, top-level default or per-task override). Parent-composed context/data, not worker instructions: it cannot replace `task`. It is trimmed and omitted when blank, rejected above 12,000 UTF-8 bytes, sent as its own delimited untrusted dynamic message, and retained only as byte/hash provenance. The shared value applies to string tasks and object tasks without an override; an object-level briefing wins.
- `intent` (optional object, top-level default or per-task override). Declares `read_roots`, `write_roots`, `relevant_paths`, `expected_outputs`, and `verification`. Path arrays contain normalized repository-relative POSIX paths. Verification entries contain a declared `check` id and optional `timeout_ms`; ids are resolved from package scripts and `.clio-coder/verifiers.yaml` before approval. Checks are ids, not shell commands.
- `gate` (optional string, top-level default or per-task override). Exact shorthand for `intent.verification=[{check: gate}]`. Supplying it together with `intent.verification` is refused.
- `max_output_bytes` (optional). Summary byte budget; default 20000, split across runs with at least 1024 bytes each.

Argument tolerance: `tasks` sent as a JSON string is parsed and a single object or bare string is wrapped into an array. The top-level singular `task` is first-class. Briefing-only calls fail with guidance that briefing is context and cannot replace a task.

Output is one batch-shaped summary even for a single task: a header `dispatch (<mode>) total=N failed=M`, the assignment id list, then one terminal-attempt receipt line per assignment (run id, agent, exit code, target, model, tokens, receipt path, verification state, failure message if any) followed by the worker's final assistant text. `details = {mode, assignmentIds, receiptCount, failedCount, runs[]}`, and each `runs[]` entry carries distinct `assignmentId` and terminal `runId` fields plus the structured `verification` state and `receiptIntegrity` result. There is no `runIds` compatibility alias. Any terminal attempt with a nonzero exit turns the whole result into an error carrying the same summary. A run that succeeded without a single successful tool call carries a `note=` marker; do not treat such a run as validated work.

The summary separates five things that must never be conflated: `receipt_integrity=verified/v19/sha256` comes only from verification against the ledger; `host_verification=<status>` describes orchestrator-executed declared checks; `evidence_verification=<state>/<basis>` describes worker-tool validation evidence; `briefing=bytes:<n> sha256:<hash>` authenticates parent-supplied data; and `project_context=...` authenticates the independently rendered bounded project message. A tampered receipt renders a head-anchored `RECEIPT INTEGRITY FAILED` banner. A read-only Scout can have verified integrity with `not_applicable/read-only-agent` evidence. Missing briefing is `briefing=none`, never a project-context hash.

Exit zero is insufficient without a durable deliverable. A successful native or ACP run must seal a nonempty `output.state="final"`. Otherwise it fails with `worker_final_output_missing`; any unfinished text remains partial diagnostics and automatic retry is suppressed. Live tool-use preambles never replace a missing receipt answer.

Sealed receipts are the durable evidence; worker prose remains advisory until verified or spot-checked. Treat a successful reconnaissance receipt as an index and normally spot-check no more than six risk-weighted citations. Parent spot-checking is not independent specialist confirmation. For detached work, `wait` only observes; `collect` closes the batch and is required before final synthesis. Collection resolves each assignment to its terminal attempt and includes `assignmentId`, `terminalRunId`, and `attemptRunIds`; each failed earlier attempt remains available through monitor/ledger receipt lookup. A successful steer records ordered byte/hash/timestamp and acknowledgement provenance without storing prose. After a loop guard blocks a repeated call, do not retry the same call or a syntactic variant. When a report is requested but file modification is forbidden, answer in the final assistant response rather than creating `REPORT.md`.

```text
dispatch(list=true)
dispatch(agent="debugger", task="Adversarially verify the strict v19 receipt boundary", briefing="Prior receipt R1 cited receipt-integrity.ts and left these claims unresolved", detach=true)
dispatch(tasks=["Run the contract tests in tests/contracts/dispatch.test.ts and report each failure with its assertion"])
dispatch(tasks=[
  {agent: "researcher", task: "Map every caller of finalizeObservation and summarize the envelope shapes"},
  {agent: "coder", task: "Fix the failing assertion in tests/contracts/safety.test.ts", intent: {write_roots: ["tests/contracts"], verification: [{check: "test"}]}}
], mode="parallel")
dispatch(tasks=["Refactor step 1", "Refactor step 2"], mode="sequential", timeout_ms=600000)
```

## verify: run declared verification checks

One EXECUTE entry point for declared verification. Sources: `src/tools/verify/index.ts`, `src/tools/verify/catalog.ts`, `src/tools/verify/scripts.ts`, `src/tools/verify/authoring.ts`, `src/tools/verify/frontend.ts`.

Arguments:

- `check` (optional). A declared project-catalog ID, package.json script name, or `"frontend"`. Omit to list available checks.
- `path` (check=frontend). Artifact file under the workspace root.
- `args` (package scripts only). Extra arguments passed after `--`. A JSON-string array is tolerated and parsed. Project-catalog checks ignore this field.
- `browser` (check=frontend). `auto` (default), `required`, or `off`.
- `cwd` (package scripts only). Package working directory. Project catalogs are always discovered at the session workspace root, and a project check uses its declared `cwd`.
- `timeout_ms` (package scripts and frontend only). Default 120000. A project check uses its declared `timeoutMs`.
- `max_output_bytes` (package scripts and frontend only). Default 600000. Project checks retain the safe-exec default cap.

`verify()` lists checks grouped as `package.json` and `.clio-coder/verifiers.yaml`. Both providers project through the same canonical metadata: `{id, description, command, cwd, timeoutMs, tags, source}`. Package scripts must match the verification family `test*/lint*/build*/typecheck*/check*/format*/ci*` (a family prefix, optionally followed by `:`, `.`, or `-` and a suffix, e.g. `test:unit`). `verify(check="typecheck")` runs `npm run typecheck` through the safe-exec spine with no shell. A package script name outside the family is rejected with a pointer to run it through bash.

### Project verifier catalog

Projects may commit a versioned executable catalog at `.clio-coder/verifiers.yaml`:

```yaml
version: 1
checks:
  - id: rust-workspace
    description: Run the Rust workspace tests
    command: [cargo, test, --workspace]
    cwd: .
    timeoutMs: 600000
    tags: [rust, test]
```

Version 1 is strict. Every root and check field shown above is required, unknown fields fail, and duplicate IDs fail. A project ID uses lowercase letters, digits, `.`, `_`, `:`, or `-`, begins with a letter or digit, and is at most 64 UTF-8 bytes. `frontend` is reserved. Descriptions are trimmed single-line text capped at 512 bytes. `command` is a nonempty argv array with at most 64 entries and 4096 bytes per entry. A shell command string is invalid, and explicit shell executables such as `sh`, `bash`, `pwsh`, and `cmd` are rejected. `cwd` is a repository-relative existing directory capped at 512 bytes; absolute paths, `..` escapes, and symbolic-link escapes fail. `timeoutMs` is a positive integer capped at 900000. A check may carry at most 16 distinct lowercase tags of at most 32 bytes each. The whole file is capped at 262144 bytes and may contain at most 128 checks. YAML aliases are disabled.

Provider IDs share one namespace. If a catalog ID collides with a discovered package script, listing and execution fail and identify both source files. Catalog parsing also fails closed before any package or project check runs.

`verify(check="rust-workspace")` spawns exactly `cargo` with `test` and `--workspace`; it does not interpolate model text or invoke a shell. Model-supplied `args`, `cwd`, `timeout_ms`, `max_output_bytes`, or undeclared environment fields cannot widen or replace the catalog entry. Safe execution passes only Clio's small environment allowlist, applies cancellation and the declared timeout, and shapes output at the standard 600000-byte cap. Execution details retain the compatible command string plus exact `argv`, `cwd`, `exitCode`, `durationMs`, `aborted`, `timedOut`, and `outputCapped` evidence, along with the check's declared source, command, cwd, timeout, description, and tags.

### Guided catalog authoring

An empty `verify()` result points to `clio-coder verifiers author`. The authoring command inspects only command-bearing files at the workspace root:

- verification-family package scripts, projected exactly as `npm run <script>` and shown as already active rather than duplicated into the catalog;
- `Cargo.toml`, projected to Cargo's package or workspace test vector;
- visible build and test entries in `CMakePresets.json`, projected to the corresponding `cmake --build --preset` or `ctest --preset` vector;
- declared Python runners in `pyproject.toml`, `pytest.ini`, `tox.ini`, `noxfile.py`, or the pytest section of `setup.cfg`;
- a module directive in `go.mod`, projected to `go test ./...`;
- top-level `validators` entries in the documented YAML scientific-validation files.

Every proposal records its source path and location and labels the command origin as `project-declared` or `toolchain-defined`. Project-declared examples include a package script, a Python entry point, and an exact validation-contract command. Toolchain-defined examples include Cargo's test command, a named CMake preset invocation, a configured Python runner, and Go's module test command. Validation command strings are converted to argv only when their quoting is complete and they contain no shell operators, expansion, redirection, or environment assignment. Ambiguous entries and `VALIDATION.md` prose receive a manual-entry diagnostic. Directory names such as `build`, `tests`, `python`, or `cargo` never imply a command.

`discover` and every mutating command first print an authority preview. Each check shows the destination or active source path, source provenance, exact JSON argv vector, repository-relative cwd, timeout, tags, and effective execution authority. Preview and discovery do not create `.clio-coder`, write a file, or run a check. A mutating command without `--yes` ends after the preview. Repeating the reviewed command with `--yes` is the explicit write decision; the serialized YAML must pass the production catalog parser before the atomic write is reachable.

```text
clio-coder verifiers discover
clio-coder verifiers author
clio-coder verifiers author --exclude cmake-build-debug --rename go-test=go-suite
clio-coder verifiers author --dry-run go-suite --yes
clio-coder verifiers validate
```

`validate` reads the committed file with the same parser used by `verify()`. `dry-run <id>` is an explicit request to execute one admitted check through the production `verify` path. `author --dry-run <id> --yes` writes only after confirmation and starts the selected dry run only after the write is accepted by production discovery.

Later changes use the same preview and confirmation boundary. `edit` preserves the ID unless `rename` is requested. Renames and additions reject collisions with catalog IDs and active package-script IDs. Removals state that the deleted command will no longer be executable through catalog authority. Generated IDs are stable for a stable ordered signal set; a collision receives the first available deterministic `-2`, `-3`, and later suffix.

```text
clio-coder verifiers add --id validate-grid --description "Validate the regional grid" --command '["python","tools/check_grid.py","out/region_west.nc"]'
clio-coder verifiers add --id validate-grid --description "Validate the regional grid" --command '["python","tools/check_grid.py","out/region_west.nc"]' --tags scientific,netcdf --yes
clio-coder verifiers edit validate-grid --timeout-ms 300000
clio-coder verifiers rename validate-grid validate-regional-grid --yes
clio-coder verifiers remove validate-regional-grid --yes
```

The `add` command is the explicit path for an unsupported or ambiguous project. `--command` must be a JSON argv array, so manual entry still cannot turn a shell command string into executable catalog authority.

`verify(check="frontend", path=<file>)` validates an HTML, CSS, or JavaScript artifact without shell access. The path must stay inside the workspace root and end in `.html`, `.htm`, `.css`, `.js`, `.mjs`, or `.cjs`. Checks per type: HTML tag balance (comment-aware, HTML5 optional end tags honored), inline and referenced script syntax (classic scripts parsed in-process, modules via `node --check`), inline and linked CSS brace/string/comment balance, local script and stylesheet references resolved and existence-checked (external and root-relative references are skipped), and an optional headless browser load. `browser="auto"` warns when no chromium/chrome/edge executable is on PATH, `"required"` fails, `"off"` skips. Each check reports pass, warn, fail, or skip; any fail makes the whole result an error. `details = {action: "verify", check: "frontend", path, browserMode, status, checks}`.

Prefer verify over bash for the verification family and project catalog: the typed result feeds the finish contract as validation evidence.

```text
verify()
verify(check="typecheck")
verify(check="test", args=["tests/contracts/dispatch.test.ts"])
verify(check="rust-workspace")
verify(check="frontend", path="site/index.html", browser="off")
```

## git: read-only inspection of git repository state

Executes read-only inspection commands against the local git repository. Source: `src/tools/safe-exec.ts`. Read class; parallel.

Arguments:

- `op` (required). The inspection operation to run: `status`, `diff`, or `log`.
- `path` (optional). Limit diff/log to a specific file or directory path.
- `cached` (optional boolean). For `op="diff"`: staged changes (`--cached`).
- `stat` (optional boolean). For `op="diff"`: summary only (`--stat`).
- `name_only` (optional boolean). For `op="diff"`: file names only.
- `limit` (optional number). For `op="log"`: commits to show (default 20, max 200).
- `cwd` (optional). Working directory.

Commands map directly to git subprocess execution:
- `op="status"` runs `git status --short --branch`.
- `op="diff"` runs `git diff` with optional `--cached`, `--stat`, or `--name-only` flags.
- `op="log"` runs `git log --oneline -n <limit>` listing recent commit shas and subjects.

```text
git(op="status")
git(op="diff", stat=true)
git(op="diff", path="src/tools/safe-exec.ts")
git(op="log", limit=10)
```

## context: workspace snapshot, docs retrieval, and skills

One OBSERVE entry point for material about the working environment rather than the tree itself. Sources: `src/tools/context/index.ts`, `src/tools/context/docs-engine.ts`.

Arguments:

- `scope` (required). `workspace`, `docs`, or `skills`.
- `query` (scope=docs). Question or terms; omit to list the corpus (files plus doc/section counts) instead of searching.
- `limit` (scope=docs). Max sections; default 5, max 12.
- `name` (scope=skills). Skill to load; omit to list.
- `include_tree` (scope=skills, boolean). List up to 50 files under the skill's base_dir.

`scope="workspace"` returns the session's git/project snapshot as JSON, probing and caching it on first call. When model-visible skills are installed, the payload carries a one-line `skills` pointer (count plus the suggest protocol) so orientation surfaces the catalog; the pointer never includes catalog entries and never changes the load gate. It requires a bound session; worker registries without one get a clean error. 50KB cap.

`scope="docs"` runs deterministic, offline retrieval over Clio's bundled docs (every `docs/*.md` plus README.md, CHANGELOG.md, and CLIO-CODER.md), indexed as heading-delimited sections with light stemming, Clio vocabulary aliases, phrase boosts, and BM25-style body scoring. The JSON payload carries `corpus`, the expanded `terms`, and ranked `results` with `file`, `heading`, `breadcrumb`, `anchor`, `lines`, `snippet`, `score`, `coverage`, `matchedTerms`, and `signals`, plus an `omitted` count. Follow the `followUp` guidance: read the cited file and line range when you need the full section. Empty results are still valid JSON with `next` populated (the closest vocabulary expansion, or `query=overview`). 16KB cap; an oversize payload is replaced by the parseable JSON stub. The old `docs_search` `file` filter was dropped in the consolidation. Omitting `query` returns the corpus listing (the file set plus doc and section counts, the same `corpus` shape a search carries) so the model can pick a term without wasting a round on a `requires query` error.

`scope="skills"` with no `name` lists installed skills with descriptions; the listing asks the model to match the current task against the catalog and, on a fit, to open its reply with `Suggested skill: /skill <name>` (a comma-separated sequence when skills compose) and wait for the operator. Loading a body is policy-gated: a skill loads only after an explicit `/skill <name> [task]` operator request, including one picked from the Skills Hub, and recipe-bound workers may load only their declared skills. A load attempt without a pending request is denied with the model's compliant next move spelled out: do not retry, open the reply with the `Suggested skill: /skill <name>` line and wait for the operator, or continue without skills. On the first substantive turn of a session with model-visible skills installed, a once-per-session middleware reminder in the user message teaches the same protocol. A pending request's task text is surfaced with the body. Marketplace-installed skills are drift-checked against their pinned hash; a mismatch annotates the result with a `skill_drift` warning but never blocks. 50KB cap; a truncated body offloads in full.

```text
context(scope="workspace")
context(scope="docs", query="dispatch receipts evidence", limit=8)
context(scope="skills")
context(scope="skills", name="context-prime", include_tree=true)
```

## code_nav: navigate the codewiki index

Structural navigation over the persisted codewiki index (`.clio-coder/codewiki.json`)
and the optional Markdown wiki metadata. The index is built by context init,
refresh, or index commands and can be rebuilt/backfilled on tool demand. Source:
`src/tools/codewiki/code-nav.ts`.

Arguments:

- `mode` (required). `symbol`, `path`, `entries`, `outline`, `deps`, `dependents`, or `wiki`.
- `query` (required for every mode except `entries` and `wiki`). Symbol name, indexed path, path pattern, or path substring.
- `limit` (optional). Default 50 (25 for `entries`), max 200.

Modes:

- `symbol`: returns declaration records for an exact symbol name, including path, line, kind, and signature.
- `path`: returns indexed files whose paths match a glob, `/regex/flags`, regex-looking pattern, or substring.
- `entries`: returns likely entry points ranked from file roles and `package.json` `main`/`bin`.
- `outline`: returns declarations in one indexed file, sorted by line.
- `deps`: returns one indexed file's internal and external imports.
- `dependents`: returns indexed files that import the target file.
- `wiki`: returns Markdown wiki pages plus absent/fresh/stale wiki state and layout warnings.

For `outline`, `deps`, and `dependents` the query must resolve to exactly one indexed file: an exact path or a substring matching one path. An ambiguous substring errors with the match count. Output is always parseable JSON (empty results carry empty arrays, an `omitted` count, and `next`); an omitted remainder suggests `next: limit=<2x>`. 16KB cap with the JSON stub on overflow.

Reach for code_nav instead of grep when you want a definition site, a file's structure, change-impact fan-out, or wiki inventory; it reads local artifacts, not the tree.

```text
code_nav(mode="symbol", query="finalizeObservation")
code_nav(mode="outline", query="src/tools/grep.ts")
code_nav(mode="dependents", query="src/tools/observation.ts")
code_nav(mode="entries")
code_nav(mode="wiki")
```

## web_fetch: fetch http(s) URLs and convert HTML to markdown

Fetches content from an http(s) URL. HTML content is automatically cleaned and converted to readable Markdown. Source: `src/tools/web-fetch.ts`. Read class; parallel.

Arguments:

- `url` (required). Fully-qualified http(s) URL.
- `method` (optional). HTTP method (default `GET`).
- `headers` (optional). Key-value request headers.
- `body` (optional). Request body string.
- `timeout_ms` (optional). Request timeout in milliseconds (default 30000).
- `max_bytes` (optional). Max bytes returned (default 600000, capped at 5MB).
- `format` (optional). Content parsing format: `auto` (default, converts HTML to Markdown), `markdown`, or `raw`.

Specialized behaviors:
- **ArXiv Papers**: If the URL points to an arXiv paper or abstract page (such as `arxiv.org/abs/...` or `alphaxiv.org/...`), it automatically retrieves paper metadata, abstract, and any AlphaXiv markdown overview.
- **ArXiv API Query**: If the URL points to the arXiv search API, it parses the Atom XML and returns a structured markdown listing of papers.
- **Git Repo Tree Summary**: If the URL points to a GitHub or GitLab directory tree (such as `github.com/.../tree/...`), it fetches repository contents, summarizes the directory tree, and preloads the first few markdown files (e.g. README/SKILL/INSTALL).
- **HTML Cleaning**: For regular websites, boilerplate content (scripts, styles, svg, iframe, forms) is stripped, and the main article/content area is extracted and parsed into Markdown.
- **Binary formats**: Non-text, binary, or unsupported content types are rejected.

```text
web_fetch(url="https://arxiv.org/abs/2303.17564")
web_fetch(url="https://github.com/iowarp/clio-coder/tree/main/docs")
web_fetch(url="https://example.com", format="raw")
```

## monitor: inspect dispatched runs

Read-only visibility into known synchronous and detached dispatched runs, built on the dispatch domain's ledger, live snapshot, and instance-scoped event tails. Synchronous dispatch auto-waits. The interactive operator/TUI can inspect an active synchronous run through the dispatch contract, but the parent model cannot schedule monitor while its sequential synchronous dispatch call is pending; it must choose `detach:true` to receive ids first. Source: `src/tools/monitor.ts`. Read class; runs in parallel with other reads.

Arguments:

- `run_id` (optional). A run id from dispatch output or `monitor(mode="list")`.
- `mode` (optional). `list`, `status`, `peek`, `receipt`, `wait`, `collect`, or `tools`. Default is `status` when `run_id` is given, `list` otherwise.

Modes:

- `list`: up to 20 known runs, newest first, scoped to this session when it has runs and otherwise all sessions. Each line carries the run id, agent, state, start time, tokens, and receipt path.
- `status`: one run's state and outcome, target/model/runtime, start/end times, exit code, tokens, cost, and receipt path. A still-running run adds a live line with phase, heartbeat, elapsed seconds, and token count.
- `peek`: the bounded tail of the run's recent events buffered in this process (an in-process ring of 100 events per run across at most 64 runs, heartbeats excluded, 8KB output with the oldest entries trimmed first). Runs dispatched by another process, or before this process started, have no tail; monitor says so and points at `mode="receipt"` or `mode="status"`.
- `receipt`: the stored receipt JSON, truncated at 14KB with a note naming the receipt path so you can read the rest.
- `wait`: bounded observation of one run until it becomes terminal or the timeout elapses; timeout never cancels the run.
- `collect`: a non-blocking barrier snapshot for a detached `batch_id` or explicit `run_ids`, returning full results once all are terminal.
- `tools`: what a run executed, from this process's bounded event buffer plus the integrity-verified receipt totals. The buffer records tool name and outcome, not command arguments, and the answer says so; a run from another process may have no buffer at all.

Use monitor to check on detached parallel workers without interrupting them; pair with steer when a native run needs correction.

```text
monitor(mode="list")
monitor(run_id="run-01H...")
monitor(run_id="run-01H...", mode="peek")
monitor(run_id="run-01H...", mode="receipt")
monitor(run_id="run-01H...", mode="tools")
```

## steer: guide or cancel a running worker

Controls a running dispatched worker whose id is already available. Parent-model mid-run control requires detached dispatch because dispatch and steer are sequential; the interactive operator/TUI can steer an active synchronous HTTP or SDK worker through the dispatch contract. Source: `src/tools/steer.ts`. Dispatch class; sequential.

Arguments:

- `run_id` (required). A run id from dispatch output or `monitor(mode="list")`.
- `action` (required). `guide` or `cancel`.
- `message` (required for `guide`). The steering text.

`action="guide"` injects the message through the dispatch contract's stdin steer channel; an HTTP or SDK worker sees it as a user message at its next turn boundary. The worker acknowledges only after its runtime accepts the guidance. Single-shot subprocess runtimes (Claude CLI and Antigravity) and ACP delegation do not expose live input and return the contract's structured unsupported-steering error.

`action="cancel"` aborts a non-terminal run; the run finalizes with `outcome=canceled` and its receipt records the cancellation. A run that already finished (completed, failed, interrupted, stale, or dead) errors with its state, since there is nothing to cancel.

Prefer guide over cancel-and-redispatch when the worker is on track but needs a scope correction; the worker keeps its context.

```text
steer(run_id="run-01H...", action="guide", message="Skip the docs sweep; limit the fix to tests/contracts and report the diff.")
steer(run_id="run-01H...", action="cancel")
```

## tasks: the session task board

Declares and tracks the agent's own working plan. Source: `src/tools/tasks.ts`. Read class (never gated); sequential.

Arguments:

- `action` (required). `plan`, `add`, `start`, `done`, `block`, `drop`, or `list`.
- `title` (required for `plan`). The board title.
- `tasks` (required for `plan` and `add`). Task titles as an array of strings.
- `id` (required for `start`, `done`, `block`, `drop`). A task id like `t2`.
- `note` (optional). Evidence of completion on `done`; the reason on `block` (required there) and `drop`.

`action="plan"` declares a titled board and replaces any prior board; tasks get sequential ids `t1..tN` and start pending. `start` marks one task active and parks any other active task back to pending, so the board always names exactly one current focus. `done` completes a task; its `note` is recorded on the session ledger as passed validation evidence, so a completed task carries its receipt rather than a bare status flip. `block` requires a reason and is the honest state for work waiting on the operator; blocked tasks never trigger the turn-end nudge. `drop` cancels a task; ids are never reused. Every action returns the whole rendered board, so the current state always sits in the latest tool result.

Every mutation persists a full-snapshot `taskLedger` entry in the session ledger: the board replays from the JSONL alone, survives `/resume` and `/fork`, costs nothing at compaction, and feeds the footer tasks row plus the `/tasks` overlay. When a tool-calling turn settles while pending or active tasks remain, the `nudge.open-tasks` middleware carries the turn onward once with the open-task list; record the honest state (`done` with evidence, `block` with a reason, or `drop`) instead of stopping with a stale board.

Dispatched runs link to the live board through the ledger's `activeRunIds` field: the orchestrator attaches a run when its worker process goes live and detaches it when the run finalizes, so a snapshot records which fleet runs were serving the board. The linkage is process-live, so a refold after `/resume` or `/fork` restores it empty (the runs ended with the process that dispatched them). Claude SDK/CLI workers map their `TodoWrite` calls onto this tool, so a Claude worker's todo list lands on the same board rather than writing a separate artifact.

```text
tasks(action="plan", title="Fix the flaky scheduler test", tasks=["reproduce the failure", "isolate the race", "fix and verify"])
tasks(action="start", id="t1")
tasks(action="done", id="t1", note="reproduced 3/3 with CLIO_CODER_SEED=7; failure in tests/contracts/scheduler.test.ts:88")
tasks(action="block", id="t2", note="needs operator decision on the retry policy")
tasks(action="list")
```

## ask_user: host-owned operator interviews

Runs a host-owned interactive interview or single-question prompt with the operator, recording decisions and/or free-form answers. Source: `src/tools/ask-user.ts`. Read class; sequential.

Arguments:

- `action` (optional). `ask` (default) to present questions; `complete` to finalise the interview and record compact decisions.
- `mode` (optional). `round` (default) to batch multiple questions; `single_question` for exactly one question.
- `questions` (optional array). For `action="ask"`, up to four question objects containing:
  - `question` (required): Question text prompt.
  - `header` (optional): Short header.
  - `options` (optional array): Suggested choices (`{label, description}`).
  - `multi_select` (optional boolean): Allows multiple selections.
- `decisions` (optional array). For `action="complete"`, key-value objects representing settled configurations.
- `summary` (optional). Closeout explanation for `action="complete"`.
- `max_rounds` (optional number). Round limit for this interview (default 6, max 24).
- `exposure` (optional). `local` (default) or `outward`. `outward` marks a gate whose answer publishes or sends something outside the workspace (filing an issue or PR, posting a comment, pushing, releasing). At autonomy `auto-edit` an outward gate parks for the operator instead of being answered automatically; `full-auto` answers it. See [safety-model.md](safety-model.md).

The tool manages a stateful operator interview. The UI presents choices (with an implicit "Other" option for custom text input). Once completed, the final decisions are persisted as standard configurations in the session ledger, allowing the agent to proceed with operators' inputs or defaults.

Ask only when blocked on a decision the request does not answer. Never ask about anything the operator already stated: a request that names its own scope ("all tools", "read only") has answered the interview before it starts.

```text
ask_user(action="ask", questions=[{question: "Which database should we use?", options: [{label: "SQLite", description: "Local database"}, {label: "PostgreSQL"}]}])
ask_user(action="complete", summary="Operator selected SQLite.", decisions=[{key: "db_choice", value: "SQLite"}])
```

## artifact: plans, reviews, and reports

Terminal document writers behind one surface. Source: `src/tools/artifact.ts`.

Arguments:

- `kind` (required). `plan`, `review`, or `report`.
- `content` (required). Full Markdown body.
- `title` (optional). Document title.
- `path` (optional). Override the default path under `.clio-coder/artifacts/`.

`kind=plan|review|report` writes a Markdown document to `.clio-coder/artifacts/PLAN.md`, `REVIEW.md`, or `REPORT.md` by default, so a turn nobody asked a file from never litters the working tree; `path` may override the destination but must stay inside the workspace. See [artifact-placement.md](artifact-placement.md) for the full contract. When `content` does not already start with `#`, a non-empty `title` is prepended as an H1. These kinds are TERMINAL: writing the artifact completes the turn and the harness skips the follow-up model call, so the artifact body itself is the answer. Put everything the reader needs in `content`; there is no closing message after the write.

Skills are not artifacts. A skill is a `SKILL.md` folder written with the ordinary write tool into `.clio-coder/skills/<name>/` (or the user skill store) and validated by the skills loader; the `skill-craft` shipped skill documents the format and craft rules.

```text
artifact(kind="plan", content="# Migration plan\n\n## Step 1 ...")
artifact(kind="report", title="Benchmark results", path="docs/reports/bench.md", content="...")
artifact(kind="review", content="# Review: toolkit-v2\n\n## Findings ...")
```
