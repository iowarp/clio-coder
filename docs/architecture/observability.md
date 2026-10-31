# /view

`/view` is the interactive artifact viewer for a Clio Coder session. It keeps the live transcript compact while preserving a full inspection path for run records, evidence, task ledgers, decisions and successful workspace outputs. What it shows is recorded by [telemetry](telemetry.md) and the session ledger; the viewer only reads.

```text
/view
/view <id-or-filter>
/view verify <runId>
```

`/view` opens a full-screen split viewer. The left pane groups artifacts by category, newest first within a category, and supports type-to-filter. The right pane renders the selected artifact with pager controls. Below 84 columns of body width the viewer shows one pane at a time. The artifact providers live in [view-artifacts.ts](../../src/domains/session/view-artifacts.ts) in the session domain, and the viewer in [view-overlay.ts](../../src/interactive/view/view-overlay.ts) only renders them. ACP clients read the same providers through `_clio-coder/artifacts/list` and `_clio-coder/artifacts/read`; see [ACP](acp.md). The graphical application's session Artifacts drill-in is one such client ([the GUI guide](../guide/gui.md)).

| Pane | Keys |
| --- | --- |
| List | `Up` and `Down` select. `Left` and `Right` jump to the previous or next non-empty category, wrapping at the ends and honoring the active filter. Typing filters. `Ctrl+U` clears the filter. `Enter`, `Tab`, or `Shift+Tab` moves to the content pane. `Esc` closes the viewer. |
| Content | `Up` and `Down` (or `k` and `j`) scroll by line. `PgUp` and `PgDn` scroll by page, `Ctrl+U` and `Ctrl+D` by half page, `g` and `G` jump to the top and bottom. `n` and `p` move to the next and previous artifact. `Left` and `Right` jump category. `i` toggles the details and provenance view. `v` verifies the selected run record. `o` shows the absolute backing path through the notice channel, or a warning notice when the artifact has no backing path. `Tab`, `Shift+Tab`, or `Esc` returns to the list. |

The filter splits on whitespace and requires every token to match, case-insensitively, against the artifact id, `category:id`, category, title, description, run id, session id, correlation id, tool name, backing path, and search text. A `<category>:<value>` filter, such as `receipt:abc1234`, restricts the list to that category and selects the artifact whose id matches the value exactly when one does. A bare `transcript`, `task-ledger`, `workspace`, `protected-artifact`, `compaction`, `prompt-manifest`, or `audit` selects that whole category. `/view <id-or-filter>` opens the viewer with that filter applied.

## Verifying a run

Pressing `v` on a run record or running `/view verify <runId>` checks the run's sealed scope again from its own files (`verifyRunRecordReport` in [view-artifacts.ts](../../src/domains/session/view-artifacts.ts)) and posts the report as a notice without opening the viewer. The report lists each check with its evidence:

1. **Run journal.** `<stateDir>/telemetry/runs/<runId>/` holds a readable journal.
2. **Run settled.** The journal holds the run's `run.settled` record.
3. **Run seal.** The scope's `bundle.json`, segments, objects and hash chain verify as `clio-coder telemetry verify` checks them ([Verify](telemetry.md#verify)), and the report names the seal time and the record, segment and object counts.
4. **Trust axes.** Each trust axis the run's assessment marks compromised, such as a failed artifact integrity check, ungrounded validation, a review that was not independent or invalid context provenance, is listed as a failed check with its evidence.

A run whose seal verifies but whose trust is compromised posts a warning; a run that is missing, unsettled or fails its seal posts an error. The check is read-only. `clio-coder fleet verify <runId> --json` runs the same check from the command line ([fleet-verify.ts](../../src/cli/fleet-verify.ts)).

## Categories

Directories resolve under platform XDG defaults (on Linux, `~/.config/clio-coder/`, `~/.local/share/clio-coder/` and `~/.local/state/clio-coder/`). `/view` lists twelve categories in this order (`VIEW_ARTIFACT_CATEGORIES`).

| Category | Description | Backing path |
| --- | --- | --- |
| **Transcript details** | The live transcript's acts rendered unbounded and redacted: provider and terminal errors, thinking blocks, and tool executions with every argument. Held by the running session only. | None |
| **Accountability** | First-pass success rate, unverified successes, ungrounded claims, and the top failure causes over the runs this view lists: the session's own runs plus runs recorded in the same project. | The listed runs' sealed run scopes |
| **Evidence bundles** | Each settled run's assessment: trust status, findings, gate verdicts and totals. | `<stateDir>/telemetry/runs/<runId>/` |
| **Receipts** | One record per finished run whose run journal exists, from its `run.settled` record and seal verdict. `v` verifies it. | `<stateDir>/telemetry/runs/<runId>/journal.jsonl` |
| **Dispatch outputs** | Every run the run ledger lists, with its run journal when one exists. | The run journal, else `<stateDir>/runs.json` |
| **Task ledgers** | Per-turn task-board goals, active runs, required validation evidence, and operator-task provenance when present. | `<stateDir>/sessions/<cwdHash>/<sessionId>/current.jsonl` |
| **Workspace outputs** | Latest successful `artifact`, `write`, or `edit` result for each normalized path on the active session branch. Missing files remain visible as recorded facts. | Recorded path beneath the session metadata `cwd` |
| **Tool outputs** | Offloaded large outputs or execution logs. | `<stateDir>/scratch/<sessionId>/<sha256 of the captured text>.txt` |
| **Protected artifacts** | Validation-protected artifact metadata and its absolute artifact path when available. | Session ledger record plus the protected workspace path |
| **Compaction summaries** | Summaries of compacted history. | `<stateDir>/sessions/<cwdHash>/<sessionId>/current.jsonl` |
| **Prompt manifests** | One record per prompt compile from the session journal's `prompt.compiled` records and their `prompt-structure` objects: prompt hash, token estimate, thinking level, sections and fragment content hashes, without prompt text. Unreadable records appear as an explicit read-error artifact. | `<stateDir>/telemetry/sessions/<sessionId>/journal.jsonl` |
| **Safety audit rows** | The newest 200 safety, permission and lifecycle decisions of the current session, from its journal and the run journals it references. Unreadable journal records appear as a separate artifact, because the list is then partial. A view with no session lists none. | `<stateDir>/telemetry/sessions/<sessionId>/journal.jsonl` |

Workspace output containment is checked again when the operator loads an item, not only when `/view` builds its list. The loader re-resolves the recorded workspace root and target through symlinks on every load, verifies canonical path-segment containment, and reads the canonical target. A target or ancestor symlink swapped outside the workspace is refused. A missing target keeps the recorded timestamp and reports `file no longer on disk`; it does not disappear from the artifact history.

## The accountability panel

The **Accountability** category folds the assessments of the runs the viewer lists, so runs from other projects do not count.

- **First-pass success.** A run counts when its outcome succeeded, it needed no dispatch retry, and its assessment found validation evidence. The panel prints `first-pass success: <first-pass runs>/<runs> (<pct>%)`.
- **Unverified successes.** Runs that succeeded with no validation or only proxy validation, or with a warning-level completion-evidence finding: `unverified successes: <count>`.
- **Ungrounded claims.** The validation claims in verified runs with no matching command: `ungrounded claims: <count>`.
- **Top failure causes.** Up to eight failure causes sorted by frequency, then by name, from the closed set `timeout`, `auth-failure`, `missing-dependency`, `build-failure`, `test-failure` and `blocked-tool` (`FAILURE_CAUSE_TAG_ORDER` in [types.ts](../../src/domains/evidence/types.ts)). With none the panel prints `none`.
