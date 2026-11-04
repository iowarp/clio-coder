---
title: "Materio plugin helper scripts and tests"
summary: "Describes the stdlib-only Python helpers that the Materio plugin's action guides call for research state, citation verification, physical-sanity checks, generated-script checks, and peer-host projection, and the focused tests that exercise them. Read this page before changing any helper under library/plugins/materio/assets/scripts or its tests."
sources:
  - "library/plugins/materio/assets/scripts/research_state.py"
  - "library/plugins/materio/assets/scripts/verify_citations.py"
  - "library/plugins/materio/assets/scripts/check_physics.py"
  - "library/plugins/materio/assets/scripts/check_scripts.py"
  - "library/plugins/materio/assets/scripts/project_plugin.py"
symbols:
  - "research_state.checkpoint_save"
  - "research_state.checkpoint_restore"
  - "research_state.next_ready_task"
  - "research_state.validate_workflow"
  - "research_state.record"
  - "research_state.register_copy"
  - "verify_citations.extract_markdown"
  - "verify_citations.extract_bibtex"
  - "verify_citations.verify_one"
  - "check_physics.scan"
  - "check_physics.check_temperature"
  - "check_scripts.check_python"
  - "check_scripts.check_shell"
  - "project_plugin.project"
tests:
  - "library/plugins/materio/tests/test_research_state.py"
  - "library/plugins/materio/tests/test_verify_citations.py"
  - "library/plugins/materio/tests/test_check_scripts.py"
  - "library/plugins/materio/tests/test_check_physics.py"
invariants:
  - "research_state.py refuses checkpoint restore unless the caller passes the confirmed flag; without it, no state is touched."
  - "research_state.py record writes nothing to git unless config key commit_research is true, and it refuses to commit when the git index already has staged changes."
  - "research_state.py checkpoint restore stages the archive before swapping the research root, and rolls back the original root if the swap fails."
  - "check_physics.py does not sign-check quantities that are legitimately negative (energies, stresses, deltas, rates, gradients); it flags only absolute temperature below 0 K, non-positive density, and out-of-range bounded fractions."
  - "verify_citations.py, when run with --offline, never performs a network request and reports every resolvable candidate as UNVERIFIABLE."
  - "check_scripts.py parses and does not import or execute the files it checks."
validate:
  - "python3 -B -m unittest library/plugins/materio/tests/test_research_state.py library/plugins/materio/tests/test_verify_citations.py library/plugins/materio/tests/test_check_scripts.py library/plugins/materio/tests/test_check_physics.py"
---

# Materio plugin helper scripts and tests

The Materio plugin ships a small set of stdlib-only Python helpers under
`library/plugins/materio/assets/scripts`. The action guides in
`library/plugins/materio/assets/actions` call them as shell commands through
`${PACKAGE_ROOT}/assets/scripts/...`, and the Materio extension runtime
(`library/extensions/materio/runtime/extension.ts`) invokes several of them
through a `python(...)` helper. Read this page when you need to change how a
research workspace is initialized, checkpointed, or recorded, or how generated
task outputs are checked before they reach a researcher.

## What this area does

The helpers fall into four groups:

- **Research state**: `library/plugins/materio/assets/scripts/research_state.py` manages the `.research/` directory
  of a project: configuration, workflow task IDs and dependencies, data
  registration, checkpoints, and an optional git record.
- **Citation checking**: `library/plugins/materio/assets/scripts/verify_citations.py` extracts citation candidates
  from `LITERATURE.md`-style Markdown and `.bib` files and classifies them
  against Crossref, or offline as unverifiable.
- **Output checks**: `library/plugins/materio/assets/scripts/check_physics.py` scans task outputs for impossible or
  implausible numeric values, and `library/plugins/materio/assets/scripts/check_scripts.py` checks generated Python
  and shell files for syntax, suspect imports, and stubs without running them.
- **Peer projection**: `library/plugins/materio/assets/scripts/project_plugin.py` writes a host-specific package
  (Codex, Claude, or Gemini) from the canonical bundle.

All four checks report findings and set an exit status. None of them mutates
a task output. `library/plugins/materio/assets/scripts/research_state.py` is the only helper that writes project state.

## Ownership and key symbols

