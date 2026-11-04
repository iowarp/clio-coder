---
title: "Materio extension runtime and helper scripts"
summary: "How the Materio materials-characterization extension's runtime (extension.ts) drives the bundled Python helpers for research state, checkpoints, citation and physics checks, script linting, and peer-host projection. Read this to find which helper does what and how the runtime calls it."
sources:
  - "library/extensions/materio/runtime/extension.ts"
  - "library/extensions/materio/assets/scripts/research_state.py"
  - "library/extensions/materio/assets/scripts/verify_citations.py"
  - "library/extensions/materio/assets/scripts/check_physics.py"
  - "library/extensions/materio/assets/scripts/check_scripts.py"
  - "library/extensions/materio/assets/scripts/project_plugin.py"
symbols:
  - "extension"
  - "python"
  - "checkpoint"
  - "checkpoint_save"
  - "checkpoint_read"
  - "checkpoint_restore"
  - "next_ready_task"
  - "verify_one"
  - "check_temperature"
  - "project"
tests:
  - "library/extensions/materio/runtime/extension.test.ts"
invariants:
  - "The runtime runs only the authored helpers in assets/scripts through python3 -B with an argument array and no shell expansion; generated research scripts are inspected, never executed."
  - "Checkpoint restore requires the --confirmed flag, validates the archive before touching current research state, and rolls back the original root if the swap fails."
  - "A checkpoint archive is accepted only if its embedded manifest's per-file SHA-256 digests match the archived content."
  - "The research state helper refuses symlinks inside .research and rejects dependency cycles and dependencies on missing or archived tasks."
  - "The citation verifier reports UNVERIFIABLE in offline mode and never contacts the network in that mode."
  - "The peer projection refuses symbolic links in skills and assets and refuses an output path that already exists or lies inside the canonical bundle."
validate:
  - "pnpm run test:file -- library/extensions/materio/runtime/extension.test.ts"
---

# Materio extension runtime and helper scripts

The Materio extension supports materials-characterization research work inside Clio. Its TypeScript runtime, `library/extensions/materio/runtime/extension.ts`, exposes tools, commands, actions, and interviews to the host. For file-level state changes it shells out to small, stdlib-only Python helpers in `library/extensions/materio/assets/scripts/`. Read this page when you need to know which helper owns a given operation, how the runtime invokes it, or what the helpers refuse to do.

## Ownership

| Source | Responsibility |
| --- | --- |
| `library/extensions/materio/runtime/extension.ts` | Registers tools (`complete_task`, `set_task_status`, `record_decision`, `interview`), command handles (`lab`, `status`, `progress`, `help`, `cost`, `checkpoint`), observers, a `before_tool` hook, and actions and interviews (`next`, `task`, `findings`, `restore`). Exported default function `extension`. |
| `library/extensions/materio/assets/scripts/research_state.py` | Deterministic `.research/` state: config, task numbering, workflow validation, next ready task, checkpoints (save, list, restore), optional record, and data copy. Entry point `main`. |
| `library/extensions/materio/assets/scripts/verify_citations.py` | Extracts citations from `LITERATURE.md` and `.bib` files and checks them against Crossref. Entry point `main`, with `verify_one` as the per-citation decision. |
| `library/extensions/materio/assets/scripts/check_physics.py` | Scans Markdown and input files for unit and physical-plausibility errors, such as absolute temperatures below 0 K. Entry point `main`. |
| `library/extensions/materio/assets/scripts/check_scripts.py` | Lints generated Python and shell scripts for stub bodies, unresolved imports, and similar issues. Entry point `main`. |
| `library/extensions/materio/assets/scripts/project_plugin.py` | Generates a peer-host package (`codex`, `claude`, or `gemini`) from the canonical bundle. Entry point `main`, with `project` as the workhorse. |

The runtime's entry point is `extension(api: ExtensionApiV2)`. It is the default export of `library/extensions/materio/runtime/extension.ts`, and the host calls it when the extension loads. The Python helpers are not imported by the runtime; they run as separate processes.

## How the runtime calls helpers

All helper invocations go through `python(ctx, script, args, timeout)` in `library/extensions/materio/runtime/extension.ts`. It calls `execFile("python3", ["-B", path.join(SCRIPTS, script), ...args], …)` with the workspace as `cwd`, a timeout (default 800 seconds), a 1 MiB output buffer, and the context's abort signal. The helper's stdout must be one JSON document, which the runtime parses into a `Receipt`. A non-numeric exit code or a timeout rejects the promise. A non-zero numeric exit code is returned to the caller as `code`, with the parsed receipt. If stdout is not JSON, the call rejects with the script name and stderr.

