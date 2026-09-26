# Tools and permissions

Read, search, edit, and run commands with Clio's repository tools.

## Search scope: read, ls, grep, and find outside the workspace

`read`, `ls`, `grep`, and `find` run without asking on any path inside the session workspace. A path that resolves outside it, by an absolute path, a `..`, or a link at any component, asks for one-shot approval in `default` and runs in `yolo`. Headless runs deny the ask, so give a headless run `--autonomy yolo` or a `--cwd` that contains what it must read. Zero-access paths (`.env`, `~/.ssh/`, the credential store) are refused in both modes. Read-only dispatched runs deny outside reads and all non-read calls without asking. Workers run at `default`. Installed skill, plugin, and extension trees, the `full:` offload files a truncation notice names, and dispatch receipts stay readable without an ask. A search that starts inside the workspace never follows a linked directory out of it. See [the safety model](../architecture/safety-model.md#autonomy).

## read: page through a file with offset, limit, and tail

Reads one UTF-8 text file. Source: [read.ts](../../src/tools/read.ts).

| Argument | Contract |
| --- | --- |
| `path` | Required; relative/absolute, with `~` home expansion. |
| `offset` | 1-indexed line, default 1. |
| `limit` | Maximum lines. |
| `tail` | Last N lines; overrides offset/limit. |
| `line_numbers` | Prefix source line numbers; default false. |

Each call stops at 2000 lines or the 50 KiB read cap; the turn budget may lower it. Files are read in bounded windows; exact line counts stop after 32 MiB, then total is unknown (`N+`). Images are limited to 20 MB and need the routed model's resolved vision capability. An explicit text-only deployment probe blocks image forwarding even when the model family normally accepts images. Managed Codex, Pi, OpenCode, Claude Code, and Antigravity CLI bridges take text work orders, so they do not accept direct image blocks even if the underlying model supports vision. NUL and invalid UTF-8 in inspected bytes error with zero-based byte offsets. A bounded read says nothing about unread regions.

Truncation provides the first unshown line as `next: offset=...`; read uses the file itself for continuation, never offloads. Oversized single lines return a UTF-8 prefix and hint to narrow grep/edit. Tail continuation widens when total is unknown; numbered tail is refused if absolute line numbers cannot be established. `details.file` includes bytes/mtime and `details.fileChange` reports observed identity changes; neither locks against writers.

Use grep to locate a region, then read that span. Use tail for logs.

```text
read(path="src/tools/read.ts", offset=80, limit=60)
read(path="build.log", tail=100)
```

## edit: exact text replacements in one file

Replaces disjoint exact text regions in an existing file. Sources: [edit.ts](../../src/tools/edit.ts), [edit-diff.ts](../../src/tools/edit-diff.ts).

| Argument | Contract |
| --- | --- |
| `path` | Required target file. |
| `edits` | Required array of `{oldText,newText}`; each old text must identify one unique, non-overlapping region. |

Files up to 1 MiB try exact match, then Unicode punctuation/nonbreaking-space/trailing-whitespace normalization, then indentation-relaxed line matching that preserves file indentation. Ambiguous or absent matches error. Above 1 MiB only exact matching applies. NUL, invalid UTF-8, mixed LF/CRLF, and bare CR are refused; BOM and uniform line endings are preserved. JSON-string edits and a legacy top-level old/new pair are normalized.

Edit and write serialize same-target changes and publish through a temporary file, fsync, and rename. Symlink paths update their target; mode bits are preserved. Ownership/ACL/xattrs/timestamps are not copied, external writers are not locked, and the last rename wins. A post-rename directory-fsync failure reports publication with a durability warning.

Success reports replacement counts, `details.paths`, before/after byte and mtime identities, and a diff with `firstChangedLine` when both versions are at most 1 MiB. Larger diffs are skipped explicitly.

Prefer edit for existing files; batch disjoint edits to one file in one call.

```text
edit(path="src/tools/ls.ts", edits=[{oldText: "const DEFAULT_LIMIT = 500;", newText: "const DEFAULT_LIMIT = 1000;"}])
```

## write: create or overwrite a whole file

Writes complete UTF-8 content, creating parent directories and replacing an existing file. Source: [write.ts](../../src/tools/write.ts).

| Argument | Contract |
| --- | --- |
| `path` | Required target path. |
| `content` | Required complete file content. |

Returns bytes written. If prior content ended in newline and new content does not, the result notes the dropped newline. Publication, symlink, mode, mutation-queue, and external-writer semantics match [edit](#edit-exact-text-replacements-in-one-file). The previous file is read only up to 1 MiB plus one byte; a diff is included only if both versions are at most 1 MiB, otherwise the skip is reported. Result includes before/after file identity.

Use write for a new or fully regenerated file; use edit for a surgical change.

```text
write(path="docs/session.md", content="# Session notes\n")
```

## bash: run a shell command

Runs a fresh `/bin/bash` per call and returns stdout/stderr. Login environment is captured once and reused when possible; fallback is per-call `bash -lc`. Sources: [bash.ts](../../src/tools/bash.ts), [bash-exec.ts](../../src/core/bash-exec.ts).

| Argument | Contract |
| --- | --- |
| `command` | Required shell command. |
| `cwd` | Optional; must remain within the session workspace. |
| `timeout_ms` | Optional, default 300000 ms. |
| `output_policy` | `full`, `bounded` (default), `summary`, or `metadata-only`. |

Filesystem targets resolving outside the workspace escalate to `system_modify` and require one-shot approval in `default`; `yolo` admits them unless a damage-control rule asks or blocks. Inside-workspace writes remain `execute`. Detection covers redirects, path operands to `tee`/`mkdir`/`touch`, `cp`/`mv`/`ln`, in-place `sed`, outside `cd`/`pushd`, runtime-expanded targets, and link-preserving/creating copies. Wrappers such as `nice`, `timeout`, `xargs`, or `find -exec` do not bypass it. Here-doc bodies are inspected for `cd`; child shells do not inherit `CDPATH`.

| Policy | Model context |
| --- | --- |
| `bounded` | Tail-biased excerpt under the 16 KiB result budget. |
| `summary` | Deterministic head/tail/error excerpt, repository-secret-redacted with hash/algorithm provenance. |
| `metadata-only` | Outcome/termination facts; output stays out of model context. |
| `full` | Complete output only when it fits; otherwise typed downgrade to bounded with retrieval path. |

Operator display is independently folded and tail-biased. If display/context omits captured bytes, terminal output is retained in a per-session scratch artifact; live updates follow the selected policy but create no artifacts. Results record requested/applied context modes, captured/display/context bytes, truncation/downgrade, retrieval path, and exit/signal/timeout/abort/cap facts. Scratch retrieval may contain raw output; summary is the redacted projection. More than 16 MiB combined stdout/stderr stops with error; use `run_script` for larger output.

Commands writing outside the workspace ask in `default` and run in `yolo` unless damage control intervenes; zero-access paths remain denied. Repository test runners are allowed without confirmation in both modes: `npm test`, `pytest`, `python -m pytest`, `python -m unittest` (python/python3/python3.N), `cargo test`, `go test`, `ctest`, `make test`, `make check`, `ninja test`, `meson test`, `mvn test`, `gradle test`, `./gradlew test`. Arguments must be bare words to qualify as recognized. An `&&` chain is admitted in `default` only if each command qualifies. Repository build, lint, typecheck and CI scripts (`npm run lint`, `npm run build`, `npm run typecheck`, `npm run ci`) are unrecognized by default: they ask in `default`, where a headless run denies them, and run in `yolo`. A project safety policy entry can recognize one. Its `requireConfirmation` setting asks in `default` and is skipped in `yolo`. Damage-control asks and blocks remain authoritative.

Shell commands inside `$(...)` or backticks are scanned for damage-control rules, including substitutions inside double quotes. An escaped delimiter in the outer shell word or a single-quoted substitution remains literal text. Escaped backticks inside a backtick script can delimit a nested substitution. A matching damage-control rule still asks in `yolo`.

Prefer dedicated read/search tools for envelope continuation and ignore rules, and `verify` for declared checks.

```text
bash(command="npm run build", timeout_ms=600000, output_policy="summary")
bash(command="make artifact", output_policy="metadata-only")
```

## grep: search file contents with ripgrep

Search a file or directory with ripgrep, or a bounded pure-Node fallback. Source: [grep.ts](../../src/tools/grep.ts).

| Argument | Contract |
| --- | --- |
| `pattern` | Required; regex by default. |
| `path` | File/directory, default `.`. |
| `mode` | `content` (default, paths/lines), `files`, or `count`. |
| `glob` | Optional file filter. |
| `ignore_case`, `literal` | Optional booleans; fixed-text matching when literal. |
| `context` | Optional non-negative lines per match (default 0), content mode only. |
| `limit` | Maximum matches, default 100. |
| `include_ignored` | Also include gitignored/generated paths. |

Native rg honors `.gitignore`; both implementations always exclude `.git`, `.fallow`, and `.clio-coder`, and exclude generated directories such as `node_modules`, `dist`, `build`, `coverage`, `target`, `.venv`, `.next`, `.cache`, `.pytest_cache`, and `.turbo`. `include_ignored=true` lifts gitignore/generated exclusions, not internal ones. Explicitly searching inside an excluded directory works. The fallback does not parse `.gitignore`, so native/fallback results can differ; result details disclose the path.

Content renders `path:line: text`; context uses `path-line- text`. Lines over 500 chars are cut. Limits yield `next: limit=<2x>`; byte caps are 16 KiB content, 8 KiB files/count, with full offload and a `mode=files` hint for content. Searches stop after 30s and retain partial results. `details.search` reports completeness, reason (`timeout`, `errors`, `limit`, `cancelled`), and bounded skipped-path diagnostics. Invalid patterns error; recoverable native errors may retain matches. Invalid UTF-8 bytes render as U+FFFD.

Use `mode=files` to map breadth, `count` to size a sweep, then read relevant lines.

```text
grep(pattern="finalizeObservation", path="src", mode="files")
grep(pattern="TODO|FIXME", path="src/tools", context=2, limit=50)
```

## find: locate files and directories by glob pattern

Locate paths using fd or a bounded dirent fallback. Source: [find.ts](../../src/tools/find.ts).

| Argument | Contract |
| --- | --- |
| `pattern` | Required glob: `*`, `**`, `?`, `[abc]`. A bare filename pattern matches any depth; slash patterns match root-relative paths and auto-prefix `**/` unless anchored. |
| `path` | Search directory, default `.`. |
| `order` | `path` (default) or `mtime` (newest first). |
| `limit` | Maximum results, default 500. |
| `include_ignored` | Same visibility rules as grep; see [grep](#grep-search-file-contents-with-ripgrep). |

Results are search-root-relative; directories end in `/`. `mtime` gathers at most `max(4 * limit, 2000)` candidates before stat/sort, so ordering is approximate when capped; details report the cap. Neither implementation follows symlinked directories. The fallback counts symlink skips; fd reports that it cannot count them. Native/fallback glob behavior may differ.

Limit gives `next: limit=<2x>`; the 8 KiB byte cap offloads the complete list. A 30s timeout returns partial paths and search diagnostics like grep. Use `mtime` with a small limit for recent files.

```text
find(pattern="*.test.ts", path="tests")
find(pattern="*", path="src/tools", order="mtime", limit=10)
```

## ls: list one directory

Lists one directory without recursion. Source: [ls.ts](../../src/tools/ls.ts).

| Argument | Contract |
| --- | --- |
| `path` | Directory, default `.`. |
| `limit` | Maximum entries, default 500. |

Entries include dotfiles, sort case-insensitively, and mark directories with `/`. No ignore policy applies. Symlinks display their target or a broken marker. Uninspectable entries stay visible and `details.skipped` counts failures. Selection retains the requested alphabetical prefix in O(limit) memory but still enumerates the directory. Empty directories return `(empty directory)`; a reached limit gives `next: limit=<2x>`, and an 8 KiB output cut offloads the listing.

Use ls to orient in one directory, find for recursive matching.

```text
ls(path="src/tools")
```

## verify: run declared verification checks

One entry point for listing/running declared checks and validating frontend artifacts. Sources: [`src/tools/verify/`](../../src/tools/verify/index.ts), [`src/cli/verifiers.ts`](../../src/cli/verifiers.ts).

Projects can declare [quality policies](quality-policy.md) in `.clio-coder/quality.yaml` to require named checks for changed paths. Listing includes the policy; complete check invocations record source, policy, and declaration snapshots in `details.quality`. The completion assessment reports missing, failed, or stale requirements and records structured findings in the completion audit.

| Argument | Contract |
| --- | --- |
| `check` | Omit or pass an empty string to list; otherwise a catalog ID, verification-family package script, derived check ID, or `frontend`. A bare family word (`test`, `lint`, `check`, `typecheck`, `format`, `build`, `ci`) that no package script declares resolves to the one derived check tagged with it. |
| `path` | `frontend` only: required HTML/CSS/JavaScript file inside the workspace. |
| `args` | Package scripts: string array appended after `--`. Derived test runners: appended to the runner argv (`python -m unittest <args>` replaces discovery). Make targets and CI scripts refuse arguments. JSON-encoded arrays are also parsed. Catalog argv cannot be overridden. |
| `browser` | `frontend` only: `auto` (default), `required`, or `off`. |
| `cwd` | Package scripts only. Sets package discovery/working directory; the catalog is always loaded at the session workspace root and uses its declared `cwd`. |
| `timeout_ms` | Package scripts, derived checks and frontend; default 120000 ms. Catalog checks use `timeoutMs`. |
| `max_output_bytes` | Package scripts and frontend; default 600000 bytes. Catalog checks retain the safe-exec cap. |

Listing groups package and catalog providers under `{id, description, command, cwd, timeoutMs, tags, source}`. Package scripts must match `test`, `lint`, `build`, `typecheck`, `check`, `format`, or `ci`, optionally followed by `:`, `.`, or `-` plus a suffix. They run as `npm run <script>` without a shell. Script execution follows the [bash safety policy](#bash-run-a-shell-command).

### Derived checks

When a repository declares its checks outside `package.json`, `verify` derives them at call time from the files it already has, without writing a catalog. Sources: [`toolchain-checks.ts`](../../src/tools/verify/toolchain-checks.ts), [`resolve.ts`](../../src/tools/verify/resolve.ts).

| ID | Derived from | Runs |
| --- | --- | --- |
| `python-pytest` | `[tool.pytest.ini_options]`, `pytest.ini`, `setup.cfg [tool:pytest]`, a `conftest.py`, or pytest in a dependency list | `python -m pytest` |
| `python-unittest` | `tests/` or `test/` holding `test*.py` modules when pytest is not configured | `python -m unittest discover -s tests` |
| `python-tox`, `python-nox`, `python-<entry>` | tox/nox configuration, verification-family `[project.scripts]` entries | the runner or entry point |
| `cargo-test`, `go-test`, `cmake-test-<preset>` | `Cargo.toml`, `go.mod`, `CMakePresets.json` test presets | `cargo test`, `go test ./...`, `ctest --preset <name>` |
| `make-<target>`, `just-<recipe>` | Makefile and justfile targets named `test`, `lint`, `check`, `typecheck`, `format`, `build` or `ci` (with suffixes) | `make <target>`, `just <recipe>` |
| `ci-<script>` | a CI step that runs a repository script directly, such as `run: scripts/gate.sh` or `run: sh scripts/gate.sh` | the step's argv |

A `uv.lock` at the root prefixes every Python runner with `uv run`, because a bare `python` does not see the uv project environment. A package script or catalog entry with the same ID wins, and identical argv is listed once. The listing prints each derived argv. When nothing is declared or derivable, the error names every source it read and directs the agent to run the documented command through `bash`. A check string that names no declared or derived check runs nothing.

### Project verifier catalog

Commit `.clio-coder/verifiers.yaml` to declare exact argv checks. Declaration makes a check available; normal execution safety policy still applies.

```yaml
version: 2
checks:
  - id: rust-workspace
    description: Run Rust workspace tests
    command: [cargo, test, --workspace]
    cwd: .
    timeoutMs: 600000
    tags: [rust, test]
  - id: grid-metadata
    description: Compare regional grid statistics
    kind: numeric-compare
    command: [python, tools/grid_stats.py, out/region_west.nc]
    reference: tests/reference/region_west.json
    tolerance: {relative: 1.0e-6, ulp: 4}
    cwd: .
    timeoutMs: 120000
    tags: [scientific, netcdf]
  - id: solver-time
    description: Bound solver wall time
    kind: perf-budget
    command: [python, tools/solve.py, --small]
    budget: {wallTimeMs: 30000, tolerance: {relative: 0.25}}
    cwd: .
    timeoutMs: 600000
    tags: [scientific, performance]
```

Version 1 remains readable and means `kind: command`; version 2 adds `numeric-compare` and `perf-budget`. Required core fields are `id`, `description`, `command`, `cwd`, `timeoutMs`, and `tags`. Unknown fields and duplicate IDs fail closed; YAML aliases are disabled.

| Kind | Contract |
| --- | --- |
| `command` | Passes on exit code zero. |
| `numeric-compare` | Compare stdout JSON object `string -> number or number[]` with a repository-relative `reference` JSON file of the same shape. `tolerance` requires finite, non-negative `relative`, `absolute`, or `ulp`; `combine: all` (default) requires every named bound, `any` requires at least one. Missing keys and unequal array lengths fail. `nonFinite: fail` (default) rejects non-finite pairs; `match` accepts NaN/NaN and same-signed infinities. `ulp` is an integer up to 9007199254740991. Relative error against zero passes only on equality. |
| `perf-budget` | Compare measured wall time with exactly one of `budget: {wallTimeMs, tolerance?: {relative}}` or a repository-relative `baseline`. Relative tolerance is non-negative fractional headroom. `verifiers baseline <id>` records a successful run. |

| Field | Constraint |
| --- | --- |
| `id` | `[a-z0-9][a-z0-9._:-]*`, at most 64 bytes; `frontend` is reserved. |
| `description` | Trimmed, single line; at most 512 bytes. |
| `command` | Nonempty argv, at most 64 entries and 4096 bytes per entry. No shell command strings or shell executables (`bash`, `cmd`, `command.com`, `dash`, `fish`, `ksh`, `powershell`, `pwsh`, `sh`, `tcsh`, `zsh`). |
| `cwd` | Existing repository-relative directory, at most 512 bytes; absolute paths, parent escapes, and symlink escapes fail. |
| `timeoutMs` | Integer from 1 to 900000. |
| `tags` | Up to 16 unique tags matching `[a-z0-9][a-z0-9._-]*`, at most 32 bytes each. |
| File | At most 262144 bytes and 128 checks. |

Catalog and package IDs share one namespace; a collision or invalid catalog prevents listing and execution. Checks run declared argv without model-supplied args, cwd, timeout, or environment overrides, through safe-exec's environment allowlist and 600000-byte output cap. Judged output and reference/baseline files are capped at 32 MiB. Nonzero exit, timeout, abort, or output cap prevents judgement. Results include exact argv/cwd/exit/duration and `aborted`/`timedOut`/`outputCapped` flags; judged checks also report numeric deviations or measured time, budget, and ratio. `judgement.execution` is `succeeded`, `failed`, `timed-out`, `aborted`, or `output-capped`; validation is `passed`, `failed`, `exit-code`, or `not-run`. `scientificValidity` is always `not established by this check`.

Numeric reports identify the reference and extracted payload by SHA-256 and byte count. Non-finite report values serialize as `"NaN"`, `"Infinity"`, or `"-Infinity"`. Version 2 performance baselines record wall time, check, timestamp, and host (`hostname`, `platform`, `arch`, `cpuModel`, `cpuCount`, `totalMemoryBytes`, `nodeVersion`); version 1 still loads. Host differences are reported but do not change the verdict.

### Guided catalog authoring

`discover` and `inspect --json` are read-only. `author` previews commands from root `package.json`, `justfile`/`Justfile`, `Makefile`, `Cargo.toml`, `CMakePresets.json`, Python runner files (`pyproject.toml`, `pytest.ini`, `tox.ini`, `noxfile.py`, `setup.cfg`), `go.mod`, and documented YAML `validators`. The preview distinguishes active commands from proposals, records source/location and origin (`project-declared` or `toolchain-defined`), and shows exact argv, cwd, timeout, tags, and authority. Ambiguous shell-like validation commands require manual entry; directories and `VALIDATION.md` prose never imply executable checks. `numerical_tolerances` can propose an incomplete numeric check, but the operator supplies its command.

Every mutation previews first and stops without `--yes`. Confirmation validates with the production parser before atomic write. `--dry-run <id>` runs a check through production `verify` after an accepted write. Additions/renames reject catalog or package-script ID collisions; removing a check revokes catalog access. Generated IDs are stable for the same ordered signals, with deterministic numeric suffixes for collisions.

```text
clio-coder verifiers discover
clio-coder verifiers inspect --json
clio-coder verifiers author --yes
clio-coder verifiers author --exclude cmake-build-debug --rename go-test=go-suite
clio-coder verifiers validate
clio-coder verifiers dry-run rust-workspace
clio-coder verifiers baseline solver-time
clio-coder verifiers add --id validate-grid --description "Validate the grid" --command '["python","tools/check_grid.py"]' --kind numeric-compare --reference tests/grid.json --tolerance '{"relative":1e-6}' --yes
clio-coder verifiers edit validate-grid --timeout-ms 300000
clio-coder verifiers rename validate-grid validate-regional-grid --yes
clio-coder verifiers remove validate-regional-grid --yes
```

CLI fields: `add` requires `--id`, `--description`, and `--command` as a JSON argv array; `edit` accepts these plus `--cwd`, `--timeout-ms`, `--tags`, and kind options. Numeric checks take `--reference` and JSON `--tolerance`; performance checks take `--budget-ms` with optional `--budget-relative`, or `--baseline` with optional relative `--tolerance`. Mutations need `--yes`. `validate` runs the production parser and declared-check discovery; an ID collision with a package script fails validation. `dry-run <id>` executes one admitted check, and `baseline <id>` runs one performance check and writes only on success.

`verify(check="frontend", path=...)` checks an in-workspace `.html`, `.htm`, `.css`, `.js`, `.mjs`, or `.cjs` file without shell access: HTML tag balance, classic/module script syntax, CSS balance, and local script/stylesheet existence. External and root-relative references are skipped. Optional browser load: `auto` warns if Chromium/Chrome/Edge is unavailable, `required` fails, `off` skips. Checks report pass/warn/fail/skip; any fail errors the tool. Details include `{action, check, path, browserMode, status, checks}`.

Prefer `verify` for declared checks: its typed result supplies validation evidence to the finish contract.

```text
verify()
verify(check="typecheck")
verify(check="test", args=["tests/contracts/dispatch-lifecycle.test.ts"])
verify(check="rust-workspace")
verify(check="frontend", path="site/index.html", browser="off")
```

## git: read-only inspection of git repository state

Executes read-only inspection commands against the local git repository. Source: [safe-exec.ts](../../src/tools/safe-exec.ts). Read class; parallel.

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
gateway(op="call", capability="git", args={op: "status"})
gateway(op="call", capability="git", args={op: "diff", stat: true})
gateway(op="call", capability="git", args={op: "diff", path: "src/tools/safe-exec.ts"})
gateway(op="call", capability="git", args={op: "log", limit: 10})
```
