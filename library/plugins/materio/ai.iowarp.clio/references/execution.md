# Clio orchestration binding

Read ${component:resource:research-policy}. Resolve package references from their
component paths. Project paths stay under the current project `.research/`.
Treat command arguments as operator text, validate positive decimal task numbers,
and pass real values as separate quoted argv values to bash. Shell variables do
not persist between calls. Prefer read/ls/find/grep and write/edit for documents.

When this action needs researcher answers, check ask_user availability before any
write. Use the interactive ask_user ask/complete lifecycle, batch related questions,
preserve actual supplied answers, and keep cancellation or missing answers pending.
Use `ask_user(action="ask", max_rounds=24, questions=[{header:"...",
question:"...", options:[{label:"..."}]}])`; close a settled interview with
`ask_user(action="complete", summary="...", decisions=[{key:"...",value:"..."}])`.
No worker recipe may call ask_user. A headless caller needs previously confirmed
answers or returns a checkpoint before gated writes. Do not treat absent tools,
permissions, or researcher answers as implied consent.

Read effective config with `python3 "${component:script:research-state}" config`.
The helper fails on malformed, duplicate-key, or nonboolean policy settings.
Initialize missing state using its `init` command after the interview gate. It
preserves existing configuration and never initializes git. Allocate a new stable
ID with `next-task-id`; use `validate-workflow` before `task-dirs` or execution.
Use `checkpoint save LABEL`, `checkpoint list`, and after confirmation and a
current-state snapshot, `checkpoint restore NAME --confirmed`.

Optional recording uses `record --message TEXT --files FILE...` with only explicit
files this action actually changed. Bind CHANGED_FILES as a quoted Bash array of
that actual read-back inventory in the same call that uses it. The helper accepts no directory staging,
requires commit_research=true and an empty preexisting git index, and reports a
skipped or failed record. Do not run git init, git tag, broad git add, or raw tar.
A recording failure does not erase successfully saved research artifacts.

Workers use registered native recipe IDs and dispatch intent.write_roots for the
exact approved outputs. Read required package references, current state, and prior
answers; include relevant contents in each fresh assignment if the worker cannot
retrieve them itself. Honor admission refusals. Use monitor for active runs.
Route mutation-report summary prefixes, including needs_input checkpoint kinds
`decision`, `human-action`, and `human-verify`; re-dispatch only after their exact
question is answered. Validate actual files after every writing return, including
partial results and loop-back. Failed checks override a success claim.

Read required files using ls/read, verify nonempty meaningful content, and record
what was actually checked. Advisory Python checks use explicit existing filenames;
record exit status, stdout/stderr and coverage. A missing Python installation or
checker is a skipped check, never a pass. Default citation checks to --offline;
allow network only if effective config permits it and the supplied source scope
is authorized. Preserve findings for researcher decisions, with no automatic deletion.

For writing workers that cannot execute the outstanding checks, require a typed
limitation receipt naming the output paths and verification scope before their
final response. Readback is artifact inspection, not command-backed scientific
validation. Inspect the receipt outcome as well as the summary: a failed finish
gate remains a failed run even when an output file exists. Retain partial files
and the failure; reconcile the specific limitation in a fresh bounded assignment
before continuing. Independent operator checks remain separate evidence.