Every runtime-initiated state transition is serialized inside one process by a local promise chain (`serial`). The code comment notes that store compare-and-swap still guards against other sessions.

### Checkpoint restore flow

The `restore` interview is the clearest end-to-end path:

1. The `checkpoint` command handler (`checkpointCommand`) and the `restore` interview answer supply the archive name. The interview reads the stored name from `ctx.state` and clears it.
2. The interview refuses unless `answer.answers.confirm === "restore"` and a name exists. Otherwise it returns "Restore cancelled; research files unchanged."
3. `checkArchiveName(ctx, name)` validates the name, then `checkpoint(ctx, "before-restore")` saves the current state as a safety checkpoint.
4. `python(ctx, "research_state.py", ["--project", workspace, "checkpoint", "restore", name, "--confirmed"], 1200)` runs. In `library/extensions/materio/assets/scripts/research_state.py`, `main` calls `checkpoint_restore(root, name, confirmed)`.
5. `checkpoint_restore` refuses without `--confirmed`. It calls `checkpoint_read` first, which fully validates the archive before anything is changed. It then stages the new tree in a temporary directory beside `.research`, moves the current root aside to a backup, moves `data` and `checkpoints` from the backup into the stage, and renames the stage into place. If any step raises after the swap, the code moves the preserved directories back and renames the backup to the root. The stage and backup are cleaned up in `finally`.
6. The interview reports success only when `result.code === 0` and `result.receipt.restored === name`; otherwise it throws `Restore failed`.

`checkpoint_restore` keeps `data` and `checkpoints` (the `PRESERVED` set in `library/extensions/materio/assets/scripts/research_state.py`) out of the restored tree. Those directories are moved, never copied or traversed.

### Checkpoint save and read

`checkpoint_save(root, label)` requires a label matching `[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}`, requires `root` to be a directory, and writes a gzip tarball under `.research/checkpoints/`. Its name combines a UTC timestamp, the label, and a random hex suffix. The archive contains every regular file under `.research` except the preserved top-level `data` and `checkpoints` directories, plus a `.snapshot-manifest.json` with per-file SHA-256 digests, the directory inventory, and per-file modes. Members are written with mode `0o600`. `snapshot_files` raises on any symlink or non-regular file.

`checkpoint_read(root, name)` accepts only names matching `[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz` and resolves them through `contained`. It rejects absolute, parent-escaping, duplicate, non-canonical, preserved-prefix, and non-regular members. It then recomputes the SHA-256 digest of every member and compares it with the manifest's `files` map. A mismatch raises "checkpoint content integrity mismatch".

The runtime's `checkpoint(ctx, label)` wrapper applies a second label check (`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/`) before it calls the helper, and the helper repeats the check.

### Workflow ordering

`library/extensions/materio/assets/scripts/research_state.py` derives task state from `library/plugins/materio/assets/templates/WORKFLOW.md`. `workflow(root)` splits the file at `## Archived Tasks` and parses `### Task N:` blocks in each half. `validate_workflow` rejects a dependency on a missing or archived task (`Task X depends on archived Task Y`) and any cycle. `next_ready_task` returns the lowest-numbered task whose status is `pending` or `in-progress` and whose dependencies are all `complete`; otherwise it returns `id: null` with the blocked list.

`next_task(root)` numbers new tasks above the maximum of active, archived, and `tasks/task-N` directory IDs. The runtime's `taskId` helper normalizes IDs used by actions and the `before_tool` hook.

The `before_tool` hook in `library/extensions/materio/runtime/extension.ts` records a pending dispatch for a dispatch call whose `agent` is a known skin agent. It extracts a task number only when `intent.write_roots` names exactly one `.research/tasks/task-N` path. The `pending-dispatch` state keeps the most recent 32 entries.

## Tests

The focused test is `library/extensions/materio/runtime/extension.test.ts`. Its `project()` helper builds a temporary `.research` tree with a seven-task `library/plugins/materio/assets/templates/WORKFLOW.md`, a `library/plugins/materio/assets/templates/VIRTUAL-LAB.md` that marks APT as unavailable, a `library/plugins/materio/assets/templates/config.json` with `web_search` false, and a `task-03` summary containing a BibTeX entry and a `def analyze(:` script.

The test file uses `createExtensionTestHost` from `@iowarp/clio-coder/extensions/testing`. Cases that demonstrate behavior described above include:

