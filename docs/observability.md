# Observability Viewer

> [!TIP]
> **Interactive Spec Available:** An interactive dashboard is located at [docs/html/observability_blueprint.html](html/observability_blueprint.html) (Version: 0.2.4).

`/view` is the interactive artifact viewer for a Clio session. It keeps the live transcript compact while preserving a full inspection path for durable artifacts.

```text
/view
/view <id-or-filter>
/view verify <runId>
```

`/view` opens a full-screen split viewer. The left pane groups artifacts by category and supports type-to-filter. The right pane renders the selected artifact with pager controls. `Tab` switches panes. `v` verifies a selected receipt. `o` shows the absolute backing path through the notice channel so the file can be opened outside the TUI.

## Artifact Categories

| Category | Source | Backing path |
| --- | --- | --- |
| Receipts | Dispatch ledger entries with completed receipt files | `<stateDir>/receipts/<runId>.json` |
| Dispatch outputs | Dispatch ledger rows plus matching session dispatch tool results when present | `<stateDir>/runs.json`, receipt path, or the current session transcript |
| Tool outputs | Current-session durable output references, including `bashExecution.fullOutputPath`, `resultSize.offloadPath`, and tool-result detail paths such as `outputPath` | The referenced absolute path |
| Compaction summaries | Current-session `compactionSummary` entries | `<stateDir>/sessions/<cwdHash>/<sessionId>/current.jsonl` |

Receipts and dispatch rows are global ledger artifacts so historical runs remain inspectable. Tool output and compaction categories are session-local because they are stored inside the active session transcript or referenced from it.

## Rendering

Receipt JSON is pretty-printed before rendering. Plain text is rendered without stripping ANSI sequences. Markdown summaries render through the shared TUI Markdown component. Large file-backed artifacts are read incrementally and capped at the first 50,000 lines with a footer that points to the original path.

The dispatch domain does not currently persist a separate worker terminal log. `/view` therefore renders the durable ledger and receipt metadata, then adds the matching dispatch tool result from the active session when that result is present.

The generic tool result shaper truncates oversized tool results in the
transcript and saves a scratch copy under `<stateDir>/scratch/<sessionId>/`
when possible. `/view` follows those offload paths plus durable output paths
written by tools, especially `bashExecution.fullOutputPath` and tool-result
detail paths.

## Verification

`/view verify <runId>` and `v` on a receipt both run the same read-only verification path:

1. Read `<stateDir>/receipts/<runId>.json`.
2. Validate the required receipt fields and basic value ranges.
3. Read `<stateDir>/runs.json` and find the matching run envelope.
4. Recompute receipt integrity with the dispatch receipt integrity helper.

Verification never mutates the receipt, ledger, or session transcript. It reports one success or failure notice in headless mode, and paints the result into the viewer header in interactive mode.

## Minimal Transcript

Clio keeps routine transcript output short so the active conversation stays readable and inexpensive to replay. `/view` is the detailed inspection surface: receipts, worker outputs, file-backed tool output, and compaction summaries remain available on demand without forcing every byte into the main chat panel.

## Diagnostics and telemetry routing

Operational events are typed at the process boundary and routed to notices,
status, audit, overlays, or read-only snapshots instead of dying on the event
bus. Dispatch native worker failures include a bounded stderr tail and
malformed-stdout diagnostics in failure payloads and receipts. Audit records
distinguish safety classification from the final disposition, such as
`allowed`, `blocked`, `permission_requested`, or `denied`.