| Path | Responsibility | Key symbols |
| --- | --- | --- |
| `library/plugins/materio/assets/scripts/research_state.py` | Project state, checkpoints, optional git record | `config`, `contained`, `workflow`, `validate_workflow`, `next_ready_task`, `checkpoint_save`, `checkpoint_read`, `checkpoint_restore`, `record`, `register_copy` |
| `assets/scripts/verify_citations.py` | Citation extraction and Crossref classification | `extract_markdown`, `extract_bibtex`, `verify_one`, `crossref_by_title`, `crossref_by_doi`, `main` |
| `assets/scripts/check_physics.py` | Numeric physical-bounds checks | `scan`, `check_temperature`, `check_density`, `check_fractions`, `check_composition`, `CHECKS` |
| `assets/scripts/check_scripts.py` | Generated-script syntax and stub checks | `check_python`, `check_shell`, `scan`, `stdlib_names`, `KNOWN_PACKAGES` |
| `library/plugins/materio/assets/scripts/project_plugin.py` | Host-specific peer package generation | `project`, `render_peer_guides`, `ACTION_ROLES` |

The focused tests live in `library/plugins/materio/tests`. There is no test file
for `library/plugins/materio/assets/scripts/project_plugin.py` in that directory, and this page does not claim one.

## Research state (`library/plugins/materio/assets/scripts/research_state.py`)

### Entry point and dispatch

`main(argv)` parses `--project` and a subcommand. It resolves the project
root with `research_root`, which rejects a `.research` that is a symlink, and
dispatches to one of: `init`, `config`, `next-task-id`, `next-task`,
`validate-workflow`, `task-dirs`, `checkpoint {save,restore,list}`, `record`,
and `copy-data`. Errors (`ValueError`, `OSError`, JSON, tar, or subprocess
failures) print a JSON `error` object to stderr and return exit status 2.

The action guides call these subcommands directly, for example
`research_state.py next-task-id` in `library/plugins/materio/assets/actions/add-task.md`, and
`research_state.py checkpoint save LABEL` in `library/plugins/materio/assets/actions/checkpoint.md`.
The extension runtime calls `checkpoint save`, `checkpoint list`,
`checkpoint restore NAME --confirmed`, `config`, `init`, and `copy-data` from
`library/extensions/materio/runtime/extension.ts`.

### Configuration

`DEFAULTS` sets `web_search`, `auto_checkpoint`, and `commit_research`. The
`config(root)` function merges `.research/config.json` over these defaults. It
rejects a symlinked config file, a non-object JSON document, duplicate keys
(via `unique_object`), and any default key whose value is not a JSON boolean.
`init` writes the defaults only when no `library/plugins/materio/assets/templates/config.json` exists.

### Workflow tasks

`workflow(root)` splits `library/plugins/materio/assets/templates/WORKFLOW.md` at `## Archived Tasks` and parses
`### Task N:` blocks in each half. `validate_workflow` rejects duplicate IDs,
dependencies on a missing or archived task, and dependency cycles. Its
dependency parser reads a `**Dependencies**:` line. `next_ready_task` returns
the first `pending` or `in-progress` task in workflow order whose dependencies
all have status `complete`. Otherwise it returns `id: None` with the list of
blocked tasks. `next_task` allocates `max(existing IDs) + 1`, where existing
IDs include active and archived workflow entries and `tasks/task-N`
directories.

The focused test `test_ids_are_decimal_stable_and_include_archived_and_disk`
in `library/plugins/materio/tests/test_research_state.py` builds a workflow with
task 07 active, task 12 archived, and a `tasks/task-15` directory. It asserts
`next_task` returns `"16"` and `validate_workflow` returns `active == ["07"]`.
`test_dependency_cycle_missing_and_archived_refs_rejected` asserts that a
two-task cycle, a dependency on a missing task, a dependency on an archived
task, and a duplicate task heading each raise `ValueError`.
`test_next_task_follows_ready_dependencies_and_workflow_order_across_gaps`
checks that the selection skips task 09 until task 04 is `complete`, and then
returns `None` when no pending task remains. It also asserts that
`next_ready_task` does not rewrite `library/plugins/materio/assets/templates/WORKFLOW.md`.
`test_next_task_cli_reports_real_id_without_mutating_workflow` runs the script
as a subprocess with `-B` and asserts that the file bytes are unchanged.

### Checkpoints

`checkpoint_save(root, label)` requires a label matching
`[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}`. It snapshots every regular file under the
research root except the top-level `data` and `checkpoints` directories
(`PRESERVED`). It writes a gzip tar named with a UTC timestamp, the label, and
a random suffix, containing a `.snapshot-manifest.json` with per-file SHA-256
digests, directory inventory, and permission modes. The archive is opened with
mode `xb`, so an existing name is never overwritten.