- With no `STATE.md`, `record_decision` returns `isError: true` and a message naming the interview and the help command. The test asserts that the message does not contain the legacy `/materio:` command prefix.
- With the plugin absent, `next` and `task` actions return text saying they need the Materio plugin, with no `prompt` field.
- `status check 03` and the `findings` interview are exercised; a `fix` decision leaves the task at checkpoint and does not return a prompt when the plugin is absent.

This page does not run this test. The test file is the only focused test This page reads; This page does not search the wider repository for other consumers of the helper scripts. Helper scripts `library/extensions/materio/assets/scripts/verify_citations.py`, `library/extensions/materio/assets/scripts/check_physics.py`, `library/extensions/materio/assets/scripts/check_scripts.py`, and `library/extensions/materio/assets/scripts/project_plugin.py` have no focused test that I inspected, so their behavior here rests on the source reads described below.

## Citation verification

`library/extensions/materio/assets/scripts/verify_citations.py` collects citations with `collect(paths)`. `.bib` files go to `extract_bibtex`; other files go to `extract_markdown`, which also returns placeholder keys. `main` then calls `verify_one` for each citation.

`verify_one` returns `UNVERIFIABLE` when a citation has no title or when `--offline` is set (in that case no network call is made). With a DOI, it calls `crossref_by_doi`. A DOI that Crossref does not know yields `UNVERIFIABLE` with a note that another registration agency may own it. A matching title (similarity at or above `TITLE_MATCH`) with an acceptable year returns `VERIFIED`; otherwise `MISMATCH`. Without a DOI, `crossref_by_title` is queried, and the best title similarity determines the status. A similarity at or above `TITLE_WEAK` is rescued to `VERIFIED` when a primary author surname and a consistent year both match; otherwise it is `MISMATCH`. Below that threshold, the result is `NOT_FOUND`.

`main` exits 2 when an input is unreadable or no citations are extracted, 1 when any `NOT_FOUND` or `MISMATCH` remains, and 0 otherwise. Without a DOI, the loop sleeps `REQ_PAUSE` between requests when not offline.

## Physics and script checks

`library/extensions/materio/assets/scripts/check_physics.py` provides `check_temperature`, `check_density`, `check_fractions`, and `check_composition`, each applied to the file text. `check_temperature` raises an error for an absolute Kelvin, Celsius, or Fahrenheit value below absolute zero unless the same line matches a delta, rate, gradient, or change keyword, or the unit is followed by `/`. A Kelvin value above 100000 gets a warning instead. Findings are collected through the `Findings` class, which `main` uses to print or emit JSON.

`library/extensions/materio/assets/scripts/check_scripts.py` provides `check_python` and `check_shell`, plus `_stub_findings`. `_stub_findings` warns on a bare `...` statement, a raised `NotImplementedError`, and a function whose only body is `pass` (after an optional docstring). These are warnings, not errors.

This page reads the signatures and branches of these checkers but did not trace their CLI output paths or run them on fixtures.

## Peer projection

`library/extensions/materio/assets/scripts/project_plugin.py` implements `project(target, output, source=None)`. It refuses an existing output path or one inside the canonical bundle, requires a `plugin.json` at the source, and rejects any symlink under `skills` or `assets` before copying those directories. On any exception after `mkdir`, it removes the partial output tree.

For `codex`, it writes a portable `plugin.json` and no commands or agents. For `claude`, it writes a `plugin.json` manifest under a `.claude-plugin/` directory, one command file per action, and one agent file per skill, with tool lists that give `task-verifier` read-only tools. For `gemini`, it writes `gemini-extension.json`, `GEMINI.md`, and TOML command files. Each target writes `capability-report.json` recording the counts and the explicit statement that no native fleet write-scope enforcement is claimed. An unsupported target raises `unsupported peer target`.

`render_peer_guides` rewrites action and skill text so that logical skill requests point at each host's actual invocation vocabulary.

## Things to watch when editing

- Keep the helper contract intact: `python()` requires one JSON document on stdout, and the runtime depends on the receipt keys it reads (`restored`, `checkpoint`, `errors`, `results`, and so on). A helper that prints extra text to stdout breaks parsing.
- `checkpoint_restore` moves `data` and `checkpoints` rather than copying them. Changing the `PRESERVED` set changes what survives a restore and what a snapshot excludes.
- The interview's restore path runs a `before-restore` checkpoint first. Keep that ordering if you alter restore.
- `library/extensions/materio/assets/scripts/project_plugin.py` detects partial output on failure and deletes it; any new step that writes outside `output` is not covered by that cleanup.
- Checkpoint archive validation happens in `checkpoint_read`. Any new archive member type must be added there, or restore will refuse it.