`checkpoint_read` validates the archive before any restore: it rejects
absolute, parent-relative, or duplicate members; members under `data` or
`checkpoints`; non-file members; noncanonical names; and any mismatch between
the manifest digests and the observed content.

`checkpoint_restore(root, name, confirmed)` raises `ValueError` unless
`confirmed` is true. This is the only check the code performs before reading
the archive, so the restore subcommand requires the `--confirmed` flag. It
then stages the archive in a temporary directory beside the root, renames the
current root to a backup, moves `data` and `checkpoints` from the backup into
the stage, and renames the stage into place. If any step raises after the swap,
it moves the preserved directories back and restores the backup as the root.
The backup is removed only after the swap succeeds.

The focused test `test_checkpoint_roundtrip_replaces_state_preserves_data_and_archives`
saves a checkpoint, changes `STATE.md`, adds `later.md`, and edits
`data/observations.csv`. It asserts that a restore without confirmation raises
`ValueError`. It then asserts that a confirmed restore returns the checkpoint
name, restores `STATE.md`, removes `later.md`, keeps the edited data file,
and leaves the archive in `checkpoints/`.

### Optional git record

`record(root, message, paths)` returns `{"recorded": False}` unless the
`commit_research` config value is true. When it is enabled, it requires that
no changes are already staged, accepts only paths beginning with `.research/`
that resolve to files, stages them, and commits with the message. The focused
test `test_default_record_never_initializes_git` asserts that the default
configuration returns `recorded: False` and does not create `.git`.

### Data registration

`register_copy(root, source)` copies a regular file into `.research/data`.
An existing identical file is reported as `copied: False`. A different file with
the same name raises a collision error. The file is written with mode `xb`.
The extension runtime calls this through `copy-data` when the researcher chooses
the copy storage option.

## Citation verification (`library/plugins/materio/assets/scripts/verify_citations.py`)

### Extraction

`extract_markdown(text, source)` returns a list of `Cite` candidates and a list
of placeholder citations. It reads three kinds of content and no prose:
BibTeX entries embedded in the document, rows of a `Key Papers` table (header
first cell containing `paper`, or a section heading containing `key papers`),
and rows of other tables that contain a four-digit year. The
`Methodological Landscape` table (header first cell containing `approach`, or
a `landscape` heading) is skipped. Quoted titles shorter than 12 normalized
characters and titles ending in an ellipsis are dropped. Exact duplicates of
normalized title and year are removed by `dedup_truncated`.

`extract_bibtex(text, source)` uses a brace- and quote-aware scanner
(`_group`, `_bibtex_entries`) so nested braces in titles are preserved.
`comment`, `preamble`, and `string` entries are skipped.

The focused tests in `library/plugins/materio/tests/test_verify_citations.py`
cover these rules. `test_table_row_title_extracted` feeds a Key Papers row with
a quoted title and year 2017 and asserts one candidate with year `"2017"`.
`test_prose_emphasis_not_extracted` feeds a quoted phrase in prose with no
table and asserts that no candidates are returned.
`test_ellipsis_truncated_title_dropped` asserts that an ellipsis-truncated
duplicate in a References table is dropped and the full Key Papers title is
kept. `test_distinct_complete_prefix_title_preserved` asserts that a complete
prefix title is kept as a separate candidate. `test_bibtex_extraction` parses
a one-entry `.bib` string and asserts the DOI `10.1/abc`.

Author strings are taken from the Key Papers row's first cell only when
`_row_authors` recognizes an author list. The tests
`test_authors_from_et_al_prefix` and
`test_authors_from_surname_and_surname_prefix` assert that
`King W.E. et al.` and `W.E. King and R. Smith` are kept.

### Classification

`collect(paths)` reads each path, routes `.bib` files to `extract_bibtex` and
other files to `extract_markdown`, and deduplicates the result. `main` also
reads each path once to record unreadable inputs in the JSON coverage block.

`verify_one(c, offline)` returns `(status, detail)`. The order of checks is:

1. No title: `UNVERIFIABLE`.
2. `offline` true: `UNVERIFIABLE` with reason "offline mode; not resolved".
3. A DOI: `crossref_by_doi`. An absent DOI (HTTP 404) gives `UNVERIFIABLE`;
   a network error gives `UNVERIFIABLE`; otherwise the title similarity and a
   year tolerance of one year decide `VERIFIED` or `MISMATCH`.
4. Title query: `crossref_by_title` sends up to five results. No results gives
   `NOT_FOUND`. The best title similarity decides the rest. At or above
   `TITLE_MATCH` (0.75) with a consistent year gives `VERIFIED`. At or above
   `TITLE_WEAK` (0.50), `VERIFIED` only when both an author surname and the year
   agree, otherwise `MISMATCH`. Below that, `NOT_FOUND`.

`_get` makes one retry after `RETRY_BACKOFF` on HTTP 429 or 5xx. The
`execute-task.md` and `literature-review.md` guides call the script with
`--offline` unless `web_search` is true in the research configuration.

The offline behavior is covered by the script's own design and by `main`,
which returns `UNVERIFIABLE` for every candidate when `--offline` is passed.
No focused test in `library/plugins/materio/tests/test_verify_citations.py` asserts the network path, and
this page does not claim one.

### Exit status

`main` returns 2 when any input is unreadable or no candidates are extracted,
1 when any result is `NOT_FOUND` or `MISMATCH`, and 0 otherwise.

## Physical-sanity checks (`library/plugins/materio/assets/scripts/check_physics.py`)

`scan(paths)` runs each function in `CHECKS` over each readable file and returns
a `Findings` object with separate `errors` and `warnings` lists. The checks are:

- `check_temperature`: an absolute Kelvin, Celsius, or Fahrenheit value below
  zero is an error. A value above 100000 K is a warning. A line matching the
  `_TEMP_SIGNED_CTX` pattern (delta, gradient, rate, change, difference) is not
  sign-checked.
- `check_density`: a density of zero or less is an error, and above 30 g/cm^3
  is a warning. kg/m^3 values are converted by a factor of 0.001.
- `check_fractions`: a `wt%`, `at%`, `mol%`, or `vol%` value outside 0 to 100 is
  an error. A bare `%` is checked only on lines with a bounded-quantity keyword
  (porosity, density, purity, yield, and similar) and without a relative-change
  word such as "improved" or "relative".
- `check_composition`: inline lists or vertical runs of one unit whose values
  sum to between 80 and 120 but differ from 100 by more than 1 are warnings.

The focused test file `library/plugins/materio/tests/test_check_physics.py` is
the reference for these rules. Its `TestNoFalsePositives.CASES` list
asserts zero findings for values such as `DFT total energy: -8.35 eV/atom`,
`Residual stress -250 MPa (compressive)`, and `Composition: Ti 90 wt%, Al 6 wt%,
V 4 wt%`. `TestTemperature.test_negative_rate_and_delta_not_flagged` asserts zero
errors for `Cooling rate: -50 K/s during quench` and `ΔT = -5 K`.
`TestTemperature.test_absolute_negative_kelvin_still_flagged` asserts one error
for `Cool the sample to -5 K`. `TestFractions.test_relative_change_of_bounded_quantity_ignored`
asserts zero errors for `Efficiency improved by 250% over baseline`.
`TestComposition.test_scattered_percentages_not_summed` asserts zero warnings
for two non-contiguous single values.

The extension runtime runs this script with `--json` over Markdown files in a
task output set (`library/extensions/materio/runtime/extension.ts`). The
`execute-task.md` guide runs it without `--json` on `physics_files`.

## Generated-script checks (`library/plugins/materio/assets/scripts/check_scripts.py`)

`check_python(text, path, fnd, local_modules)` calls `ast.parse`. A
`SyntaxError` is an error with rule `syntax`. Otherwise it warns on any
top-level import whose module is not in `stdlib_names()`, `KNOWN_PACKAGES`, or
the sibling script names passed in `local_modules`. Relative imports are skipped.
`_stub_findings` warns on a bare `...` statement, `raise NotImplementedError`,
and a function whose body after an optional docstring is only `pass`. A line
matching the placeholder pattern (`path/to/`, `YOUR_`, `<name>`, `TODO`,
`FIXME`, and similar) is a warning with rule `placeholder`.

`check_shell(path, fnd)` runs `bash -n` on the file with a 15-second timeout.
A non-zero exit is an error with rule `syntax`.

`scan(paths)` builds `local_modules` from the basenames of the `.py` arguments,
so that sibling scripts in the same run are recognized. It dispatches `.py`
files to `check_python` and `.sh` or `.bash` files to `check_shell`. Other
extensions are ignored.

`stdlib_names()` uses `sys.stdlib_module_names` when present, and otherwise a
hardcoded fallback set.

The focused test file `library/plugins/materio/tests/test_check_scripts.py`
covers these paths. `test_syntax_error_is_error` parses `def f(:` and asserts
one error with rule `syntax`. `test_hallucinated_import_warns` parses
`import nummpy as np` and asserts one warning with rule `import`.
`test_stdlib_and_known_and_local_ok` asserts zero warnings for `json`,
`pymatgen`, and a local `helpers` module. `test_pass_only_function`,
`test_not_implemented`, and `test_bare_ellipsis_flagged` assert `stub` warnings.
`test_ellipsis_indexing_not_flagged` asserts that `a[...]` produces no stub
warning. `test_path_placeholder` and `test_angle_placeholder` assert
`placeholder` warnings. `TestShell.test_broken_shell_is_error` runs `bash -n`
on a file with a missing `do` and asserts one error.

`TestStdlibFallback.test_works_without_sys_stdlib_module_names` deletes
`sys.stdlib_module_names` temporarily and asserts that `os`, `sys`, `json`,
`re`, and `pathlib` are still recognized.

The extension runtime runs this script with `--json` over Python and shell files
in a task output set. The `execute-task.md` guide runs it over `script_files`.

## Peer projection (`library/plugins/materio/assets/scripts/project_plugin.py`)

`project(target, output, source=None)` copies the `skills` and `assets`
directories from the canonical bundle into a new output directory outside the
bundle, refusing any symbolic link in those trees and refusing an existing
output path. It then writes host-specific metadata:

- `codex`: a portable `plugin.json` with `$schema` and the metadata fields.
- `claude`: a generated plugin manifest named `plugin.json` inside a `.claude-plugin` directory, one command file per action guide in
  `commands/`, and one agent file per role skill in `agents/`. Agent `tools`
  are restricted to `Read, Glob, Grep` for `task-verifier` and extended for the
  other roles.
- `gemini`: `gemini-extension.json`, `GEMINI.md`, and TOML command files under
  `commands/materio/`.

`render_peer_guides` rewrites the exported action and skill text to bind
action names to the commands or skills a host exports. `ACTION_ROLES` maps
each action name to a role name, with `research-explorer` as the default.

`capability-report.json` is written at the end and records the target, the
number of commands and agents, and the fleet status. The report states
"instructions only; no native write-scope enforcement claimed" for the fleet.
On any exception, `project` removes the partial output directory and re-raises.

This module has no focused test file in `library/plugins/materio/tests`, and
this page does not describe any test for it. Its callers were not located in
the extension runtime during this review, so the place that invokes it is
unverified.

## Things to watch when editing

- `library/plugins/materio/assets/scripts/research_state.py` is invoked by the action guides as a fixed command with
  arguments built from user input. Changes to its argument names (for example
  `--confirmed`, `--files`, `--message`) must be matched in the guides listed
  above and in `extension.ts`.
- The restore path depends on `PRESERVED` (`data`, `checkpoints`) in both
  `snapshot_files` and `checkpoint_restore`. A change to one without the other
  alters what is kept or dropped.
- `library/plugins/materio/assets/scripts/verify_citations.py` classifies a Methodological Landscape table by skipping
  it. The Key Papers table is recognized from its header or its section heading,
  so changes to those strings in the literature guide affect extraction.
- `library/plugins/materio/assets/scripts/check_physics.py` deliberately omits sign checks for most quantities. Its
  test file asserts zero findings for legitimately negative values, so adding a
  sign rule needs a matching case in `TestNoFalsePositives.CASES`.
- `library/plugins/materio/assets/scripts/check_scripts.py` never imports the files it checks. The `KNOWN_PACKAGES`
  list is a fixed allowlist; a package missing from it produces an `import`
  warning, not an error.
- The helpers are stdlib-only and must keep running under Python versions
  without `sys.stdlib_module_names`, which the fallback in `stdlib_names`
  handles.

## Verification

The focused tests named above are unittest modules. The validate command at the
top of this page runs them with `python3 -B -m unittest`. This page does not
record a run of that command. Test files `library/plugins/materio/tests/test_research_state.py`,
`library/plugins/materio/tests/test_verify_citations.py`, `library/plugins/materio/tests/test_check_scripts.py`, and `library/plugins/materio/tests/test_check_physics.py`
were read in this review, and the cases described above are taken from those
reads.
